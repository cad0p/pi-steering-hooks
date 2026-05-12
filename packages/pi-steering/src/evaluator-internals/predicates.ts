// SPDX-License-Identifier: MIT
// Part of pi-steering.

/**
 * Predicate evaluators for the v2 engine.
 *
 * Three public entry points:
 *
 *   - {@link matchesPatternOrFn}  — resolves `pattern` / `requires` /
 *                                    `unless` values against a target
 *                                    string.
 *   - {@link evaluateWhen}        — walks a {@link WhenClause} tree,
 *                                    dispatching built-in (`cwd`, `not`,
 *                                    `condition`) + plugin-registered
 *                                    predicates.
 *   - {@link UnknownPredicateError} — thrown when a WhenClause names a
 *                                    predicate nobody registered. Kept as
 *                                    a named error so callers can catch
 *                                    it by type; the message includes the
 *                                    offending key.
 *
 * The walker's `cwdTracker.unknown` sentinel is `"unknown"`. That's the
 * string we compare against for `onUnknown` policy application on the
 * built-in `cwd` predicate. Plugin-registered trackers emit their own
 * unknown sentinels; handling those is the plugin handler's job.
 */

import type {
	Pattern,
	PredicateContext,
	PredicateFn,
	PredicateHandler,
	WhenClause,
} from "../schema.ts";
import { AGENT_LOOP_INDEX_KEY } from "./context.ts";
import type { SyntheticEntry } from "./speculative-synthesis.ts";

// ---------------------------------------------------------------------------
// Pattern / PredicateFn resolution
// ---------------------------------------------------------------------------

/**
 * Regex-compile cache: reuses the same RegExp object for the same string
 * source. Rule patterns are typically long-lived; caching avoids
 * recompilation on every tool_call while still being safe for ad-hoc
 * patterns (weak in the worst case, Map in practice).
 *
 * Module-scoped so it lives across evaluator instances — same rule
 * definition in two configs produces the same RegExp. Cheap enough
 * we don't bother with eviction.
 */
const REGEX_CACHE = new Map<string, RegExp>();

function compileRegex(source: string): RegExp {
	const hit = REGEX_CACHE.get(source);
	if (hit !== undefined) return hit;
	const re = new RegExp(source);
	REGEX_CACHE.set(source, re);
	return re;
}

/**
 * Match a string against a {@link Pattern} (string source or RegExp).
 * Patterns are compiled once and cached; RegExps pass through.
 */
export function matchesPattern(pattern: Pattern, target: string): boolean {
	if (pattern instanceof RegExp) return pattern.test(target);
	return compileRegex(pattern).test(target);
}

/**
 * Evaluate a rule-level predicate (`pattern`, `requires`, `unless`).
 *
 * Accepts the same union v1's `Rule` supported plus {@link PredicateFn}:
 *   - `string` / `RegExp` → pattern match against `target`.
 *   - `function`          → call with `ctx`, coerce result to boolean.
 */
export async function matchesPatternOrFn(
	value: Pattern | PredicateFn,
	target: string,
	ctx: PredicateContext,
): Promise<boolean> {
	if (typeof value === "function") {
		const r = await value(ctx);
		return Boolean(r);
	}
	return matchesPattern(value, target);
}

// ---------------------------------------------------------------------------
// WhenClause dispatch
// ---------------------------------------------------------------------------

/**
 * Thrown when a {@link WhenClause} references a predicate name that no
 * plugin has registered. The error message includes the offending key
 * so the source of the typo / missing plugin is clear at the site of
 * the rule.
 *
 * Schema-level typo detection doesn't cover this because the
 * `WhenClause` index signature is deliberately loose (`unknown`) — per
 * the ADR, plugin predicates can accept arbitrary arg shapes. The
 * trade-off is that we surface the error at evaluation time instead of
 * load time; the key-scoped message keeps that tolerable.
 */
export class UnknownPredicateError extends Error {
	readonly key: string;
	constructor(key: string) {
		super(
			`[pi-steering] unknown when.${key} predicate — ` +
				`no plugin registered a handler for this key. ` +
				`Check for typos, or add a plugin that provides "${key}".`,
		);
		this.name = "UnknownPredicateError";
		this.key = key;
	}
}

/**
 * Built-in `when.cwd` predicate. Accepts shorthand `Pattern` or the
 * `{ pattern, onUnknown }` object form. Applies the `onUnknown` policy
 * when the walker-supplied `walkerCwd` equals the cwd tracker's
 * `"unknown"` sentinel.
 *
 *   - `onUnknown: "block"` (default, fail-closed) → predicate PASSES on
 *     unknown so the rule fires (block the command).
 *   - `onUnknown: "allow"`                        → predicate FAILS on
 *     unknown so the rule skips (allow the command).
 *
 * Fast path: the common shorthand form `when.cwd: /regex/` (or a
 * string pattern) is read directly — no normalization object
 * allocated. Only the object form `{ pattern, onUnknown }` takes
 * the slightly-slower path of reading two fields. Matters because
 * `when.cwd` runs once per rule per extracted ref per tool_call,
 * so cutting the per-call allocation saves micro-seconds on hot
 * configs with many cwd-scoped rules.
 */
function evaluateCwd(
	value: unknown,
	walkerCwd: string,
): boolean {
	// Shorthand Pattern form (string or RegExp).
	if (typeof value === "string" || value instanceof RegExp) {
		if (walkerCwd === "unknown") return true; // onUnknown default: block
		return matchesPattern(value, walkerCwd);
	}
	// Object form: { pattern, onUnknown? }.
	if (
		value !== null &&
		typeof value === "object" &&
		"pattern" in (value as Record<string, unknown>)
	) {
		const obj = value as {
			pattern: Pattern;
			onUnknown?: "allow" | "block";
		};
		if (walkerCwd === "unknown") {
			return (obj.onUnknown ?? "block") === "block";
		}
		return matchesPattern(obj.pattern, walkerCwd);
	}
	// Malformed input — treat as shorthand Pattern with fail-closed default.
	if (walkerCwd === "unknown") return true;
	return matchesPattern(value as Pattern, walkerCwd);
}

/**
 * Built-in `when.happened` predicate. Merges real session entries
 * (from `ctx.findEntries`, scope-filtered) with speculative entries
 * (from `ctx.walkerState.events[event]`, produced by the walker-level
 * synthesis pass — see {@link synthesizeSpeculativeEntries}) and
 * returns **true when the unified timeline says the event has NOT
 * happened** — i.e. the rule should fire.
 *
 * Single pipeline: the merge via timestamp ordering collapses the
 * prior two-path structure (specialized tool_call-scope speculative-
 * allow running only on stale/absent real entries) into one uniform
 * sort-and-compare. Synthetic entries carry reserved timestamps above
 * all real entries in the same type (see
 * {@link synthesizeSpeculativeEntries}'s timestamp convention); so on
 * an `&&` chain where the prior ref would produce `event`, the
 * merged timeline correctly treats the event as fresher than any
 * stale real entry of the same type.
 *
 * ADR §5 scope semantics are applied to real entries only —
 * speculative entries are always considered in-scope. Synthetic
 * entries represent "about to happen in the current tool_call", and
 * the current tool_call is always part of the current agent_loop and
 * session, so a scope subset check adds no signal. This also means a
 * rule using `in: "agent_loop"` and a rule using `in: "session"` see
 * the same speculative view (correct — "about to happen" is scope-
 * independent; a speculative entry newer than ALL real entries for
 * the type is newer than any scope subset too).
 *
 * Inversion is handled by the caller via `when.not`. Authors wanting
 * "fires when the event HAS happened" wrap this clause in `not:`.
 */
function evaluateHappened(
	value: unknown,
	ctx: PredicateContext,
	ruleName: string,
): boolean {
	if (
		value === null ||
		typeof value !== "object" ||
		!("event" in value) ||
		!("in" in value)
	) {
		throw new Error(
			`[pi-steering] Rule "${ruleName}": when.happened ` +
				`expected { event: string; in: "agent_loop" | "session" | "tool_call"; since?: string; notIn?: "agent_loop" | "session" | "tool_call" }; ` +
				`got ${JSON.stringify(value)}`,
		);
	}
	const {
		event,
		in: scope,
		since,
		notIn,
	} = value as {
		event: string;
		in: unknown;
		since?: unknown;
		notIn?: unknown;
	};
	// Validate the scope string. The type system says
	// `"agent_loop" | "session" | "tool_call"`, but a typo like
	// `"agentLoop"` slips through TypeScript when the value arrives
	// from a JSON source (import-json CLI, hand-written config, etc.).
	// Surface those as loud runtime errors rather than silent
	// fallthrough.
	if (scope !== "agent_loop" && scope !== "session" && scope !== "tool_call") {
		throw new Error(
			`[pi-steering] Rule "${ruleName}": ` +
				`when.happened.in must be "agent_loop", "session", or "tool_call"; ` +
				`got ${JSON.stringify(scope)}`,
		);
	}
	if (since !== undefined && typeof since !== "string") {
		throw new Error(
			`[pi-steering] Rule "${ruleName}": ` +
				`when.happened.since must be a string if present; ` +
				`got ${JSON.stringify(since)}`,
		);
	}

	// Optional `notIn`: scope-subtraction modifier. Flat string — no
	// nested object shape. Validated here rather than at load time to
	// match the existing unknown-scope validation pattern (engine has no
	// schema-level validation pass).
	let innerScope: "agent_loop" | "session" | "tool_call" | null = null;
	if (notIn !== undefined) {
		if (
			notIn !== "agent_loop" &&
			notIn !== "session" &&
			notIn !== "tool_call"
		) {
			throw new Error(
				`[pi-steering] Rule "${ruleName}": ` +
					`when.happened.notIn must be "agent_loop", "session", or "tool_call"; ` +
					`got ${JSON.stringify(notIn)}`,
			);
		}
		if (notIn === scope) {
			throw new Error(
				`[pi-steering] Rule "${ruleName}": ` +
					`when.happened.in and when.happened.notIn are identical (${JSON.stringify(scope)}); subtraction is empty. Remove the "notIn" modifier.`,
			);
		}
		if (SCOPE_ORDER[notIn] > SCOPE_ORDER[scope]) {
			throw new Error(
				`[pi-steering] Rule "${ruleName}": ` +
					`when.happened.notIn (${JSON.stringify(notIn)}) is a superset of when.happened.in (${JSON.stringify(scope)}); subtraction is empty. Adjust the scopes.`,
			);
		}
		innerScope = notIn;
	}

	const sinceValue = typeof since === "string" ? since : undefined;

	const eventLatest = latestTimestampSubtracted(
		event,
		scope,
		innerScope,
		ctx,
	);
	if (eventLatest === null) {
		// Event absent in the (subtracted) timeline → rule fires.
		return true;
	}
	if (sinceValue === undefined) {
		// Simple presence check: event happened → rule does NOT fire.
		return false;
	}
	const sinceLatest = latestTimestampSubtracted(
		sinceValue,
		scope,
		innerScope,
		ctx,
	);
	if (sinceLatest === null) {
		// Invalidator never written in the (subtracted) timeline →
		// degrade to simple-happened semantics (event wins).
		return false;
	}
	// Both present. Event counts as happened iff its latest entry
	// is strictly newer than the invalidator's.
	return eventLatest <= sinceLatest;
}

/**
 * Latest timestamp across the unified real + speculative timeline
 * for the given customType, with optional set-subtraction against an
 * inner scope. `null` when no entries remain after subtraction.
 *
 * Semantics:
 *   - Outer scope `"tool_call"`: real entries are skipped entirely
 *     (real entries are never "within this one bash invocation");
 *     only speculative entries count. Exactly the existing "about to
 *     happen in THIS command" semantic.
 *   - Outer `"agent_loop"`: real entries scope-filtered by
 *     `_agentLoopIndex`; speculative always included.
 *   - Outer `"session"`: all real entries; speculative always included.
 *
 * When `innerScope` is non-null, the subtraction removes entries that
 * are in `innerScope` from the entry stream BEFORE the timestamp max.
 * Since speculative entries are `tool_call`-scope by construction and
 * `tool_call ⊂ agent_loop ⊂ session`, ANY non-null `innerScope`
 * subtracts all speculative entries. For real entries, the inner
 * scope's membership predicate gates which are excluded.
 *
 * Invariant (enforced by {@link evaluateHappened}'s validation):
 * `innerScope === null` OR `SCOPE_ORDER[innerScope] <= SCOPE_ORDER[outer]`
 * AND `innerScope !== outer`. Callers passing anything else get a
 * configuration error before arriving here.
 */
function latestTimestampSubtracted(
	customType: string,
	outer: "agent_loop" | "session" | "tool_call",
	innerScope: "agent_loop" | "session" | "tool_call" | null,
	ctx: PredicateContext,
): number | null {
	let latest = -Infinity;

	// Real entries: in outer scope AND NOT in inner scope.
	// Outer = "tool_call" excludes all real entries outright.
	if (outer !== "tool_call") {
		const inOuter = realEntryInScope(outer, ctx);
		const inInner =
			innerScope !== null && innerScope !== "tool_call"
				? realEntryInScope(innerScope, ctx)
				: null;
		for (const entry of ctx.findEntries<Record<string, unknown>>(customType)) {
			if (!inOuter(entry)) continue;
			if (inInner !== null && inInner(entry)) continue;
			if (entry.timestamp > latest) latest = entry.timestamp;
		}
	}

	// Speculative entries are always `tool_call` scope. Any non-null
	// inner scope subtracts them (tool_call itself, or a superset that
	// includes tool_call). When inner is null, keep them.
	if (innerScope === null) {
		const speculative = speculativeEntriesFor(ctx, customType);
		for (const entry of speculative) {
			if (entry.timestamp > latest) latest = entry.timestamp;
		}
	}

	return latest === -Infinity ? null : latest;
}

/**
 * Read the speculative-entry slice for `customType` off
 * `ctx.walkerState.events`. Returns an empty array when walkerState
 * is undefined (non-bash candidates) or carries no `events` field
 * (configs with no observers producing synthesis entries for this
 * event → the synthesis pass returned empty views per ref).
 */
function speculativeEntriesFor(
	ctx: PredicateContext,
	customType: string,
): readonly SyntheticEntry[] {
	const events = ctx.walkerState?.["events"] as
		| Readonly<Record<string, readonly SyntheticEntry[]>>
		| undefined;
	return events?.[customType] ?? [];
}

/**
 * Scope nesting order used for superset detection in happened.notIn
 * validation. `tool_call ⊂ agent_loop ⊂ session`; a higher number
 * means a broader scope.
 */
const SCOPE_ORDER = {
	tool_call: 0,
	agent_loop: 1,
	session: 2,
} as const;

/**
 * Build a per-entry filter for a scope as it applies to REAL entries
 * (session JSONL). Speculative entries are filtered elsewhere since
 * they have their own scope semantics.
 *
 * For a scope `tool_call`, real entries never match (no real entry
 * originates from the current tool_call's speculative view).
 */
function realEntryInScope(
	scope: "agent_loop" | "session" | "tool_call",
	ctx: PredicateContext,
): (entry: { data: Record<string, unknown> }) => boolean {
	if (scope === "session") {
		return () => true;
	}
	if (scope === "tool_call") {
		return () => false;
	}
	const target = ctx.agentLoopIndex;
	return (entry) => {
		const tag = entry.data?.[AGENT_LOOP_INDEX_KEY];
		return tag === target;
	};
}

/**
 * Walker state consumed by `when` evaluation. Today just the per-ref
 * cwd; the shape is open for future built-ins (e.g. branch) to pull
 * their own fields from the same snapshot.
 *
 * @internal — not a plugin-author surface. Plugin predicates consume
 * `ctx.walkerState` (the public `Readonly<Record<string, unknown>>`
 * on {@link PredicateContext}) instead.
 */
interface WhenWalkerState {
	readonly cwd: string;
}

/**
 * Evaluate a {@link WhenClause}: returns true if every predicate in the
 * clause "matches" for the given context. An empty / undefined clause
 * trivially matches (rule fires regardless of `when`).
 *
 * Dispatch table:
 *   - `cwd`        — built-in (walker-tied), consumes `state.cwd`.
 *   - `happened`   — built-in (session-entry-scoped), consumes
 *                    `ctx.findEntries` + `ctx.agentLoopIndex`.
 *   - `not`        — nested WhenClause; inversion: NONE of the nested
 *                    predicates match.
 *   - `condition`  — {@link PredicateFn}; call with ctx.
 *   - anything else — `predicates[key]`; throws
 *                    {@link UnknownPredicateError} when absent.
 */
export async function evaluateWhen(
	when: WhenClause | undefined,
	state: WhenWalkerState,
	ctx: PredicateContext,
	predicates: Record<string, PredicateHandler>,
	ruleName: string,
): Promise<boolean> {
	if (!when) return true;

	for (const [key, value] of Object.entries(when)) {
		if (value === undefined) continue;

		// Built-in: cwd
		if (key === "cwd") {
			if (!evaluateCwd(value, state.cwd)) return false;
			continue;
		}

		// Built-in: happened (session-entry presence check)
		if (key === "happened") {
			if (!evaluateHappened(value, ctx, ruleName)) return false;
			continue;
		}

		// Built-in: not (recursive inversion)
		if (key === "not") {
			const nested = value as WhenClause;
			const nestedMatches = await evaluateWhen(
				nested,
				state,
				ctx,
				predicates,
				ruleName,
			);
			if (nestedMatches) return false;
			continue;
		}

		// Built-in: condition (escape-hatch function)
		if (key === "condition") {
			const fn = value as PredicateFn;
			const result = await fn(ctx);
			if (!result) return false;
			continue;
		}

		// Plugin-registered predicate. Must have been declared via
		// `resolved.predicates[key]` (populated by plugin-merger from
		// Plugin.predicates).
		const handler = predicates[key];
		if (handler === undefined) {
			throw new UnknownPredicateError(key);
		}
		const result = await handler(value, ctx);
		if (!result) return false;
	}
	return true;
}

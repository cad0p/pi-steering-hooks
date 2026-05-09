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
 */
function evaluateCwd(
	value: unknown,
	walkerCwd: string,
): boolean {
	const unwrapped = unwrapOnUnknown(value);
	if (walkerCwd === "unknown") {
		return unwrapped.onUnknown === "block"; // block → pred passes → rule fires
	}
	return matchesPattern(unwrapped.pattern, walkerCwd);
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
 * prior two-path structure (specialized chain-aware speculative-allow
 * running only on stale/absent real entries) into one uniform
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
				`expected { event: string; in: "agent_loop" | "session"; since?: string }; ` +
				`got ${JSON.stringify(value)}`,
		);
	}
	const {
		event,
		in: scope,
		since,
	} = value as {
		event: string;
		in: unknown;
		since?: unknown;
	};
	// Validate the scope string. The type system says
	// `"agent_loop" | "session"`, but a user migrating from v0.0.0-poc
	// configs where the scope was called `"turn"` — or anyone with a
	// typo like `"agentLoop"` — slips through TypeScript when the value
	// arrives from a JSON source (import-json CLI, hand-written config,
	// etc.). Surface those as loud runtime errors rather than silent
	// fallthrough to the else-branch (the agent_loop filter path).
	if (scope === "turn") {
		throw new Error(
			`[pi-steering] Rule "${ruleName}": ` +
				`when.happened.in: "turn" is no longer supported in ` +
				`pi-steering v0.1.0. Use "agent_loop" instead ` +
				`(see the v0.1.0 migration notes).`,
		);
	}
	if (scope !== "agent_loop" && scope !== "session") {
		throw new Error(
			`[pi-steering] Rule "${ruleName}": ` +
				`when.happened.in must be "agent_loop" or "session"; ` +
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
	const inScope = scopeFilter(scope, ctx);
	const eventLatest = latestTimestamp(event, inScope, ctx);
	if (eventLatest === null) {
		// Event absent in unified timeline → rule fires.
		return true;
	}
	if (since === undefined) {
		// Simple presence check: event happened → rule does NOT fire.
		return false;
	}
	const sinceLatest = latestTimestamp(since, inScope, ctx);
	if (sinceLatest === null) {
		// Invalidator never written in scope → degrade to simple-
		// happened semantics (event wins).
		return false;
	}
	// Both present. Event counts as happened iff its latest entry
	// (real or speculative) is strictly newer than the invalidator's.
	return eventLatest <= sinceLatest;
}

/**
 * Latest timestamp across the unified real + speculative timeline
 * for the given customType. `null` when no entries exist in either
 * the scope-filtered real stream or the speculative stream.
 *
 * Speculative entries bypass the scope filter — see
 * {@link evaluateHappened}'s JSDoc for why the scope subset check
 * adds no signal on "about to happen" entries.
 */
function latestTimestamp(
	customType: string,
	inScope: (entry: { data: Record<string, unknown> }) => boolean,
	ctx: PredicateContext,
): number | null {
	let latest = -Infinity;
	for (const entry of ctx.findEntries<Record<string, unknown>>(customType)) {
		if (!inScope(entry)) continue;
		if (entry.timestamp > latest) latest = entry.timestamp;
	}
	const speculative = speculativeEntriesFor(ctx, customType);
	for (const entry of speculative) {
		if (entry.timestamp > latest) latest = entry.timestamp;
	}
	return latest === -Infinity ? null : latest;
}

/**
 * Read the speculative-entry slice for `customType` off
 * `ctx.walkerState.events`. Returns an empty array when walkerState
 * is undefined (non-bash candidates) or carries no `events` field
 * (configs with no chain-aware observers → the synthesis pass
 * returned empty views per ref).
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
 * Build a per-entry filter for the happened scope. Hoisted out of
 * {@link evaluateHappened} so both the `event` and the optional
 * `since` entry streams share the same predicate.
 */
function scopeFilter(
	scope: "agent_loop" | "session",
	ctx: PredicateContext,
): (entry: { data: Record<string, unknown> }) => boolean {
	if (scope === "session") {
		return () => true;
	}
	const target = ctx.agentLoopIndex;
	return (entry) => {
		const tag = entry.data?.[AGENT_LOOP_INDEX_KEY];
		return tag === target;
	};
}

/**
 * Normalize the union shape accepted by built-in predicates:
 *   - `Pattern`                            → { pattern, onUnknown: "block" }
 *   - `{ pattern: Pattern, onUnknown? }`   → as supplied; `onUnknown`
 *                                            defaults to "block".
 */
function unwrapOnUnknown(value: unknown): {
	pattern: Pattern;
	onUnknown: "allow" | "block";
} {
	if (
		value !== null &&
		typeof value === "object" &&
		!(value instanceof RegExp) &&
		"pattern" in (value as Record<string, unknown>)
	) {
		const obj = value as {
			pattern: Pattern;
			onUnknown?: "allow" | "block";
		};
		return { pattern: obj.pattern, onUnknown: obj.onUnknown ?? "block" };
	}
	return { pattern: value as Pattern, onUnknown: "block" };
}

/**
 * Walker state consumed by `when` evaluation. Today just the per-ref
 * cwd; the shape is open for future built-ins (e.g. branch) to pull
 * their own fields from the same snapshot.
 */
export interface WhenWalkerState {
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

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
	ObserverWatch,
	Pattern,
	PredicateContext,
	PredicateFn,
	PredicateHandler,
	ToolResultEvent,
	WhenClause,
} from "../schema.ts";
import { matchesWatch } from "../internal/watch-matcher.ts";
import { AGENT_LOOP_INDEX_KEY } from "./context.ts";

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
 * Built-in `when.happened` predicate. Reads session entries of the
 * given event from `ctx.findEntries`, filters by scope, and returns
 * **true when NO matching entry is found** — i.e. the event has NOT
 * happened yet in that scope.
 *
 * Matches ADR §5 semantics:
 *   - `in: "agent_loop"` keeps only entries whose
 *     `_agentLoopIndex === ctx.agentLoopIndex`.
 *   - `in: "session"` keeps every entry.
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
	const eventEntries = ctx
		.findEntries<Record<string, unknown>>(event)
		.filter(inScope);
	if (eventEntries.length > 0) {
		if (since === undefined) {
			// Simple presence check: event happened → rule does NOT fire.
			return false;
		}
		const sinceEntries = ctx
			.findEntries<Record<string, unknown>>(since)
			.filter(inScope);
		if (sinceEntries.length === 0) {
			// Sentinel never written → degrade to simple-happened semantics.
			return false;
		}
		// Both present in scope. The event is "happened" iff its latest
		// entry is strictly newer than the latest `since` entry.
		// `findEntries` returns entries in append order, so the last
		// element is the most recent.
		const latestEvent =
			eventEntries[eventEntries.length - 1]?.timestamp ?? 0;
		const latestSince =
			sinceEntries[sinceEntries.length - 1]?.timestamp ?? 0;
		if (latestEvent > latestSince) {
			// Event is fresher than the invalidator → still happened.
			return false;
		}
		// Event is older than (or equal to) the invalidator → stale;
		// fall through to speculative-allow + fire.
	}
	// At this point the happened predicate WOULD fire (event absent or
	// stale). Before firing, try the chain-aware speculative-allow path
	// (only meaningful for bash candidates with prior-`&&` refs and a
	// config that ships observers writing `event`).
	if (speculativeHappenedAllow(ctx, event)) {
		return false;
	}
	return true;
}

/**
 * Chain-aware speculative allow for `when.happened`. Returns `true`
 * when the current tool_call contains a prior `&&`-chained ref that
 * matches an observer declaring `writes: [event]` — meaning the event
 * is "about to happen" once the chain executes.
 *
 * Only `&&`-joined predecessors qualify (see
 * {@link PredicateContext.priorAndChainedRefs} and ADR amendment). The
 * guarantee: `A && B` short-circuits on A's failure, so if A would
 * make the observer fire on success, the speculative decision is safe
 * to grant — either A succeeds (event writes, block was correct to
 * skip) or A fails and B (the current ref) never runs.
 *
 * Filter semantics are delegated to the dispatcher's
 * {@link matchesWatch} via a synthesized `ToolResultEvent`
 * representing "a successful bash ref about to run" — the two paths
 * share one filter contract so new `watch` fields added to
 * {@link matchesWatch} automatically gate speculative-allow correctly.
 * Chain-aware-specific invariants (see
 * {@link observerEligibleForSpeculativeAllow}) are layered on top.
 *
 * IMPORTANT: `priorAndChainedRefs` contains refs STRICTLY BEFORE the
 * current ref in source order. The contract is preserved by
 * {@link computePriorAndChains} (a left-to-right walk that never
 * forward-references) — we do NOT consult refs that come after, which
 * would let an agent bypass a block by placing the "satisfying" ref
 * after the blocked ref.
 */
function speculativeHappenedAllow(
	ctx: PredicateContext,
	event: string,
): boolean {
	const priorRefs = ctx.priorAndChainedRefs;
	if (priorRefs === undefined || priorRefs.length === 0) return false;
	const observers = ctx.observersByWrittenEvent?.get(event);
	if (!observers || observers.length === 0) return false;
	for (const ref of priorRefs) {
		for (const obs of observers) {
			if (!observerEligibleForSpeculativeAllow(obs.watch)) continue;
			// Synthesize the minimal event shape `matchesWatch` inspects
			// for a successful bash ref. Fields the dispatcher fills on a
			// real `tool_result` are either covered (`toolName`, `input`,
			// `exitCode`) or irrelevant to the filter (`output` — never
			// read by `matchesWatch`). If a future filter field becomes
			// speculative-relevant, extend the synthesis here; the filter
			// body itself stays single-sourced in watch-matcher.ts.
			const synthetic: ToolResultEvent = {
				toolName: "bash",
				input: { command: ref.text },
				output: undefined,
				exitCode: 0,
			};
			if (matchesWatch(obs.watch, synthetic)) return true;
		}
	}
	return false;
}

/**
 * Chain-aware-specific pre-gate layered on top of the shared
 * {@link matchesWatch} contract. `matchesWatch` answers "would this
 * observer fire on this concrete event?"; speculative-allow needs the
 * stronger question "is it SAFE to grant an allow on the mere presence
 * of a prior `&&` ref matching this watch?". Two gates are specific to
 * speculative-allow:
 *
 *   - **Missing `inputMatches.command`**: an observer that fires on
 *     any bash event isn't a strong enough signal — it would grant
 *     allow on any `foo && cr` regardless of what `foo` does.
 *     Observers participating in chain-aware allow must declare
 *     `watch.inputMatches.command` (documented authoring
 *     requirement).
 *   - **toolName excluded from bash**: prior refs always come from
 *     the bash tool; a non-bash watch can never fire on one. Caught
 *     structurally by {@link matchesWatch}, but we fail fast here
 *     too so the synthesized event isn't constructed for obviously
 *     incompatible observers.
 *
 * Exit-code validation is delegated entirely to {@link matchesWatch}
 * against the synthesized `exitCode: 0` event — observers gated on
 * `"failure"` or non-zero codes can never fire via `&&` short-circuit
 * and `matchesWatch` correctly rejects the synthesized success event
 * for them.
 */
function observerEligibleForSpeculativeAllow(
	watch: ObserverWatch | undefined,
): boolean {
	if (!watch) return false;
	if (watch.toolName !== undefined && watch.toolName !== "bash") return false;
	const command = watch.inputMatches?.["command"];
	if (command === undefined) return false;
	return true;
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

// SPDX-License-Identifier: MIT
// Part of @cad0p/pi-steering-hooks.

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
			`[pi-steering-hooks] unknown when.${key} predicate — ` +
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
 * given type from `ctx.findEntries`, filters by scope, and returns
 * **true when NO matching entry is found** — i.e. the type has NOT
 * happened yet in that scope.
 *
 * Matches ADR §5 semantics:
 *   - `in: "agent_loop"` keeps only entries whose
 *     `_agentLoopIndex === ctx.agentLoopIndex`.
 *   - `in: "session"` keeps every entry.
 *
 * Inversion is handled by the caller via `when.not`. Authors wanting
 * "fires when the type HAS happened" wrap this clause in `not:`.
 */
function evaluateHappened(
	value: unknown,
	ctx: PredicateContext,
): boolean {
	if (
		value === null ||
		typeof value !== "object" ||
		!("type" in value) ||
		!("in" in value)
	) {
		throw new Error(
			`[pi-steering-hooks] when.happened expects ` +
				`{ type: string; in: "agent_loop" | "session" }; got ${JSON.stringify(value)}`,
		);
	}
	const { type, in: scope } = value as {
		type: string;
		in: "agent_loop" | "session";
	};
	const entries = ctx.findEntries<Record<string, unknown>>(type);
	if (scope === "session") {
		return entries.length === 0;
	}
	// scope === "agent_loop": filter by engine-injected tag.
	for (const entry of entries) {
		const tag = entry.data?.["_agentLoopIndex"];
		if (tag === ctx.agentLoopIndex) return false;
	}
	return true;
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
			if (!evaluateHappened(value, ctx)) return false;
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

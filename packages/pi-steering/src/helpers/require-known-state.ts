// SPDX-License-Identifier: MIT
// Part of pi-steering.

/**
 * Guards for predicate handlers whose answer derives from runtime
 * `ctx.cwd` (shell-exec queries, filesystem reads) rather than from
 * walker-tracked state.
 *
 * ## Why
 *
 * The engine's built-in `when.cwd` predicate applies an
 * `onUnknown: "allow" | "block"` policy (default `"block"`,
 * fail-closed) when the walker's `cwdTracker` can't statically resolve
 * a command's effective cwd — e.g. `cd "$WS_DIR/pkg" && git commit`
 * collapses to the walker's `"unknown"` sentinel. Every
 * walker-backed predicate shipped by a plugin inherits that guard for
 * free because the engine threads the sentinel through
 * `ctx.walkerState.cwd`.
 *
 * Custom predicates that read `ctx.cwd` DIRECTLY — typically via
 * `ctx.exec("git", [...], { cwd: ctx.cwd })` or a filesystem check —
 * do NOT. `ctx.cwd` is populated with the walker's pre-cd cwd (the pi
 * session cwd) when the walker bailed, so the predicate silently
 * queries the WRONG directory. An `isClean` gate on `cd $VAR && git
 * commit` would happily report "clean" for the session cwd and let
 * the commit through.
 *
 * See `cwd-dynamic-tracking-gap.md` (napkin feature doc) for the full
 * motivating analysis and the long-term v0.2+ alternatives
 * (Approaches B and C). This helper is Approach A — a per-predicate
 * fail-closed wrapper that plugin authors can opt into at
 * registration time.
 *
 * ## How
 *
 * `requireKnownState(handler, dimensions)` inspects
 * `ctx.walkerState[dim]` for each listed tracker dimension. If ANY is
 * the `"unknown"` sentinel, the wrapper returns `true` (predicate
 * fires) WITHOUT running the wrapped handler — mirroring the engine's
 * `onUnknown: "block"` default. If every listed dimension is known
 * (or `walkerState` is absent entirely, e.g. on `write` / `edit`
 * tools where there's no bash chain to track), the wrapper delegates
 * to the handler unchanged and returns the handler's verdict verbatim.
 *
 * `requireKnownCwd(handler)` is the common-case shorthand for
 * `requireKnownState(handler, ["cwd"])`.
 *
 * ## When NOT to wrap
 *
 * Predicates that read ONLY walker-tracked state via
 * `ctx.walkerState.<key>` (e.g. the git plugin's `branch`,
 * `upstream`, `commitsAhead` — which consult tracker state directly
 * or run git at the effective cwd the tracker validated) don't need
 * this wrapper. The engine's `when.cwd` cooperates with
 * `onUnknown: "block"` upstream of them.
 *
 * Predicates that rely on the session cwd being static regardless of
 * walker state (rare) also shouldn't wrap; they'd fail-close on every
 * dynamic-cwd chain the walker couldn't resolve.
 */

import type { PredicateHandler } from "../schema.ts";

/**
 * Walker-tracked state dimensions known to the engine out of the box.
 * Plugin-registered trackers can add additional dimensions at
 * config-build time; the `(string & {})` widening below preserves
 * acceptance of those custom names while still prompting IDE
 * autocomplete for the built-ins.
 *
 * Kept in this module (rather than `schema.ts`) because it's a
 * helper-layer authoring convenience, not a runtime type the
 * engine consumes — exported so plugin helpers can compose with
 * the same literal union.
 */
export type BuiltInTrackerDimension = "cwd" | "env";

/**
 * Wrap a predicate handler so it fires (returns `true`) whenever any
 * listed walker-state dimension is the `"unknown"` sentinel, without
 * invoking the wrapped handler.
 *
 * Design notes:
 *   - `dimensions` accepts `BuiltInTrackerDimension | (string & {})`
 *     so IDE autocomplete prompts the engine's built-in dimension
 *     names (`"cwd"`, `"env"`) as soon as the author opens the
 *     array literal, reducing the typo footgun (`"bracnh"` silently
 *     degrades to passthrough because the wrapper can never match
 *     the `"unknown"` sentinel on a key no tracker produces). The
 *     `(string & {})` intersection preserves acceptance of custom
 *     dimension names registered by plugin-supplied trackers —
 *     fully additive, zero runtime change.
 *   - Invalid dimension names still "work" at runtime (they'll
 *     never match `"unknown"`) and the handler runs as-is; this
 *     mirrors the loose `PredicateContext.walkerState` indexing.
 *   - When `ctx.walkerState` is `undefined` (the tool isn't bash —
 *     `write` / `edit` have no walker invocation), no dimension can
 *     resolve to `"unknown"`, so the wrapper delegates. This keeps
 *     the wrapper a no-op for file-surface rules that happen to use
 *     a bash-leaning predicate through `when.condition`.
 *   - The wrapped handler is awaited — the return type is the same
 *     `boolean | Promise<boolean>` union the handler produces. Async
 *     handlers stay async; sync handlers stay sync-ish (the outer
 *     wrapper is async, which the evaluator awaits either way).
 *
 * @example
 *   // A custom predicate that reads the filesystem at ctx.cwd.
 *   const isWorktreeDir: PredicateHandler<boolean> = requireKnownState(
 *     async (args, ctx) => {
 *       const { existsSync } = await import("node:fs");
 *       return existsSync(`${ctx.cwd}/.git`) === args;
 *     },
 *     ["cwd"],
 *   );
 */
export function requireKnownState<A>(
	handler: PredicateHandler<A>,
	dimensions: readonly (BuiltInTrackerDimension | (string & {}))[],
): PredicateHandler<A> {
	return async (args, ctx) => {
		const state = ctx.walkerState;
		if (state !== undefined) {
			for (const dim of dimensions) {
				if (state[dim] === "unknown") return true;
			}
		}
		return handler(args, ctx);
	};
}

/**
 * Shorthand for `requireKnownState(handler, ["cwd"])` — the dominant
 * use case. Gate a predicate handler on the walker having statically
 * resolved the effective cwd; fire (return `true`) when the walker
 * surfaces `"unknown"` instead of running the handler against a
 * stale `ctx.cwd`.
 *
 * @example
 *   export const isClean: PredicateHandler<boolean> = requireKnownCwd(
 *     async (args, ctx) => {
 *       const r = await ctx.exec("git", ["status", "--porcelain"], {
 *         cwd: ctx.cwd,
 *       });
 *       return (r.stdout.trim() === "") === args;
 *     },
 *   );
 */
export const requireKnownCwd = <A>(
	handler: PredicateHandler<A>,
): PredicateHandler<A> => requireKnownState(handler, ["cwd"]);

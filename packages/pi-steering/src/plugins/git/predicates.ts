// SPDX-License-Identifier: MIT
// Part of pi-steering.

/**
 * Predicate handlers for the git plugin.
 *
 * Each handler is a `PredicateHandler<A>` where `A` is the
 * plugin-author-facing argument shape the rule passes under the
 * matching `when.<key>` slot. See each handler's JSDoc for the
 * accepted shape and worked examples.
 *
 * Evaluation strategy:
 *
 *   - `branch`           - read `ctx.walkerState.branch` first (set by
 *                           the branch tracker on in-chain checkouts).
 *                           If the tracker resolved statically, use
 *                           that value. If the tracker reports
 *                           `"unknown"` (dynamic checkout like
 *                           `git checkout $VAR` that the walker
 *                           couldn't resolve), apply `onUnknown`
 *                           policy without falling back to `exec` -
 *                           a `git branch --show-current` call would
 *                           return the PRE-checkout branch and
 *                           silently defeat the walker. If no
 *                           tracker state exists (no checkout in
 *                           chain), shell out via `git branch
 *                           --show-current`.
 *   - `upstream`         - no tracker today; always shell out via
 *                           `git rev-parse --abbrev-ref @{upstream}`.
 *   - `commitsAhead`     - shell out via `git rev-list --count`.
 *   - `hasStagedChanges` - shell out via `git diff --cached --quiet`.
 *   - `isClean`          - shell out via `git status --porcelain`.
 *   - `remote`           - shell out via `git config --get
 *                           remote.origin.url`.
 *
 * `ctx.exec` is memoized per `(cmd, args, cwd)` within one tool_call
 * (see the evaluator's `createExecCache`) so multiple rules reading
 * the same git state don't re-fork git.
 *
 * `onUnknown` policy for string-valued predicates (`branch`,
 * `upstream`, `remote`): fail-closed by default. When the underlying
 * query fails (not a repo, no upstream configured, ...), the predicate
 * reports "match" so the rule fires. Rule authors opt into the
 * "allow-through" behavior explicitly by passing
 * `{ pattern, onUnknown: "allow" }`.
 */

import type {
	Pattern,
	PredicateContext,
	PredicateHandler,
} from "../../schema.ts";
import { NO_CHECKOUT_IN_CHAIN } from "./branch-tracker.ts";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Normalize the two shorthand forms accepted by string-valued
 * predicates:
 *
 *   - `Pattern`                              -> `{ pattern, onUnknown: "block" }`
 *   - `{ pattern, onUnknown? }`              -> object used as-is,
 *                                                `onUnknown` defaults
 *                                                to `"block"`.
 *
 * Returning `null` means the author supplied something that isn't a
 * valid value for this predicate (e.g. a bare number); handlers treat
 * that as a non-match and don't throw - invalid config shouldn't
 * crash the evaluator, but it also shouldn't silently fire.
 */
function unwrapPatternArg(value: unknown): {
	pattern: Pattern;
	onUnknown: "allow" | "block";
} | null {
	if (typeof value === "string" || value instanceof RegExp) {
		return { pattern: value, onUnknown: "block" };
	}
	if (
		value !== null &&
		typeof value === "object" &&
		"pattern" in (value as Record<string, unknown>)
	) {
		const obj = value as {
			pattern?: unknown;
			onUnknown?: "allow" | "block";
		};
		if (typeof obj.pattern === "string" || obj.pattern instanceof RegExp) {
			return {
				pattern: obj.pattern,
				onUnknown: obj.onUnknown === "allow" ? "allow" : "block",
			};
		}
	}
	return null;
}

/** Test a Pattern against a concrete string. */
function matchPattern(pattern: Pattern, target: string): boolean {
	if (pattern instanceof RegExp) return pattern.test(target);
	return new RegExp(pattern).test(target);
}

/**
 * Apply the predicate's `onUnknown` policy to a shell failure or
 * tracker-unknown case. "block" means the predicate reports "match"
 * (rule fires); "allow" means the predicate reports "no match" (rule
 * skips). Fail-closed default.
 */
function unknownVerdict(onUnknown: "allow" | "block"): boolean {
	return onUnknown === "block";
}

/**
 * Run a shell command and return its trimmed stdout on exit 0, or
 * `null` on any failure (non-zero exit, spawn error, timeout, ...).
 *
 * Callers map `null` to their `onUnknown` policy. A thrown exception
 * inside `ctx.exec` (e.g. the command path couldn't be resolved) is
 * caught and also returned as `null` - predicates should not surface
 * bespoke errors; "I couldn't learn the answer" is uniformly handled
 * via `onUnknown`.
 */
async function tryExec(
	ctx: PredicateContext,
	cmd: string,
	args: readonly string[],
	cwd?: string,
): Promise<string | null> {
	try {
		const res = await ctx.exec(cmd, [...args], cwd !== undefined ? { cwd } : undefined);
		if (res.exitCode !== 0) return null;
		return res.stdout.trim();
	} catch {
		return null;
	}
}

/**
 * Resolved outcome of reading a string tracker value from
 * `ctx.walkerState[key]`. Callers MUST distinguish the three cases:
 *
 *   - `value`   - the tracker resolved the value statically for this
 *                  command ref. Use it directly.
 *   - `unknown` - the tracker observed a write it couldn't resolve
 *                  statically (e.g. `git checkout $VAR`). The walker
 *                  deliberately surfaces this to signal "a change
 *                  happened but I can't name the new value". Falling
 *                  through to `exec` would return the PRE-write
 *                  value and silently defeat the walker's static
 *                  tracking - exactly the case it exists for.
 *                  Callers must apply their `onUnknown` policy.
 *   - `missing` - no tracker modifier fired for this dimension in
 *                  this ref's scope (the walker threaded the
 *                  tracker's initial sentinel, or `walkerState` has
 *                  no key for this tracker at all). `exec` fallback
 *                  is correct here: the shell's current state is the
 *                  value the predicate wants.
 *
 * The three-way split requires cooperation from the tracker: its
 * `initial` value must be distinct from its `unknown` sentinel, so
 * the predicate can tell "no modifier fired" apart from "modifier
 * fired and couldn't resolve". `branchTracker` does this via
 * {@link NO_CHECKOUT_IN_CHAIN}. A tracker that reuses `"unknown"`
 * for both initial and unknown would collapse these two cases -
 * preserved here as `missing` for backward compatibility (the
 * predicate then behaves as it did pre-U1, shelling out on any
 * unknown).
 */
type WalkerStringResult =
	| { kind: "value"; value: string }
	| { kind: "unknown" }
	| { kind: "missing" };

/**
 * Resolve a string tracker value from `ctx.walkerState[key]` into a
 * three-state discriminated result. See {@link WalkerStringResult}
 * for why callers must not conflate `unknown` with `missing`.
 *
 * `initialSentinel` is the tracker's initial value (distinct from
 * its `unknown` sentinel). When `walkerState[key]` equals this
 * sentinel, the result is `missing` - no modifier fired for this
 * dimension in this ref's scope.
 */
function walkerString(
	ctx: PredicateContext,
	key: string,
	initialSentinel: string,
): WalkerStringResult {
	const v = ctx.walkerState?.[key];
	if (typeof v !== "string") return { kind: "missing" };
	if (v === initialSentinel) return { kind: "missing" };
	if (v === "unknown") return { kind: "unknown" };
	return { kind: "value", value: v };
}

// ---------------------------------------------------------------------------
// branch
// ---------------------------------------------------------------------------

/**
 * `when.branch` - match the current git branch.
 *
 * Accepted arg shapes:
 *
 *   ```ts
 *   when: { branch: /^main$/ }
 *   when: { branch: "^feat-" }
 *   when: { branch: { pattern: /^main$/, onUnknown: "allow" } }
 *   ```
 *
 * Resolution order:
 *   1. `ctx.walkerState.branch` - set by the branch tracker when the
 *       current bash chain contains `git checkout` / `git switch`.
 *       Three outcomes:
 *         - value resolved statically (e.g. `git checkout main`) ->
 *           match the pattern against it.
 *         - `"unknown"` sentinel (dynamic checkout like `git checkout
 *           $VAR`) -> apply `onUnknown` policy. Do NOT fall through
 *           to exec: a `git branch --show-current` call here would
 *           return the PRE-checkout branch (the walker exists to
 *           track exactly this kind of in-chain change statically).
 *         - missing (no checkout in chain) -> fall through to exec.
 *   2. `git branch --show-current` in `ctx.cwd`. Empty stdout is
 *       treated as "no branch" (detached HEAD) - the predicate falls
 *       back to `onUnknown`.
 *
 * `onUnknown` default is `"block"` (fail-closed): if we can't
 * determine the branch, the predicate reports "match" so
 * branch-gated rules still fire.
 */
export const branch: PredicateHandler = async (value, ctx) => {
	const arg = unwrapPatternArg(value);
	if (arg === null) return false;

	// 1. Walker state (tracker-resolved mid-command).
	const fromWalker = walkerString(ctx, "branch", NO_CHECKOUT_IN_CHAIN);
	if (fromWalker.kind === "value") {
		return matchPattern(arg.pattern, fromWalker.value);
	}
	if (fromWalker.kind === "unknown") {
		// Dynamic in-chain checkout. Exec would return the PRE-checkout
		// branch, which is the case the walker exists to catch. Apply
		// the predicate's `onUnknown` policy instead of falling through.
		return unknownVerdict(arg.onUnknown);
	}

	// 2. Shell out (tracker saw no in-chain checkout).
	const out = await tryExec(ctx, "git", ["branch", "--show-current"], ctx.cwd);
	if (out === null || out.length === 0) return unknownVerdict(arg.onUnknown);
	return matchPattern(arg.pattern, out);
};

// ---------------------------------------------------------------------------
// upstream
// ---------------------------------------------------------------------------

/**
 * `when.upstream` - match the current branch's configured upstream.
 *
 * Accepted arg shapes: same as {@link branch}.
 *
 * Resolves via `git rev-parse --abbrev-ref @{upstream}`. A branch
 * without an upstream set returns a non-zero exit; the predicate then
 * applies `onUnknown`.
 *
 * No tracker today - upstream configuration isn't changed by in-chain
 * git commands at a rate that justifies modelling it (and `git push
 * -u origin main` changes it but only AFTER the push succeeds, which
 * is past the point where a pre-execution guard would act). The
 * per-tool_call exec cache ensures multiple upstream-gated rules share
 * one git call.
 */
export const upstream: PredicateHandler = async (value, ctx) => {
	const arg = unwrapPatternArg(value);
	if (arg === null) return false;

	const out = await tryExec(
		ctx,
		"git",
		["rev-parse", "--abbrev-ref", "@{upstream}"],
		ctx.cwd,
	);
	if (out === null || out.length === 0) return unknownVerdict(arg.onUnknown);
	return matchPattern(arg.pattern, out);
};

// ---------------------------------------------------------------------------
// commitsAhead
// ---------------------------------------------------------------------------

/**
 * Argument shape for {@link commitsAhead}.
 *
 * ```ts
 * when: { commitsAhead: { eq: 1 } }                    // exactly one ahead
 * when: { commitsAhead: { gt: 0 } }                    // at least one
 * when: { commitsAhead: { lt: 5 } }                    // fewer than five
 * when: { commitsAhead: { gt: 0, lt: 5 } }             // 1..4
 * when: { commitsAhead: { wrt: "origin/main", eq: 1 } }
 * ```
 *
 * At least one of `eq` / `gt` / `lt` MUST be specified. All provided
 * comparisons must pass (AND). `wrt` is the git revision expression
 * to count commits behind (`git rev-list --count WRT..HEAD`); it
 * defaults to `@{upstream}`.
 */
export interface CommitsAheadArgs {
	/** Git revision to count commits ahead of. Defaults to `@{upstream}`. */
	wrt?: string;
	/** Exact equality: `count === eq`. */
	eq?: number;
	/** Strict greater-than: `count > gt`. */
	gt?: number;
	/** Strict less-than: `count < lt`. */
	lt?: number;
}

/**
 * `when.commitsAhead` - match when commits-ahead-of-WRT satisfy every
 * supplied comparator.
 *
 * Returns `false` (rule doesn't fire) when:
 *   - the arg shape isn't an object with at least one of `eq` / `gt`
 *     / `lt`,
 *   - the `git rev-list` call fails,
 *   - the comparator chain doesn't match.
 *
 * No `onUnknown` here: commits-ahead is a numeric comparator, not a
 * pattern match, and "I couldn't learn the answer" arguably shouldn't
 * fire a rule that's gated on a specific count. Authors who want the
 * fail-closed behavior can layer `{ upstream: "..." }` first in the
 * same `when` (AND semantics via the ADR's plugin predicates) - that
 * handles the "no upstream" case with explicit `onUnknown`.
 */
export const commitsAhead: PredicateHandler<CommitsAheadArgs> = async (
	args,
	ctx,
) => {
	if (args === null || typeof args !== "object") return false;
	const { wrt = "@{upstream}", eq, gt, lt } = args;
	if (eq === undefined && gt === undefined && lt === undefined) {
		return false;
	}

	const out = await tryExec(
		ctx,
		"git",
		["rev-list", "--count", `${wrt}..HEAD`],
		ctx.cwd,
	);
	if (out === null) return false;
	const count = Number.parseInt(out, 10);
	if (!Number.isFinite(count)) return false;

	if (eq !== undefined && count !== eq) return false;
	if (gt !== undefined && !(count > gt)) return false;
	if (lt !== undefined && !(count < lt)) return false;
	return true;
};

// ---------------------------------------------------------------------------
// hasStagedChanges
// ---------------------------------------------------------------------------

/**
 * `when.hasStagedChanges` - match on the presence / absence of staged
 * changes in the repo at `ctx.cwd`.
 *
 *   - `when: { hasStagedChanges: true }`  - fires when there ARE staged
 *     changes.
 *   - `when: { hasStagedChanges: false }` - fires when there are NOT.
 *
 * Uses `git diff --cached --quiet`: exit 0 = no staged changes, exit
 * 1 = staged changes exist. On any other exit / spawn failure, we
 * conservatively report `false` - the caller can AND this with an
 * `upstream` check if fail-closed behavior is needed.
 */
export const hasStagedChanges: PredicateHandler<boolean> = async (
	args,
	ctx,
) => {
	if (typeof args !== "boolean") return false;
	let exitCode: number | null = null;
	try {
		const res = await ctx.exec(
			"git",
			["diff", "--cached", "--quiet"],
			{ cwd: ctx.cwd },
		);
		exitCode = res.exitCode;
	} catch {
		return false;
	}
	if (exitCode === 0) return args === false; // no staged changes
	if (exitCode === 1) return args === true; //   staged changes present
	return false; // unexpected - don't fire
};

// ---------------------------------------------------------------------------
// isClean
// ---------------------------------------------------------------------------

/**
 * `when.isClean` - match on the working tree's cleanliness at
 * `ctx.cwd`.
 *
 *   - `when: { isClean: true }`  - fires when the working tree is
 *     clean (no unstaged, no untracked, no staged changes).
 *   - `when: { isClean: false }` - fires when the working tree is
 *     dirty.
 *
 * Uses `git status --porcelain`: empty stdout = clean. Non-zero exit
 * returns `false` (unknown); pair with an `upstream` check for
 * fail-closed behavior.
 */
export const isClean: PredicateHandler<boolean> = async (args, ctx) => {
	if (typeof args !== "boolean") return false;
	const out = await tryExec(ctx, "git", ["status", "--porcelain"], ctx.cwd);
	if (out === null) return false;
	const clean = out.length === 0;
	return args === clean;
};

// ---------------------------------------------------------------------------
// remote
// ---------------------------------------------------------------------------

/**
 * `when.remote` - match the repo's `origin` remote URL.
 *
 * Accepted arg shapes: same as {@link branch}. Useful for rules that
 * should only fire in specific repos ("never force-push to
 * github.com/org/prod").
 *
 * Resolves via `git config --get remote.origin.url`. Non-zero exit
 * (no origin configured) falls back to `onUnknown`.
 */
export const remote: PredicateHandler = async (value, ctx) => {
	const arg = unwrapPatternArg(value);
	if (arg === null) return false;

	const out = await tryExec(
		ctx,
		"git",
		["config", "--get", "remote.origin.url"],
		ctx.cwd,
	);
	if (out === null || out.length === 0) return unknownVerdict(arg.onUnknown);
	return matchPattern(arg.pattern, out);
};

// ---------------------------------------------------------------------------
// Plugin-level export
// ---------------------------------------------------------------------------

/**
 * Bundle of predicate handlers the git plugin registers under
 * `Plugin.predicates`. Keys become the `when.<key>` slots rule authors
 * see.
 */
export const predicates: Record<string, PredicateHandler> = {
	branch,
	upstream,
	commitsAhead: commitsAhead as PredicateHandler,
	hasStagedChanges: hasStagedChanges as PredicateHandler,
	isClean: isClean as PredicateHandler,
	remote,
};

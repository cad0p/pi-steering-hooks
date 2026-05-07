// SPDX-License-Identifier: MIT
// Part of @cad0p/pi-steering-hooks.

/**
 * End-to-end integration tests for the git plugin.
 *
 * These are the most valuable tests in Phase 4: they exercise the
 * full wire-up from plugin registration through `resolvePlugins`,
 * `buildEvaluator`, walker tracker composition, predicate dispatch,
 * and override handling. Unit tests pin individual pieces; this
 * suite pins that the pieces fit together.
 *
 * Scenarios covered:
 *
 *   1. Plugin resolution - predicates, rules, trackers, and
 *      trackerExtensions land in the resolved state.
 *   2. `DEFAULT_RULES` still block basic force-push regardless of the
 *      plugin (sanity: plugin wiring hasn't broken the core).
 *   3. Branch predicate against a fake git `exec` - fires on main,
 *      allows on feature.
 *   4. `-C /other` cwd extension doesn't accidentally bypass the rule.
 *   5. The WALKER-DRIVEN branch case: `git checkout main && git
 *      commit` - the branch tracker folds the checkout into the
 *      commit's state, so `no-main-commit` fires on the commit even
 *      though `exec` would see whatever the fake session is on.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type {
	BashToolCallEvent,
	ExecResult as PiExecResult,
} from "@mariozechner/pi-coding-agent";
import {
	makeCtx,
	makeTrackedHost,
} from "../../v2/__test-helpers__.ts";
import { DEFAULT_RULES } from "../../v2/defaults.ts";
import { buildEvaluator } from "../../v2/evaluator.ts";
import { resolvePlugins } from "../../v2/plugin-merger.ts";
import type { SteeringConfig } from "../../v2/schema.ts";
import gitPlugin from "./index.ts";

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

function bashEvent(command: string): BashToolCallEvent {
	return {
		type: "tool_call",
		toolCallId: "t1",
		toolName: "bash",
		input: { command },
	};
}

/**
 * Build an evaluator that mirrors the realistic wiring: defaults +
 * the git plugin + any extra user rules. Uses `makeTrackedHost` for
 * a controllable `exec` stub.
 */
function buildRuntime(
	config: SteeringConfig,
	execStub?: (cmd: string, args: string[]) => Promise<PiExecResult>,
) {
	const host = makeTrackedHost({
		exec: async (cmd, args) => {
			if (execStub) return execStub(cmd, args);
			return { stdout: "", stderr: "", code: 1, killed: false };
		},
	});
	const plugins = config.plugins ?? [];
	// Pass `["cwd"]` as the known built-in tracker name so the git
	// plugin's cwd extension (`--git-dir=` / `--work-tree=`) doesn't
	// trigger an orphan warning and is preserved for the evaluator to
	// compose onto the built-in `cwdTracker`. The pi extension runtime
	// (`src/index.ts`) passes the same list.
	const resolved = resolvePlugins(plugins, config, ["cwd"]);
	const evaluator = buildEvaluator(
		{ ...config, rules: config.rules ?? [...DEFAULT_RULES] },
		resolved,
		host,
	);
	return { evaluator, host, resolved };
}

/** Stub exec that reports a given branch name for `git branch --show-current`. */
function branchExec(name: string) {
	return async (cmd: string, args: string[]): Promise<PiExecResult> => {
		if (
			cmd === "git" &&
			args[0] === "branch" &&
			args[1] === "--show-current"
		) {
			return { stdout: `${name}\n`, stderr: "", code: 0, killed: false };
		}
		return { stdout: "", stderr: "", code: 1, killed: false };
	};
}

// ---------------------------------------------------------------------------
// 1. Plugin resolution
// ---------------------------------------------------------------------------

describe("git plugin: registration + resolution", () => {
	it("resolvePlugins surfaces all four plugin surfaces", () => {
		const resolved = resolvePlugins([gitPlugin], {}, ["cwd"]);
		// Predicates registered.
		assert.ok("branch" in resolved.predicates);
		assert.ok("upstream" in resolved.predicates);
		assert.ok("commitsAhead" in resolved.predicates);
		assert.ok("hasStagedChanges" in resolved.predicates);
		assert.ok("isClean" in resolved.predicates);
		assert.ok("remote" in resolved.predicates);
		// Rules registered.
		assert.ok(resolved.rules.some((r) => r.name === "no-main-commit"));
		// Branch tracker registered.
		assert.ok("branch" in resolved.trackers);
		// Cwd extension captured: when the caller declares `"cwd"` as a
		// known built-in tracker name, the merger keeps the extension in
		// `trackerModifiers` (rather than dropping it as orphan) so the
		// evaluator can compose it onto the built-in cwdTracker.
		assert.ok("cwd" in resolved.trackerModifiers);
		assert.ok(resolved.trackerModifiers["cwd"]?.["git"] !== undefined);
	});

	it("without the knownBuiltinTrackers hint, cwd extension falls through with an orphan warning", () => {
		// Callers that DON'T declare cwd as a built-in see an orphan
		// warning + the extension is dropped. Pin this behavior so the
		// semantic doesn't silently drift: the merger trusts the caller's
		// declaration, not implicit knowledge of built-in trackers.
		const resolved = resolvePlugins([gitPlugin], {});
		assert.ok(
			resolved.warnings.some((w) => w.kind === "extension-orphan"),
			"expected orphan warning when cwd isn't declared as built-in",
		);
		assert.ok(
			!("cwd" in resolved.trackerModifiers),
			"expected the cwd extension to be dropped",
		);
	});
});

// ---------------------------------------------------------------------------
// 2. DEFAULT_RULES still work with the plugin loaded
// ---------------------------------------------------------------------------

describe("git plugin: does not break DEFAULT_RULES", () => {
	it("`git push --force` still blocks via no-force-push", async () => {
		const { evaluator } = buildRuntime({ plugins: [gitPlugin] });
		const res = await evaluator.evaluate(
			bashEvent("git push --force origin main"),
			makeCtx("/repo"),
			0,
		);
		assert.ok(res && res.block === true);
		assert.match(res.reason!, /\[steering:no-force-push\]/);
	});
});

// ---------------------------------------------------------------------------
// 3. Branch predicate via fake exec
// ---------------------------------------------------------------------------

describe("git plugin: no-main-commit via branch predicate", () => {
	it("fires on main", async () => {
		const { evaluator } = buildRuntime(
			{
				plugins: [gitPlugin],
				rules: [], // only plugin-shipped rules, no DEFAULT_RULES to confuse
			},
			branchExec("main"),
		);
		const res = await evaluator.evaluate(
			bashEvent("git commit -m 'x'"),
			makeCtx("/repo"),
			0,
		);
		assert.ok(res && res.block === true);
		assert.match(res.reason!, /\[steering:no-main-commit\]/);
	});

	it("allows on feature", async () => {
		const { evaluator } = buildRuntime(
			{ plugins: [gitPlugin], rules: [] },
			branchExec("feature-x"),
		);
		const res = await evaluator.evaluate(
			bashEvent("git commit -m 'x'"),
			makeCtx("/repo"),
			0,
		);
		assert.equal(res, undefined);
	});
});

// ---------------------------------------------------------------------------
// 4. `-C /other` doesn't bypass the rule
// ---------------------------------------------------------------------------

describe("git plugin: -C routing does not bypass no-main-commit", () => {
	it("`git -C /other commit` still evaluates branch and fires on main", async () => {
		// Stub reports main regardless of cwd - the predicate queries
		// git at `ctx.cwd`, which for the `-C /other` ref is `/other`
		// (walker cwd). Either way the stubbed branch is main.
		const { evaluator } = buildRuntime(
			{ plugins: [gitPlugin], rules: [] },
			branchExec("main"),
		);
		const res = await evaluator.evaluate(
			bashEvent("git -C /other commit -m 'x'"),
			makeCtx("/repo"),
			0,
		);
		assert.ok(res && res.block === true);
	});

	it("when.branch doesn't fire if predicate resolves non-main", async () => {
		// Pair of the above: `-C /other commit` with exec reporting
		// feature -> allow. Pins that branch predicate reads the stub
		// every tool_call (not cached from a previous call).
		const { evaluator } = buildRuntime(
			{ plugins: [gitPlugin], rules: [] },
			branchExec("feature"),
		);
		const res = await evaluator.evaluate(
			bashEvent("git -C /other commit -m 'x'"),
			makeCtx("/repo"),
			0,
		);
		assert.equal(res, undefined);
	});

	it("`git --git-dir=/other commit` forwards effective cwd through to the branch predicate", async () => {
		// This pins the cwd-tracker-extension wire-up end-to-end: the
		// `--git-dir=/other` flag is parsed by the plugin's cwd extension,
		// producing walker cwd `/other` for that command ref. The branch
		// predicate then runs `git branch --show-current` with `cwd:
		// "/other"`. We assert that cwd on the exec call to pin the
		// extension reached the evaluator (via the `knownBuiltinTrackers`
		// hint and the evaluator's `composeBuiltinCwd` helper).
		const { evaluator, host } = buildRuntime(
			{ plugins: [gitPlugin], rules: [] },
			branchExec("main"),
		);
		await evaluator.evaluate(
			bashEvent("git --git-dir=/other commit -m 'x'"),
			makeCtx("/repo"),
			0,
		);
		const branchCall = host.execCalls.find(
			(c) =>
				c.cmd === "git" &&
				c.args[0] === "branch" &&
				c.args[1] === "--show-current",
		);
		assert.ok(
			branchCall !== undefined,
			"expected a `git branch --show-current` call",
		);
		assert.equal(
			branchCall.cwd,
			"/other",
			"branch predicate should run in the cwd produced by the --git-dir= extension",
		);
	});
});

// ---------------------------------------------------------------------------
// 5. THE KEY TEST: walker-driven branch state
// ---------------------------------------------------------------------------

describe("git plugin: walker-driven branch state (the KEY test)", () => {
	it("`git checkout main && git commit` - the second command is evaluated on branch=main", async () => {
		// The fake session "current branch" is `feature-x` - a
		// naive session-state predicate would see that and let the
		// commit through. The branch TRACKER folds the in-chain
		// `git checkout main` into the walker state seen by the
		// second ref (`git commit`), so `no-main-commit` fires.
		//
		// The predicate prefers `ctx.walkerState.branch` over a shell
		// call; the walker-resolved `main` wins over the stubbed
		// `feature-x`. The `exec` stub is effectively unreachable
		// here - if the predicate ever shelled out for this case it
		// would incorrectly allow.
		const { evaluator, host } = buildRuntime(
			{ plugins: [gitPlugin], rules: [] },
			branchExec("feature-x"),
		);
		const res = await evaluator.evaluate(
			bashEvent("git checkout main && git commit -m 'x'"),
			makeCtx("/repo"),
			0,
		);
		assert.ok(res && res.block === true);
		assert.match(res.reason!, /\[steering:no-main-commit\]/);
		// Regression guard: the branch predicate MUST NOT shell out
		// when the walker already provided a concrete branch value.
		assert.equal(
			host.execCalls.filter(
				(c) =>
					c.cmd === "git" &&
					c.args[0] === "branch" &&
					c.args[1] === "--show-current",
			).length,
			0,
			"branch predicate must read walkerState, not shell out",
		);
	});

	it("`git checkout feature && git commit` - evaluated on branch=feature, allows", async () => {
		// Pair test: walker folds the checkout in, lands on feature,
		// rule skips. Exec stub would say `main` here - again
		// walker-state wins.
		const { evaluator } = buildRuntime(
			{ plugins: [gitPlugin], rules: [] },
			branchExec("main"),
		);
		const res = await evaluator.evaluate(
			bashEvent("git checkout feature && git commit -m 'x'"),
			makeCtx("/repo"),
			0,
		);
		assert.equal(res, undefined);
	});

	it("checkout in a subshell does NOT escape - outer `git commit` allowed on feature", async () => {
		// `(git checkout main)` is subshell-isolated; the outer
		// `git commit` inherits the pre-subshell branch state.
		// Walker says `unknown` (no initial branch seeded; tracker's
		// initial value), so the predicate falls back to exec which
		// reports `feature`. Rule doesn't fire.
		const { evaluator } = buildRuntime(
			{ plugins: [gitPlugin], rules: [] },
			branchExec("feature"),
		);
		const res = await evaluator.evaluate(
			bashEvent("(git checkout main) && git commit -m 'x'"),
			makeCtx("/repo"),
			0,
		);
		assert.equal(res, undefined);
	});

	it("`git checkout $VAR && git commit` - walker unknown + fail-closed fires no-main-commit", async () => {
		// When $VAR is not statically resolvable, the branch tracker
		// collapses to "unknown". The branch predicate's
		// onUnknown:"block" default makes the rule fire even though
		// git's exec fallback (if it ran) would report the starting
		// branch. This is the fail-closed enforcement the ADR's
		// walker+predicate story promises at the rule level.
		//
		// NB: today the predicate treats walker "unknown" as "absent"
		// and DOES fall back to exec (see the sibling unit test for
		// that); the stub here deliberately makes exec FAIL so the
		// fail-closed policy is what produces the fire. Wiring a
		// direct walker-unknown -> onUnknown=block short-circuit is
		// tracked as a follow-up (ADR Phase 5).
		const { evaluator } = buildRuntime(
			{ plugins: [gitPlugin], rules: [] },
			// exec fails -> onUnknown:"block" default fires the rule.
			async () => ({ stdout: "", stderr: "", code: 128, killed: false }),
		);
		const res = await evaluator.evaluate(
			bashEvent("git checkout $VAR && git commit -m 'x'"),
			makeCtx("/repo"),
			0,
		);
		assert.ok(
			res && res.block === true,
			"unresolvable branch must fail-closed and fire no-main-commit",
		);
	});
});

// SPDX-License-Identifier: MIT
// Part of pi-steering.

/**
 * Tests for the git plugin's predicate handlers (`./predicates.ts`).
 *
 * Each handler is tested in isolation with a mock `PredicateContext`
 * whose `exec` records every invocation and returns a stubbed
 * `ExecResult`. This pins the shell-command shape each predicate
 * emits AND the branching logic without spawning real git. Walker-
 * state interactions for `branch` are covered here (the tracker's own
 * modifier semantics live in `./branch-tracker.test.ts`).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type {
	ExecResult,
	PredicateContext,
	WhenWalkerState,
} from "../../index.ts";
import {
	branch,
	commitsAhead,
	hasStagedChanges,
	isClean,
	remote,
	upstream,
	walkerString,
} from "./predicates.ts";

// ---------------------------------------------------------------------------
// Context builder
// ---------------------------------------------------------------------------

interface ExecCall {
	cmd: string;
	args: string[];
	cwd?: string | undefined;
}

/**
 * Minimal `PredicateContext` stub for predicate unit tests.
 *
 * `exec` dispatches on the FIRST matching key in `responses` (the
 * table is consulted top-to-bottom), letting tests stub different
 * results for different commands. Unmatched calls throw so the test
 * catches accidental shell-out expansions.
 */
function makeCtx(
	responses: ReadonlyArray<{
		match: (cmd: string, args: string[]) => boolean;
		result?: ExecResult;
		throwError?: Error;
	}>,
	opts?: {
		cwd?: string;
		walkerState?: Partial<WhenWalkerState> & Record<string, unknown>;
	},
): { ctx: PredicateContext; execCalls: ExecCall[] } {
	const execCalls: ExecCall[] = [];
	const ctx: PredicateContext = {
		cwd: opts?.cwd ?? "/repo",
		tool: "bash",
		input: { tool: "bash", command: "" },
		agentLoopIndex: 0,
		exec: async (cmd, args, execOpts) => {
			execCalls.push({ cmd, args: [...args], cwd: execOpts?.cwd });
			for (const entry of responses) {
				if (entry.match(cmd, args)) {
					if (entry.throwError) throw entry.throwError;
					if (entry.result) return entry.result;
				}
			}
			throw new Error(
				`unexpected exec call: ${cmd} ${args.join(" ")}`,
			);
		},
		appendEntry: () => {},
		findEntries: () => [],
		...(opts?.walkerState !== undefined
			? { walkerState: opts.walkerState as Readonly<WhenWalkerState> }
			: {}),
	};
	return { ctx, execCalls };
}

function execOk(stdout: string): ExecResult {
	return { stdout, stderr: "", exitCode: 0 };
}

function execFail(exitCode: number, stderr = ""): ExecResult {
	return { stdout: "", stderr, exitCode };
}

// ---------------------------------------------------------------------------
// branch
// ---------------------------------------------------------------------------

describe("predicate: branch", () => {
	it("reads ctx.walkerState.branch when set (no exec)", async () => {
		const { ctx, execCalls } = makeCtx([], {
			walkerState: { branch: "main" },
		});
		const matches = await branch(/^main$/, ctx);
		assert.equal(matches, true);
		assert.equal(execCalls.length, 0);
	});

	it("walkerState misses -> falls back to `git branch --show-current`", async () => {
		const { ctx, execCalls } = makeCtx([
			{
				match: (cmd, args) =>
					cmd === "git" && args[0] === "branch" && args[1] === "--show-current",
				result: execOk("feature\n"),
			},
		]);
		const matches = await branch(/^feature$/, ctx);
		assert.equal(matches, true);
		assert.equal(execCalls.length, 1);
		assert.deepEqual(execCalls[0]!.args, ["branch", "--show-current"]);
		assert.equal(execCalls[0]!.cwd, "/repo");
	});

	it("walkerState value `\"unknown\"` (dynamic checkout) short-circuits: default onUnknown=block fires, no exec fallback", async () => {
		// The walker saw something like `git checkout $VAR` - a write
		// happened but the target branch can't be resolved statically.
		// Falling through to `git branch --show-current` would return
		// the PRE-checkout branch and silently defeat the walker's
		// whole purpose. Predicate must apply onUnknown without exec.
		const { ctx, execCalls } = makeCtx([], {
			walkerState: { branch: "unknown" },
		});
		const matches = await branch(/^main$/, ctx);
		assert.equal(matches, true);
		assert.equal(
			execCalls.length,
			0,
			"exec must not be called when walker reports unknown",
		);
	});

	it("walkerState value `\"unknown\"` with onUnknown: \"allow\" - rule skips, still no exec", async () => {
		const { ctx, execCalls } = makeCtx([], {
			walkerState: { branch: "unknown" },
		});
		const matches = await branch(
			{ pattern: /^main$/, onUnknown: "allow" },
			ctx,
		);
		assert.equal(matches, false);
		assert.equal(execCalls.length, 0);
	});

	it("walkerState missing entirely (no in-chain checkout) -> exec fallback", async () => {
		// No `walkerState` on ctx at all: the tracker observed no git
		// checkout in this chain, so the current shell-level branch
		// value IS the predicate's answer. Exec is the right path.
		const { ctx, execCalls } = makeCtx([
			{
				match: (cmd, args) =>
					cmd === "git" && args[0] === "branch" && args[1] === "--show-current",
				result: execOk("trunk\n"),
			},
		]);
		const matches = await branch(/^trunk$/, ctx);
		assert.equal(matches, true);
		assert.equal(execCalls.length, 1);
	});

	it("onUnknown defaults to block - exec failure fires the predicate", async () => {
		// `git branch --show-current` fails (not a repo). Default
		// `onUnknown: "block"` means "the rule fires" - the predicate
		// reports match=true so the surrounding rule does NOT skip.
		const { ctx } = makeCtx([
			{
				match: (cmd, args) => cmd === "git" && args[0] === "branch",
				result: execFail(128, "not a git repository"),
			},
		]);
		const matches = await branch(/^main$/, ctx);
		assert.equal(matches, true);
	});

	it("onUnknown: \"allow\" - exec failure skips the rule", async () => {
		const { ctx } = makeCtx([
			{
				match: (cmd, args) => cmd === "git" && args[0] === "branch",
				result: execFail(128),
			},
		]);
		const matches = await branch(
			{ pattern: /^main$/, onUnknown: "allow" },
			ctx,
		);
		assert.equal(matches, false);
	});

	it("empty stdout (detached HEAD) applies onUnknown", async () => {
		const { ctx } = makeCtx([
			{
				match: (cmd, args) => cmd === "git" && args[0] === "branch",
				result: execOk(""),
			},
		]);
		// Default block -> fires.
		assert.equal(await branch(/^main$/, ctx), true);
		// Explicit allow -> skips.
		const { ctx: ctxAllow } = makeCtx([
			{
				match: (cmd, args) => cmd === "git" && args[0] === "branch",
				result: execOk(""),
			},
		]);
		assert.equal(
			await branch({ pattern: /^main$/, onUnknown: "allow" }, ctxAllow),
			false,
		);
	});

	it("string pattern compiles as regex", async () => {
		const { ctx } = makeCtx([], { walkerState: { branch: "feat-new" } });
		assert.equal(await branch("^feat-", ctx), true);
		assert.equal(await branch("^main$", ctx), false);
	});

	it("invalid arg shape returns false", async () => {
		const { ctx } = makeCtx([], { walkerState: { branch: "main" } });
		// Numeric is not a valid pattern - predicate returns false
		// rather than throwing.
		assert.equal(await branch(42 as unknown, ctx), false);
	});

	it("thrown exec error treated as failure + applies onUnknown", async () => {
		const { ctx } = makeCtx([
			{
				match: (cmd) => cmd === "git",
				throwError: new Error("spawn ENOENT"),
			},
		]);
		// Default block -> fires.
		assert.equal(await branch(/^main$/, ctx), true);
	});
});

// ---------------------------------------------------------------------------
// upstream
// ---------------------------------------------------------------------------

describe("predicate: upstream", () => {
	it("matches when git rev-parse resolves", async () => {
		const { ctx, execCalls } = makeCtx([
			{
				match: (cmd, args) =>
					cmd === "git" &&
					args[0] === "rev-parse" &&
					args[1] === "--abbrev-ref" &&
					args[2] === "@{upstream}",
				result: execOk("origin/main\n"),
			},
		]);
		assert.equal(await upstream(/^origin\/main$/, ctx), true);
		assert.equal(execCalls.length, 1);
	});

	it("no upstream configured (exit != 0) -> onUnknown block (default)", async () => {
		const { ctx } = makeCtx([
			{
				match: (cmd, args) => cmd === "git" && args[0] === "rev-parse",
				result: execFail(128, "no upstream configured"),
			},
		]);
		assert.equal(await upstream(/./, ctx), true);
	});

	it("onUnknown: allow - exec failure skips", async () => {
		const { ctx } = makeCtx([
			{
				match: (cmd, args) => cmd === "git" && args[0] === "rev-parse",
				result: execFail(128),
			},
		]);
		assert.equal(
			await upstream({ pattern: /./, onUnknown: "allow" }, ctx),
			false,
		);
	});

	it("pattern doesn't match stdout -> false (rule skips)", async () => {
		const { ctx } = makeCtx([
			{ match: (cmd) => cmd === "git", result: execOk("origin/feature\n") },
		]);
		assert.equal(await upstream(/^origin\/main$/, ctx), false);
	});
});

// ---------------------------------------------------------------------------
// commitsAhead
// ---------------------------------------------------------------------------

describe("predicate: commitsAhead", () => {
	it("eq matches exact count", async () => {
		const { ctx, execCalls } = makeCtx([
			{
				match: (cmd, args) =>
					cmd === "git" &&
					args[0] === "rev-list" &&
					args[1] === "--count" &&
					args[2] === "@{upstream}..HEAD",
				result: execOk("1\n"),
			},
		]);
		assert.equal(await commitsAhead({ eq: 1 }, ctx), true);
		assert.equal(execCalls.length, 1);
	});

	it("eq misses -> false", async () => {
		const { ctx } = makeCtx([
			{
				match: (cmd, args) => cmd === "git" && args[0] === "rev-list",
				result: execOk("3\n"),
			},
		]);
		assert.equal(await commitsAhead({ eq: 1 }, ctx), false);
	});

	it("gt strict greater-than", async () => {
		const { ctx: ctx1 } = makeCtx([
			{
				match: (cmd) => cmd === "git",
				result: execOk("0\n"),
			},
		]);
		assert.equal(await commitsAhead({ gt: 0 }, ctx1), false);

		const { ctx: ctx2 } = makeCtx([
			{
				match: (cmd) => cmd === "git",
				result: execOk("1\n"),
			},
		]);
		assert.equal(await commitsAhead({ gt: 0 }, ctx2), true);
	});

	it("gt + lt combined - all comparators must pass (AND)", async () => {
		const { ctx: ctx3 } = makeCtx([
			{ match: (cmd) => cmd === "git", result: execOk("3\n") },
		]);
		// 3 > 0 AND 3 < 5 -> true
		assert.equal(await commitsAhead({ gt: 0, lt: 5 }, ctx3), true);

		const { ctx: ctx5 } = makeCtx([
			{ match: (cmd) => cmd === "git", result: execOk("5\n") },
		]);
		// 5 > 0 but 5 < 5 is false -> false
		assert.equal(await commitsAhead({ gt: 0, lt: 5 }, ctx5), false);
	});

	it("custom wrt is forwarded to git rev-list", async () => {
		const { ctx, execCalls } = makeCtx([
			{
				match: (cmd, args) =>
					cmd === "git" &&
					args[0] === "rev-list" &&
					args[2] === "origin/main..HEAD",
				result: execOk("2\n"),
			},
		]);
		assert.equal(
			await commitsAhead({ wrt: "origin/main", eq: 2 }, ctx),
			true,
		);
		assert.equal(execCalls[0]!.args[2], "origin/main..HEAD");
	});

	it("no comparators specified -> false (invalid config)", async () => {
		// Don't register any responses - the predicate must not call
		// exec when the arg shape is invalid.
		const { ctx, execCalls } = makeCtx([]);
		assert.equal(await commitsAhead({}, ctx), false);
		assert.equal(execCalls.length, 0);
	});

	it("exec failure -> false (no upstream configured)", async () => {
		const { ctx } = makeCtx([
			{ match: (cmd) => cmd === "git", result: execFail(128) },
		]);
		assert.equal(await commitsAhead({ eq: 1 }, ctx), false);
	});

	it("non-numeric stdout -> false", async () => {
		const { ctx } = makeCtx([
			{ match: (cmd) => cmd === "git", result: execOk("not-a-number") },
		]);
		assert.equal(await commitsAhead({ eq: 0 }, ctx), false);
	});

	it("null / non-object args -> false", async () => {
		const { ctx } = makeCtx([]);
		assert.equal(
			await commitsAhead(null as unknown as { eq: number }, ctx),
			false,
		);
		assert.equal(
			await commitsAhead(
				"bogus" as unknown as { eq: number },
				ctx,
			),
			false,
		);
	});

	it("lt standalone - strict less-than boundary", async () => {
		const { ctx: ctxAtLimit } = makeCtx([
			{ match: (cmd) => cmd === "git", result: execOk("5\n") },
		]);
		assert.equal(await commitsAhead({ lt: 5 }, ctxAtLimit), false);
		const { ctx: ctxBelow } = makeCtx([
			{ match: (cmd) => cmd === "git", result: execOk("4\n") },
		]);
		assert.equal(await commitsAhead({ lt: 5 }, ctxBelow), true);
	});
});

// ---------------------------------------------------------------------------
// hasStagedChanges
// ---------------------------------------------------------------------------

describe("predicate: hasStagedChanges", () => {
	it("exit 0 (no staged) matches `false`", async () => {
		const { ctx, execCalls } = makeCtx([
			{
				match: (cmd, args) =>
					cmd === "git" &&
					args[0] === "diff" &&
					args[1] === "--cached" &&
					args[2] === "--quiet",
				result: execOk(""),
			},
		]);
		assert.equal(await hasStagedChanges(false, ctx), true);
		assert.equal(await hasStagedChanges(true, ctx), false);
		assert.equal(execCalls.length, 2);
	});

	it("exit 1 (staged) matches `true`", async () => {
		const { ctx } = makeCtx([
			{
				match: (cmd, args) =>
					cmd === "git" && args[0] === "diff",
				result: execFail(1),
			},
		]);
		assert.equal(await hasStagedChanges(true, ctx), true);
	});

	it("unexpected exit code -> false (don't fire)", async () => {
		const { ctx } = makeCtx([
			{ match: (cmd) => cmd === "git", result: execFail(128) },
		]);
		assert.equal(await hasStagedChanges(true, ctx), false);
		const { ctx: ctx2 } = makeCtx([
			{ match: (cmd) => cmd === "git", result: execFail(128) },
		]);
		assert.equal(await hasStagedChanges(false, ctx2), false);
	});

	it("thrown exec -> false", async () => {
		const { ctx } = makeCtx([
			{
				match: (cmd) => cmd === "git",
				throwError: new Error("spawn"),
			},
		]);
		assert.equal(await hasStagedChanges(true, ctx), false);
	});

	it("non-boolean arg -> false", async () => {
		const { ctx } = makeCtx([]);
		assert.equal(
			await hasStagedChanges("yes" as unknown as boolean, ctx),
			false,
		);
	});
});

// ---------------------------------------------------------------------------
// isClean
// ---------------------------------------------------------------------------

describe("predicate: isClean", () => {
	it("empty stdout matches `true` (clean)", async () => {
		const { ctx, execCalls } = makeCtx([
			{
				match: (cmd, args) =>
					cmd === "git" &&
					args[0] === "status" &&
					args[1] === "--porcelain",
				result: execOk(""),
			},
		]);
		assert.equal(await isClean(true, ctx), true);
		assert.equal(execCalls.length, 1);
	});

	it("dirty stdout matches `false`", async () => {
		const { ctx } = makeCtx([
			{
				match: (cmd) => cmd === "git",
				result: execOk(" M src/x.ts\n?? tmp.log\n"),
			},
		]);
		assert.equal(await isClean(false, ctx), true);
		const { ctx: ctx2 } = makeCtx([
			{
				match: (cmd) => cmd === "git",
				result: execOk(" M src/x.ts\n"),
			},
		]);
		assert.equal(await isClean(true, ctx2), false);
	});

	it("exec failure -> false", async () => {
		const { ctx } = makeCtx([
			{ match: (cmd) => cmd === "git", result: execFail(128) },
		]);
		assert.equal(await isClean(true, ctx), false);
	});

	it("non-boolean arg -> false", async () => {
		const { ctx } = makeCtx([]);
		assert.equal(await isClean(1 as unknown as boolean, ctx), false);
	});
});

// ---------------------------------------------------------------------------
// remote
// ---------------------------------------------------------------------------

describe("predicate: remote", () => {
	it("matches origin URL via regex", async () => {
		const { ctx, execCalls } = makeCtx([
			{
				match: (cmd, args) =>
					cmd === "git" &&
					args[0] === "config" &&
					args[1] === "--get" &&
					args[2] === "remote.origin.url",
				result: execOk("git@github.com:org/repo.git\n"),
			},
		]);
		assert.equal(await remote(/github\.com:org\//, ctx), true);
		assert.equal(execCalls.length, 1);
	});

	it("no origin configured -> onUnknown block (default) fires", async () => {
		const { ctx } = makeCtx([
			{
				match: (cmd) => cmd === "git",
				result: execFail(1),
			},
		]);
		assert.equal(await remote(/./, ctx), true);
	});

	it("onUnknown: allow skips on failure", async () => {
		const { ctx } = makeCtx([
			{ match: (cmd) => cmd === "git", result: execFail(1) },
		]);
		assert.equal(
			await remote({ pattern: /./, onUnknown: "allow" }, ctx),
			false,
		);
	});

	it("pattern doesn't match stdout -> false", async () => {
		const { ctx } = makeCtx([
			{
				match: (cmd) => cmd === "git",
				result: execOk("git@github.com:other-org/repo.git\n"),
			},
		]);
		assert.equal(await remote(/my-org\//, ctx), false);
	});

	it("matches https:// origin URL", async () => {
		const { ctx } = makeCtx([
			{
				match: (cmd) => cmd === "git",
				result: execOk("https://github.com/org/repo.git\n"),
			},
		]);
		assert.equal(await remote(/github\.com\/org\//, ctx), true);
	});
});

// ---------------------------------------------------------------------------
// Explicit `onUnknown: "block"` form (pins the default behavior is
// identical to the explicit form)
// ---------------------------------------------------------------------------

describe("predicates: explicit onUnknown:block form", () => {
	it("branch { pattern, onUnknown: \"block\" } behaves like default", async () => {
		const { ctx } = makeCtx([
			{ match: (cmd) => cmd === "git", result: execFail(128) },
		]);
		assert.equal(
			await branch({ pattern: /^main$/, onUnknown: "block" }, ctx),
			true,
		);
	});

	it("upstream { pattern, onUnknown: \"block\" } behaves like default", async () => {
		const { ctx } = makeCtx([
			{ match: (cmd) => cmd === "git", result: execFail(128) },
		]);
		assert.equal(
			await upstream({ pattern: /^origin\/main$/, onUnknown: "block" }, ctx),
			true,
		);
	});

	it("remote { pattern, onUnknown: \"block\" } behaves like default", async () => {
		const { ctx } = makeCtx([
			{ match: (cmd) => cmd === "git", result: execFail(128) },
		]);
		assert.equal(
			await remote({ pattern: /my-org/, onUnknown: "block" }, ctx),
			true,
		);
	});
});

// ---------------------------------------------------------------------------
// walkerString: tracker contract assertion
// ---------------------------------------------------------------------------

describe("walkerString: rejects initialSentinel === \"unknown\"", () => {
	// Future tracker authors MUST NOT pass `"unknown"` as the
	// `initialSentinel` argument: that sentinel is reserved for the
	// dynamic-unresolvable signal, and overloading it collapses the
	// three-way discrimination (value / unknown / missing) back to the
	// pre-U1 two-step bug. The function's JSDoc flagged this; the
	// assertion makes the contract un-foot-shootable.
	it("throws a targeted error when called with initialSentinel === \"unknown\"", () => {
		const { ctx } = makeCtx([]);
		assert.throws(
			() => walkerString(ctx, "branch", "unknown"),
			(err: unknown) => {
				assert.ok(err instanceof Error);
				assert.match(err.message, /initialSentinel cannot be/);
				assert.match(err.message, /"unknown"/);
				return true;
			},
		);
	});
});

// ---------------------------------------------------------------------------
// requireKnownCwd wrap (Item 4 of PR #5 scope expansion)
//
// `isClean`, `hasStagedChanges`, `remote` all call `ctx.exec("git", [...],
// { cwd: ctx.cwd })` at runtime. When the walker's cwd tracker couldn't
// statically resolve the effective cwd (e.g. `cd "$VAR/pkg" && git commit`)
// `ctx.cwd` falls back to the pre-cd ambient cwd — the pi session cwd,
// NOT the intended subpackage. Without a guard the predicate silently
// queries the wrong repo and a gate like `isClean: true` would miss the
// state that matters.
//
// The runtime-cwd predicates are wrapped with `requireKnownCwd` from
// `helpers/require-known-state.ts` so the walker's `"unknown"` sentinel
// short-circuits to "fire" (fail-closed) without running the handler.
// These tests pin that contract: when `ctx.walkerState.cwd === "unknown"`,
// each wrapped predicate fires regardless of what the stubbed exec would
// have returned — in fact exec must not be called at all.
// ---------------------------------------------------------------------------

describe("predicates: requireKnownCwd wrap fires on walker-unknown cwd", () => {
	it("isClean fires without calling exec when walker reports cwd unknown", async () => {
		// Even though the stubbed `git status --porcelain` would return
		// empty stdout (i.e. clean → `isClean: true` would MATCH and
		// `isClean: false` would NOT), the wrapper must short-circuit
		// BEFORE dispatch and fire regardless of the args value.
		const { ctx, execCalls } = makeCtx(
			[
				{
					match: (cmd, args) =>
						cmd === "git" &&
						args[0] === "status" &&
						args[1] === "--porcelain",
					result: execOk(""),
				},
			],
			{ walkerState: { cwd: "unknown" } },
		);
		assert.equal(await isClean(true, ctx), true);
		assert.equal(await isClean(false, ctx), true);
		assert.equal(
			execCalls.length,
			0,
			"exec must not be called when walker reports cwd unknown",
		);
	});

	it("hasStagedChanges fires without calling exec when walker reports cwd unknown", async () => {
		// Stubbed exit 0 would classify as "no staged changes", so
		// `hasStagedChanges: true` would NOT match under the normal
		// code path. The wrap must override that and fire for both
		// boolean args.
		const { ctx, execCalls } = makeCtx(
			[
				{
					match: (cmd, args) =>
						cmd === "git" &&
						args[0] === "diff" &&
						args[1] === "--cached" &&
						args[2] === "--quiet",
					result: execOk(""),
				},
			],
			{ walkerState: { cwd: "unknown" } },
		);
		assert.equal(await hasStagedChanges(true, ctx), true);
		assert.equal(await hasStagedChanges(false, ctx), true);
		assert.equal(execCalls.length, 0);
	});

	it("remote fires without calling exec when walker reports cwd unknown", async () => {
		// Stubbed stdout matches the test pattern under normal
		// dispatch (→ match = true → fire). Without the wrap the rule
		// would also fire, so the test is sharpened by asserting that
		// exec is NOT called even once: the fire verdict must come
		// from the walker short-circuit, not from the stub.
		const { ctx, execCalls } = makeCtx(
			[
				{
					match: (cmd, args) =>
						cmd === "git" &&
						args[0] === "config" &&
						args[1] === "--get" &&
						args[2] === "remote.origin.url",
					result: execOk("git@github.com:org/repo.git\n"),
				},
			],
			{ walkerState: { cwd: "unknown" } },
		);
		assert.equal(await remote(/github\.com:org\//, ctx), true);
		// Also pin the wrap fires even when the pattern would NOT have
		// matched the stubbed stdout — the verdict is walker-driven,
		// not pattern-driven.
		assert.equal(await remote(/never-matches/, ctx), true);
		assert.equal(
			execCalls.length,
			0,
			"exec must not be called when walker reports cwd unknown",
		);
	});

	it("isClean with known cwd still dispatches to the handler (wrap is transparent)", async () => {
		// Counter-pin: with walker cwd resolved, the wrap must NOT
		// interfere — the handler runs and the verdict reflects the
		// git state. Guards against a refactor that over-fires on a
		// walker-known cwd.
		const { ctx, execCalls } = makeCtx(
			[
				{
					match: (cmd, args) =>
						cmd === "git" &&
						args[0] === "status" &&
						args[1] === "--porcelain",
					result: execOk(""),
				},
			],
			{ walkerState: { cwd: "/workplace/pkg" } },
		);
		assert.equal(await isClean(true, ctx), true);
		assert.equal(execCalls.length, 1);
	});

	it("upstream fires without calling exec when walker reports cwd unknown", async () => {
		// Same contract as isClean / hasStagedChanges / remote: the
		// underlying `git rev-parse --abbrev-ref @{upstream}` call runs
		// at `ctx.cwd`. When the walker bails, exec would target the pi
		// session cwd — wrong repo — and a rule with
		// `onUnknown: "allow"` would silently fail-OPEN. Pin that the
		// wrap fires before dispatch.
		const { ctx, execCalls } = makeCtx(
			[
				{
					match: (cmd, args) =>
						cmd === "git" &&
						args[0] === "rev-parse" &&
						args[1] === "--abbrev-ref" &&
						args[2] === "@{upstream}",
					result: execOk("origin/main\n"),
				},
			],
			{ walkerState: { cwd: "unknown" } },
		);
		// Default onUnknown=block: wrap fires regardless of pattern.
		assert.equal(await upstream(/^origin\/main$/, ctx), true);
		// onUnknown="allow" is also overridden by the wrap — the
		// walker-cwd-unknown case is fail-closed at the wrap layer.
		assert.equal(
			await upstream({ pattern: /^origin\/main$/, onUnknown: "allow" }, ctx),
			true,
		);
		assert.equal(
			execCalls.length,
			0,
			"exec must not be called when walker reports cwd unknown",
		);
	});

	it("upstream with known cwd still dispatches to the handler (wrap is transparent)", async () => {
		// Counter-pin: walker cwd resolved → handler runs.
		const { ctx, execCalls } = makeCtx(
			[
				{
					match: (cmd, args) =>
						cmd === "git" &&
						args[0] === "rev-parse" &&
						args[1] === "--abbrev-ref" &&
						args[2] === "@{upstream}",
					result: execOk("origin/main\n"),
				},
			],
			{ walkerState: { cwd: "/workplace/pkg" } },
		);
		assert.equal(await upstream(/^origin\/main$/, ctx), true);
		assert.equal(execCalls.length, 1);
	});

	it("commitsAhead fires without calling exec when walker reports cwd unknown", async () => {
		// commitsAhead has no `onUnknown` knob at all; its exec-
		// failure path returns `false` (rule silently skips). That's
		// exactly the silent fail-OPEN class `requireKnownCwd` exists
		// to close. Pin that the wrap fires ahead of dispatch for
		// every comparator flavor.
		const { ctx, execCalls } = makeCtx(
			[
				{
					match: (cmd, args) =>
						cmd === "git" && args[0] === "rev-list",
					result: execOk("3\n"),
				},
			],
			{ walkerState: { cwd: "unknown" } },
		);
		// Under normal dispatch, `3 === 1` would be false; under the
		// wrap it fires true.
		assert.equal(await commitsAhead({ eq: 1 }, ctx), true);
		// Normal dispatch would fire for `gt: 0`; wrap still returns
		// true without running exec.
		assert.equal(await commitsAhead({ gt: 0 }, ctx), true);
		assert.equal(
			execCalls.length,
			0,
			"exec must not be called when walker reports cwd unknown",
		);
	});

	it("commitsAhead with known cwd still dispatches to the handler (wrap is transparent)", async () => {
		const { ctx, execCalls } = makeCtx(
			[
				{
					match: (cmd, args) =>
						cmd === "git" &&
						args[0] === "rev-list" &&
						args[1] === "--count",
					result: execOk("2\n"),
				},
			],
			{ walkerState: { cwd: "/workplace/pkg" } },
		);
		assert.equal(await commitsAhead({ eq: 2 }, ctx), true);
		assert.equal(execCalls.length, 1);
	});
});

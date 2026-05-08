// SPDX-License-Identifier: MIT
// Part of @cad0p/pi-steering-hooks.

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
} from "../../index.ts";
import {
	branch,
	commitsAhead,
	hasStagedChanges,
	isClean,
	remote,
	upstream,
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
		walkerState?: Record<string, unknown>;
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
			? { walkerState: opts.walkerState }
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

	it("walkerState value `\"unknown\"` triggers exec fallback (tracker sentinel treated as absent)", async () => {
		const { ctx, execCalls } = makeCtx(
			[
				{
					match: (cmd, args) => cmd === "git" && args[0] === "branch",
					result: execOk("trunk\n"),
				},
			],
			{ walkerState: { branch: "unknown" } },
		);
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

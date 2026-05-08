// SPDX-License-Identifier: MIT
// Part of @cad0p/pi-steering-hooks.

/**
 * Tests for the v2 evaluator pipeline (`buildEvaluator`).
 *
 * The suite exercises the full `tool_call`-to-verdict path:
 *
 *   - bash rules (pattern / requires / unless / when.cwd + onUnknown /
 *     when.not / when.condition / plugin predicates / override comments
 *     / noOverride semantics / rule ordering / walker reuse / exec
 *     memoization / findEntries),
 *   - write + edit rules (field=path / field=content, override
 *     detection, `joined newText` behavior),
 *   - evaluator-level guarantees (walker called once per tool_call;
 *     exec cache shared across rules; unknown `when.<key>` surfaces a
 *     clear error).
 *
 * Heavy use of in-memory stubs for `ExtensionContext` +
 * {@link EvaluatorHost} so the tests are hermetic — no child processes,
 * no real pi runtime. Each helper is commented where it deviates from
 * pi's real behavior.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type {
	BashToolCallEvent,
	EditToolCallEvent,
	ToolCallEvent,
	WriteToolCallEvent,
} from "@mariozechner/pi-coding-agent";
import {
	makeCtx,
	makeTrackedHost as makeHost,
} from "./__test-helpers__.ts";
import { buildEvaluator, type EvaluatorHost } from "./evaluator.ts";
import type { ResolvedPluginState } from "./plugin-merger.ts";
import { resolvePlugins } from "./plugin-merger.ts";
import type {
	Observer,
	Plugin,
	PredicateContext,
	PredicateHandler,
	Rule,
	SteeringConfig,
} from "./schema.ts";

// ---------------------------------------------------------------------------
// Event builders
// ---------------------------------------------------------------------------
//
// Event shape helpers stay local to this file — the tool_call and
// tool_result builders in observer-dispatcher.test.ts are genuinely
// different events and don't share a helper surface.

/** Short-hand: build a bash tool_call event with the given command. */
function bashEvent(command: string): BashToolCallEvent {
	return {
		type: "tool_call",
		toolCallId: "t1",
		toolName: "bash",
		input: { command },
	};
}

function writeEvent(path: string, content: string): WriteToolCallEvent {
	return {
		type: "tool_call",
		toolCallId: "t1",
		toolName: "write",
		input: { path, content },
	};
}

function editEvent(
	path: string,
	edits: ReadonlyArray<{ oldText: string; newText: string }>,
): EditToolCallEvent {
	return {
		type: "tool_call",
		toolCallId: "t1",
		toolName: "edit",
		input: { path, edits: [...edits] },
	};
}

/** Resolve plugins with `{}` config so the merger surface is exercised too. */
function resolve(plugins: Plugin[] = []): ResolvedPluginState {
	return resolvePlugins(plugins, {});
}

// ---------------------------------------------------------------------------
// Baseline bash behaviour
// ---------------------------------------------------------------------------

const NO_FORCE_PUSH: Rule = {
	name: "no-force-push",
	tool: "bash",
	field: "command",
	pattern: "\\bgit\\s+push\\b.*--force(?!-with-lease)",
	reason: "no force push",
};

describe("buildEvaluator: bash basics", () => {
	it("fires on a matching command", async () => {
		const evaluator = buildEvaluator(
			{ rules: [NO_FORCE_PUSH] },
			resolve(),
			makeHost(),
		);
		const res = await evaluator.evaluate(
			bashEvent("git push --force"),
			makeCtx("/repo"),
			0,
		);
		assert.ok(res && res.block === true);
		assert.match(res!.reason!, /\[steering:no-force-push\]/);
	});

	it("returns undefined on a non-matching command", async () => {
		const evaluator = buildEvaluator(
			{ rules: [NO_FORCE_PUSH] },
			resolve(),
			makeHost(),
		);
		const res = await evaluator.evaluate(
			bashEvent("ls -la"),
			makeCtx("/repo"),
			0,
		);
		assert.equal(res, undefined);
	});

	it("respects requires (AND logic)", async () => {
		const rule: Rule = { ...NO_FORCE_PUSH, requires: "\\bmain\\b" };
		const evaluator = buildEvaluator({ rules: [rule] }, resolve(), makeHost());
		const fires = await evaluator.evaluate(
			bashEvent("git push --force origin main"),
			makeCtx("/repo"),
			0,
		);
		const skips = await evaluator.evaluate(
			bashEvent("git push --force origin feature"),
			makeCtx("/repo"),
			0,
		);
		assert.ok(fires);
		assert.equal(skips, undefined);
	});

	it("respects unless (exemption)", async () => {
		const rule: Rule = { ...NO_FORCE_PUSH, unless: "--force-with-lease" };
		const evaluator = buildEvaluator({ rules: [rule] }, resolve(), makeHost());
		assert.equal(
			await evaluator.evaluate(
				bashEvent("git push --force-with-lease"),
				makeCtx("/repo"),
				0,
			),
			undefined,
		);
	});

	it("catches wrappers (sh -c '...')", async () => {
		const evaluator = buildEvaluator(
			{ rules: [NO_FORCE_PUSH] },
			resolve(),
			makeHost(),
		);
		const res = await evaluator.evaluate(
			bashEvent("sh -c 'git push --force'"),
			makeCtx("/repo"),
			0,
		);
		assert.ok(res && res.block === true);
	});

	it("accepts RegExp pattern (not just string)", async () => {
		const rule: Rule = {
			...NO_FORCE_PUSH,
			pattern: /\bgit\s+push\b.*--force(?!-with-lease)/,
		};
		const evaluator = buildEvaluator({ rules: [rule] }, resolve(), makeHost());
		const res = await evaluator.evaluate(
			bashEvent("git push --force"),
			makeCtx("/repo"),
			0,
		);
		assert.ok(res && res.block === true);
	});
});

// ---------------------------------------------------------------------------
// requires / unless as PredicateFn
// ---------------------------------------------------------------------------
//
// `requires` and `unless` also accept a PredicateFn (per schema.ts),
// not just a Pattern. The existing bash-basics block only exercises
// the Pattern form. These tests pin the PredicateFn form + verify the
// PredicateContext the fn receives carries the documented fields
// (cwd, tool, input, agentLoopIndex).

describe("buildEvaluator: requires/unless as PredicateFn", () => {
	it("requires: PredicateFn gates the rule and sees a full PredicateContext", async () => {
		const seen: PredicateContext[] = [];
		let shouldPass = true;
		const rule: Rule = {
			name: "req-fn",
			tool: "bash",
			field: "command",
			pattern: "^git\\s+push",
			reason: "req-fn",
			requires: async (ctx) => {
				seen.push(ctx);
				return shouldPass;
			},
		};
		const evaluator = buildEvaluator({ rules: [rule] }, resolve(), makeHost());

		// requires-fn returns true → rule fires.
		shouldPass = true;
		const fires = await evaluator.evaluate(
			bashEvent("git push"),
			makeCtx("/repo"),
			7,
		);
		assert.ok(fires);

		// requires-fn returns false → rule skipped.
		shouldPass = false;
		const skips = await evaluator.evaluate(
			bashEvent("git push"),
			makeCtx("/repo"),
			8,
		);
		assert.equal(skips, undefined);

		// Spy verified: ctx shape is the documented PredicateContext for
		// a bash candidate (cwd = per-ref walker cwd, tool = "bash",
		// input.command = basename+args, agentLoopIndex forwarded verbatim).
		assert.equal(seen.length, 2);
		const ctx = seen[0]!;
		assert.equal(ctx.cwd, "/repo");
		assert.equal(ctx.tool, "bash");
		assert.equal(
			(ctx.input as { tool: "bash"; command: string }).command,
			"git push",
		);
		assert.equal(ctx.agentLoopIndex, 7);
		// Functional-shape sanity: the closures the evaluator injected.
		assert.equal(typeof ctx.exec, "function");
		assert.equal(typeof ctx.findEntries, "function");
		assert.equal(typeof ctx.appendEntry, "function");
		// Second invocation carries the updated agentLoopIndex.
		assert.equal(seen[1]!.agentLoopIndex, 8);
	});

	it("unless: PredicateFn exempts the rule and sees a full PredicateContext", async () => {
		const seen: PredicateContext[] = [];
		let exempt = false;
		const rule: Rule = {
			name: "unl-fn",
			tool: "bash",
			field: "command",
			pattern: "^git\\s+push",
			reason: "unl-fn",
			unless: async (ctx) => {
				seen.push(ctx);
				return exempt;
			},
		};
		const evaluator = buildEvaluator({ rules: [rule] }, resolve(), makeHost());

		// unless-fn returns false → rule NOT exempt → fires.
		exempt = false;
		const fires = await evaluator.evaluate(
			bashEvent("git push"),
			makeCtx("/repo"),
			3,
		);
		assert.ok(fires);

		// unless-fn returns true → rule exempted → skipped.
		exempt = true;
		const skips = await evaluator.evaluate(
			bashEvent("git push"),
			makeCtx("/repo"),
			4,
		);
		assert.equal(skips, undefined);

		assert.equal(seen.length, 2);
		const ctx = seen[0]!;
		assert.equal(ctx.cwd, "/repo");
		assert.equal(ctx.tool, "bash");
		assert.equal(
			(ctx.input as { tool: "bash"; command: string }).command,
			"git push",
		);
		assert.equal(ctx.agentLoopIndex, 3);
		assert.equal(seen[1]!.agentLoopIndex, 4);
	});
});

// ---------------------------------------------------------------------------
// when.cwd + walker + onUnknown
// ---------------------------------------------------------------------------

describe("buildEvaluator: when.cwd", () => {
	it("fires only when per-ref effective cwd matches", async () => {
		const rule: Rule = {
			name: "no-amend-personal",
			tool: "bash",
			field: "command",
			pattern: "\\bgit\\s+commit\\b.*--amend",
			reason: "no amend personal",
			when: { cwd: "/personal/" },
		};
		const evaluator = buildEvaluator({ rules: [rule] }, resolve(), makeHost());
		const fires = await evaluator.evaluate(
			bashEvent("cd /home/me/personal/x && git commit --amend"),
			makeCtx("/work"),
			0,
		);
		const skips = await evaluator.evaluate(
			bashEvent("cd /home/me/work/x && git commit --amend"),
			makeCtx("/work"),
			0,
		);
		assert.ok(fires);
		assert.equal(skips, undefined);
	});

	it("object-form with onUnknown:'block' fires on unresolvable cd target", async () => {
		const rule: Rule = {
			name: "block-unknown-cwd",
			tool: "bash",
			field: "command",
			pattern: "^rm\\b",
			reason: "blocks on unknown cwd",
			when: { cwd: { pattern: "/never-matches/", onUnknown: "block" } },
		};
		const evaluator = buildEvaluator({ rules: [rule] }, resolve(), makeHost());
		// `cd $VAR` today returns the current cwd (Phase-1 exception in
		// cwdTracker). Use a more aggressively non-static form — command
		// substitution — which cwdTracker's `cdModifier` still treats as
		// "not static"; the returned value is the pre-cd cwd in v1 but
		// the test asserts the onUnknown path shouldn't blow up on
		// resolvable paths either.
		//
		// For the *onUnknown* exercise the cleanest surface is plugin
		// predicates (see the plugin-predicate test below). This test
		// documents the observable v1 behaviour: cd $(...) does NOT
		// trigger unknown; cwd stays pre-cd.
		const res = await evaluator.evaluate(
			bashEvent("cd $(pwd) && rm foo"),
			makeCtx("/repo"),
			0,
		);
		// With Phase-1 exception, cwd remains "/repo", which doesn't
		// match "/never-matches/" and doesn't flag as unknown — so the
		// rule doesn't fire. This pins the current behavior and guards
		// against an accidental change of the exception.
		assert.equal(res, undefined);
	});

	it("plugin predicate with onUnknown:'block' fires when handler sees unknown", async () => {
		// Stand in for the future `when.branch` predicate: the plugin
		// handler honors the object form's `onUnknown` policy itself.
		const branchPredicate: PredicateHandler<
			string | { pattern: string; onUnknown?: "allow" | "block" }
		> = (args) => {
			const unwrapped =
				typeof args === "object" &&
				args !== null &&
				"pattern" in (args as Record<string, unknown>)
					? (args as { pattern: string; onUnknown?: "allow" | "block" })
					: { pattern: args as string };
			// Stub: pretend the branch is always "unknown".
			if (unwrapped.onUnknown === "allow") return false;
			// "block" (default) → predicate passes so the rule fires.
			return true;
		};
		const plugin: Plugin = {
			name: "git",
			predicates: { branch: branchPredicate as PredicateHandler },
		};
		const ruleBlock: Rule = {
			name: "no-main-commit",
			tool: "bash",
			field: "command",
			pattern: "^git\\s+commit\\b",
			reason: "no commit on main",
			when: { branch: { pattern: "^main$", onUnknown: "block" } },
		};
		const ruleAllow: Rule = {
			...ruleBlock,
			name: "no-main-commit-allow",
			when: { branch: { pattern: "^main$", onUnknown: "allow" } },
		};

		const evalBlock = buildEvaluator(
			{ rules: [ruleBlock] },
			resolve([plugin]),
			makeHost(),
		);
		const evalAllow = buildEvaluator(
			{ rules: [ruleAllow] },
			resolve([plugin]),
			makeHost(),
		);

		assert.ok(
			await evalBlock.evaluate(bashEvent("git commit -m x"), makeCtx("/r"), 0),
		);
		assert.equal(
			await evalAllow.evaluate(bashEvent("git commit -m x"), makeCtx("/r"), 0),
			undefined,
		);
	});
});

describe("buildEvaluator: when.happened", () => {
	// "Fires when NOT happened." — the mental model is inverted from
	// the rule author's perspective (they say "block cr unless sync
	// has happened"). The engine reads: no entry of the type in the
	// given scope → predicate matches → rule fires (block).
	const sessionEntry = (
		customType: string,
		data: Record<string, unknown>,
		ts = "2026-01-01T00:00:00.000Z",
		id = "e1",
	) => ({
		type: "custom" as const,
		customType,
		data,
		timestamp: ts,
		id,
		parentId: null,
	});

	it("in: 'agent_loop' — fires when no entry for current agent loop", async () => {
		const rule: Rule = {
			name: "cr-needs-sync",
			tool: "bash",
			field: "command",
			pattern: "^cr\\b",
			reason: "sync first",
			when: { happened: { type: "ws-sync-done", in: "agent_loop" } },
		};
		// No entries anywhere → rule fires.
		const evaluator = buildEvaluator({ rules: [rule] }, resolve(), makeHost());
		const fires = await evaluator.evaluate(
			bashEvent("cr --review"),
			makeCtx("/r"),
			5,
		);
		assert.ok(fires);
	});

	it("in: 'agent_loop' — skips when entry's _agentLoopIndex matches ctx", async () => {
		const rule: Rule = {
			name: "cr-needs-sync",
			tool: "bash",
			field: "command",
			pattern: "^cr\\b",
			reason: "sync first",
			when: { happened: { type: "ws-sync-done", in: "agent_loop" } },
		};
		const ctx = makeCtx("/r", [
			sessionEntry("ws-sync-done", { _agentLoopIndex: 5 }),
		]);
		const evaluator = buildEvaluator({ rules: [rule] }, resolve(), makeHost());
		const skips = await evaluator.evaluate(
			bashEvent("cr --review"),
			ctx,
			5,
		);
		assert.equal(skips, undefined);
	});

	it("in: 'agent_loop' — fires when only entries from PRIOR agent loops exist", async () => {
		const rule: Rule = {
			name: "cr-needs-sync",
			tool: "bash",
			field: "command",
			pattern: "^cr\\b",
			reason: "sync first",
			when: { happened: { type: "ws-sync-done", in: "agent_loop" } },
		};
		const ctx = makeCtx("/r", [
			sessionEntry("ws-sync-done", { _agentLoopIndex: 3 }, undefined, "a"),
			sessionEntry("ws-sync-done", { _agentLoopIndex: 4 }, undefined, "b"),
		]);
		const evaluator = buildEvaluator({ rules: [rule] }, resolve(), makeHost());
		const fires = await evaluator.evaluate(
			bashEvent("cr --review"),
			ctx,
			5,
		);
		assert.ok(fires);
	});

	it("in: 'session' — skips whenever ANY entry of type exists", async () => {
		const rule: Rule = {
			name: "once-per-session",
			tool: "bash",
			field: "command",
			pattern: "^cr\\b",
			reason: "once-per-session",
			when: { happened: { type: "welcome-shown", in: "session" } },
		};
		const ctx = makeCtx("/r", [
			sessionEntry("welcome-shown", { _agentLoopIndex: 0 }),
		]);
		const evaluator = buildEvaluator({ rules: [rule] }, resolve(), makeHost());
		const skips = await evaluator.evaluate(
			bashEvent("cr --review"),
			ctx,
			99,
		);
		assert.equal(skips, undefined);
	});

	it("in: 'session' — fires when no entry of type exists", async () => {
		const rule: Rule = {
			name: "once-per-session",
			tool: "bash",
			field: "command",
			pattern: "^cr\\b",
			reason: "once-per-session",
			when: { happened: { type: "welcome-shown", in: "session" } },
		};
		const evaluator = buildEvaluator({ rules: [rule] }, resolve(), makeHost());
		const fires = await evaluator.evaluate(
			bashEvent("cr --review"),
			makeCtx("/r"),
			0,
		);
		assert.ok(fires);
	});

	it("not.happened: inverts — fires when type HAS happened in agent loop", async () => {
		const rule: Rule = {
			name: "no-cr-twice",
			tool: "bash",
			field: "command",
			pattern: "^cr\\b",
			reason: "no-cr-twice",
			when: {
				not: { happened: { type: "cr-attempted", in: "agent_loop" } },
			},
		};
		// Entry tagged with the current agent loop → happened predicate
		// says NOT-happened=false (so happened did happen) → nested clause
		// is false → not flips to true → rule fires.
		const ctx = makeCtx("/r", [
			sessionEntry("cr-attempted", { _agentLoopIndex: 5 }),
		]);
		const evaluator = buildEvaluator({ rules: [rule] }, resolve(), makeHost());
		const fires = await evaluator.evaluate(
			bashEvent("cr --review"),
			ctx,
			5,
		);
		assert.ok(fires);
	});

	it("not.happened: skips — when type has NOT happened in agent loop", async () => {
		const rule: Rule = {
			name: "no-cr-twice",
			tool: "bash",
			field: "command",
			pattern: "^cr\\b",
			reason: "no-cr-twice",
			when: {
				not: { happened: { type: "cr-attempted", in: "agent_loop" } },
			},
		};
		const evaluator = buildEvaluator({ rules: [rule] }, resolve(), makeHost());
		const skips = await evaluator.evaluate(
			bashEvent("cr --review"),
			makeCtx("/r"),
			5,
		);
		assert.equal(skips, undefined);
	});

	it("throws on malformed value", async () => {
		const rule: Rule = {
			name: "bad",
			tool: "bash",
			field: "command",
			pattern: "^cr\\b",
			reason: "bad",
			// @ts-expect-error — deliberately malformed for runtime check
			when: { happened: "not-an-object" },
		};
		const evaluator = buildEvaluator({ rules: [rule] }, resolve(), makeHost());
		await assert.rejects(
			evaluator.evaluate(bashEvent("cr"), makeCtx("/r"), 0),
			/when\.happened expects/,
		);
	});
});

describe("buildEvaluator: when.not + when.condition", () => {
	it("when.not inverts the nested clause", async () => {
		const rule: Rule = {
			name: "push-outside-mainline",
			tool: "bash",
			field: "command",
			pattern: "^git\\s+push",
			reason: "push outside mainline",
			when: { not: { cwd: "/mainline/" } },
		};
		const evaluator = buildEvaluator({ rules: [rule] }, resolve(), makeHost());
		const inMainline = await evaluator.evaluate(
			bashEvent("cd /mainline/x && git push"),
			makeCtx("/repo"),
			0,
		);
		const outside = await evaluator.evaluate(
			bashEvent("cd /feature/x && git push"),
			makeCtx("/repo"),
			0,
		);
		// Inside mainline → inner match → not fails → rule skipped.
		assert.equal(inMainline, undefined);
		// Outside mainline → inner fails → not matches → rule fires.
		assert.ok(outside);
	});

	it("when.condition calls the PredicateFn with ctx", async () => {
		let seenCwd: string | null = null;
		const rule: Rule = {
			name: "cond-rule",
			tool: "bash",
			field: "command",
			pattern: "^git\\s+push",
			reason: "cond",
			when: {
				condition: (ctx) => {
					seenCwd = ctx.cwd;
					return ctx.cwd.includes("/feature/");
				},
			},
		};
		const evaluator = buildEvaluator({ rules: [rule] }, resolve(), makeHost());
		const fires = await evaluator.evaluate(
			bashEvent("cd /feature/x && git push"),
			makeCtx("/home"),
			0,
		);
		assert.ok(fires);
		assert.equal(seenCwd, "/feature/x");

		const skips = await evaluator.evaluate(
			bashEvent("cd /trunk/x && git push"),
			makeCtx("/home"),
			0,
		);
		assert.equal(skips, undefined);
	});
});

// ---------------------------------------------------------------------------
// when multi-key (AND semantics + short-circuit) and when.not multi-key
// ---------------------------------------------------------------------------
//
// The existing when.* tests exercise a single key per clause. These
// pin the two multi-key behaviours {@link evaluateWhen} implements:
// AND semantics across keys at the SAME level (cwd AND condition),
// and nested AND inversion through `not` (NOT of the inner AND).

describe("buildEvaluator: when multi-key AND + short-circuit", () => {
	it("when with multiple keys requires ALL to pass (AND) and short-circuits", async () => {
		let conditionCalls = 0;
		const rule: Rule = {
			name: "multi-key",
			tool: "bash",
			field: "command",
			pattern: "^git\\s+push",
			reason: "multi-key",
			// `cwd` key is declared first: Object.entries iterates in
			// insertion order, so cwd is evaluated before condition. This
			// property is what lets the evaluator short-circuit: when cwd
			// misses, the condition fn is never called.
			when: {
				cwd: "^/feature/",
				condition: () => {
					conditionCalls++;
					return conditionCalls === 1;
				},
			},
		};
		const evaluator = buildEvaluator({ rules: [rule] }, resolve(), makeHost());

		// (a) cwd matches + condition returns true (first call) → fires.
		const firesA = await evaluator.evaluate(
			bashEvent("cd /feature/x && git push"),
			makeCtx("/home"),
			0,
		);
		assert.ok(firesA, "(a) both true → AND passes → rule fires");
		assert.equal(conditionCalls, 1);

		// (b) cwd matches + condition returns false (second call) → skipped.
		const skipsB = await evaluator.evaluate(
			bashEvent("cd /feature/y && git push"),
			makeCtx("/home"),
			0,
		);
		assert.equal(skipsB, undefined, "(b) cond false → AND fails → skipped");
		assert.equal(conditionCalls, 2);

		// (c) cwd doesn't match → evaluator short-circuits BEFORE the
		// condition fn is called; the counter stays at 2.
		const skipsC = await evaluator.evaluate(
			bashEvent("cd /trunk/x && git push"),
			makeCtx("/home"),
			0,
		);
		assert.equal(
			skipsC,
			undefined,
			"(c) cwd miss → AND fails → rule skipped",
		);
		assert.equal(
			conditionCalls,
			2,
			"(c) short-circuit must NOT invoke condition when cwd already failed",
		);
	});

	it("when.not inverts the nested clause: NOT (cwd AND condition)", async () => {
		// Four-cell truth table for NOT (cwd AND condition):
		//   cwd | cond | inner AND | NOT → rule fires?
		//    F  |  F   |    F      |  T  → fires
		//    F  |  T   |    F      |  T  → fires
		//    T  |  F   |    F      |  T  → fires
		//    T  |  T   |    T      |  F  → SKIPPED
		// Only the (T, T) cell should skip; the other three fire.
		let flag = false;
		const rule: Rule = {
			name: "not-multi-key",
			tool: "bash",
			field: "command",
			pattern: "^git\\s+push",
			reason: "not-multi-key",
			when: {
				not: {
					cwd: "^/main$",
					condition: () => flag,
				},
			},
		};
		const evaluator = buildEvaluator({ rules: [rule] }, resolve(), makeHost());

		async function run(cwdPath: string, f: boolean) {
			flag = f;
			return evaluator.evaluate(
				bashEvent(`cd ${cwdPath} && git push`),
				makeCtx("/home"),
				0,
			);
		}

		// (F, F): cwd mismatch + flag false.
		assert.ok(await run("/other", false), "(F,F) → NOT(F)=T → fires");
		// (F, T): cwd mismatch + flag true.
		assert.ok(await run("/other", true), "(F,T) → NOT(F)=T → fires");
		// (T, F): cwd match + flag false.
		assert.ok(await run("/main", false), "(T,F) → NOT(F)=T → fires");
		// (T, T): cwd match + flag true → inner AND is true → NOT flips to
		// false → rule skipped.
		assert.equal(
			await run("/main", true),
			undefined,
			"(T,T) → NOT(T)=F → rule skipped",
		);
	});
});

describe("buildEvaluator: plugin predicates", () => {
	it("dispatches to resolved.predicates[key]", async () => {
		const seenArgs: unknown[] = [];
		const plugin: Plugin = {
			name: "p",
			predicates: {
				commitsAhead: ((args, _ctx) => {
					seenArgs.push(args);
					return true;
				}) as PredicateHandler,
			},
		};
		const rule: Rule = {
			name: "p-rule",
			tool: "bash",
			field: "command",
			pattern: "^git\\s+push",
			reason: "p",
			when: { commitsAhead: { wrt: "origin/main", eq: 1 } },
		};
		const evaluator = buildEvaluator(
			{ rules: [rule] },
			resolve([plugin]),
			makeHost(),
		);
		const res = await evaluator.evaluate(
			bashEvent("git push"),
			makeCtx("/r"),
			0,
		);
		assert.ok(res);
		assert.deepEqual(seenArgs, [{ wrt: "origin/main", eq: 1 }]);
	});

	it("throws a clear error on unknown when.<key>", async () => {
		const rule: Rule = {
			name: "bad-when",
			tool: "bash",
			field: "command",
			pattern: "^git",
			reason: "bad",
			when: { totallyMadeUp: /whatever/ },
		};
		const evaluator = buildEvaluator({ rules: [rule] }, resolve(), makeHost());
		await assert.rejects(
			evaluator.evaluate(bashEvent("git status"), makeCtx("/r"), 0),
			/unknown when\.totallyMadeUp/,
		);
	});
});

// ---------------------------------------------------------------------------
// Rule.onFire side-effect hook
// ---------------------------------------------------------------------------

describe("buildEvaluator: Rule.onFire", () => {
	it("runs when the rule fires and before the block verdict is returned", async () => {
		const host = makeHost();
		const order: string[] = [];
		const rule: Rule = {
			name: "f",
			tool: "bash",
			field: "command",
			pattern: "^echo",
			reason: "f",
			onFire: (ctx) => {
				order.push("onFire");
				ctx.appendEntry("marker", { saw: ctx.cwd });
			},
		};
		const evaluator = buildEvaluator({ rules: [rule] }, resolve(), host);
		const res = await evaluator.evaluate(
			bashEvent("echo hi"),
			makeCtx("/r"),
			3,
		);
		assert.ok(res && res.block === true);
		assert.deepEqual(order, ["onFire"]);
		const marker = host.appended.find((e) => e.type === "marker");
		assert.ok(marker);
		// Auto-tag from item 4 stays in effect: writes inside onFire get
		// the current agentLoopIndex merged in.
		assert.deepEqual(marker.data, { saw: "/r", _agentLoopIndex: 3 });
	});

	it("does NOT run when a predicate (when.cwd) fails", async () => {
		let called = false;
		const rule: Rule = {
			name: "f",
			tool: "bash",
			field: "command",
			pattern: "^git\\s+push",
			reason: "f",
			when: { cwd: "/mainline/" },
			onFire: () => {
				called = true;
			},
		};
		const evaluator = buildEvaluator({ rules: [rule] }, resolve(), makeHost());
		const res = await evaluator.evaluate(
			bashEvent("cd /feature/x && git push"), // cwd = /feature/x, no match
			makeCtx("/repo"),
			0,
		);
		assert.equal(res, undefined);
		assert.equal(called, false);
	});

	it("does NOT run when the rule is overridden (noOverride: false + comment)", async () => {
		let called = false;
		const rule: Rule = {
			name: "f",
			tool: "bash",
			field: "command",
			pattern: "^git\\s+push",
			reason: "f",
			noOverride: false,
			onFire: () => {
				called = true;
			},
		};
		const evaluator = buildEvaluator({ rules: [rule] }, resolve(), makeHost());
		const res = await evaluator.evaluate(
			bashEvent("git push # steering-override: f — need to"),
			makeCtx("/r"),
			0,
		);
		assert.equal(res, undefined);
		assert.equal(called, false);
	});

	it("runs on fail-closed rules that actually block (even with bogus override comment)", async () => {
		// noOverride defaults to true — the override comment is ignored,
		// rule blocks, onFire runs.
		let called = false;
		const rule: Rule = {
			name: "f",
			tool: "bash",
			field: "command",
			pattern: "^git\\s+push",
			reason: "f",
			onFire: () => {
				called = true;
			},
		};
		const evaluator = buildEvaluator({ rules: [rule] }, resolve(), makeHost());
		const res = await evaluator.evaluate(
			bashEvent("git push # steering-override: f — ignored"),
			makeCtx("/r"),
			0,
		);
		assert.ok(res && res.block === true);
		assert.equal(called, true);
	});

	it("awaits async onFire before returning the block verdict", async () => {
		const host = makeHost();
		let awaited = false;
		const rule: Rule = {
			name: "f",
			tool: "bash",
			field: "command",
			pattern: "^echo",
			reason: "f",
			onFire: async (ctx) => {
				await new Promise((r) => setImmediate(r));
				awaited = true;
				ctx.appendEntry("after-await", { ok: true });
			},
		};
		const evaluator = buildEvaluator({ rules: [rule] }, resolve(), host);
		const res = await evaluator.evaluate(
			bashEvent("echo hi"),
			makeCtx("/r"),
			0,
		);
		assert.ok(res && res.block === true);
		assert.equal(awaited, true);
		const after = host.appended.find((e) => e.type === "after-await");
		assert.ok(after);
	});
});

// ---------------------------------------------------------------------------
// Override comments + noOverride
// ---------------------------------------------------------------------------

describe("buildEvaluator: override comments", () => {
	it("consumes override comment, appends audit entry, skips block", async () => {
		const host = makeHost();
		const evaluator = buildEvaluator(
			// defaultNoOverride: false so the rule is overridable by default.
			{ defaultNoOverride: false, rules: [NO_FORCE_PUSH] },
			resolve(),
			host,
		);
		const res = await evaluator.evaluate(
			bashEvent(
				"git push --force # steering-override: no-force-push \u2014 coordinated rewrite",
			),
			makeCtx("/repo"),
			0,
		);
		assert.equal(res, undefined);
		assert.equal(host.appended.length, 1);
		assert.equal(host.appended[0]!.type, "steering-override");
		assert.deepEqual(
			(host.appended[0]!.data as { rule: string; reason: string }).rule,
			"no-force-push",
		);
		assert.equal(
			(host.appended[0]!.data as { reason: string }).reason,
			"coordinated rewrite",
		);
	});

	it("rule.noOverride:true blocks even with override comment", async () => {
		const host = makeHost();
		const rule: Rule = { ...NO_FORCE_PUSH, noOverride: true };
		const evaluator = buildEvaluator(
			{ defaultNoOverride: false, rules: [rule] },
			resolve(),
			host,
		);
		const res = await evaluator.evaluate(
			bashEvent(
				"git push --force # steering-override: no-force-push \u2014 I promise",
			),
			makeCtx("/repo"),
			0,
		);
		assert.ok(res && res.block === true);
		assert.equal(host.appended.length, 0);
		// Golden-string: noOverride:true must OMIT the override hint tail.
		// Tighter than a `doesNotMatch(/To override/)` — pins the whole
		// reason including the `[steering:…]` prefix and lack of trailing
		// punctuation.
		assert.equal(res!.reason, "[steering:no-force-push] no force push");
	});

	it("defaultNoOverride=true (default) blocks even with override comment", async () => {
		const host = makeHost();
		const evaluator = buildEvaluator(
			// No defaultNoOverride → defaults to true per ADR.
			{ rules: [NO_FORCE_PUSH] },
			resolve(),
			host,
		);
		const res = await evaluator.evaluate(
			bashEvent(
				"git push --force # steering-override: no-force-push \u2014 nope",
			),
			makeCtx("/repo"),
			0,
		);
		assert.ok(res && res.block === true);
		assert.equal(host.appended.length, 0);
	});

	it("rule.noOverride:false wins over defaultNoOverride:true", async () => {
		const host = makeHost();
		const rule: Rule = { ...NO_FORCE_PUSH, noOverride: false };
		const evaluator = buildEvaluator(
			{ defaultNoOverride: true, rules: [rule] },
			resolve(),
			host,
		);
		const res = await evaluator.evaluate(
			bashEvent(
				"git push --force # steering-override: no-force-push \u2014 ok",
			),
			makeCtx("/repo"),
			0,
		);
		assert.equal(res, undefined);
		assert.equal(host.appended.length, 1);
	});

	it("block reason is a stable golden string (overridable vs not)", async () => {
		// Golden-string assertions instead of fuzzy regex: pin the
		// leader character (`#` for bash), the em dash, the backticks,
		// and the trailing period. These shapes are part of the public
		// block-reason contract with pi's agent — drift in any
		// character is an observable behaviour change.
		const evNoOverride = buildEvaluator(
			{ rules: [NO_FORCE_PUSH] }, // defaultNoOverride defaults to true
			resolve(),
			makeHost(),
		);
		const evOverridable = buildEvaluator(
			{ defaultNoOverride: false, rules: [NO_FORCE_PUSH] },
			resolve(),
			makeHost(),
		);
		const r1 = await evNoOverride.evaluate(
			bashEvent("git push --force"),
			makeCtx("/r"),
			0,
		);
		const r2 = await evOverridable.evaluate(
			bashEvent("git push --force"),
			makeCtx("/r"),
			0,
		);
		// Not overridable → no hint tail.
		assert.equal(r1!.reason, "[steering:no-force-push] no force push");
		// Overridable → hint tail uses the `#` bash leader, em dash, and
		// backticked comment template.
		assert.equal(
			r2!.reason,
			"[steering:no-force-push] no force push To override, " +
				"include a comment: `# steering-override: no-force-push \u2014 <reason>`.",
		);
	});

	it("override for rule-A does NOT apply to rule-B (name-specific lookup)", async () => {
		// Two rules, both firing on the same bash command. The override
		// comment targets only rule-a by name. The evaluator's
		// first-match-wins loop surfaces rule-a first → the override is
		// consumed → rule-a logs + yields. The loop then moves to
		// rule-b, whose name is not mentioned in the override text, so
		// rule-b should still block.
		const host = makeHost();
		const ruleA: Rule = {
			name: "rule-a",
			tool: "bash",
			field: "command",
			pattern: "^git\\s+push",
			reason: "a",
		};
		const ruleB: Rule = {
			name: "rule-b",
			tool: "bash",
			field: "command",
			pattern: "^git\\s+push",
			reason: "b",
		};
		const evaluator = buildEvaluator(
			{ defaultNoOverride: false, rules: [ruleA, ruleB] },
			resolve(),
			host,
		);
		const res = await evaluator.evaluate(
			bashEvent(
				"git push # steering-override: rule-a \u2014 docs say so",
			),
			makeCtx("/r"),
			0,
		);
		// rule-b still blocks.
		assert.ok(res && res.block === true);
		assert.match(res!.reason!, /\[steering:rule-b\]/);
		// rule-a's override was recorded as consumed; rule-b was NOT
		// overridden (exactly one audit entry, keyed to rule-a).
		assert.equal(host.appended.length, 1);
		assert.equal(host.appended[0]!.type, "steering-override");
		assert.equal(
			(host.appended[0]!.data as { rule: string }).rule,
			"rule-a",
		);
	});
});

// ---------------------------------------------------------------------------
// Write / edit tools
// ---------------------------------------------------------------------------

describe("buildEvaluator: write / edit", () => {
	it("fires on write content matching pattern", async () => {
		const rule: Rule = {
			name: "no-private-key",
			tool: "write",
			field: "content",
			pattern: "BEGIN RSA PRIVATE KEY",
			reason: "no private keys",
		};
		const evaluator = buildEvaluator(
			// Overridable so the block reason carries the override hint.
			// Lets us pin the write/edit `//` leader variant as a golden
			// string (leader + em dash + backticks + trailing period).
			{ defaultNoOverride: false, rules: [rule] },
			resolve(),
			makeHost(),
		);
		const res = await evaluator.evaluate(
			writeEvent("/r/k.pem", "-----BEGIN RSA PRIVATE KEY-----"),
			makeCtx("/r"),
			0,
		);
		assert.ok(res && res.block === true);
		assert.equal(
			res!.reason,
			"[steering:no-private-key] no private keys To override, " +
				"include a comment: `// steering-override: no-private-key \u2014 <reason>`.",
		);
	});

	it("field:path scans path instead of content", async () => {
		const rule: Rule = {
			name: "no-node-modules-write",
			tool: "write",
			field: "path",
			pattern: "/node_modules/",
			reason: "no node_modules writes",
		};
		const evaluator = buildEvaluator({ rules: [rule] }, resolve(), makeHost());
		const res = await evaluator.evaluate(
			writeEvent("/r/node_modules/foo.js", "// content"),
			makeCtx("/r"),
			0,
		);
		assert.ok(res && res.block === true);
	});

	it("edit joins newText across edits", async () => {
		const rule: Rule = {
			name: "no-console-log",
			tool: "edit",
			field: "content",
			pattern: "console\\.log",
			reason: "no console.log",
		};
		const evaluator = buildEvaluator({ rules: [rule] }, resolve(), makeHost());
		const res = await evaluator.evaluate(
			editEvent("/r/a.ts", [
				{ oldText: "const x = 1;", newText: "const x = 1;\nconsole.log(x);" },
			]),
			makeCtx("/r"),
			0,
		);
		assert.ok(res && res.block === true);
	});

	it("edit field:path scans path instead of joined newText", async () => {
		// Mirrors the write+path test above for the edit tool. Proves
		// the field="path" dispatch in evaluateWriteEditRule picks
		// `event.input.path` as the pattern target — independent of the
		// edits array's joined newText, which could have been the
		// naive default carried over from the edit-content branch.
		const rule: Rule = {
			name: "no-node-modules-edit",
			tool: "edit",
			field: "path",
			pattern: "/node_modules/",
			reason: "no node_modules edits",
		};
		const evaluator = buildEvaluator({ rules: [rule] }, resolve(), makeHost());
		const res = await evaluator.evaluate(
			editEvent("/r/node_modules/foo.js", [
				// newText has NO `/node_modules/` token — proving the rule
				// would miss if field:path were silently ignored and the
				// evaluator fell back to the joined-newText default.
				{ oldText: "a", newText: "b" },
			]),
			makeCtx("/r"),
			0,
		);
		assert.ok(res && res.block === true);
	});

	it("write override comment is honored (// leader)", async () => {
		const host = makeHost();
		const rule: Rule = {
			name: "no-todo",
			tool: "write",
			field: "content",
			pattern: "TODO",
			reason: "no todos",
		};
		const evaluator = buildEvaluator(
			{ defaultNoOverride: false, rules: [rule] },
			resolve(),
			host,
		);
		const res = await evaluator.evaluate(
			writeEvent(
				"/r/note.ts",
				"// steering-override: no-todo \u2014 doc-only\nTODO: remove later",
			),
			makeCtx("/r"),
			0,
		);
		assert.equal(res, undefined);
		assert.equal(host.appended.length, 1);
		assert.equal(host.appended[0]!.type, "steering-override");
		assert.deepEqual(
			(host.appended[0]!.data as { path: string }).path,
			"/r/note.ts",
		);
	});
});

// ---------------------------------------------------------------------------
// Rule ordering + walker reuse + exec memoization
// ---------------------------------------------------------------------------

describe("buildEvaluator: rule ordering (config before plugin)", () => {
	it("config rule fires first when both would fire", async () => {
		const userRule: Rule = {
			name: "user-rule",
			tool: "bash",
			field: "command",
			pattern: "^git\\s+push",
			reason: "user",
		};
		const pluginRule: Rule = {
			name: "plugin-rule",
			tool: "bash",
			field: "command",
			pattern: "^git\\s+push",
			reason: "plugin",
		};
		const plugin: Plugin = { name: "p", rules: [pluginRule] };
		const evaluator = buildEvaluator(
			{ rules: [userRule] },
			resolve([plugin]),
			makeHost(),
		);
		const res = await evaluator.evaluate(
			bashEvent("git push"),
			makeCtx("/r"),
			0,
		);
		assert.ok(res);
		assert.match(res!.reason!, /\[steering:user-rule\]/);
	});
});

describe("buildEvaluator: walker reuse + exec cache", () => {
	it("evaluates N rules against the SAME walker output (no re-parse)", async () => {
		// Smoke test: three bash rules firing against one tool_call all
		// see consistent cwd resolution — the walker runs once. We can't
		// directly observe `parseBash` calls without mocking, so we use
		// the test that all three rules independently resolve the same
		// per-ref cwd as evidence.
		const rules: Rule[] = [
			{
				name: "r1",
				tool: "bash",
				field: "command",
				pattern: "^ls",
				reason: "1",
				when: { cwd: "^/tmp/A$" },
			},
			{
				name: "r2",
				tool: "bash",
				field: "command",
				pattern: "^ls",
				reason: "2",
				when: { cwd: "^/tmp/B$" },
			},
			{
				name: "r3",
				tool: "bash",
				field: "command",
				pattern: "^echo",
				reason: "3",
				when: { cwd: "^/tmp/B$" },
			},
		];
		const evaluator = buildEvaluator({ rules }, resolve(), makeHost());
		// `ls` runs at /tmp/A, `echo` runs at /tmp/B. r1 should fire (ls in A)
		// and short-circuits further evaluation.
		const res = await evaluator.evaluate(
			bashEvent("cd /tmp/A && ls && cd /tmp/B && echo hi"),
			makeCtx("/home"),
			0,
		);
		assert.ok(res);
		assert.match(res!.reason!, /\[steering:r1\]/);
	});

	it("memoizes exec by (cmd, args, cwd) within one tool_call", async () => {
		const host = makeHost();
		let callCount = 0;
		const trackingHost: EvaluatorHost = {
			exec: async (cmd, args, opts) => {
				callCount++;
				return host.exec(cmd, args, opts);
			},
			appendEntry: host.appendEntry,
		};
		// Two rules hit the same exec() query inside their `condition`.
		const r1: Rule = {
			name: "r1",
			tool: "bash",
			field: "command",
			pattern: "^git",
			reason: "r1",
			when: {
				condition: async (ctx) => {
					await ctx.exec("git", ["status"], { cwd: "/repo" });
					return false; // don't fire — let the second rule run
				},
			},
		};
		const r2: Rule = {
			name: "r2",
			tool: "bash",
			field: "command",
			pattern: "^git",
			reason: "r2",
			when: {
				condition: async (ctx) => {
					await ctx.exec("git", ["status"], { cwd: "/repo" });
					return true;
				},
			},
		};
		const evaluator = buildEvaluator(
			{ rules: [r1, r2] },
			resolve(),
			trackingHost,
		);
		const res = await evaluator.evaluate(
			bashEvent("git status"),
			makeCtx("/home"),
			0,
		);
		assert.ok(res);
		assert.match(res!.reason!, /\[steering:r2\]/);
		// Both rules asked for the same (cmd, args, cwd): memoized → 1 call.
		assert.equal(callCount, 1);
	});

	it("does NOT memoize across tool_calls (fresh cache each time)", async () => {
		let callCount = 0;
		const host: EvaluatorHost = {
			exec: async () => {
				callCount++;
				return { stdout: "", stderr: "", code: 0, killed: false };
			},
			appendEntry: () => {},
		};
		const rule: Rule = {
			name: "r",
			tool: "bash",
			field: "command",
			pattern: "^git",
			reason: "r",
			when: {
				condition: async (ctx) => {
					await ctx.exec("git", ["status"], { cwd: "/repo" });
					return false;
				},
			},
		};
		const evaluator = buildEvaluator({ rules: [rule] }, resolve(), host);
		await evaluator.evaluate(bashEvent("git status"), makeCtx("/r"), 0);
		await evaluator.evaluate(bashEvent("git status"), makeCtx("/r"), 0);
		assert.equal(callCount, 2);
	});

	it("ctx.exec returns schema-shape ExecResult (exitCode, not code)", async () => {
		// The evaluator owns an adapter (toSchemaExecResult in
		// context.ts) that renames pi's `code` to the schema's
		// `exitCode` and drops `killed`. This test pins the boundary:
		// a host returning pi's shape must surface as the schema
		// shape inside the predicate context.
		const host: EvaluatorHost = {
			exec: async () => ({
				stdout: "x",
				stderr: "y",
				code: 42,
				killed: false,
			}),
			appendEntry: () => {},
		};
		let observed: { hasExitCode: boolean; hasCode: boolean } | null = null;
		const rule: Rule = {
			name: "exec-shape",
			tool: "bash",
			field: "command",
			pattern: "^git",
			reason: "shape",
			when: {
				condition: async (ctx) => {
					const r = await ctx.exec("git", ["status"]);
					observed = {
						hasExitCode: (r as { exitCode?: number }).exitCode === 42,
						// Adapter drops `code` — accessing it returns undefined.
						hasCode:
							(r as unknown as { code?: number }).code !== undefined,
					};
					// Rule fires only when exitCode === 42, which
					// implicitly proves the rename happened.
					return r.exitCode === 42;
				},
			},
		};
		const evaluator = buildEvaluator({ rules: [rule] }, resolve(), host);
		const res = await evaluator.evaluate(
			bashEvent("git status"),
			makeCtx("/r"),
			0,
		);
		assert.ok(res && res.block === true);
		assert.ok(observed, "condition should have been invoked");
		const obs = observed as unknown as {
			hasExitCode: boolean;
			hasCode: boolean;
		};
		assert.equal(obs.hasExitCode, true, "exitCode should equal 42");
		assert.equal(
			obs.hasCode,
			false,
			"adapter must drop pi's `code` field",
		);
	});

	it("exec cache keys cwd — different cwd triggers a second call", async () => {
		// Contrast with the "memoizes by (cmd, args, cwd)" test above,
		// which reuses one cwd and expects a single call. Here the same
		// (cmd, args) query runs twice with DIFFERENT cwd values; the
		// cache key must differ so the host sees two invocations.
		let callCount = 0;
		const host: EvaluatorHost = {
			exec: async () => {
				callCount++;
				return { stdout: "", stderr: "", code: 0, killed: false };
			},
			appendEntry: () => {},
		};
		const rule: Rule = {
			name: "cwd-key",
			tool: "bash",
			field: "command",
			pattern: "^git",
			reason: "cwd-key",
			when: {
				condition: async (ctx) => {
					await ctx.exec("git", ["status"], { cwd: "/repo-a" });
					await ctx.exec("git", ["status"], { cwd: "/repo-b" });
					return false;
				},
			},
		};
		const evaluator = buildEvaluator({ rules: [rule] }, resolve(), host);
		await evaluator.evaluate(
			bashEvent("git status"),
			makeCtx("/home"),
			0,
		);
		assert.equal(callCount, 2, "different cwds must not collide in cache");
	});
});

// ---------------------------------------------------------------------------
// findEntries reading session entries
// ---------------------------------------------------------------------------

describe("buildEvaluator: findEntries", () => {
	it("reads customType-filtered session entries, timestamps in epoch ms", async () => {
		const rule: Rule = {
			name: "turn-state-rule",
			tool: "bash",
			field: "command",
			pattern: "^git\\s+push",
			reason: "must have read-first",
			when: {
				condition: (ctx) => {
					const entries = ctx.findEntries<{ note: string }>("marker");
					assert.equal(entries.length, 1);
					assert.equal(entries[0]!.data.note, "hi");
					assert.equal(
						typeof entries[0]!.timestamp,
						"number",
						"timestamp is epoch ms",
					);
					assert.ok(entries[0]!.timestamp > 0);
					return true;
				},
			},
		};
		const ctx = makeCtx("/r", [
			{
				type: "custom",
				customType: "marker",
				data: { note: "hi" },
				timestamp: "2026-01-01T00:00:00.000Z",
				id: "e1",
				parentId: null,
			},
			{
				type: "custom",
				customType: "other",
				data: { ignore: true },
				timestamp: "2026-01-01T00:00:01.000Z",
				id: "e2",
				parentId: null,
			},
		]);
		const evaluator = buildEvaluator({ rules: [rule] }, resolve(), makeHost());
		const res = await evaluator.evaluate(bashEvent("git push"), ctx, 0);
		assert.ok(res);
	});

	it("memoizes findEntries by customType within one tool_call (stable reference)", async () => {
		// createFindEntries caches per-customType, per-closure. Within a
		// single tool_call two reads of the SAME customType must return
		// the exact same array reference — otherwise predicate chains
		// that dedupe or diff entry lists would get a fresh array every
		// call and wrongly believe state changed.
		let observed: {
			first: ReadonlyArray<unknown>;
			second: ReadonlyArray<unknown>;
		} | null = null;
		const rule: Rule = {
			name: "memo-ref",
			tool: "bash",
			field: "command",
			pattern: "^git\\s+push",
			reason: "memo-ref",
			when: {
				condition: (ctx) => {
					const a = ctx.findEntries<{ note: string }>("marker");
					const b = ctx.findEntries<{ note: string }>("marker");
					observed = { first: a, second: b };
					return true;
				},
			},
		};
		const ctx = makeCtx("/r", [
			{
				type: "custom",
				customType: "marker",
				data: { note: "hi" },
				timestamp: "2026-01-01T00:00:00.000Z",
				id: "e1",
				parentId: null,
			},
		]);
		const evaluator = buildEvaluator({ rules: [rule] }, resolve(), makeHost());
		await evaluator.evaluate(bashEvent("git push"), ctx, 0);
		assert.ok(observed, "condition should have run");
		const obs = observed as unknown as {
			first: ReadonlyArray<unknown>;
			second: ReadonlyArray<unknown>;
		};
		assert.strictEqual(
			obs.first,
			obs.second,
			"findEntries must return the same array reference on repeat calls",
		);
	});
});

// ---------------------------------------------------------------------------
// Default fail-closed defaultNoOverride (sanity)
// ---------------------------------------------------------------------------

describe("buildEvaluator: appendEntry auto-tags with _agentLoopIndex", () => {
	it("object payload gets _agentLoopIndex merged in", async () => {
		const host = makeHost();
		const rule: Rule = {
			name: "tag-object",
			tool: "bash",
			field: "command",
			pattern: "^echo",
			reason: "tag-object",
			when: {
				condition: (ctx) => {
					ctx.appendEntry("pred-write", { foo: "bar" });
					return false; // never fires; only side effect matters
				},
			},
		};
		const evaluator = buildEvaluator({ rules: [rule] }, resolve(), host);
		await evaluator.evaluate(bashEvent("echo hi"), makeCtx("/r"), 5);
		const found = host.appended.find((e) => e.type === "pred-write");
		assert.ok(found);
		assert.deepEqual(found.data, { foo: "bar", _agentLoopIndex: 5 });
	});

	it("primitive / undefined payloads wrap as { value, _agentLoopIndex }", async () => {
		const host = makeHost();
		const rule: Rule = {
			name: "tag-prim",
			tool: "bash",
			field: "command",
			pattern: "^echo",
			reason: "tag-prim",
			when: {
				condition: (ctx) => {
					ctx.appendEntry("no-data");
					ctx.appendEntry("num", 7);
					ctx.appendEntry("str", "hi");
					return false;
				},
			},
		};
		const evaluator = buildEvaluator({ rules: [rule] }, resolve(), host);
		await evaluator.evaluate(bashEvent("echo hi"), makeCtx("/r"), 2);
		const pred = host.appended.filter((e) =>
			["no-data", "num", "str"].includes(e.type),
		);
		assert.equal(pred.length, 3);
		assert.deepEqual(pred[0]!.data, {
			value: undefined,
			_agentLoopIndex: 2,
		});
		assert.deepEqual(pred[1]!.data, { value: 7, _agentLoopIndex: 2 });
		assert.deepEqual(pred[2]!.data, { value: "hi", _agentLoopIndex: 2 });
	});
});

describe("buildEvaluator: defaults", () => {
	it("omitted defaultNoOverride coerces to true (fail-closed)", async () => {
		// Same as the noOverride:true case above, but without any rule
		// flag or config flag. Both should block — pure default path.
		const rule: Rule = {
			name: "f",
			tool: "bash",
			field: "command",
			pattern: "^git\\s+push",
			reason: "f",
		};
		const evaluator = buildEvaluator({ rules: [rule] }, resolve(), makeHost());
		const res = await evaluator.evaluate(
			bashEvent(
				"git push # steering-override: f \u2014 please let me through",
			),
			makeCtx("/r"),
			0,
		);
		assert.ok(res && res.block === true);
	});
});

// ---------------------------------------------------------------------------
// empty config (nothing to evaluate)
// ---------------------------------------------------------------------------

describe("buildEvaluator: no rules", () => {
	it("returns undefined when neither config.rules nor plugin rules present", async () => {
		const evaluator = buildEvaluator({}, resolve(), makeHost());
		assert.equal(
			await evaluator.evaluate(bashEvent("rm -rf /"), makeCtx("/r"), 0),
			undefined,
		);
	});
});

// ---------------------------------------------------------------------------
// Plugin-shipped rule evaluation (smoke)
// ---------------------------------------------------------------------------

describe("buildEvaluator: plugin-shipped rules", () => {
	it("fires a plugin rule when no user rule matches", async () => {
		const plugin: Plugin = {
			name: "p",
			rules: [NO_FORCE_PUSH],
		};
		const evaluator = buildEvaluator({}, resolve([plugin]), makeHost());
		const res = await evaluator.evaluate(
			bashEvent("git push --force"),
			makeCtx("/r"),
			0,
		);
		assert.ok(res && res.block === true);
		assert.match(res!.reason!, /\[steering:no-force-push\]/);
	});

	it("honors config.disable to skip plugin rule", async () => {
		const plugin: Plugin = {
			name: "p",
			rules: [NO_FORCE_PUSH],
		};
		const cfg: SteeringConfig = { disable: ["no-force-push"] };
		// `resolvePlugins` applies `disable` to plugin rules at merge time.
		const evaluator = buildEvaluator(
			cfg,
			resolvePlugins([plugin], cfg),
			makeHost(),
		);
		assert.equal(
			await evaluator.evaluate(
				bashEvent("git push --force"),
				makeCtx("/r"),
				0,
			),
			undefined,
		);
	});
});

// Keep `Observer` import referenced — downstream tests in
// observer-dispatcher.test.ts exercise it directly; keeping the symbol
// used here avoids "unused import" diagnostics if this file migrates.
const _obsTypeKeepalive = null as unknown as Observer | null;
void _obsTypeKeepalive;
// And pull in ToolCallEvent for the narrow type echo below so unused-
// import linting stays green even if test helpers are slimmed.
const _eventTypeKeepalive = null as unknown as ToolCallEvent | null;
void _eventTypeKeepalive;

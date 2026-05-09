// SPDX-License-Identifier: MIT
// Part of pi-steering.

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
} from "@earendil-works/pi-coding-agent";
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

/**
 * Capture `console.warn` invocations for the S1 tests asserting that
 * a predicate throw is logged (vs. propagating up into pi's
 * `tool_result` shim and leaking the raw `error.message` to the LLM).
 *
 * Usage:
 *
 * ```ts
 * const warnings = captureWarnings();
 * try {
 *   // ... code that should log ...
 *   assert.ok(warnings.some((w) => /expected/.test(w)));
 * } finally {
 *   warnings.restore();
 * }
 * ```
 *
 * Implemented as direct reassignment rather than `t.mock.method` so
 * the helper works regardless of which describe/it block it's called
 * from (some tests don't take `t` — adding it everywhere was noisier
 * than the 4-line util).
 */
function captureWarnings(): string[] & { restore: () => void } {
	const warnings: string[] = [];
	const original = console.warn;
	console.warn = (...args: unknown[]) => {
		warnings.push(args.map((a) => String(a)).join(" "));
	};
	return Object.assign(warnings, {
		restore: () => {
			console.warn = original;
		},
	});
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
		assert.match(res!.reason!, /\[steering:no-force-push@[^\]]+\]/);
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
			when: { happened: { event: "ws-sync-done", in: "agent_loop" } },
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
			when: { happened: { event: "ws-sync-done", in: "agent_loop" } },
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
			when: { happened: { event: "ws-sync-done", in: "agent_loop" } },
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

	it("in: 'session' — skips whenever ANY entry of event exists", async () => {
		const rule: Rule = {
			name: "once-per-session",
			tool: "bash",
			field: "command",
			pattern: "^cr\\b",
			reason: "once-per-session",
			when: { happened: { event: "welcome-shown", in: "session" } },
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

	it("in: 'session' — fires when no entry of event exists", async () => {
		const rule: Rule = {
			name: "once-per-session",
			tool: "bash",
			field: "command",
			pattern: "^cr\\b",
			reason: "once-per-session",
			when: { happened: { event: "welcome-shown", in: "session" } },
		};
		const evaluator = buildEvaluator({ rules: [rule] }, resolve(), makeHost());
		const fires = await evaluator.evaluate(
			bashEvent("cr --review"),
			makeCtx("/r"),
			0,
		);
		assert.ok(fires);
	});

	it("not.happened: inverts — fires when event HAS happened in agent loop", async () => {
		const rule: Rule = {
			name: "no-cr-twice",
			tool: "bash",
			field: "command",
			pattern: "^cr\\b",
			reason: "no-cr-twice",
			when: {
				not: { happened: { event: "cr-attempted", in: "agent_loop" } },
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

	it("not.happened: skips — when event has NOT happened in agent loop", async () => {
		const rule: Rule = {
			name: "no-cr-twice",
			tool: "bash",
			field: "command",
			pattern: "^cr\\b",
			reason: "no-cr-twice",
			when: {
				not: { happened: { event: "cr-attempted", in: "agent_loop" } },
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

	it("treats a predicate throw as 'rule did not fire' and logs a warning (S1)", async () => {
		const rule: Rule = {
			name: "bad",
			tool: "bash",
			field: "command",
			pattern: "^cr\\b",
			reason: "bad",
			// @ts-expect-error — deliberately malformed for runtime check
			when: { happened: "not-an-object" },
		};
		const warnings = captureWarnings();
		try {
			const evaluator = buildEvaluator(
				{ rules: [rule] },
				resolve(),
				makeHost(),
			);
			const result = await evaluator.evaluate(
				bashEvent("cr"),
				makeCtx("/r"),
				0,
			);
			// Rule does NOT fire — a throwing predicate is isolated from the
			// rest of the rule list (S1). No block verdict returned.
			assert.equal(result, undefined);
			// Warning names the rule + source tag and contains the original
			// error message (so operators can locate + fix the bug).
			assert.ok(
				warnings.some((w) =>
					/predicate threw for rule "bad"@user.*when\.happened expected/.test(
						w,
					),
				),
				`no matching warning in:\n${warnings.join("\n")}`,
			);
		} finally {
			warnings.restore();
		}
	});

	it('isolates the "turn" migration error (S1 × migration)', async () => {
		// The "turn" → "agent_loop" migration error path is still the
		// correct thing to throw from inside the predicate (it's how
		// migrating users get told what to rename). With S1, the throw is
		// now CAUGHT by the evaluator — the user sees a warning on
		// startup / first fire and the rule stops firing, rather than the
		// error leaking back to the LLM via pi's tool-result shim.
		const rule: Rule = {
			name: "legacy-turn",
			tool: "bash",
			field: "command",
			pattern: "^cr\\b",
			reason: "legacy",
			// @ts-expect-error — "turn" is the removed v0.0.0-poc scope name
			when: { happened: { event: "ws-sync-done", in: "turn" } },
		};
		const warnings = captureWarnings();
		try {
			const evaluator = buildEvaluator(
				{ rules: [rule] },
				resolve(),
				makeHost(),
			);
			const result = await evaluator.evaluate(
				bashEvent("cr"),
				makeCtx("/r"),
				0,
			);
			assert.equal(result, undefined);
			assert.ok(
				warnings.some((w) =>
					/predicate threw for rule "legacy-turn"@user.*"turn" is no longer supported/.test(
						w,
					),
				),
				`no matching warning in:\n${warnings.join("\n")}`,
			);
		} finally {
			warnings.restore();
		}
	});

	it('isolates a typo-scope throw like "agentLoop" (camelCase, S1)', async () => {
		const rule: Rule = {
			name: "typo",
			tool: "bash",
			field: "command",
			pattern: "^cr\\b",
			reason: "typo",
			// @ts-expect-error — camelCase is not a valid scope
			when: { happened: { event: "ws-sync-done", in: "agentLoop" } },
		};
		const warnings = captureWarnings();
		try {
			const evaluator = buildEvaluator(
				{ rules: [rule] },
				resolve(),
				makeHost(),
			);
			const result = await evaluator.evaluate(
				bashEvent("cr"),
				makeCtx("/r"),
				0,
			);
			assert.equal(result, undefined);
			assert.ok(
				warnings.some((w) =>
					/predicate threw for rule "typo"@user.*when\.happened\.in must be.*"agent_loop" or "session"/.test(
						w,
					),
				),
				`no matching warning in:\n${warnings.join("\n")}`,
			);
		} finally {
			warnings.restore();
		}
	});

	it("untagged entries are treated as 'not happened this loop' (G5)", async () => {
		// Simulates a pre-feature entry (hand-written session JSONL,
		// migration across pi-steering versions, plugin that bypassed
		// the wrapper): `data` has no `_agentLoopIndex` key. The
		// agent_loop filter must NOT treat undefined as a match, so the
		// rule's `when.happened` predicate still fires (rule blocks).
		const rule: Rule = {
			name: "cr-needs-sync",
			tool: "bash",
			field: "command",
			pattern: "^cr\\b",
			reason: "sync first",
			when: { happened: { event: "legacy", in: "agent_loop" } },
		};
		const ctx = makeCtx("/r", [
			sessionEntry("legacy", { foo: "bar" }), // no _agentLoopIndex
		]);
		const evaluator = buildEvaluator({ rules: [rule] }, resolve(), makeHost());
		const res = await evaluator.evaluate(bashEvent("cr review"), ctx, 5);
		assert.ok(
			res && res.block === true,
			"untagged entries must not satisfy agent_loop scope",
		);
	});
});

describe("buildEvaluator: when.happened.since (temporal ordering)", () => {
	// `since` acts as an invalidation sentinel. Rule fires when the
	// most-recent `event` entry in scope is NOT strictly newer than
	// the most-recent `since` entry in scope. Absent / never-written
	// `since` degrades to simple-happened semantics.
	const sessionEntry = (
		customType: string,
		data: Record<string, unknown>,
		ts: string,
		id: string,
	) => ({
		type: "custom" as const,
		customType,
		data,
		timestamp: ts,
		id,
		parentId: null,
	});

	it("same loop, event after since → happened (rule does NOT fire)", async () => {
		const rule: Rule = {
			name: "needs-fresh-sync",
			tool: "bash",
			field: "command",
			pattern: "^cr\\b",
			reason: "sync first",
			when: {
				happened: {
					event: "ws-sync-done",
					in: "agent_loop",
					since: "upstream-failed",
				},
			},
		};
		const ctx = makeCtx("/r", [
			sessionEntry(
				"upstream-failed",
				{ _agentLoopIndex: 5 },
				"2026-01-01T00:00:00.000Z",
				"a",
			),
			sessionEntry(
				"ws-sync-done",
				{ _agentLoopIndex: 5 },
				"2026-01-01T00:00:10.000Z",
				"b",
			),
		]);
		const evaluator = buildEvaluator({ rules: [rule] }, resolve(), makeHost());
		const res = await evaluator.evaluate(bashEvent("cr review"), ctx, 5);
		assert.equal(res, undefined, "rule must skip when event is fresh");
	});

	it("same loop, since after event → stale (rule fires)", async () => {
		const rule: Rule = {
			name: "needs-fresh-sync",
			tool: "bash",
			field: "command",
			pattern: "^cr\\b",
			reason: "sync first",
			when: {
				happened: {
					event: "ws-sync-done",
					in: "agent_loop",
					since: "upstream-failed",
				},
			},
		};
		const ctx = makeCtx("/r", [
			sessionEntry(
				"ws-sync-done",
				{ _agentLoopIndex: 5 },
				"2026-01-01T00:00:00.000Z",
				"a",
			),
			sessionEntry(
				"upstream-failed",
				{ _agentLoopIndex: 5 },
				"2026-01-01T00:00:10.000Z",
				"b",
			),
		]);
		const evaluator = buildEvaluator({ rules: [rule] }, resolve(), makeHost());
		const res = await evaluator.evaluate(bashEvent("cr review"), ctx, 5);
		assert.ok(res && res.block === true, "rule must fire when event is stale");
	});

	it("event present, since never written → happened (rule does NOT fire)", async () => {
		const rule: Rule = {
			name: "needs-fresh-sync",
			tool: "bash",
			field: "command",
			pattern: "^cr\\b",
			reason: "sync first",
			when: {
				happened: {
					event: "ws-sync-done",
					in: "agent_loop",
					since: "upstream-failed",
				},
			},
		};
		const ctx = makeCtx("/r", [
			sessionEntry(
				"ws-sync-done",
				{ _agentLoopIndex: 5 },
				"2026-01-01T00:00:00.000Z",
				"a",
			),
		]);
		const evaluator = buildEvaluator({ rules: [rule] }, resolve(), makeHost());
		const res = await evaluator.evaluate(bashEvent("cr review"), ctx, 5);
		assert.equal(
			res,
			undefined,
			"never-written since degrades to simple-happened",
		);
	});

	it("neither event nor since written → rule fires", async () => {
		const rule: Rule = {
			name: "needs-fresh-sync",
			tool: "bash",
			field: "command",
			pattern: "^cr\\b",
			reason: "sync first",
			when: {
				happened: {
					event: "ws-sync-done",
					in: "agent_loop",
					since: "upstream-failed",
				},
			},
		};
		const evaluator = buildEvaluator({ rules: [rule] }, resolve(), makeHost());
		const res = await evaluator.evaluate(
			bashEvent("cr review"),
			makeCtx("/r"),
			5,
		);
		assert.ok(
			res && res.block === true,
			"no event at all must fire regardless of since",
		);
	});

	it("only since written → event absent, rule fires", async () => {
		const rule: Rule = {
			name: "needs-fresh-sync",
			tool: "bash",
			field: "command",
			pattern: "^cr\\b",
			reason: "sync first",
			when: {
				happened: {
					event: "ws-sync-done",
					in: "agent_loop",
					since: "upstream-failed",
				},
			},
		};
		const ctx = makeCtx("/r", [
			sessionEntry(
				"upstream-failed",
				{ _agentLoopIndex: 5 },
				"2026-01-01T00:00:00.000Z",
				"a",
			),
		]);
		const evaluator = buildEvaluator({ rules: [rule] }, resolve(), makeHost());
		const res = await evaluator.evaluate(bashEvent("cr review"), ctx, 5);
		assert.ok(
			res && res.block === true,
			"no event means happened=false regardless of since",
		);
	});

	it("cross-loop: since in prior loop, event in current loop (agent_loop scope)", async () => {
		// The `since` entry from loop 4 is OUT of current-loop scope, so
		// the agent_loop filter drops it. From loop-5's perspective
		// `since` is "never written" → simple-happened semantics.
		const rule: Rule = {
			name: "needs-fresh-sync",
			tool: "bash",
			field: "command",
			pattern: "^cr\\b",
			reason: "sync first",
			when: {
				happened: {
					event: "ws-sync-done",
					in: "agent_loop",
					since: "upstream-failed",
				},
			},
		};
		const ctx = makeCtx("/r", [
			sessionEntry(
				"upstream-failed",
				{ _agentLoopIndex: 4 },
				"2026-01-01T00:00:05.000Z",
				"a",
			),
			sessionEntry(
				"ws-sync-done",
				{ _agentLoopIndex: 5 },
				"2026-01-01T00:00:00.000Z",
				"b",
			),
		]);
		const evaluator = buildEvaluator({ rules: [rule] }, resolve(), makeHost());
		const res = await evaluator.evaluate(bashEvent("cr review"), ctx, 5);
		assert.equal(
			res,
			undefined,
			"prior-loop since must not invalidate current-loop event",
		);
	});

	it("in: 'session' scope with since compares across whole session", async () => {
		const rule: Rule = {
			name: "needs-fresh-welcome",
			tool: "bash",
			field: "command",
			pattern: "^cr\\b",
			reason: "welcome",
			when: {
				happened: {
					event: "welcome-shown",
					in: "session",
					since: "policy-updated",
				},
			},
		};
		// policy-updated after welcome-shown → stale, rule fires.
		const ctx = makeCtx("/r", [
			sessionEntry(
				"welcome-shown",
				{},
				"2026-01-01T00:00:00.000Z",
				"a",
			),
			sessionEntry(
				"policy-updated",
				{},
				"2026-01-01T00:01:00.000Z",
				"b",
			),
		]);
		const evaluator = buildEvaluator({ rules: [rule] }, resolve(), makeHost());
		const res = await evaluator.evaluate(bashEvent("cr review"), ctx, 99);
		assert.ok(
			res && res.block === true,
			"session-scope since must fire on stale event",
		);
	});

	it("runtime error on non-string since value", async () => {
		const rule: Rule = {
			name: "bad-since",
			tool: "bash",
			field: "command",
			pattern: "^cr\\b",
			reason: "bad",
			when: {
				happened: {
					event: "ws-sync-done",
					in: "agent_loop",
					// @ts-expect-error — deliberate runtime type violation.
					since: 42,
				},
			},
		};
		const warnings = captureWarnings();
		try {
			const evaluator = buildEvaluator(
				{ rules: [rule] },
				resolve(),
				makeHost(),
			);
			const res = await evaluator.evaluate(
				bashEvent("cr review"),
				makeCtx("/r"),
				5,
			);
			// Predicate throw is isolated (S1) — no block verdict.
			assert.equal(res, undefined);
			assert.ok(
				warnings.some((w) =>
					/when\.happened\.since must be a string/.test(w),
				),
				`no matching warning in:\n${warnings.join("\n")}`,
			);
		} finally {
			warnings.restore();
		}
	});
});

describe("buildEvaluator: chain-aware when.happened (&&-speculative allow)", () => {
	// When the current bash tool_call contains a prior `&&`-chained ref
	// that matches an observer writing the required event, the engine
	// speculatively treats the event as "about to happen" and declines
	// to fire the rule. Safe because `&&` short-circuits: if the prior
	// command fails, the current one never runs, so the speculative
	// decision is moot.
	const SYNC_DONE_EVENT = "chain-sync-done" as const;

	const syncObserver: Observer = {
		name: "chain-sync-tracker",
		writes: [SYNC_DONE_EVENT],
		watch: {
			toolName: "bash",
			inputMatches: { command: /^sync\b/ },
			exitCode: "success",
		},
		onResult: () => {
			/* unused in evaluator tests — the reverse-index only reads metadata */
		},
	};

	const crNeedsSync: Rule = {
		name: "cr-needs-sync",
		tool: "bash",
		field: "command",
		pattern: /^cr\b/,
		reason: "sync first",
		when: { happened: { event: SYNC_DONE_EVENT, in: "agent_loop" } },
	};

	it("allows `sync && cr` — prior && ref matches the sync observer", async () => {
		const evaluator = buildEvaluator(
			{ rules: [crNeedsSync], observers: [syncObserver] },
			resolve(),
			makeHost(),
		);
		const res = await evaluator.evaluate(
			bashEvent("sync && cr --review"),
			makeCtx("/r"),
			5,
		);
		assert.equal(
			res,
			undefined,
			"speculative allow should skip the rule on sync && cr",
		);
	});

	it("blocks `cr && sync` — cr is first, no prior && match", async () => {
		const evaluator = buildEvaluator(
			{ rules: [crNeedsSync], observers: [syncObserver] },
			resolve(),
			makeHost(),
		);
		const res = await evaluator.evaluate(
			bashEvent("cr --review && sync"),
			makeCtx("/r"),
			5,
		);
		assert.ok(
			res && res.block === true,
			"cr has no prior && ref matching sync — rule must fire",
		);
	});

	it("blocks `sync ; cr` — `;` does NOT qualify as prior-&&", async () => {
		const evaluator = buildEvaluator(
			{ rules: [crNeedsSync], observers: [syncObserver] },
			resolve(),
			makeHost(),
		);
		const res = await evaluator.evaluate(
			bashEvent("sync ; cr --review"),
			makeCtx("/r"),
			5,
		);
		assert.ok(
			res && res.block === true,
			"semicolon does not short-circuit — speculative allow unsafe",
		);
	});

	it("blocks `sync || cr` — `||` means cr runs on sync failure", async () => {
		const evaluator = buildEvaluator(
			{ rules: [crNeedsSync], observers: [syncObserver] },
			resolve(),
			makeHost(),
		);
		const res = await evaluator.evaluate(
			bashEvent("sync || cr --review"),
			makeCtx("/r"),
			5,
		);
		assert.ok(
			res && res.block === true,
			"|| means cr runs on sync failure — speculative allow unsafe",
		);
	});

	it("allows `(sync) && cr` — subshell + && commits the chain", async () => {
		const evaluator = buildEvaluator(
			{ rules: [crNeedsSync], observers: [syncObserver] },
			resolve(),
			makeHost(),
		);
		const res = await evaluator.evaluate(
			bashEvent("(sync) && cr --review"),
			makeCtx("/r"),
			5,
		);
		assert.equal(
			res,
			undefined,
			"subshell exit with && should still count as prior-&&",
		);
	});

	it("allows `echo foo && sync && cr` — full && chain", async () => {
		const evaluator = buildEvaluator(
			{ rules: [crNeedsSync], observers: [syncObserver] },
			resolve(),
			makeHost(),
		);
		const res = await evaluator.evaluate(
			bashEvent("echo foo && sync && cr --review"),
			makeCtx("/r"),
			5,
		);
		assert.equal(
			res,
			undefined,
			"sync is a prior && ref of cr via transitive chain",
		);
	});

	it("no observers writing event → no speculative allow", async () => {
		// Reverse index is empty (no observers registered), so the rule
		// fires even though `sync` runs first — no way to know sync
		// writes SYNC_DONE_EVENT without the observer's `writes:` link.
		const evaluator = buildEvaluator(
			{ rules: [crNeedsSync] },
			resolve(),
			makeHost(),
		);
		const res = await evaluator.evaluate(
			bashEvent("sync && cr --review"),
			makeCtx("/r"),
			5,
		);
		assert.ok(
			res && res.block === true,
			"with no observers, fall back to simple happened check",
		);
	});

	it("observer without inputMatches.command → no speculative allow", async () => {
		// An observer that would fire on any bash tool_result isn't a
		// strong enough signal for speculative allow: we can't tell
		// whether the prior ref would actually make the observer fire.
		const looseObserver: Observer = {
			name: "loose-observer",
			writes: [SYNC_DONE_EVENT],
			watch: { toolName: "bash" },
			onResult: () => {},
		};
		const evaluator = buildEvaluator(
			{ rules: [crNeedsSync], observers: [looseObserver] },
			resolve(),
			makeHost(),
		);
		const res = await evaluator.evaluate(
			bashEvent("sync && cr --review"),
			makeCtx("/r"),
			5,
		);
		assert.ok(
			res && res.block === true,
			"observers with no command pattern must not trigger speculative allow",
		);
	});

	it("multiple observers writing same event — any command match triggers allow", async () => {
		const obsA: Observer = {
			name: "obs-a",
			writes: [SYNC_DONE_EVENT],
			watch: {
				toolName: "bash",
				inputMatches: { command: /^never-match\b/ },
			},
			onResult: () => {},
		};
		const obsB: Observer = {
			name: "obs-b",
			writes: [SYNC_DONE_EVENT],
			watch: {
				toolName: "bash",
				inputMatches: { command: /^sync\b/ },
			},
			onResult: () => {},
		};
		const evaluator = buildEvaluator(
			{ rules: [crNeedsSync], observers: [obsA, obsB] },
			resolve(),
			makeHost(),
		);
		const res = await evaluator.evaluate(
			bashEvent("sync && cr --review"),
			makeCtx("/r"),
			5,
		);
		assert.equal(res, undefined, "obs-b's command pattern matches — allow");
	});

	it("plugin observer (not inline) also feeds the reverse index", async () => {
		const pluginWithObs: Plugin = {
			name: "chain-plugin",
			observers: [syncObserver],
		};
		const evaluator = buildEvaluator(
			{ rules: [crNeedsSync] },
			resolve([pluginWithObs]),
			makeHost(),
		);
		const res = await evaluator.evaluate(
			bashEvent("sync && cr --review"),
			makeCtx("/r"),
			5,
		);
		assert.equal(
			res,
			undefined,
			"plugin-shipped observers should populate the reverse index too",
		);
	});

	it("combines with since — speculative allow also applies when event is stale", async () => {
		// Event previously happened but since-sentinel made it stale.
		// Prior && ref matches → the new sync is "about to happen" and
		// freshens the state. Speculative allow, rule skips.
		const ruleWithSince: Rule = {
			name: "cr-needs-fresh-sync",
			tool: "bash",
			field: "command",
			pattern: /^cr\b/,
			reason: "sync first",
			when: {
				happened: {
					event: SYNC_DONE_EVENT,
					in: "agent_loop",
					since: "upstream-failed",
				},
			},
		};
		const makeStaleCtx = () =>
			makeCtx("/r", [
				{
					type: "custom" as const,
					customType: SYNC_DONE_EVENT,
					data: { _agentLoopIndex: 5 },
					timestamp: "2026-01-01T00:00:00.000Z",
					id: "a",
					parentId: null,
				},
				{
					type: "custom" as const,
					customType: "upstream-failed",
					data: { _agentLoopIndex: 5 },
					timestamp: "2026-01-01T00:00:10.000Z",
					id: "b",
					parentId: null,
				},
			]);
		const evaluator = buildEvaluator(
			{ rules: [ruleWithSince], observers: [syncObserver] },
			resolve(),
			makeHost(),
		);
		const res = await evaluator.evaluate(
			bashEvent("sync && cr --review"),
			makeStaleCtx(),
			5,
		);
		assert.equal(
			res,
			undefined,
			"stale event + prior && sync ref → speculative allow",
		);
	});

	// ---- Chain reachability (|| and | must not bleed into && prior sets) ----

	it("blocks `lint || sync && cr` — `||` short-circuits sync out of cr's prior", async () => {
		// Bash parses as `(lint || sync) && cr`. When `lint` succeeds, `sync`
		// is SKIPPED but the compound `(lint || sync)` is true, so `cr`
		// still runs — without sync ever running. Speculative allow via
		// sync would be unsafe here, because sync is not guaranteed to
		// have run before cr.
		const evaluator = buildEvaluator(
			{ rules: [crNeedsSync], observers: [syncObserver] },
			resolve(),
			makeHost(),
		);
		const res = await evaluator.evaluate(
			bashEvent("lint || sync && cr --review"),
			makeCtx("/r"),
			5,
		);
		assert.ok(
			res && res.block === true,
			"`||` before a prior-&& ref breaks reachability — cr must still block",
		);
	});

	it("allows `cd /r ; sync && cr` — `;` restores reachability on a new statement", async () => {
		// After a `;` statement boundary, the next ref runs unconditionally
		// again. From there `sync && cr` is a continuous `&&` chain
		// starting on an unconditionally-reached ref, so speculative allow
		// of `cr` via `sync` is safe.
		const evaluator = buildEvaluator(
			{ rules: [crNeedsSync], observers: [syncObserver] },
			resolve(),
			makeHost(),
		);
		const res = await evaluator.evaluate(
			bashEvent("cd /r ; sync && cr --review"),
			makeCtx("/r"),
			5,
		);
		assert.equal(
			res,
			undefined,
			"`;` restores reachability; the sync && cr segment grants speculative allow",
		);
	});

	// ---- Observer watch compatibility (toolName + exitCode) ----

	it("does not speculative-allow when observer requires exitCode: 'failure'", async () => {
		// `&&` only advances on success, so an observer gated on failure
		// can never fire from a prior-&& ref. Treating its `writes` as
		// speculatively-happening would be wrong (the event will never be
		// written from this path).
		const failObserver: Observer = {
			name: "fail-gated-sync",
			writes: [SYNC_DONE_EVENT],
			watch: {
				toolName: "bash",
				inputMatches: { command: /^sync\b/ },
				exitCode: "failure",
			},
			onResult: () => {},
		};
		const evaluator = buildEvaluator(
			{ rules: [crNeedsSync], observers: [failObserver] },
			resolve(),
			makeHost(),
		);
		const res = await evaluator.evaluate(
			bashEvent("sync && cr --review"),
			makeCtx("/r"),
			5,
		);
		assert.ok(
			res && res.block === true,
			"observer gated on failure cannot fire via && short-circuit; no speculative allow",
		);
	});

	it("does not speculative-allow when observer's toolName is non-bash", async () => {
		// Prior `&&` refs always originate from bash tool_calls. An
		// observer scoped to a non-bash tool can never fire on one, so
		// its declared writes are never produced on this code path.
		const readObserver: Observer = {
			name: "read-scoped-sync",
			writes: [SYNC_DONE_EVENT],
			watch: {
				toolName: "read",
				inputMatches: { command: /^sync\b/ },
			},
			onResult: () => {},
		};
		const evaluator = buildEvaluator(
			{ rules: [crNeedsSync], observers: [readObserver] },
			resolve(),
			makeHost(),
		);
		const res = await evaluator.evaluate(
			bashEvent("sync && cr --review"),
			makeCtx("/r"),
			5,
		);
		assert.ok(
			res && res.block === true,
			"read-scoped observer can't fire on bash refs; no speculative allow",
		);
	});

	// ---- Observer dedup (user wins, matches dispatcher) ----

	it("user observer shadows plugin observer of the same name in chain-aware allow", async () => {
		// Plugin ships an observer `chain-sync-tracker` with a LOOSE watch
		// (`/^sync\b/`) that would match `sync`. User declares their own
		// observer of the same name with a TIGHT watch (`/^sync --lock\b/`)
		// that does NOT match bare `sync`. The dispatcher fires only the
		// user's observer (dedup-by-name, user wins); chain-aware reverse-
		// index must apply the same semantics or it will grant on a
		// pattern that never actually produces the event.
		const userTightObserver: Observer = {
			name: "chain-sync-tracker",
			writes: [SYNC_DONE_EVENT],
			watch: {
				toolName: "bash",
				inputMatches: { command: /^sync --lock\b/ },
				exitCode: "success",
			},
			onResult: () => {},
		};
		const pluginWithLooseObs: Plugin = {
			name: "chain-plugin",
			observers: [syncObserver], // loose `/^sync\b/`
		};
		const evaluator = buildEvaluator(
			{ rules: [crNeedsSync], observers: [userTightObserver] },
			resolve([pluginWithLooseObs]),
			makeHost(),
		);
		const res = await evaluator.evaluate(
			bashEvent("sync && cr --review"),
			makeCtx("/r"),
			5,
		);
		assert.ok(
			res && res.block === true,
			"user observer's tighter watch wins; bare `sync` no longer matches",
		);
	});

	// ---- Subshell coverage: multi-ref + conservative under-allow pins ----

	it("allows `(echo hi && sync) && cr` — multi-ref subshell inherits the outer && chain", async () => {
		// GAP-01 regression fence. The walker flattens the subshell into
		// a linear ref list with `echo.joiner='&&', sync.joiner='&&',
		// cr.joiner=undefined`. Under the chain reachability rule, sync is
		// unconditionally reached via echo's `&&` and contributes to cr's
		// prior set. Speculative allow fires via the sync observer.
		const evaluator = buildEvaluator(
			{ rules: [crNeedsSync], observers: [syncObserver] },
			resolve(),
			makeHost(),
		);
		const res = await evaluator.evaluate(
			bashEvent("(echo hi && sync) && cr --review"),
			makeCtx("/r"),
			5,
		);
		assert.equal(
			res,
			undefined,
			"multi-ref subshell: both refs inside the `(...)` participate in cr's prior chain; sync matches observer",
		);
	});

	it("conservative-under: `foo && (bar ; sync) && cr` — only sync in prior, foo is dropped at `;`", async () => {
		// GAP-02 regression fence. The walker flattens to
		// `foo.joiner='&&', bar.joiner=';', sync.joiner='&&',
		// cr.joiner=undefined`. The `;` inside the subshell clears the
		// prior chain, so cr's prior set is `[sync]` only — NOT
		// `[foo, sync]`. This is the intentional conservative-under trade-
		// off documented on `computePriorAndChains`; pin it so a future
		// walker change that treats the outer `&&` as bridging across the
		// `;` doesn't silently flip to an over-allow.
		//
		// We prove it with an observer that matches ONLY `foo` (not sync).
		// If foo were in cr's prior chain the rule would wrongly
		// speculative-allow; because the `;` cleared it, the rule must
		// still fire.
		const fooObserver: Observer = {
			name: "foo-only",
			writes: [SYNC_DONE_EVENT],
			watch: {
				toolName: "bash",
				inputMatches: { command: /^foo\b/ },
				exitCode: "success",
			},
			onResult: () => {},
		};
		const evaluator = buildEvaluator(
			{ rules: [crNeedsSync], observers: [fooObserver] },
			resolve(),
			makeHost(),
		);
		const res = await evaluator.evaluate(
			bashEvent("foo && (bar ; sync) && cr --review"),
			makeCtx("/r"),
			5,
		);
		assert.ok(
			res && res.block === true,
			"conservative-under: cr's prior is [sync] after `;`; fooObserver can't allow",
		);
	});

	// ---- Pinned correctness case: two-speculative-writes + since ----

	it("blocks `A && B && cr` when A writes X and B writes Y (X since Y)", async () => {
		// Walker-producer unification correctness case. Pre-unification,
		// speculative-allow was a boolean "any prior && ref matches an
		// observer writing the event" — it ignored cross-type invalidators
		// written by OTHER prior && refs. So `A && B && cr` with X-writer A
		// and Y-writer B (Y being X's since-invalidator) incorrectly
		// speculative-allowed: A's write of X counted even though B's later
		// write of Y would stale it.
		//
		// Post-unification, speculative entries carry AST-ordered timestamps
		// (baseline + 1 + index), so the synthetic X at ts=baseline+1 is
		// older than synthetic Y at ts=baseline+2. `when.happened: { event:
		// X, since: Y }` correctly reads X as stale and fires the rule.
		const EVENT_X = "chain-two-writes-x" as const;
		const EVENT_Y = "chain-two-writes-y" as const;
		const aObserver: Observer = {
			name: "a-writer",
			writes: [EVENT_X],
			watch: {
				toolName: "bash",
				inputMatches: { command: /^alpha\b/ },
				exitCode: "success",
			},
			onResult: () => {},
		};
		const bObserver: Observer = {
			name: "b-writer",
			writes: [EVENT_Y],
			watch: {
				toolName: "bash",
				inputMatches: { command: /^bravo\b/ },
				exitCode: "success",
			},
			onResult: () => {},
		};
		const rule: Rule = {
			name: "cr-since-y-blocks",
			tool: "bash",
			field: "command",
			pattern: /^cr\b/,
			reason: "X is stale (Y written after)",
			when: {
				happened: {
					event: EVENT_X,
					in: "agent_loop",
					since: EVENT_Y,
				},
			},
		};
		const evaluator = buildEvaluator(
			{ rules: [rule], observers: [aObserver, bObserver] },
			resolve(),
			makeHost(),
		);
		const res = await evaluator.evaluate(
			bashEvent("alpha && bravo && cr --review"),
			makeCtx("/r"),
			5,
		);
		assert.ok(
			res && res.block === true,
			"unification: synthetic X older than synthetic Y → X is stale → rule fires",
		);
	});

	it("allows `A && B && cr` when the since-type matches NEITHER prior ref's observer", async () => {
		// Regression guard for the inverse scenario. If only X's observer
		// is registered (no one writes Y), A's write of X makes the event
		// fresh AND the invalidator is absent in scope — happened degrades
		// to simple-presence semantics, rule does NOT fire. Confirms the
		// unification still grants allow when there's no cross-type
		// invalidator in play.
		const EVENT_X = "chain-only-x" as const;
		const EVENT_Y_ABSENT = "chain-only-x-since-absent" as const;
		const aObserver: Observer = {
			name: "a-writer-only",
			writes: [EVENT_X],
			watch: {
				toolName: "bash",
				inputMatches: { command: /^alpha\b/ },
				exitCode: "success",
			},
			onResult: () => {},
		};
		const rule: Rule = {
			name: "cr-since-absent-allows",
			tool: "bash",
			field: "command",
			pattern: /^cr\b/,
			reason: "X is stale (Y written after)",
			when: {
				happened: {
					event: EVENT_X,
					in: "agent_loop",
					since: EVENT_Y_ABSENT,
				},
			},
		};
		const evaluator = buildEvaluator(
			{ rules: [rule], observers: [aObserver] },
			resolve(),
			makeHost(),
		);
		const res = await evaluator.evaluate(
			bashEvent("alpha && bravo && cr --review"),
			makeCtx("/r"),
			5,
		);
		assert.equal(
			res,
			undefined,
			"synthetic X present + Y absent → simple-presence → rule does NOT fire",
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

	it("isolates an unknown when.<key> throw as 'rule did not fire' (S1)", async () => {
		// UnknownPredicateError is still the right thing to throw from
		// inside the predicate dispatcher (it names the offending key so
		// operators can locate the typo / missing plugin). S1 catches it
		// at the evaluator boundary so the raw error message doesn't leak
		// back to the agent via pi's tool-result shim.
		const rule: Rule = {
			name: "bad-when",
			tool: "bash",
			field: "command",
			pattern: "^git",
			reason: "bad",
			when: { totallyMadeUp: /whatever/ },
		};
		const warnings = captureWarnings();
		try {
			const evaluator = buildEvaluator(
				{ rules: [rule] },
				resolve(),
				makeHost(),
			);
			const result = await evaluator.evaluate(
				bashEvent("git status"),
				makeCtx("/r"),
				0,
			);
			assert.equal(result, undefined);
			assert.ok(
				warnings.some((w) =>
					/predicate threw for rule "bad-when"@user.*unknown when\.totallyMadeUp/.test(
						w,
					),
				),
				`no matching warning in:\n${warnings.join("\n")}`,
			);
		} finally {
			warnings.restore();
		}
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

	it("sync-throwing onFire is caught, warn is logged, rule still blocks (F4 / G1)", async () => {
		const host = makeHost();
		const rule: Rule = {
			name: "bad-onfire-sync",
			tool: "bash",
			field: "command",
			pattern: "^echo",
			reason: "bad",
			onFire: () => {
				throw new Error("boom-sync");
			},
		};
		const evaluator = buildEvaluator({ rules: [rule] }, resolve(), host);
		const warns: unknown[][] = [];
		const origWarn = console.warn;
		console.warn = (...a) => {
			warns.push(a);
		};
		try {
			const res = await evaluator.evaluate(
				bashEvent("echo hi"),
				makeCtx("/r"),
				0,
			);
			assert.ok(res && res.block === true);
		} finally {
			console.warn = origWarn;
		}
		assert.equal(warns.length, 1);
		assert.match(
			String(warns[0]![0]),
			/onFire for rule "bad-onfire-sync" threw:.*boom-sync/s,
		);
	});

	it("rejected-promise onFire is caught, warn is logged, rule still blocks (F4 / G1)", async () => {
		const host = makeHost();
		const rule: Rule = {
			name: "bad-onfire-async",
			tool: "bash",
			field: "command",
			pattern: "^echo",
			reason: "bad",
			onFire: async () => {
				await Promise.resolve();
				throw new Error("boom-async");
			},
		};
		const evaluator = buildEvaluator({ rules: [rule] }, resolve(), host);
		const warns: unknown[][] = [];
		const origWarn = console.warn;
		console.warn = (...a) => {
			warns.push(a);
		};
		try {
			const res = await evaluator.evaluate(
				bashEvent("echo hi"),
				makeCtx("/r"),
				0,
			);
			assert.ok(res && res.block === true);
		} finally {
			console.warn = origWarn;
		}
		assert.equal(warns.length, 1);
		assert.match(
			String(warns[0]![0]),
			/onFire for rule "bad-onfire-async" threw:.*boom-async/s,
		);
	});

	it("throwing onFire on the first-matching rule does not abort the verdict (F4)", async () => {
		// First-match-wins: rule A fires first, its onFire throws, the
		// verdict still returns, rule B is never consulted. This pins
		// that the throw didn't propagate up to pi OR cause fallthrough
		// to later rules.
		const host = makeHost();
		let bCalled = false;
		const ruleA: Rule = {
			name: "a",
			tool: "bash",
			field: "command",
			pattern: "^echo",
			reason: "ra",
			onFire: () => {
				throw new Error("a-boom");
			},
		};
		const ruleB: Rule = {
			name: "b",
			tool: "bash",
			field: "command",
			pattern: "^echo",
			reason: "rb",
			onFire: () => {
				bCalled = true;
			},
		};
		const evaluator = buildEvaluator(
			{ rules: [ruleA, ruleB] },
			resolve(),
			host,
		);
		const origWarn = console.warn;
		console.warn = () => {};
		try {
			const res = await evaluator.evaluate(
				bashEvent("echo hi"),
				makeCtx("/r"),
				0,
			);
			assert.ok(res && res.block === true);
			assert.match(res!.reason!, /\[steering:a@user\]/);
		} finally {
			console.warn = origWarn;
		}
		assert.equal(
			bCalled,
			false,
			"first-match-wins — rule B's onFire must not run",
		);
	});

	it("runs when rule is overridable but no override comment present (G7)", async () => {
		// Branch not covered by the existing onFire suite: overridable
		// rule (noOverride: false) + no override comment. Semantically
		// equivalent to the fail-closed + no-override case but goes
		// through a different code path — `extractOverride` returns null,
		// falls through to onFire.
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
			bashEvent("git push"),
			makeCtx("/r"),
			0,
		);
		assert.ok(res && res.block === true);
		assert.equal(called, true);
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
		assert.equal(res!.reason, "[steering:no-force-push@user] no force push");
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
		assert.equal(r1!.reason, "[steering:no-force-push@user] no force push");
		// Overridable → hint tail uses the `#` bash leader, em dash, and
		// backticked comment template.
		assert.equal(
			r2!.reason,
			"[steering:no-force-push@user] no force push To override, " +
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
		assert.match(res!.reason!, /\[steering:rule-b@[^\]]+\]/);
		// rule-a's override was recorded as consumed; rule-b was NOT
		// overridden (exactly one audit entry, keyed to rule-a).
		assert.equal(host.appended.length, 1);
		assert.equal(host.appended[0]!.type, "steering-override");
		assert.equal(
			(host.appended[0]!.data as { rule: string }).rule,
			"rule-a",
		);
	});

	it("audit entry carries the current _agentLoopIndex (F3)", async () => {
		// Override entries go through `shared.appendEntry` (the wrapped
		// path) so rules using `when.happened: { event:
		// "steering-override", in: "agent_loop" }` can see them. This
		// test just pins the shape — the agent_loop / session behaviours
		// follow.
		const host = makeHost();
		const evaluator = buildEvaluator(
			{ defaultNoOverride: false, rules: [NO_FORCE_PUSH] },
			resolve(),
			host,
		);
		await evaluator.evaluate(
			bashEvent(
				"git push --force # steering-override: no-force-push \u2014 r",
			),
			makeCtx("/r"),
			11,
		);
		assert.equal(host.appended.length, 1);
		const data = host.appended[0]!.data as Record<string, unknown>;
		assert.equal(data["_agentLoopIndex"], 11);
		assert.equal(data["rule"], "no-force-push");
	});

	it('when.happened { event: "steering-override", in: "agent_loop" } filters overrides by current loop (F3)', async () => {
		// Loop 7: override is consumed for no-force-push. A DIFFERENT rule
		// gates on `happened: { steering-override, agent_loop }` — after the
		// override lands in loop 7 it should observe "happened" in loop 7
		// (predicate returns false → rule skips) but NOT in loop 8
		// (predicate returns true → rule fires).
		const host = makeHost();
		const overridableRule: Rule = {
			name: "no-force-push",
			tool: "bash",
			field: "command",
			pattern: "^git\\s+push\\s+--force",
			reason: "no force",
			noOverride: false,
		};
		// "Canary" rule fires on `echo hi` only when NO override-audit
		// entry exists in the current agent loop.
		const canaryRule: Rule = {
			name: "canary",
			tool: "bash",
			field: "command",
			pattern: "^echo",
			reason: "canary",
			when: {
				happened: { event: "steering-override", in: "agent_loop" },
			},
		};
		const evaluator = buildEvaluator(
			{ defaultNoOverride: false, rules: [overridableRule, canaryRule] },
			resolve(),
			host,
		);
		// Loop 7: consume the override.
		const r1 = await evaluator.evaluate(
			bashEvent(
				"git push --force # steering-override: no-force-push \u2014 r",
			),
			makeCtx("/r", host.entries),
			7,
		);
		assert.equal(r1, undefined, "override accepted, no block");

		// Loop 7: canary sees the override → "happened" is true → predicate
		// returns false → rule skips.
		const r2 = await evaluator.evaluate(
			bashEvent("echo hi"),
			makeCtx("/r", host.entries),
			7,
		);
		assert.equal(r2, undefined, "canary skipped in same loop as override");

		// Loop 8: same entries array, but agent_loop scope filters by
		// tag → the loop-7-tagged override is invisible → canary fires.
		const r3 = await evaluator.evaluate(
			bashEvent("echo hi"),
			makeCtx("/r", host.entries),
			8,
		);
		assert.ok(
			r3 && r3.block === true,
			"canary fires in new loop because override is tagged to loop 7",
		);
	});

	it('when.happened { event: "steering-override", in: "session" } sees overrides across loops (F3)', async () => {
		// Session scope ignores the `_agentLoopIndex` tag — any override
		// ever consumed in the session suppresses the canary regardless
		// of which loop produced it.
		const host = makeHost();
		const overridableRule: Rule = {
			name: "no-force-push",
			tool: "bash",
			field: "command",
			pattern: "^git\\s+push\\s+--force",
			reason: "no force",
			noOverride: false,
		};
		const canaryRule: Rule = {
			name: "canary",
			tool: "bash",
			field: "command",
			pattern: "^echo",
			reason: "canary",
			when: { happened: { event: "steering-override", in: "session" } },
		};
		const evaluator = buildEvaluator(
			{ defaultNoOverride: false, rules: [overridableRule, canaryRule] },
			resolve(),
			host,
		);
		await evaluator.evaluate(
			bashEvent(
				"git push --force # steering-override: no-force-push \u2014 r",
			),
			makeCtx("/r", host.entries),
			7,
		);
		const r = await evaluator.evaluate(
			bashEvent("echo hi"),
			makeCtx("/r", host.entries),
			99,
		);
		assert.equal(
			r,
			undefined,
			"session scope: override seen regardless of agent_loop",
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
			"[steering:no-private-key@user] no private keys To override, " +
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
		assert.match(res!.reason!, /\[steering:user-rule@[^\]]+\]/);
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
		assert.match(res!.reason!, /\[steering:r1@[^\]]+\]/);
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
		assert.match(res!.reason!, /\[steering:r2@[^\]]+\]/);
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

	it("invalidates the cache on appendEntry so later reads see the write (S2/E1)", async () => {
		// Within a single rule: read X, write X, read X — the second read
		// must reflect the write. Pre-S2 the cache held the pre-write list
		// and masked the write within one phase.
		let before: number | null = null;
		let after: number | null = null;
		const rule: Rule = {
			name: "s2-single-rule",
			tool: "bash",
			field: "command",
			pattern: "^echo",
			reason: "s2 single",
			when: {
				condition: (ctx) => {
					before = ctx.findEntries("marker").length;
					ctx.appendEntry("marker", { note: "added" });
					after = ctx.findEntries("marker").length;
					return false; // don't fire; we only care about the reads
				},
			},
		};
		const host = makeHost();
		const ctx = makeCtx("/r", host.entries);
		const evaluator = buildEvaluator({ rules: [rule] }, resolve(), host);
		await evaluator.evaluate(bashEvent("echo x"), ctx, 0);
		assert.equal(before, 0, "pre-write read must see zero entries");
		assert.equal(after, 1, "post-write read must see the new entry");
	});

	it("cross-rule: rule A's onFire write is visible to rule B's when.happened (S2/E1)", async () => {
		// Rule A fires and writes "A-fired" via onFire. Rule B's
		// when.happened reads "A-fired" with `in: "agent_loop"` and fires
		// only when the write is NOT present (the built-in `happened`
		// semantics). Pre-S2 the cached read in rule B saw the pre-write
		// snapshot and wrongly fired.
		const ruleA: Rule = {
			name: "a",
			tool: "bash",
			field: "command",
			pattern: "^echo",
			reason: "a fires",
			writes: ["A-fired"],
			onFire: (ctx) => ctx.appendEntry("A-fired", {}),
		};
		const ruleB: Rule = {
			name: "b",
			tool: "bash",
			field: "command",
			pattern: "^echo",
			reason: "b fires only if A has not fired this loop",
			when: { happened: { event: "A-fired", in: "agent_loop" } },
		};
		const host = makeHost();
		const ctx = makeCtx("/r", host.entries);
		const evaluator = buildEvaluator(
			{ rules: [ruleA, ruleB], defaultNoOverride: false },
			resolve(),
			host,
		);
		const result = await evaluator.evaluate(
			bashEvent("echo x"),
			ctx,
			7,
		);
		// Rule A fires first (first-match-wins). Its block verdict is
		// returned; rule B doesn't get to evaluate on this single event.
		assert.ok(result && result.block === true);
		assert.ok(
			/\[steering:a@user\]/.test(result.reason ?? ""),
			`expected rule A to fire; got: ${result.reason}`,
		);
		// The onFire wrote an "A-fired" entry tagged with the current
		// agentLoopIndex. Verify it landed — the cross-rule visibility
		// consequence is demonstrated by the next test.
		assert.equal(host.appended.length, 1);
		assert.equal(host.appended[0]!.type, "A-fired");
	});

	it("the override-audit write in an earlier rule is visible to a later rule's when.happened (S2/E1)", async () => {
		// A rule-level `noOverride: false` rule writes a
		// `steering-override` audit entry when the agent supplies an
		// override comment. A later rule can gate on that via
		// `when.happened: { event: "steering-override", in: "agent_loop" }`.
		// Pre-S2, the later rule's cached findEntries read from before the
		// override wrote would miss the audit entry.
		const overridable: Rule = {
			name: "overridable",
			tool: "bash",
			field: "command",
			pattern: /^git\s+push/,
			reason: "overridable",
			noOverride: false,
		};
		// A second rule that fires ONLY when no steering-override has
		// happened in this agent loop. With S2 in place, the override
		// written by `overridable` invalidates the cache — so this rule
		// sees the fresh entry and its `when.happened` returns false.
		// Pre-S2, the cached read would miss the override write and this
		// rule would wrongly fire.
		const gate: Rule = {
			name: "override-gate",
			tool: "bash",
			field: "command",
			pattern: /^git\s+push/,
			reason: "gate",
			when: {
				happened: { event: "steering-override", in: "agent_loop" },
			},
		};
		const host = makeHost();
		const ctx = makeCtx("/r", host.entries);
		const evaluator = buildEvaluator(
			{ rules: [overridable, gate] },
			resolve(),
			host,
		);
		// Send a command that matches both rules AND carries an override
		// comment addressing `overridable`. The evaluator:
		//   1. Evaluates `overridable` → fires → override comment accepted
		//      → writes steering-override audit entry → returns "overridden".
		//   2. Continues to `gate` → when.happened reads steering-override
		//      — with S2, sees the fresh audit entry → predicate returns
		//      false → rule does NOT fire.
		const result = await evaluator.evaluate(
			bashEvent(
				"git push # steering-override: overridable — shipping a hotfix",
			),
			ctx,
			3,
		);
		assert.equal(
			result,
			undefined,
			"second rule should not fire after the override audit is visible",
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

	it("non-plain-object payloads wrap as { value, _agentLoopIndex } (F2 / G3)", async () => {
		// The naive spread (`{ ...data, ... }`) silently corrupts arrays,
		// Dates, Maps, Sets, Errors, and class instances. Every such
		// input must wrap under `value` with the original reference
		// preserved, same as a primitive.
		const host = makeHost();
		const date = new Date("2020-01-01T00:00:00Z");
		const map = new Map<string, number>([["a", 1]]);
		const set = new Set<number>([1, 2, 3]);
		const err = new Error("boom");
		const fn = () => 42;
		class Box {
			readonly n: number;
			constructor(n: number) {
				this.n = n;
			}
		}
		const box = new Box(7);
		const rule: Rule = {
			name: "tag-nonplain",
			tool: "bash",
			field: "command",
			pattern: "^echo",
			reason: "tag-nonplain",
			when: {
				condition: (ctx) => {
					ctx.appendEntry("arr", [1, 2, 3]);
					ctx.appendEntry("date", date);
					ctx.appendEntry("map", map);
					ctx.appendEntry("set", set);
					ctx.appendEntry("err", err);
					ctx.appendEntry("fn", fn);
					ctx.appendEntry("box", box);
					ctx.appendEntry("nil", null);
					return false;
				},
			},
		};
		const evaluator = buildEvaluator({ rules: [rule] }, resolve(), host);
		await evaluator.evaluate(bashEvent("echo hi"), makeCtx("/r"), 5);
		const byType = new Map(
			host.appended
				.filter((e) =>
					[
						"arr",
						"date",
						"map",
						"set",
						"err",
						"fn",
						"box",
						"nil",
					].includes(e.type),
				)
				.map((e) => [e.type, e.data] as const),
		);
		assert.deepEqual(byType.get("arr"), {
			value: [1, 2, 3],
			_agentLoopIndex: 5,
		});
		assert.deepEqual(byType.get("date"), {
			value: date,
			_agentLoopIndex: 5,
		});
		assert.deepEqual(byType.get("map"), {
			value: map,
			_agentLoopIndex: 5,
		});
		assert.deepEqual(byType.get("set"), {
			value: set,
			_agentLoopIndex: 5,
		});
		assert.deepEqual(byType.get("err"), {
			value: err,
			_agentLoopIndex: 5,
		});
		assert.deepEqual(byType.get("fn"), {
			value: fn,
			_agentLoopIndex: 5,
		});
		assert.deepEqual(byType.get("box"), {
			value: box,
			_agentLoopIndex: 5,
		});
		assert.deepEqual(byType.get("nil"), {
			value: null,
			_agentLoopIndex: 5,
		});
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
		assert.match(res!.reason!, /\[steering:no-force-push@[^\]]+\]/);
	});

	it("block reason is source-tagged with the originating plugin name", async () => {
		const plugin: Plugin = {
			name: "git-plugin",
			rules: [NO_FORCE_PUSH],
		};
		const evaluator = buildEvaluator({}, resolve([plugin]), makeHost());
		const res = await evaluator.evaluate(
			bashEvent("git push --force"),
			makeCtx("/r"),
			0,
		);
		assert.ok(res && res.block === true);
		assert.match(res!.reason!, /^\[steering:no-force-push@git-plugin\]/);
	});

	it("user rules get @user source tag", async () => {
		const rule: Rule = {
			name: "my-rule",
			tool: "bash",
			field: "command",
			pattern: "^git\\s+push",
			reason: "user said so",
		};
		const evaluator = buildEvaluator(
			{ rules: [rule] },
			resolve(),
			makeHost(),
		);
		const res = await evaluator.evaluate(
			bashEvent("git push"),
			makeCtx("/r"),
			0,
		);
		assert.ok(res && res.block === true);
		assert.match(res!.reason!, /^\[steering:my-rule@user\]/);
	});

	it("honors config.disabledRules to skip plugin rule", async () => {
		const plugin: Plugin = {
			name: "p",
			rules: [NO_FORCE_PUSH],
		};
		const cfg: SteeringConfig = { disabledRules: ["no-force-push"] };
		// `resolvePlugins` applies `disabledRules` to plugin rules at merge time.
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

	it("user rule shadows plugin rule with the same name — @user source wins (G4)", async () => {
		// Both rules named "same". User rule is first in `allRules` so
		// first-match-wins returns it. Source-tag must be `@user` — the
		// evaluator keys source-lookup by Rule object identity, not name,
		// so the plugin rule's presence in the list never contaminates
		// the user rule's tag.
		const pluginRule: Rule = {
			name: "same",
			tool: "bash",
			field: "command",
			pattern: "^git\\s+push",
			reason: "plugin",
		};
		const userRule: Rule = {
			name: "same",
			tool: "bash",
			field: "command",
			pattern: "^git\\s+push",
			reason: "user",
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
		assert.ok(res && res.block === true);
		assert.match(res!.reason!, /^\[steering:same@user\]/);
		assert.match(res!.reason!, /user/); // pins which reason text won
	});

	it('disabled plugin rule + user rule with same name → @user still wins (G4)', async () => {
		// Plugin rule is filtered out by `resolvePlugins(... { disable })`.
		// The user rule remains — source tag `@user`.
		const pluginRule: Rule = {
			name: "same",
			tool: "bash",
			field: "command",
			pattern: "^git\\s+push",
			reason: "plugin",
		};
		const userRule: Rule = {
			name: "same",
			tool: "bash",
			field: "command",
			pattern: "^git\\s+push",
			reason: "user",
		};
		const plugin: Plugin = { name: "p", rules: [pluginRule] };
		const cfg: SteeringConfig = {
			rules: [userRule],
			disabledRules: ["same"],
		};
		// resolvePlugins honors config.disabledRules for plugin rules.
		// User rules come through `config.rules` directly — buildEvaluator
		// does NOT filter them on `disabledRules`, so the user rule survives.
		const evaluator = buildEvaluator(
			cfg,
			resolvePlugins([plugin], cfg),
			makeHost(),
		);
		const res = await evaluator.evaluate(
			bashEvent("git push"),
			makeCtx("/r"),
			0,
		);
		assert.ok(res && res.block === true);
		assert.match(res!.reason!, /^\[steering:same@user\]/);
	});

	it("plugin-vs-plugin collision — surviving rule tags with the winning plugin name (G4)", async () => {
		// First-registered plugin wins on name collision (merger emits a
		// soft `rule-collision` warning). Source tag must be the winning
		// plugin's name.
		const p1: Plugin = {
			name: "first",
			rules: [
				{
					name: "dup",
					tool: "bash",
					field: "command",
					pattern: "^git\\s+push",
					reason: "first",
				},
			],
		};
		const p2: Plugin = {
			name: "second",
			rules: [
				{
					name: "dup",
					tool: "bash",
					field: "command",
					pattern: "^git\\s+push",
					reason: "second",
				},
			],
		};
		// `resolvePlugins` warns on rule-name collision; swallow the
		// warning output so the test's stdout stays clean.
		const origWarn = console.warn;
		console.warn = () => {};
		let resolved: ResolvedPluginState;
		try {
			resolved = resolvePlugins([p1, p2], {});
		} finally {
			console.warn = origWarn;
		}
		const evaluator = buildEvaluator({}, resolved, makeHost());
		const res = await evaluator.evaluate(
			bashEvent("git push"),
			makeCtx("/r"),
			0,
		);
		assert.ok(res && res.block === true);
		assert.match(res!.reason!, /^\[steering:dup@first\]/);
	});
});

// ---------------------------------------------------------------------------
// PredicateToolInput bash-only fields: basename + args
// ---------------------------------------------------------------------------

describe("buildEvaluator: PredicateToolInput.basename + args", () => {
	it("bash refs populate basename and args (Word[]) per extracted ref", async () => {
		const seen: PredicateContext[] = [];
		const rule: Rule = {
			name: "peek",
			tool: "bash",
			field: "command",
			pattern: /./,
			reason: "peek",
			when: {
				condition: (ctx) => {
					seen.push(ctx);
					return false; // never fires; only capture the ctx
				},
			},
		};
		const evaluator = buildEvaluator({ rules: [rule] }, resolve(), makeHost());
		await evaluator.evaluate(
			bashEvent("git commit -m 'conventional: subject'"),
			makeCtx("/r"),
			0,
		);
		assert.equal(seen.length, 1);
		const input = seen[0]!.input as {
			tool: "bash";
			command?: string;
			basename?: string;
			args?: ReadonlyArray<{ value?: string; text?: string }>;
		};
		assert.equal(input.basename, "git");
		assert.ok(Array.isArray(input.args));
		assert.equal(input.args!.length, 3);
		// First suffix word = "commit", second = "-m", third = the quoted msg
		assert.equal(input.args![0]!.value ?? input.args![0]!.text, "commit");
		assert.equal(input.args![1]!.value ?? input.args![1]!.text, "-m");
		// Quote-aware: the Word[] preserves the unquoted lexical value
		// rather than munging it into the whitespace-split `command`.
		assert.equal(
			input.args![2]!.value ?? input.args![2]!.text,
			"conventional: subject",
		);
	});

	it("multiple refs each get their own basename + args", async () => {
		const seen: Array<{ basename?: string | undefined; args?: readonly unknown[] | undefined }> = [];
		const rule: Rule = {
			name: "multi",
			tool: "bash",
			field: "command",
			pattern: /./,
			reason: "multi",
			when: {
				condition: (ctx) => {
					const i = ctx.input as {
						basename?: string;
						args?: readonly unknown[];
					};
					seen.push({ basename: i.basename, args: i.args });
					return false;
				},
			},
		};
		const evaluator = buildEvaluator({ rules: [rule] }, resolve(), makeHost());
		await evaluator.evaluate(
			bashEvent("git push && ls -la"),
			makeCtx("/r"),
			0,
		);
		assert.equal(seen.length, 2);
		assert.equal(seen[0]!.basename, "git");
		assert.equal(seen[1]!.basename, "ls");
		assert.equal(seen[0]!.args!.length, 1);
		assert.equal(seen[1]!.args!.length, 1);
	});

	it("write / edit rules leave basename + args undefined", async () => {
		const seenWrite: PredicateContext[] = [];
		const seenEdit: PredicateContext[] = [];
		const writeRule: Rule = {
			name: "w",
			tool: "write",
			field: "content",
			pattern: /./,
			reason: "w",
			when: {
				condition: (ctx) => {
					seenWrite.push(ctx);
					return false;
				},
			},
		};
		const editRule: Rule = {
			name: "e",
			tool: "edit",
			field: "content",
			pattern: /./,
			reason: "e",
			when: {
				condition: (ctx) => {
					seenEdit.push(ctx);
					return false;
				},
			},
		};
		const evaluator = buildEvaluator(
			{ rules: [writeRule, editRule] },
			resolve(),
			makeHost(),
		);
		await evaluator.evaluate(
			{
				type: "tool_call",
				toolName: "write",
				input: { path: "/tmp/x", content: "hi" },
			} as unknown as ToolCallEvent,
			makeCtx("/r"),
			0,
		);
		await evaluator.evaluate(
			{
				type: "tool_call",
				toolName: "edit",
				input: {
					path: "/tmp/x",
					edits: [{ oldText: "a", newText: "b" }],
				},
			} as unknown as ToolCallEvent,
			makeCtx("/r"),
			0,
		);
		assert.equal(seenWrite.length, 1);
		assert.equal(seenEdit.length, 1);
		const w = seenWrite[0]!.input as {
			basename?: string;
			args?: readonly unknown[];
		};
		const e = seenEdit[0]!.input as {
			basename?: string;
			args?: readonly unknown[];
		};
		assert.equal(w.basename, undefined);
		assert.equal(w.args, undefined);
		assert.equal(e.basename, undefined);
		assert.equal(e.args, undefined);
	});

	it("wrapper-expanded refs get their INNER basename + args (G8)", async () => {
		// sh -c 'git commit -m hi' — the outer wrapper ref is `sh`, but
		// the walker expands the inner command. The INNER ref must see
		// basename="git" + quote-aware args [commit, -m, hi], not stay
		// parsed as sh's arguments.
		const seen: Array<{
			basename?: string | undefined;
			args?: readonly unknown[] | undefined;
		}> = [];
		const rule: Rule = {
			name: "peek",
			tool: "bash",
			field: "command",
			pattern: /./,
			reason: "peek",
			when: {
				condition: (ctx) => {
					const i = ctx.input as {
						basename?: string;
						args?: readonly unknown[];
					};
					seen.push({ basename: i.basename, args: i.args });
					return false;
				},
			},
		};
		const evaluator = buildEvaluator({ rules: [rule] }, resolve(), makeHost());
		await evaluator.evaluate(
			bashEvent("sh -c 'git commit -m hi'"),
			makeCtx("/r"),
			0,
		);
		// After wrapper expansion we expect the inner git ref to be
		// present with its own basename / args (the outer sh ref may or
		// may not still be in `seen` depending on the walker's
		// expansion strategy — what matters is that the inner ref's
		// basename + args are exposed).
		const git = seen.find((s) => s.basename === "git");
		assert.ok(git, "expected a git ref after wrapper expansion");
		assert.equal(git!.args!.length, 3);
		const argValues = (
			git!.args as ReadonlyArray<{ value?: string; text?: string }>
		).map((w) => w.value ?? w.text);
		assert.deepEqual(argValues, ["commit", "-m", "hi"]);
	});

	it("absolute-path command has basename stripped (G8)", async () => {
		// ADR §9: /usr/bin/git push → basename "git", args [push].
		const seen: Array<{
			basename?: string | undefined;
			args?: readonly unknown[] | undefined;
		}> = [];
		const rule: Rule = {
			name: "peek",
			tool: "bash",
			field: "command",
			pattern: /./,
			reason: "peek",
			when: {
				condition: (ctx) => {
					const i = ctx.input as {
						basename?: string;
						args?: readonly unknown[];
					};
					seen.push({ basename: i.basename, args: i.args });
					return false;
				},
			},
		};
		const evaluator = buildEvaluator({ rules: [rule] }, resolve(), makeHost());
		await evaluator.evaluate(
			bashEvent("/usr/bin/git push"),
			makeCtx("/r"),
			0,
		);
		assert.equal(seen.length, 1);
		assert.equal(seen[0]!.basename, "git");
		assert.equal(seen[0]!.args!.length, 1);
		const argValues = (
			seen[0]!.args as ReadonlyArray<{ value?: string; text?: string }>
		).map((w) => w.value ?? w.text);
		assert.deepEqual(argValues, ["push"]);
	});
});

// ---------------------------------------------------------------------------
// S1: top-level engine fail-closed + per-predicate isolation coverage
// ---------------------------------------------------------------------------

describe("buildEvaluator: top-level engine failures (S1)", () => {
	it("returns an engine-error block when evaluator scaffolding throws", async () => {
		// Force the engine scaffolding to throw by handing it a ctx whose
		// `cwd` getter throws — createExecCache dereferences `ctx.cwd`
		// SYNCHRONOUSLY at the top of evaluateEventInner, so the throw lands
		// in the outer try/catch (not the per-rule one).
		const rule: Rule = {
			name: "irrelevant",
			tool: "bash",
			field: "command",
			pattern: /./,
			reason: "n/a",
		};
		const evaluator = buildEvaluator(
			{ rules: [rule] },
			resolve(),
			makeHost(),
		);
		const boomCtx = {
			get cwd(): string {
				throw new Error("boom: ctx.cwd read failed");
			},
			sessionManager: {
				getEntries: () => [],
			} as unknown as ReturnType<typeof makeCtx>["sessionManager"],
		} as unknown as ReturnType<typeof makeCtx>;

		const originalError = console.error;
		const errors: string[] = [];
		console.error = (...args: unknown[]) => {
			errors.push(args.map((a) => String(a)).join(" "));
		};
		try {
			const result = await evaluator.evaluate(
				bashEvent("git status"),
				boomCtx,
				0,
			);
			// Fail-closed: return a block with the engine@internal tag so
			// the LLM sees it's an engine-level failure, not a rule match.
			assert.ok(result && result.block === true);
			assert.ok(
				/^\[steering:engine@internal\]/.test(result.reason ?? ""),
				`expected engine@internal tag; got: ${result.reason}`,
			);
			assert.ok(
				/safety measure/.test(result.reason ?? ""),
				`expected safety-measure phrasing; got: ${result.reason}`,
			);
			assert.ok(
				errors.some((e) =>
					/steering engine threw.*boom: ctx\.cwd read failed/.test(e),
				),
				`no matching console.error in:\n${errors.join("\n")}`,
			);
		} finally {
			console.error = originalError;
		}
	});

	it("a throwing predicate does not prevent subsequent rules from evaluating", async () => {
		// Rule A throws in its predicate; rule B is a normal rule that
		// would block on the same command. S1 policy: A is skipped, B still
		// fires. (If S1 instead poisoned the whole evaluate, B wouldn't
		// fire and the test would fail.)
		const ruleA: Rule = {
			name: "a-throws",
			tool: "bash",
			field: "command",
			pattern: /./,
			reason: "a-throws",
			when: {
				condition: () => {
					throw new Error("leaked secret: db-password=hunter2");
				},
			},
		};
		const ruleB: Rule = {
			name: "b-blocks",
			tool: "bash",
			field: "command",
			pattern: /^git\s+push/,
			reason: "b blocks",
		};
		const warnings = captureWarnings();
		try {
			const evaluator = buildEvaluator(
				{ rules: [ruleA, ruleB] },
				resolve(),
				makeHost(),
			);
			const result = await evaluator.evaluate(
				bashEvent("git push"),
				makeCtx("/r"),
				0,
			);
			// Rule B fires (A's throw did NOT poison the chain).
			assert.ok(result && result.block === true);
			assert.ok(
				/\[steering:b-blocks@user\]/.test(result.reason ?? ""),
				`expected b-blocks reason; got: ${result.reason}`,
			);
			// The secret from A's error message is NOT in B's block reason
			// (the whole point of S1). The warning carries it for operators,
			// but the LLM only sees B's reason.
			assert.ok(
				!/hunter2/.test(result.reason ?? ""),
				`block reason leaked the error message: ${result.reason}`,
			);
			assert.ok(
				warnings.some((w) =>
					/predicate threw for rule "a-throws"@user/.test(w),
				),
				`no matching warning in:\n${warnings.join("\n")}`,
			);
		} finally {
			warnings.restore();
		}
	});

	it("surfaces the plugin source in the warning tag for plugin rules", async () => {
		// Rule comes from a plugin; the warning's @source tag must read
		// `@<plugin-name>` (not `@user`). Matches block-reason formatting.
		const pluginRule: Rule = {
			name: "bad-plugin-rule",
			tool: "bash",
			field: "command",
			pattern: /./,
			reason: "bad",
			when: {
				condition: () => {
					throw new Error("plugin predicate bug");
				},
			},
		};
		const plugin: Plugin = {
			name: "my-plugin",
			rules: [pluginRule],
		};
		const warnings = captureWarnings();
		try {
			const evaluator = buildEvaluator(
				{},
				resolve([plugin]),
				makeHost(),
			);
			const result = await evaluator.evaluate(
				bashEvent("anything"),
				makeCtx("/r"),
				0,
			);
			assert.equal(result, undefined);
			assert.ok(
				warnings.some((w) =>
					/predicate threw for rule "bad-plugin-rule"@my-plugin/.test(w),
				),
				`no matching warning in:\n${warnings.join("\n")}`,
			);
		} finally {
			warnings.restore();
		}
	});
});

// ---------------------------------------------------------------------------
// S3: name validation (user-authored rules via buildEvaluator)
// ---------------------------------------------------------------------------

describe("buildEvaluator: user rule-name validation (S3)", () => {
	it("throws when a user-authored rule name contains disallowed chars", () => {
		const rule: Rule = {
			name: "phony] ALL CLEAR [real",
			tool: "bash",
			field: "command",
			pattern: /./,
			reason: "bad",
		};
		assert.throws(
			() => buildEvaluator({ rules: [rule] }, resolve(), makeHost()),
			/rule name "phony\] ALL CLEAR \[real".*disallowed/,
		);
	});

	it("accepts rule names with digits, dashes, underscores", () => {
		const rule: Rule = {
			name: "2026-critical_rule",
			tool: "bash",
			field: "command",
			pattern: /./,
			reason: "ok",
		};
		assert.doesNotThrow(() =>
			buildEvaluator({ rules: [rule] }, resolve(), makeHost()),
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

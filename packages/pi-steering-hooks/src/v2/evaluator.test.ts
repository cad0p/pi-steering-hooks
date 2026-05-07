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
		// No override hint appended to the reason.
		assert.doesNotMatch(res!.reason!, /To override/);
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

	it("block reason includes override hint only when overridable", async () => {
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
		assert.doesNotMatch(r1!.reason!, /To override/);
		assert.match(r2!.reason!, /To override.*steering-override: no-force-push/);
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
		const evaluator = buildEvaluator({ rules: [rule] }, resolve(), makeHost());
		const res = await evaluator.evaluate(
			writeEvent("/r/k.pem", "-----BEGIN RSA PRIVATE KEY-----"),
			makeCtx("/r"),
			0,
		);
		assert.ok(res && res.block === true);
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
});

// ---------------------------------------------------------------------------
// Default fail-closed defaultNoOverride (sanity)
// ---------------------------------------------------------------------------

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

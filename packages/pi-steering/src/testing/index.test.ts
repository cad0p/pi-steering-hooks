// SPDX-License-Identifier: MIT
// Part of pi-steering.

/**
 * Tests for the Phase 5a testing primitives (`./index.ts`).
 *
 * Coverage axis:
 *   - `loadHarness`         — evaluator + dispatcher built from a
 *                              minimal config; includeDefaults on/off;
 *                              plugin merging; config.disabledRules; custom
 *                              host override.
 *   - `mockContext`         — default shape; per-option overrides; exec
 *                              stubbing + unstubbed reject; findEntries
 *                              filter + timestamp parsing; appendEntry
 *                              capture visible via getAppendedEntries.
 *   - `mockObserverContext` — default shape; exec stub pass-through;
 *                              entries/appendEntry capture.
 *   - `getAppendedEntries`  — empty on fresh ctx, populated after
 *                              appendEntry, empty on non-mock ctx.
 *
 * These are UNIT tests against the primitives — they don't exercise
 * the underlying evaluator / observer dispatcher semantics in depth
 * (those are covered in the *.test.ts suites). Here we verify the
 * wrappers assemble the right plumbing.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	createRecordingHost,
	expectAllows,
	expectBlocks,
	expectRuleFires,
	formatMatrix,
	getAppendedEntries,
	loadHarness,
	mockContext,
	mockExtensionContext,
	mockObserverContext,
	runMatrix,
	testObserver,
	testPredicate,
} from "./index.ts";
import type {
	Observer,
	ObserverContext,
	Plugin,
	PredicateContext,
	PredicateHandler,
	Rule,
} from "../schema.ts";
import type { EvaluatorHost } from "../evaluator.ts";

// ---------------------------------------------------------------------------
// Shared stubs
// ---------------------------------------------------------------------------

/**
 * Minimal `ExtensionContext` stub for harness evaluate/dispatch
 * invocations. Only `cwd` + `sessionManager.getEntries` are read by
 * the evaluator pipeline; everything else we leave unset.
 */
function makeExtCtx(cwd = "/repo"): ExtensionContext {
	return {
		cwd,
		sessionManager: {
			getEntries: () => [],
		} as unknown as ExtensionContext["sessionManager"],
	} as ExtensionContext;
}

// ---------------------------------------------------------------------------
// loadHarness
// ---------------------------------------------------------------------------

describe("loadHarness", () => {
	it("builds evaluator + dispatcher from a minimal (empty) config", async () => {
		const h = loadHarness({ config: {} });
		// evaluator fires: allow (no rules → undefined).
		const res = await h.evaluate(
			{
				type: "tool_call",
				toolCallId: "t",
				toolName: "bash",
				input: { command: "echo hi" },
			},
			makeExtCtx(),
			0,
		);
		assert.equal(res, undefined);
		// dispatcher fires: no observers, no throw.
		await h.dispatch(
			{
				type: "tool_result",
				toolCallId: "t",
				toolName: "bash",
				input: { command: "echo hi" },
				content: [{ type: "text", text: "" }],
				isError: false,
				details: { exitCode: 0 },
			} as unknown as Parameters<typeof h.dispatch>[0],
			makeExtCtx(),
			0,
		);
		// Resolved shape is sane.
		assert.deepEqual(h.resolved.rules, []);
		assert.deepEqual(h.resolved.observers, []);
	});

	it("includeDefaults: true injects DEFAULT_RULES (no-force-push fires)", async () => {
		const h = loadHarness({ config: {}, includeDefaults: true });
		const res = await h.evaluate(
			{
				type: "tool_call",
				toolCallId: "t",
				toolName: "bash",
				input: { command: "git push --force" },
			},
			makeExtCtx(),
			0,
		);
		assert.ok(res && res.block === true);
		assert.match(res!.reason!, /\[steering:no-force-push@[^\]]+\]/);
	});

	it("includeDefaults: false (default) does NOT inject defaults", async () => {
		const h = loadHarness({ config: {} });
		const res = await h.evaluate(
			{
				type: "tool_call",
				toolCallId: "t",
				toolName: "bash",
				input: { command: "git push --force" },
			},
			makeExtCtx(),
			0,
		);
		assert.equal(res, undefined);
	});

	it("merges a custom plugin's rules + predicates", async () => {
		// Custom rule + plugin predicate; evaluate a matching bash call.
		const rule: Rule = {
			name: "no-cowsay",
			tool: "bash",
			field: "command",
			pattern: "^cowsay\\b",
			reason: "no cows",
		};
		const plugin: Plugin = {
			name: "petting-zoo",
			predicates: {
				// Loose predicate: always-true; here to verify the merger
				// registered it so `when` can reference it by name.
				always: async () => true,
			},
			rules: [rule],
		};
		const h = loadHarness({ config: { plugins: [plugin] } });
		assert.ok(h.resolved.predicates["always"] !== undefined);
		assert.equal(h.resolved.rules.length, 1);
		assert.equal(h.resolved.rules[0]!.name, "no-cowsay");

		const res = await h.evaluate(
			{
				type: "tool_call",
				toolCallId: "t",
				toolName: "bash",
				input: { command: "cowsay hello" },
			},
			makeExtCtx(),
			0,
		);
		assert.ok(res && res.block === true);
	});

	it("applies config.disabledRules to named rules", async () => {
		const h = loadHarness({
			config: { disabledRules: ["no-force-push"] },
			includeDefaults: true,
		});
		// Rule was filtered out → force-push no longer blocks.
		const res = await h.evaluate(
			{
				type: "tool_call",
				toolCallId: "t",
				toolName: "bash",
				input: { command: "git push --force" },
			},
			makeExtCtx(),
			0,
		);
		assert.equal(res, undefined);
	});

	it("respects a custom host option", async () => {
		let execCalls = 0;
		const host: EvaluatorHost = {
			exec: async () => {
				execCalls++;
				return { stdout: "main", stderr: "", code: 0, killed: false };
			},
			appendEntry: () => {},
		};
		// A rule with a condition that calls ctx.exec.
		const rule: Rule = {
			name: "uses-exec",
			tool: "bash",
			field: "command",
			pattern: "^git\\b",
			reason: "calls exec",
			when: {
				condition: async (ctx) => {
					await ctx.exec("git", ["rev-parse", "HEAD"]);
					return true;
				},
			},
		};
		const h = loadHarness({ config: { rules: [rule] }, host });
		const res = await h.evaluate(
			{
				type: "tool_call",
				toolCallId: "t",
				toolName: "bash",
				input: { command: "git status" },
			},
			makeExtCtx(),
			0,
		);
		assert.ok(res && res.block === true);
		assert.equal(execCalls, 1);
	});

	it("default host's unstubbed exec surfaces as a logged warning (S1)", async () => {
		// S1: a throwing predicate (here: the default host's `exec`
		// throwing 'exec not stubbed') is caught by the evaluator and
		// treated as 'rule did not fire' with a warning log. The test's
		// original intent — 'authors who forget to stub exec see a clear
		// error' — still holds: the warning names the rule + source, and
		// carries the original error message.
		const rule: Rule = {
			name: "uses-exec",
			tool: "bash",
			field: "command",
			pattern: "^git\\b",
			reason: "calls exec",
			when: {
				condition: async (ctx) => {
					await ctx.exec("git", ["rev-parse", "HEAD"]);
					return true;
				},
			},
		};
		const h = loadHarness({ config: { rules: [rule] } });
		const warnings: string[] = [];
		const originalWarn = console.warn;
		console.warn = (...args: unknown[]) => {
			warnings.push(args.map((a) => String(a)).join(" "));
		};
		try {
			const result = await h.evaluate(
				{
					type: "tool_call",
					toolCallId: "t",
					toolName: "bash",
					input: { command: "git status" },
				},
				makeExtCtx(),
				0,
			);
			// Rule does NOT fire (predicate threw → S1 isolates).
			assert.equal(result, undefined);
			// Warning names the rule + the unstubbed-exec message.
			assert.ok(
				warnings.some((w) =>
					/predicate threw for rule "uses-exec".*exec not stubbed/.test(
						w,
					),
				),
				`no matching warning in:\n${warnings.join("\n")}`,
			);
		} finally {
			console.warn = originalWarn;
		}
	});

	it("exposes harness.config reflecting the effective (disable-filtered) state (T3)", () => {
		const harness = loadHarness({
			config: {
				rules: [
					{
						name: "keep-me",
						tool: "bash",
						field: "command",
						pattern: /^keep/,
						reason: "keep",
					},
					{
						name: "drop-me",
						tool: "bash",
						field: "command",
						pattern: /^drop/,
						reason: "drop",
					},
				],
				disabledRules: ["drop-me"],
			},
		});
		// Config mirror is post-filter: only `keep-me` survives in
		// `config.rules`; the `disabledRules` list is preserved for
		// introspection.
		assert.ok(harness.config);
		assert.equal(harness.config.rules?.length, 1);
		assert.equal(harness.config.rules?.[0]?.name, "keep-me");
		assert.deepEqual(harness.config.disabledRules, ["drop-me"]);
	});

	it("exposes harness.resolved with plugin-side rules after merger (T3)", () => {
		const pluginRule = {
			name: "plugin-rule",
			tool: "bash" as const,
			field: "command" as const,
			pattern: /^keep/,
			reason: "plugin",
		};
		const droppedPluginRule = {
			name: "dropped-plugin-rule",
			tool: "bash" as const,
			field: "command" as const,
			pattern: /^drop/,
			reason: "drop",
		};
		const harness = loadHarness({
			config: {
				plugins: [
					{ name: "demo", rules: [pluginRule, droppedPluginRule] },
				],
				disabledRules: ["dropped-plugin-rule"],
			},
		});
		// `resolved` reflects plugin-merger output: plugin-shipped rules
		// after disable filtering. User rules live on `harness.config`,
		// not here.
		const resolvedNames = harness.resolved.rules.map((r) => r.name);
		assert.deepEqual(resolvedNames, ["plugin-rule"]);
		assert.ok(
			!resolvedNames.includes("dropped-plugin-rule"),
			"disabled plugin rule must not appear in resolved state",
		);
	});
});

// ---------------------------------------------------------------------------
// mockContext
// ---------------------------------------------------------------------------

describe("mockContext", () => {
	it("returns a ctx with all required PredicateContext fields populated", () => {
		const ctx = mockContext();
		assert.equal(typeof ctx.cwd, "string");
		assert.equal(ctx.tool, "bash");
		assert.deepEqual(ctx.input, { tool: "bash", command: "" });
		assert.equal(ctx.agentLoopIndex, 0);
		assert.equal(typeof ctx.exec, "function");
		assert.equal(typeof ctx.appendEntry, "function");
		assert.equal(typeof ctx.findEntries, "function");
		assert.deepEqual(ctx.walkerState, { cwd: "/tmp/test" });
	});

	it("applies cwd / agentLoopIndex / tool / input / walkerState overrides", () => {
		const ctx = mockContext({
			cwd: "/work",
			agentLoopIndex: 7,
			tool: "write",
			input: { tool: "write", path: "/a.ts", content: "x" },
			walkerState: { cwd: "/work", branch: "main" },
		});
		assert.equal(ctx.cwd, "/work");
		assert.equal(ctx.agentLoopIndex, 7);
		assert.equal(ctx.tool, "write");
		assert.deepEqual(ctx.input, {
			tool: "write",
			path: "/a.ts",
			content: "x",
		});
		assert.deepEqual(ctx.walkerState, { cwd: "/work", branch: "main" });
	});

	it("derives default input shape per tool", () => {
		const w = mockContext({ tool: "write" });
		assert.deepEqual(w.input, { tool: "write", path: "", content: "" });
		const e = mockContext({ tool: "edit" });
		assert.deepEqual(e.input, { tool: "edit", path: "", edits: [] });
	});

	it("stubs exec: passes through cmd/args/opts", async () => {
		const seen: Array<{
			cmd: string;
			args: readonly string[];
			cwd?: string | undefined;
		}> = [];
		const ctx = mockContext({
			exec: (cmd, args, opts) => {
				seen.push({ cmd, args, cwd: opts?.cwd });
				return { stdout: "ok", stderr: "", exitCode: 0 };
			},
		});
		const r = await ctx.exec("git", ["status"], { cwd: "/x" });
		assert.equal(r.stdout, "ok");
		assert.deepEqual(seen, [
			{ cmd: "git", args: ["status"], cwd: "/x" },
		]);
	});

	it("unstubbed exec rejects with a clear error", async () => {
		const ctx = mockContext();
		await assert.rejects(
			() => ctx.exec("git", ["status"]),
			/mockContext: exec not stubbed/,
		);
	});

	it("findEntries filters by customType and parses timestamps to epoch-ms", () => {
		const iso = "2026-01-02T03:04:05.000Z";
		const ctx = mockContext({
			entries: [
				{
					type: "custom",
					customType: "a",
					data: { v: 1 },
					timestamp: iso,
				},
				{
					type: "custom",
					customType: "b",
					data: { v: 2 },
					timestamp: iso,
				},
				{
					type: "custom",
					customType: "a",
					data: { v: 3 },
					timestamp: "not-a-date",
				},
			],
		});
		const hits = ctx.findEntries<{ v: number }>("a");
		assert.equal(hits.length, 2);
		assert.deepEqual(hits[0]!.data, { v: 1 });
		assert.equal(hits[0]!.timestamp, Date.parse(iso));
		// Unparseable timestamp → 0 (documented fallback).
		assert.equal(hits[1]!.timestamp, 0);
		// No match → empty.
		assert.deepEqual(ctx.findEntries("missing"), []);
	});

	it("appendEntry writes are captured (visible via getAppendedEntries)", () => {
		// Auto-tag: object payloads get `_agentLoopIndex` merged in,
		// bare calls wrap as `{ value: undefined, _agentLoopIndex }`.
		// Same shape the real engine writes (production parity is the
		// whole point of routing through createAppendEntry).
		const ctx = mockContext();
		ctx.appendEntry("x", { a: 1 });
		ctx.appendEntry("y"); // no data — pi allows bare customType.
		const captured = getAppendedEntries(ctx);
		assert.equal(captured.length, 2);
		assert.equal(captured[0]!.customType, "x");
		assert.deepEqual(captured[0]!.data, { a: 1, _agentLoopIndex: 0 });
		assert.equal(captured[1]!.customType, "y");
		assert.deepEqual(captured[1]!.data, {
			value: undefined,
			_agentLoopIndex: 0,
		});
	});

	it("appendEntry auto-tags object payloads with agentLoopIndex (G2)", () => {
		const ctx = mockContext({ agentLoopIndex: 5 });
		ctx.appendEntry("marker", { foo: 1 });
		const entries = getAppendedEntries(ctx);
		assert.deepEqual(entries, [
			{ customType: "marker", data: { foo: 1, _agentLoopIndex: 5 } },
		]);
	});

	it("appendEntry wraps primitive payloads as { value, _agentLoopIndex } (G2)", () => {
		const ctx = mockContext({ agentLoopIndex: 2 });
		ctx.appendEntry("num", 42);
		const entries = getAppendedEntries(ctx);
		assert.deepEqual(entries, [
			{ customType: "num", data: { value: 42, _agentLoopIndex: 2 } },
		]);
	});

	it("appendEntry wraps array payloads (F2 / G2 / G3)", () => {
		const ctx = mockContext({ agentLoopIndex: 5 });
		ctx.appendEntry("items", [1, 2, 3]);
		const entries = getAppendedEntries(ctx);
		assert.deepEqual(entries, [
			{ customType: "items", data: { value: [1, 2, 3], _agentLoopIndex: 5 } },
		]);
	});

	// ---- Chain-aware fields: priorAndChainedRefs + observersByWrittenEvent ----

	it("priorAndChainedRefs defaults to undefined on the returned ctx", () => {
		// Matches the production shape for non-bash candidates or when the
		// evaluator has no prior-&& refs to thread in.
		const ctx = mockContext();
		assert.equal(ctx.priorAndChainedRefs, undefined);
	});

	it("observersByWrittenEvent defaults to undefined on the returned ctx", () => {
		const ctx = mockContext();
		assert.equal(ctx.observersByWrittenEvent, undefined);
	});

	it("threads priorAndChainedRefs through to the ctx (chain-aware scenario)", () => {
		const ctx = mockContext({
			priorAndChainedRefs: [{ text: "sync" }, { text: "echo ok" }],
		});
		assert.deepEqual(ctx.priorAndChainedRefs, [
			{ text: "sync" },
			{ text: "echo ok" },
		]);
	});

	it("threads observersByWrittenEvent through to the ctx (chain-aware scenario)", () => {
		const obs: Observer = {
			name: "test-obs",
			writes: ["X"],
			watch: {
				toolName: "bash",
				inputMatches: { command: /^sync\b/ },
			},
			onResult: () => {},
		};
		const map = new Map<string, readonly Observer[]>([["X", [obs]]]);
		const ctx = mockContext({ observersByWrittenEvent: map });
		assert.equal(ctx.observersByWrittenEvent, map);
		assert.deepEqual(ctx.observersByWrittenEvent?.get("X"), [obs]);
	});

	it("testPredicate forwards chain-aware fields so the built-in happened speculative-allow path can be driven", async () => {
		// Surface-level: a plugin author can write a custom predicate that
		// introspects chain-aware state and exercise it via testPredicate
		// without dropping to loadHarness. Here we simulate a predicate
		// that fires iff at least one prior-&& ref matches an observer
		// writing the requested event — a hand-rolled sketch of the
		// built-in happened speculative-allow path.
		const spyPredicate: PredicateHandler<string> = async (event, ctx) => {
			const obs = ctx.observersByWrittenEvent?.get(event) ?? [];
			const refs = ctx.priorAndChainedRefs ?? [];
			return obs.length > 0 && refs.length > 0;
		};
		const syncObs: Observer = {
			name: "sync-tracker",
			writes: ["SYNC"],
			watch: { toolName: "bash", inputMatches: { command: /^sync\b/ } },
			onResult: () => {},
		};
		const map = new Map<string, readonly Observer[]>([["SYNC", [syncObs]]]);

		const without = await testPredicate(spyPredicate, "SYNC", {});
		assert.equal(without, false, "no chain-aware state → predicate sees nothing");

		const withChain = await testPredicate(spyPredicate, "SYNC", {
			priorAndChainedRefs: [{ text: "sync" }],
			observersByWrittenEvent: map,
		});
		assert.equal(
			withChain,
			true,
			"with both fields populated, the predicate can reason about chain-aware state",
		);
	});
});

// ---------------------------------------------------------------------------
// mockObserverContext
// ---------------------------------------------------------------------------

describe("mockObserverContext", () => {
	it("returns a ctx with all required ObserverContext fields populated", () => {
		const ctx = mockObserverContext();
		assert.equal(ctx.cwd, "/tmp/test");
		assert.equal(ctx.agentLoopIndex, 0);
		assert.equal(typeof ctx.appendEntry, "function");
		assert.equal(typeof ctx.findEntries, "function");
	});

	it("applies cwd / agentLoopIndex / entries overrides", () => {
		const iso = "2026-03-04T05:06:07.000Z";
		const ctx = mockObserverContext({
			cwd: "/work",
			agentLoopIndex: 3,
			entries: [
				{
					type: "custom",
					customType: "seen",
					data: { n: 42 },
					timestamp: iso,
				},
			],
		});
		assert.equal(ctx.cwd, "/work");
		assert.equal(ctx.agentLoopIndex, 3);
		const hits = ctx.findEntries<{ n: number }>("seen");
		assert.equal(hits.length, 1);
		assert.deepEqual(hits[0]!.data, { n: 42 });
		assert.equal(hits[0]!.timestamp, Date.parse(iso));
	});

	it("appendEntry captures are independent per context", () => {
		const a = mockObserverContext({ agentLoopIndex: 0 });
		const b = mockObserverContext({ agentLoopIndex: 0 });
		a.appendEntry("one", { x: 1 });
		b.appendEntry("two", { y: 2 });
		assert.deepEqual(getAppendedEntries(a), [
			{ customType: "one", data: { x: 1, _agentLoopIndex: 0 } },
		]);
		assert.deepEqual(getAppendedEntries(b), [
			{ customType: "two", data: { y: 2, _agentLoopIndex: 0 } },
		]);
	});

	it("observer appendEntry auto-tags with agentLoopIndex (G2)", () => {
		const ctx = mockObserverContext({ agentLoopIndex: 9 });
		ctx.appendEntry("seen", { foo: 1 });
		assert.deepEqual(getAppendedEntries(ctx), [
			{ customType: "seen", data: { foo: 1, _agentLoopIndex: 9 } },
		]);
	});

	it("observer appendEntry wraps primitive payloads (G2)", () => {
		const ctx = mockObserverContext({ agentLoopIndex: 3 });
		ctx.appendEntry("n", 7);
		assert.deepEqual(getAppendedEntries(ctx), [
			{ customType: "n", data: { value: 7, _agentLoopIndex: 3 } },
		]);
	});
});

// ---------------------------------------------------------------------------
// getAppendedEntries
// ---------------------------------------------------------------------------

describe("getAppendedEntries", () => {
	it("returns empty for a freshly-built mockContext (nothing appended yet)", () => {
		const ctx = mockContext();
		assert.deepEqual(getAppendedEntries(ctx), []);
	});

	it("returns writes after ctx.appendEntry calls", () => {
		const ctx = mockContext();
		ctx.appendEntry("x", { a: 1 });
		const captured = getAppendedEntries(ctx);
		assert.deepEqual(captured, [
			{ customType: "x", data: { a: 1, _agentLoopIndex: 0 } },
		]);
	});

	it("returns empty for a non-mock context (safe lookup, no throw)", () => {
		// Craft a minimal non-mock PredicateContext. Shape-only — we never
		// call its methods.
		const adhoc: PredicateContext = {
			cwd: "/",
			tool: "bash",
			input: { tool: "bash", command: "" },
			agentLoopIndex: 0,
			exec: () => Promise.resolve({ stdout: "", stderr: "", exitCode: 0 }),
			appendEntry: () => {},
			findEntries: () => [],
		};
		assert.deepEqual(getAppendedEntries(adhoc), []);
		// Same for an ad-hoc ObserverContext.
		const adhocObs: ObserverContext = {
			cwd: "/",
			agentLoopIndex: 0,
			appendEntry: () => {},
			findEntries: () => [],
		};
		assert.deepEqual(getAppendedEntries(adhocObs), []);
	});

	it("returned snapshot is decoupled from later writes", () => {
		const ctx = mockContext();
		ctx.appendEntry("first");
		const snap = getAppendedEntries(ctx);
		ctx.appendEntry("second");
		// Snapshot captured only the first entry.
		assert.equal(snap.length, 1);
		// Re-reading picks up both.
		assert.equal(getAppendedEntries(ctx).length, 2);
	});
});

// ===========================================================================
// Phase 5b — Convenience wrappers
// ===========================================================================

describe("testPredicate", () => {
	it("returns the predicate's boolean verdict", async () => {
		const alwaysTrue: PredicateHandler<unknown> = async () => true;
		const alwaysFalse: PredicateHandler<unknown> = async () => false;
		assert.equal(await testPredicate(alwaysTrue, null), true);
		assert.equal(await testPredicate(alwaysFalse, null), false);
	});

	it("threads args + ctx (walkerState + exec stub) to the predicate", async () => {
		const branchEq: PredicateHandler<string> = async (arg, ctx) => {
			return ctx.walkerState?.["branch"] === arg;
		};
		const fires = await testPredicate(branchEq, "main", {
			walkerState: { branch: "main" },
		});
		assert.equal(fires, true);
	});

	it("predicates can call stubbed exec via ctx", async () => {
		const readsExec: PredicateHandler<unknown> = async (_, ctx) => {
			const r = await ctx.exec("echo", ["hi"]);
			return r.exitCode === 0;
		};
		const fires = await testPredicate(readsExec, null, {
			exec: () => ({ stdout: "hi", stderr: "", exitCode: 0 }),
		});
		assert.equal(fires, true);
	});
});

describe("testObserver", () => {
	it("fires onResult when watch matches (or watch is absent)", async () => {
		const obs: Observer = {
			name: "all-events",
			onResult: (_evt, ctx) => {
				ctx.appendEntry("seen");
			},
		};
		const { entries, watchMatched } = await testObserver(obs, {
			toolName: "bash",
			input: { command: "ls" },
			output: {},
			exitCode: 0,
		});
		assert.equal(watchMatched, true);
		assert.equal(entries.length, 1);
		assert.equal(entries[0]?.customType, "seen");
	});

	it("does NOT fire onResult when watch filter rejects", async () => {
		const obs: Observer = {
			name: "bash-only",
			watch: { toolName: "bash" },
			onResult: (_evt, ctx) => {
				ctx.appendEntry("seen");
			},
		};
		const { entries, watchMatched } = await testObserver(obs, {
			toolName: "read",
			input: {},
			output: {},
		});
		assert.equal(watchMatched, false);
		assert.equal(entries.length, 0);
	});

	it("watch.inputMatches with absent key is fail-closed", async () => {
		const obs: Observer = {
			name: "cmd-match",
			watch: { inputMatches: { command: /^git/ } },
			onResult: () => {},
		};
		const { watchMatched } = await testObserver(obs, {
			toolName: "read",
			input: {}, // no `command` field
			output: {},
		});
		assert.equal(watchMatched, false);
	});

	it("watch.exitCode: success / failure / numeric / any", async () => {
		const mk = (code: number | "success" | "failure" | "any") => ({
			name: "e" + String(code),
			watch: { exitCode: code },
			onResult: () => {},
		});
		const ok = { toolName: "bash", input: {}, output: {}, exitCode: 0 };
		const fail = {
			toolName: "bash",
			input: {},
			output: {},
			exitCode: 2,
		};
		assert.equal(
			(await testObserver(mk("success"), ok)).watchMatched,
			true,
		);
		assert.equal(
			(await testObserver(mk("success"), fail)).watchMatched,
			false,
		);
		assert.equal(
			(await testObserver(mk("failure"), fail)).watchMatched,
			true,
		);
		assert.equal(
			(await testObserver(mk(2), fail)).watchMatched,
			true,
		);
		assert.equal((await testObserver(mk("any"), fail)).watchMatched, true);
	});

	it("warns when options.exec is set (observers don't see exec)", async () => {
		const obs: Observer = { name: "n", onResult: () => {} };
		const warnings: unknown[][] = [];
		const orig = console.warn;
		console.warn = (...args: unknown[]) => warnings.push(args);
		try {
			await testObserver(
				obs,
				{ toolName: "bash", input: {}, output: {} },
				{ exec: () => ({ stdout: "", stderr: "", exitCode: 0 }) },
			);
		} finally {
			console.warn = orig;
		}
		assert.equal(warnings.length, 1);
		assert.match(String(warnings[0]?.[0] ?? ""), /exec option ignored/);
	});

	it("watch.inputMatches.command is wrapper-aware on bash events (ADR §12)", async () => {
		// Regression test for the former testing-side reimplementation
		// of matchesWatch: it did a raw-string match only, so a watch of
		// `command: /^git commit/` silently missed `sh -c 'git commit ...'`
		// while production correctly fired on it. Now `testObserver`
		// shares `matchesWatch` with the dispatcher so both paths agree.
		const fired: string[] = [];
		const obs: Observer = {
			name: "commit-watcher",
			watch: {
				toolName: "bash",
				inputMatches: { command: /^git commit/ },
			},
			onResult: (evt) => {
				fired.push(String((evt.input as { command?: unknown }).command));
			},
		};

		// Raw match still works (outer command IS `git commit ...`).
		const raw = await testObserver(obs, {
			toolName: "bash",
			input: { command: 'git commit -m "x"' },
			output: {},
			exitCode: 0,
		});
		assert.equal(raw.watchMatched, true);

		// Wrapper-aware: outer is `sh -c '...'`, the inner extracted ref
		// is `git commit -m "x"` — the pattern matches the inner ref, so
		// the observer fires. This previously failed silently under the
		// reimplemented filter.
		const wrapped = await testObserver(obs, {
			toolName: "bash",
			input: { command: `sh -c 'git commit -m "x"'` },
			output: {},
			exitCode: 0,
		});
		assert.equal(wrapped.watchMatched, true);
		assert.equal(fired.length, 2);

		// Negative control: an unrelated outer command doesn't match,
		// even though it's a bash event.
		const miss = await testObserver(obs, {
			toolName: "bash",
			input: { command: "ls -la" },
			output: {},
			exitCode: 0,
		});
		assert.equal(miss.watchMatched, false);
	});
});

describe("expectBlocks / expectAllows / expectRuleFires", () => {
	const blockAllRule: Rule = {
		name: "block-all",
		tool: "bash",
		field: "command",
		pattern: /.*/,
		reason: "test block",
		noOverride: true,
	};

	it("expectBlocks returns result on block", async () => {
		const harness = loadHarness({ config: { rules: [blockAllRule] } });
		const result = await expectBlocks(harness, { command: "anything" });
		assert.ok(result);
		assert.equal(result.block, true);
	});

	it("expectBlocks throws AssertionError on allow", async () => {
		const harness = loadHarness({ config: { rules: [] } });
		await assert.rejects(
			() => expectBlocks(harness, { command: "anything" }),
			/expected block, got allow/,
		);
	});

	it("expectBlocks { rule } asserts rule name match", async () => {
		const harness = loadHarness({ config: { rules: [blockAllRule] } });
		await expectBlocks(harness, { command: "x" }, { rule: "block-all" });
		await assert.rejects(
			() => expectBlocks(harness, { command: "x" }, { rule: "other-rule" }),
			/expected rule "other-rule" to fire/,
		);
	});

	it("expectBlocks { reason: RegExp } asserts reason match", async () => {
		const harness = loadHarness({ config: { rules: [blockAllRule] } });
		await expectBlocks(
			harness,
			{ command: "x" },
			{ reason: /test block/ },
		);
		await assert.rejects(
			() =>
				expectBlocks(
					harness,
					{ command: "x" },
					{ reason: /wrong reason/ },
				),
			/reason did not match/,
		);
	});

	it("expectAllows succeeds on no block", async () => {
		const harness = loadHarness({ config: { rules: [] } });
		await expectAllows(harness, { command: "anything" });
	});

	it("expectAllows throws on block", async () => {
		const harness = loadHarness({ config: { rules: [blockAllRule] } });
		await assert.rejects(
			() => expectAllows(harness, { command: "x" }),
			/expected allow, got block/,
		);
	});

	it("expectRuleFires delegates to expectBlocks { rule }", async () => {
		const harness = loadHarness({ config: { rules: [blockAllRule] } });
		await expectRuleFires(harness, { command: "x" }, "block-all");
		await assert.rejects(
			() => expectRuleFires(harness, { command: "x" }, "nope"),
			/expected rule "nope" to fire/,
		);
	});

	it("accepts a WriteShorthand", async () => {
		const writeBlock: Rule = {
			name: "write-block",
			tool: "write",
			field: "content",
			pattern: /forbidden/,
			reason: "no",
			noOverride: true,
		};
		const harness = loadHarness({ config: { rules: [writeBlock] } });
		await expectBlocks(harness, {
			write: { path: "f.txt", content: "forbidden content" },
		});
		await expectAllows(harness, {
			write: { path: "f.txt", content: "ok content" },
		});
	});
});

describe("runMatrix / formatMatrix", () => {
	const blockAllRule: Rule = {
		name: "block-all",
		tool: "bash",
		field: "command",
		pattern: /.*/,
		reason: "test block",
		noOverride: true,
	};

	it("tallies pass / fail counts", async () => {
		const harness = loadHarness({ config: { rules: [blockAllRule] } });
		const result = await runMatrix(harness, [
			{ name: "a", event: { command: "x" }, expect: "block" },
			{
				name: "b",
				event: { command: "y" },
				expect: { block: true, rule: "block-all" },
			},
			{ name: "c", event: { command: "z" }, expect: "allow" }, // will fail
		]);
		assert.equal(result.total, 3);
		assert.equal(result.passed, 2);
		assert.equal(result.failed, 1);
		assert.equal(result.cases[0]?.passed, true);
		assert.equal(result.cases[1]?.passed, true);
		assert.equal(result.cases[2]?.passed, false);
		assert.match(
			result.cases[2]?.errorMessage ?? "",
			/expected allow.*got block/,
		);
	});

	it("block:{rule} expectation catches wrong-rule fires", async () => {
		const r1: Rule = {
			name: "rule-one",
			tool: "bash",
			field: "command",
			pattern: /^x/,
			reason: "r1",
			noOverride: true,
		};
		const r2: Rule = {
			name: "rule-two",
			tool: "bash",
			field: "command",
			pattern: /^y/,
			reason: "r2",
			noOverride: true,
		};
		const harness = loadHarness({ config: { rules: [r1, r2] } });
		const result = await runMatrix(harness, [
			{
				name: "wrong-rule",
				event: { command: "x" },
				expect: { block: true, rule: "rule-two" }, // r1 fires, not r2
			},
		]);
		assert.equal(result.passed, 0);
		assert.equal(result.failed, 1);
		assert.match(
			result.cases[0]?.errorMessage ?? "",
			/expected rule "rule-two"; got "rule-one"/,
		);
	});

	it("never throws — failures appear in the result", async () => {
		const harness = loadHarness({ config: { rules: [] } });
		// All cases will fail.
		const result = await runMatrix(harness, [
			{ name: "f1", event: { command: "x" }, expect: "block" },
			{ name: "f2", event: { command: "y" }, expect: "block" },
		]);
		assert.equal(result.passed, 0);
		assert.equal(result.failed, 2);
	});

	it("formatMatrix renders a readable report", async () => {
		const harness = loadHarness({ config: { rules: [blockAllRule] } });
		const result = await runMatrix(harness, [
			{ name: "case-a", event: { command: "x" }, expect: "block" },
			{ name: "case-b", event: { command: "y" }, expect: "allow" },
		]);
		const report = formatMatrix(result);
		assert.match(report, /MATRIX — 2 cases\. 1 pass, 1 fail/);
		assert.match(report, /\[case-a\].*expect:block.*actual:BLOCK/);
		assert.match(report, /\[case-b\].*expect:allow.*actual:BLOCK.*FAIL/);
		assert.match(report, /PASS: 1\/2/);
	});
});

// ===========================================================================
// createRecordingHost + mockExtensionContext
// ===========================================================================

describe("createRecordingHost", () => {
	it("returns a host with empty entries / execCalls / appendedEntries", () => {
		const host = createRecordingHost();
		assert.deepEqual(host.entries, []);
		assert.deepEqual(host.execCalls, []);
		assert.deepEqual(host.appendedEntries, []);
		assert.equal(typeof host.exec, "function");
		assert.equal(typeof host.appendEntry, "function");
	});

	it("appendEntry records both raw (appendedEntries) and session-shape (entries) logs", () => {
		const host = createRecordingHost();
		host.appendEntry("marker", { foo: 1 });
		host.appendEntry("marker-bare"); // bare call — pi allows no data.
		assert.equal(host.appendedEntries.length, 2);
		assert.deepEqual(host.appendedEntries[0], {
			type: "marker",
			data: { foo: 1 },
		});
		assert.deepEqual(host.appendedEntries[1], {
			type: "marker-bare",
			data: undefined,
		});

		assert.equal(host.entries.length, 2);
		// Session-shape entries mirror what pi's sessionManager emits:
		// type, customType, data, timestamp, id, parentId.
		assert.equal(host.entries[0]?.type, "custom");
		assert.equal(host.entries[0]?.customType, "marker");
		assert.deepEqual(host.entries[0]?.data, { foo: 1 });
		assert.equal(typeof host.entries[0]?.timestamp, "string");
		assert.match(
			host.entries[0]?.timestamp ?? "",
			/^2026-01-01T00:00:/, // monotonic ISO starting at the 2026-01-01 epoch.
		);
		assert.equal(host.entries[0]?.parentId, null);
		// Timestamps strictly increase so chronological asserts are stable.
		assert.ok(
			(host.entries[0]?.timestamp ?? "") <
				(host.entries[1]?.timestamp ?? ""),
			"entry timestamps should be monotonically increasing",
		);
	});

	it("exec defaults to empty-success, records cmd/args/cwd per call", async () => {
		const host = createRecordingHost();
		const r = await host.exec("git", ["status"], { cwd: "/work" });
		assert.deepEqual(r, {
			stdout: "",
			stderr: "",
			code: 0,
			killed: false,
		});
		assert.equal(host.execCalls.length, 1);
		assert.deepEqual(host.execCalls[0], {
			cmd: "git",
			args: ["status"],
			cwd: "/work",
		});

		// A call without explicit cwd falls back to "/".
		await host.exec("pwd", []);
		assert.equal(host.execCalls[1]?.cwd, "/");
	});

	it("exec override is threaded through, default still records the call", async () => {
		const host = createRecordingHost({
			exec: async (cmd, _args, cwd) => ({
				stdout: `ran:${cmd}@${cwd}`,
				stderr: "",
				code: 0,
				killed: false,
			}),
		});
		const r = await host.exec("echo", ["hi"], { cwd: "/x" });
		assert.equal(r.stdout, "ran:echo@/x");
		assert.equal(host.execCalls.length, 1);
	});

	it("defensively copies args so later mutation doesn't corrupt the record", async () => {
		const host = createRecordingHost();
		const args = ["status"];
		await host.exec("git", args, { cwd: "/x" });
		args.push("--mutated");
		assert.deepEqual(host.execCalls[0]?.args, ["status"]);
	});
});

describe("mockExtensionContext", () => {
	it("exposes cwd + sessionManager.getEntries", () => {
		const entries = [
			{
				type: "custom" as const,
				customType: "seen",
				data: { n: 1 },
				timestamp: "2026-01-01T00:00:00.000Z",
				id: "e1",
				parentId: null,
			},
		];
		const ctx = mockExtensionContext("/repo", entries);
		assert.equal(ctx.cwd, "/repo");
		assert.deepEqual(ctx.sessionManager.getEntries(), entries);
	});

	it("defaults entries to an empty array when omitted", () => {
		const ctx = mockExtensionContext("/repo");
		assert.deepEqual(ctx.sessionManager.getEntries(), []);
	});

	it("round-trips: host.appendEntry writes visible via ctx.sessionManager.getEntries", () => {
		// The core contract: feeding `host.entries` into the ctx lets
		// the engine's writes flow back into its subsequent reads.
		const host = createRecordingHost();
		const ctx = mockExtensionContext("/repo", host.entries);

		assert.deepEqual(ctx.sessionManager.getEntries(), []);
		host.appendEntry("mark", { a: 1 });
		const read = ctx.sessionManager.getEntries();
		assert.equal(read.length, 1);
		const first = read[0];
		assert.ok(first && first.type === "custom");
		assert.equal(first.customType, "mark");
		assert.deepEqual(first.data, { a: 1 });

		host.appendEntry("mark", { a: 2 });
		assert.equal(ctx.sessionManager.getEntries().length, 2);
	});

	it("drives harness.evaluate + harness.dispatch end-to-end with a shared entries store", async () => {
		// Demonstrates the intended plugin-author usage pattern:
		// harness + recording host + shared ctx lets a test assert on
		// the cross-hook observer → evaluator handoff without any
		// `as any` escape hatches.
		const rule: Rule = {
			name: "needs-mark",
			tool: "bash",
			field: "command",
			pattern: /^git pu/,
			reason: "needs mark",
			noOverride: true,
			when: {
				// Default `when.happened` semantic: fires when the type has
				// NOT been written in the scope (ADR §5).
				happened: { event: "test-passed", in: "agent_loop" },
			},
		};
		const observer: Observer = {
			name: "test-tracker",
			watch: { toolName: "bash", inputMatches: { command: /^npm test/ } },
			onResult: (_evt, obsCtx) => {
				obsCtx.appendEntry("test-passed", {});
			},
		};

		const host = createRecordingHost();
		const ctx = mockExtensionContext("/repo", host.entries);
		const harness = loadHarness({
			config: { rules: [rule], observers: [observer] },
			host,
		});

		// Without a prior test-passed entry, the guarded command blocks.
		const blocked = await harness.evaluate(
			{
				type: "tool_call",
				toolCallId: "tc1",
				toolName: "bash",
				input: { command: "git pu origin feat/x" },
			} as unknown as Parameters<typeof harness.evaluate>[0],
			ctx,
			0,
		);
		assert.ok(blocked && blocked.block === true);

		// Dispatch an `npm test` success → observer records test-passed.
		await harness.dispatch(
			{
				type: "tool_result",
				toolCallId: "tc1",
				toolName: "bash",
				input: { command: "npm test" },
				content: [],
				details: { exitCode: 0 },
			} as unknown as Parameters<typeof harness.dispatch>[0],
			ctx,
			0,
		);
		assert.ok(
			host.entries.some((e) => e.customType === "test-passed"),
			"observer should have recorded a test-passed entry",
		);

		// Subsequent guarded command in the same agent loop passes.
		const allowed = await harness.evaluate(
			{
				type: "tool_call",
				toolCallId: "tc2",
				toolName: "bash",
				input: { command: "git pu origin feat/x" },
			} as unknown as Parameters<typeof harness.evaluate>[0],
			ctx,
			0,
		);
		assert.equal(allowed, undefined);
	});
});

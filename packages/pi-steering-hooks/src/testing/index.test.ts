// SPDX-License-Identifier: MIT
// Part of @cad0p/pi-steering-hooks.

/**
 * Tests for the Phase 5a testing primitives (`./index.ts`).
 *
 * Coverage axis:
 *   - `loadHarness`         — evaluator + dispatcher built from a
 *                              minimal config; includeDefaults on/off;
 *                              plugin merging; config.disable; custom
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
 * (those are covered in the v2/*.test.ts suites). Here we verify the
 * wrappers assemble the right plumbing.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
	getAppendedEntries,
	loadHarness,
	mockContext,
	mockObserverContext,
} from "./index.ts";
import type {
	ObserverContext,
	Plugin,
	PredicateContext,
	Rule,
} from "../v2/schema.ts";
import type { EvaluatorHost } from "../v2/evaluator.ts";

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
		assert.match(res!.reason!, /\[steering:no-force-push\]/);
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

	it("applies config.disable to named rules", async () => {
		const h = loadHarness({
			config: { disable: ["no-force-push"] },
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

	it("default host's unstubbed exec rejects with a clear error", async () => {
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
		await assert.rejects(
			() =>
				h.evaluate(
					{
						type: "tool_call",
						toolCallId: "t",
						toolName: "bash",
						input: { command: "git status" },
					},
					makeExtCtx(),
					0,
				),
			/exec not stubbed/,
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
		assert.equal(ctx.turnIndex, 0);
		assert.equal(typeof ctx.exec, "function");
		assert.equal(typeof ctx.appendEntry, "function");
		assert.equal(typeof ctx.findEntries, "function");
		assert.deepEqual(ctx.walkerState, { cwd: "/tmp/test" });
	});

	it("applies cwd / turnIndex / tool / input / walkerState overrides", () => {
		const ctx = mockContext({
			cwd: "/work",
			turnIndex: 7,
			tool: "write",
			input: { tool: "write", path: "/a.ts", content: "x" },
			walkerState: { cwd: "/work", branch: "main" },
		});
		assert.equal(ctx.cwd, "/work");
		assert.equal(ctx.turnIndex, 7);
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
		const ctx = mockContext();
		ctx.appendEntry("x", { a: 1 });
		ctx.appendEntry("y"); // no data — pi allows bare customType.
		const captured = getAppendedEntries(ctx);
		assert.equal(captured.length, 2);
		assert.equal(captured[0]!.customType, "x");
		assert.deepEqual(captured[0]!.data, { a: 1 });
		assert.equal(captured[1]!.customType, "y");
		assert.equal(captured[1]!.data, undefined);
	});
});

// ---------------------------------------------------------------------------
// mockObserverContext
// ---------------------------------------------------------------------------

describe("mockObserverContext", () => {
	it("returns a ctx with all required ObserverContext fields populated", () => {
		const ctx = mockObserverContext();
		assert.equal(ctx.cwd, "/tmp/test");
		assert.equal(ctx.turnIndex, 0);
		assert.equal(typeof ctx.appendEntry, "function");
		assert.equal(typeof ctx.findEntries, "function");
	});

	it("applies cwd / turnIndex / entries overrides", () => {
		const iso = "2026-03-04T05:06:07.000Z";
		const ctx = mockObserverContext({
			cwd: "/work",
			turnIndex: 3,
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
		assert.equal(ctx.turnIndex, 3);
		const hits = ctx.findEntries<{ n: number }>("seen");
		assert.equal(hits.length, 1);
		assert.deepEqual(hits[0]!.data, { n: 42 });
		assert.equal(hits[0]!.timestamp, Date.parse(iso));
	});

	it("appendEntry captures are independent per context", () => {
		const a = mockObserverContext();
		const b = mockObserverContext();
		a.appendEntry("one", { x: 1 });
		b.appendEntry("two", { y: 2 });
		assert.deepEqual(getAppendedEntries(a), [
			{ customType: "one", data: { x: 1 } },
		]);
		assert.deepEqual(getAppendedEntries(b), [
			{ customType: "two", data: { y: 2 } },
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
		assert.deepEqual(captured, [{ customType: "x", data: { a: 1 } }]);
	});

	it("returns empty for a non-mock context (safe lookup, no throw)", () => {
		// Craft a minimal non-mock PredicateContext. Shape-only — we never
		// call its methods.
		const adhoc: PredicateContext = {
			cwd: "/",
			tool: "bash",
			input: { tool: "bash", command: "" },
			turnIndex: 0,
			exec: () => Promise.resolve({ stdout: "", stderr: "", exitCode: 0 }),
			appendEntry: () => {},
			findEntries: () => [],
		};
		assert.deepEqual(getAppendedEntries(adhoc), []);
		// Same for an ad-hoc ObserverContext.
		const adhocObs: ObserverContext = {
			cwd: "/",
			turnIndex: 0,
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

// SPDX-License-Identifier: MIT
// Part of @cad0p/pi-steering-hooks.

/**
 * Tests for the v2 observer dispatcher (`buildObserverDispatcher`).
 *
 * Covers the semantics the ADR pins down for observer watch filters
 * and dispatch behaviour:
 *
 *   - no watch → fires on every tool_result,
 *   - toolName filter,
 *   - inputMatches (single + multi-key, absent keys fail-closed),
 *   - exitCode classification ("success" / "failure" / numeric / "any"),
 *   - observer throws → caught + logged, rest still fire,
 *   - appendEntry → visible to subsequent findEntries reads,
 *   - user observers fire before plugin observers (ordering),
 *   - plugin observers still fire without user observers,
 *   - dedup by name (user observer of the same name wins).
 */

import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import type {
	ExtensionContext,
	ToolResultEvent,
} from "@mariozechner/pi-coding-agent";
import {
	buildObserverDispatcher,
	type EvaluatorHost,
} from "./observer-dispatcher.ts";
import { resolvePlugins } from "./plugin-merger.ts";
import type { Observer, Plugin } from "./schema.ts";

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

/**
 * Minimal `ExtensionContext` stub. The dispatcher reads `cwd` and
 * `sessionManager.getEntries()` only; everything else is stubbed to
 * throw so accidental dependencies surface loudly.
 */
function makeCtx(
	cwd: string,
	entries: ReadonlyArray<{
		type: "custom";
		customType: string;
		data: unknown;
		timestamp: string;
		id: string;
		parentId: string | null;
	}> = [],
): ExtensionContext {
	return {
		cwd,
		sessionManager: {
			getEntries: () => entries,
		} as unknown as ExtensionContext["sessionManager"],
	} as ExtensionContext;
}

/**
 * Tracked host: observers' appendEntry calls are visible on
 * `host.appended` for assertions, and `host.entries` mirrors what a
 * subsequent `findEntries` read would see (wire into makeCtx when
 * asserting cross-observer visibility).
 */
interface TrackedHost extends EvaluatorHost {
	readonly appended: Array<{ type: string; data: unknown }>;
	readonly entries: Array<{
		type: "custom";
		customType: string;
		data: unknown;
		timestamp: string;
		id: string;
		parentId: string | null;
	}>;
}

function makeHost(): TrackedHost {
	const appended: Array<{ type: string; data: unknown }> = [];
	const entries: TrackedHost["entries"] = [];
	let idCounter = 0;
	return {
		appended,
		entries,
		exec: async () => ({ stdout: "", stderr: "", code: 0, killed: false }),
		appendEntry: (type, data) => {
			appended.push({ type, data });
			entries.push({
				type: "custom",
				customType: type,
				data,
				timestamp: new Date(
					Date.UTC(2026, 0, 1, 0, 0, idCounter++),
				).toISOString(),
				id: `e-${idCounter}`,
				parentId: null,
			});
		},
	};
}

function bashResult(
	command: string,
	exitCode: number,
): ToolResultEvent {
	return {
		type: "tool_result",
		toolCallId: "t",
		toolName: "bash",
		input: { command },
		content: [{ type: "text", text: "" }],
		isError: exitCode !== 0,
		details: {
			command,
			cwd: "/r",
			exitCode,
			stdout: "",
			stderr: "",
			durationMs: 0,
		},
	} as ToolResultEvent;
}

function writeResult(
	path: string,
	content: string,
): ToolResultEvent {
	return {
		type: "tool_result",
		toolCallId: "t",
		toolName: "write",
		input: { path, content },
		content: [{ type: "text", text: "" }],
		isError: false,
		details: undefined,
	} as ToolResultEvent;
}

// ---------------------------------------------------------------------------
// No-watch observers
// ---------------------------------------------------------------------------

describe("buildObserverDispatcher: no watch", () => {
	it("fires on every tool_result event", async () => {
		let count = 0;
		const obs: Observer = {
			name: "all",
			onResult: () => {
				count++;
			},
		};
		const dispatcher = buildObserverDispatcher(
			resolvePlugins([], {}),
			[obs],
			makeHost(),
		);
		await dispatcher.dispatch(bashResult("ls", 0), makeCtx("/r"), 0);
		await dispatcher.dispatch(writeResult("/r/a", "x"), makeCtx("/r"), 0);
		assert.equal(count, 2);
	});
});

// ---------------------------------------------------------------------------
// watch.toolName
// ---------------------------------------------------------------------------

describe("buildObserverDispatcher: watch.toolName", () => {
	it("fires only on matching toolName", async () => {
		let bashCount = 0;
		let writeCount = 0;
		const obsBash: Observer = {
			name: "b",
			watch: { toolName: "bash" },
			onResult: () => {
				bashCount++;
			},
		};
		const obsWrite: Observer = {
			name: "w",
			watch: { toolName: "write" },
			onResult: () => {
				writeCount++;
			},
		};
		const dispatcher = buildObserverDispatcher(
			resolvePlugins([], {}),
			[obsBash, obsWrite],
			makeHost(),
		);
		await dispatcher.dispatch(bashResult("ls", 0), makeCtx("/r"), 0);
		await dispatcher.dispatch(writeResult("/r/a", "x"), makeCtx("/r"), 0);
		assert.equal(bashCount, 1);
		assert.equal(writeCount, 1);
	});
});

// ---------------------------------------------------------------------------
// watch.inputMatches
// ---------------------------------------------------------------------------

describe("buildObserverDispatcher: watch.inputMatches", () => {
	it("single-key regex partial-matches input string", async () => {
		let count = 0;
		const obs: Observer = {
			name: "o",
			watch: {
				toolName: "bash",
				inputMatches: { command: /git push/ },
			},
			onResult: () => {
				count++;
			},
		};
		const dispatcher = buildObserverDispatcher(
			resolvePlugins([], {}),
			[obs],
			makeHost(),
		);
		await dispatcher.dispatch(
			bashResult("git push origin main", 0),
			makeCtx("/r"),
			0,
		);
		await dispatcher.dispatch(bashResult("git status", 0), makeCtx("/r"), 0);
		assert.equal(count, 1);
	});

	it("multi-key filter: ALL keys must match", async () => {
		let count = 0;
		const obs: Observer = {
			name: "o",
			watch: {
				toolName: "write",
				inputMatches: { path: /\/config\//, content: /api_key/ },
			},
			onResult: () => {
				count++;
			},
		};
		const dispatcher = buildObserverDispatcher(
			resolvePlugins([], {}),
			[obs],
			makeHost(),
		);
		// Both match → fires.
		await dispatcher.dispatch(
			writeResult("/r/config/app.yml", "api_key: X"),
			makeCtx("/r"),
			0,
		);
		// path doesn't match → skipped.
		await dispatcher.dispatch(
			writeResult("/r/lib/app.yml", "api_key: X"),
			makeCtx("/r"),
			0,
		);
		// content doesn't match → skipped.
		await dispatcher.dispatch(
			writeResult("/r/config/app.yml", "foo: bar"),
			makeCtx("/r"),
			0,
		);
		assert.equal(count, 1);
	});

	it("inputMatches key absent from event → filter fails (fail-closed)", async () => {
		let count = 0;
		const obs: Observer = {
			name: "o",
			// `bogus` isn't a real bash input field.
			watch: {
				toolName: "bash",
				inputMatches: { bogus: /anything/ },
			},
			onResult: () => {
				count++;
			},
		};
		const dispatcher = buildObserverDispatcher(
			resolvePlugins([], {}),
			[obs],
			makeHost(),
		);
		await dispatcher.dispatch(bashResult("ls", 0), makeCtx("/r"), 0);
		assert.equal(count, 0);
	});

	it("string pattern form compiles + matches", async () => {
		let count = 0;
		const obs: Observer = {
			name: "o",
			watch: {
				toolName: "bash",
				inputMatches: { command: "^git\\s+push\\b" },
			},
			onResult: () => {
				count++;
			},
		};
		const dispatcher = buildObserverDispatcher(
			resolvePlugins([], {}),
			[obs],
			makeHost(),
		);
		await dispatcher.dispatch(bashResult("git push origin", 0), makeCtx("/r"), 0);
		await dispatcher.dispatch(bashResult("echo git push", 0), makeCtx("/r"), 0);
		assert.equal(count, 1);
	});
});

// ---------------------------------------------------------------------------
// watch.exitCode
// ---------------------------------------------------------------------------

describe("buildObserverDispatcher: watch.exitCode", () => {
	it("'success' matches exit 0 only", async () => {
		let count = 0;
		const obs: Observer = {
			name: "o",
			watch: { toolName: "bash", exitCode: "success" },
			onResult: () => {
				count++;
			},
		};
		const dispatcher = buildObserverDispatcher(
			resolvePlugins([], {}),
			[obs],
			makeHost(),
		);
		await dispatcher.dispatch(bashResult("ok", 0), makeCtx("/r"), 0);
		await dispatcher.dispatch(bashResult("ok", 1), makeCtx("/r"), 0);
		assert.equal(count, 1);
	});

	it("'failure' matches any non-zero exit", async () => {
		let count = 0;
		const obs: Observer = {
			name: "o",
			watch: { toolName: "bash", exitCode: "failure" },
			onResult: () => {
				count++;
			},
		};
		const dispatcher = buildObserverDispatcher(
			resolvePlugins([], {}),
			[obs],
			makeHost(),
		);
		await dispatcher.dispatch(bashResult("ok", 0), makeCtx("/r"), 0);
		await dispatcher.dispatch(bashResult("fail", 1), makeCtx("/r"), 0);
		await dispatcher.dispatch(bashResult("fail", 127), makeCtx("/r"), 0);
		assert.equal(count, 2);
	});

	it("numeric exitCode matches exact", async () => {
		let count = 0;
		const obs: Observer = {
			name: "o",
			watch: { toolName: "bash", exitCode: 127 },
			onResult: () => {
				count++;
			},
		};
		const dispatcher = buildObserverDispatcher(
			resolvePlugins([], {}),
			[obs],
			makeHost(),
		);
		await dispatcher.dispatch(bashResult("x", 127), makeCtx("/r"), 0);
		await dispatcher.dispatch(bashResult("x", 1), makeCtx("/r"), 0);
		assert.equal(count, 1);
	});

	it("'any' matches every exit code", async () => {
		let count = 0;
		const obs: Observer = {
			name: "o",
			watch: { toolName: "bash", exitCode: "any" },
			onResult: () => {
				count++;
			},
		};
		const dispatcher = buildObserverDispatcher(
			resolvePlugins([], {}),
			[obs],
			makeHost(),
		);
		await dispatcher.dispatch(bashResult("x", 0), makeCtx("/r"), 0);
		await dispatcher.dispatch(bashResult("x", 42), makeCtx("/r"), 0);
		assert.equal(count, 2);
	});

	it("omitted exitCode matches every exit code", async () => {
		let count = 0;
		const obs: Observer = {
			name: "o",
			watch: { toolName: "bash" },
			onResult: () => {
				count++;
			},
		};
		const dispatcher = buildObserverDispatcher(
			resolvePlugins([], {}),
			[obs],
			makeHost(),
		);
		await dispatcher.dispatch(bashResult("x", 0), makeCtx("/r"), 0);
		await dispatcher.dispatch(bashResult("x", 1), makeCtx("/r"), 0);
		assert.equal(count, 2);
	});

	it("numeric exitCode on non-bash event never matches", async () => {
		let count = 0;
		const obs: Observer = {
			name: "o",
			watch: { toolName: "write", exitCode: 0 },
			onResult: () => {
				count++;
			},
		};
		const dispatcher = buildObserverDispatcher(
			resolvePlugins([], {}),
			[obs],
			makeHost(),
		);
		await dispatcher.dispatch(writeResult("/r/a", "x"), makeCtx("/r"), 0);
		assert.equal(count, 0);
	});
});

// ---------------------------------------------------------------------------
// multiple observers + fault isolation
// ---------------------------------------------------------------------------

describe("buildObserverDispatcher: multiple observers", () => {
	it("every matching observer fires on one event", async () => {
		let a = 0;
		let b = 0;
		const obs: Observer[] = [
			{ name: "a", onResult: () => void a++ },
			{ name: "b", onResult: () => void b++ },
		];
		const dispatcher = buildObserverDispatcher(
			resolvePlugins([], {}),
			obs,
			makeHost(),
		);
		await dispatcher.dispatch(bashResult("ls", 0), makeCtx("/r"), 0);
		assert.equal(a, 1);
		assert.equal(b, 1);
	});

	it("observer that throws is caught; subsequent observers still run", async () => {
		let laterCount = 0;
		const obs: Observer[] = [
			{
				name: "throws",
				onResult: () => {
					throw new Error("boom");
				},
			},
			{ name: "later", onResult: () => void laterCount++ },
		];
		// Silence console.warn so the test output stays clean.
		const warn = mock.method(console, "warn", () => {});
		const dispatcher = buildObserverDispatcher(
			resolvePlugins([], {}),
			obs,
			makeHost(),
		);
		await dispatcher.dispatch(bashResult("ls", 0), makeCtx("/r"), 0);
		assert.equal(laterCount, 1);
		assert.equal(warn.mock.callCount(), 1);
		assert.match(
			String(warn.mock.calls[0]!.arguments[0]),
			/observer "throws" threw/,
		);
		warn.mock.restore();
	});

	it("async observer rejection is caught too", async () => {
		let laterCount = 0;
		const obs: Observer[] = [
			{
				name: "throws-async",
				onResult: async () => {
					throw new Error("boom-async");
				},
			},
			{ name: "later", onResult: () => void laterCount++ },
		];
		const warn = mock.method(console, "warn", () => {});
		const dispatcher = buildObserverDispatcher(
			resolvePlugins([], {}),
			obs,
			makeHost(),
		);
		await dispatcher.dispatch(bashResult("ls", 0), makeCtx("/r"), 0);
		assert.equal(laterCount, 1);
		assert.equal(warn.mock.callCount(), 1);
		warn.mock.restore();
	});
});

// ---------------------------------------------------------------------------
// appendEntry + findEntries interaction
// ---------------------------------------------------------------------------

describe("buildObserverDispatcher: appendEntry + findEntries", () => {
	it("observer appendEntry is visible to subsequent findEntries on the same ctx", async () => {
		const host = makeHost();
		const ctx = makeCtx("/r", host.entries);

		let seenAcross: Array<{ data: unknown }> = [];
		const obs: Observer[] = [
			{
				name: "writer",
				watch: { toolName: "bash" },
				onResult: (_e, ctx) => {
					ctx.appendEntry("marker", { n: 1 });
				},
			},
			{
				name: "reader",
				watch: { toolName: "bash" },
				onResult: (_e, ctx) => {
					seenAcross = ctx.findEntries<{ n: number }>("marker");
				},
			},
		];
		const dispatcher = buildObserverDispatcher(
			resolvePlugins([], {}),
			obs,
			host,
		);
		await dispatcher.dispatch(bashResult("ls", 0), ctx, 7);
		assert.equal(host.appended.length, 1);
		assert.equal(seenAcross.length, 1);
		assert.deepEqual(seenAcross[0]!.data, { n: 1 });
	});

	it("observerCtx.turnIndex is threaded from dispatch args", async () => {
		let seen = -1;
		const obs: Observer = {
			name: "t",
			onResult: (_e, ctx) => {
				seen = ctx.turnIndex;
			},
		};
		const dispatcher = buildObserverDispatcher(
			resolvePlugins([], {}),
			[obs],
			makeHost(),
		);
		await dispatcher.dispatch(bashResult("x", 0), makeCtx("/r"), 42);
		assert.equal(seen, 42);
	});
});

// ---------------------------------------------------------------------------
// user / plugin merge + ordering
// ---------------------------------------------------------------------------

describe("buildObserverDispatcher: user + plugin merge", () => {
	it("user observers fire BEFORE plugin observers on the same event", async () => {
		const order: string[] = [];
		const userObs: Observer = {
			name: "user",
			onResult: () => {
				order.push("user");
			},
		};
		const plugin: Plugin = {
			name: "p",
			observers: [
				{
					name: "plugin",
					onResult: () => {
						order.push("plugin");
					},
				},
			],
		};
		const dispatcher = buildObserverDispatcher(
			resolvePlugins([plugin], {}),
			[userObs],
			makeHost(),
		);
		await dispatcher.dispatch(bashResult("ls", 0), makeCtx("/r"), 0);
		assert.deepEqual(order, ["user", "plugin"]);
	});

	it("plugin observers fire when user observers empty", async () => {
		let hits = 0;
		const plugin: Plugin = {
			name: "p",
			observers: [{ name: "plug", onResult: () => void hits++ }],
		};
		const dispatcher = buildObserverDispatcher(
			resolvePlugins([plugin], {}),
			[],
			makeHost(),
		);
		await dispatcher.dispatch(bashResult("ls", 0), makeCtx("/r"), 0);
		assert.equal(hits, 1);
	});

	it("user observer with same name as plugin observer wins (dedup)", async () => {
		const order: string[] = [];
		const user: Observer = {
			name: "both",
			onResult: () => {
				order.push("user");
			},
		};
		const plugin: Plugin = {
			name: "p",
			observers: [
				{
					name: "both",
					onResult: () => {
						order.push("plugin");
					},
				},
			],
		};
		const dispatcher = buildObserverDispatcher(
			resolvePlugins([plugin], {}),
			[user],
			makeHost(),
		);
		await dispatcher.dispatch(bashResult("ls", 0), makeCtx("/r"), 0);
		// Only user fires; plugin-side duplicate is suppressed.
		assert.deepEqual(order, ["user"]);
	});
});

// ---------------------------------------------------------------------------
// Event shape visible to handlers
// ---------------------------------------------------------------------------

describe("buildObserverDispatcher: schema event shape", () => {
	it("handler sees toolName / input / output / exitCode (bash)", async () => {
		let captured: unknown = null;
		const obs: Observer = {
			name: "capture",
			onResult: (e) => {
				captured = e;
			},
		};
		const dispatcher = buildObserverDispatcher(
			resolvePlugins([], {}),
			[obs],
			makeHost(),
		);
		await dispatcher.dispatch(bashResult("whoami", 0), makeCtx("/r"), 0);
		const ev = captured as {
			toolName: string;
			input: unknown;
			output: unknown;
			exitCode?: number;
		};
		assert.equal(ev.toolName, "bash");
		assert.deepEqual(ev.input, { command: "whoami" });
		assert.equal(ev.exitCode, 0);
		assert.ok(Array.isArray(ev.output));
	});

	it("non-bash event has undefined exitCode", async () => {
		let captured: unknown = null;
		const obs: Observer = {
			name: "capture",
			onResult: (e) => {
				captured = e;
			},
		};
		const dispatcher = buildObserverDispatcher(
			resolvePlugins([], {}),
			[obs],
			makeHost(),
		);
		await dispatcher.dispatch(writeResult("/r/a", "x"), makeCtx("/r"), 0);
		const ev = captured as { exitCode?: number };
		assert.equal(ev.exitCode, undefined);
	});
});

// Keep the pi `ToolResultEvent` import from appearing unused if future
// refactors remove the event-shape test above.
const _resultTypeKeepalive = null as unknown as ToolResultEvent | null;
void _resultTypeKeepalive;

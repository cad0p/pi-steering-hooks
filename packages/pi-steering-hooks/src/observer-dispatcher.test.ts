// SPDX-License-Identifier: MIT
// Part of pi-steering.

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
import type { ToolResultEvent } from "@earendil-works/pi-coding-agent";
import {
	makeCtx,
	makeTrackedHost as makeHost,
} from "./__test-helpers__.ts";
import {
	buildObserverDispatcher,
} from "./observer-dispatcher.ts";
import { resolvePlugins } from "./plugin-merger.ts";
import type { Observer, Plugin } from "./schema.ts";

// ---------------------------------------------------------------------------
// Event builders
// ---------------------------------------------------------------------------
//
// Tool-result event shape helpers stay local to this file — they're
// genuinely different from the tool_call event builders in
// evaluator.test.ts and don't share a helper surface.

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
// watch.inputMatches.command — wrapper-aware matching (ADR §12)
// ---------------------------------------------------------------------------
//
// `inputMatches.command` matches against the outer raw command AND
// against walker-extracted ref texts. So `sh -c 'git commit …'` with an
// anchored `/^git\s+commit/` pattern fires the observer — which is what
// rule authors intuitively expect once they've seen the evaluator treat
// the inner `git commit` as its own ref. Parse happens at most once
// per dispatch regardless of how many observers share the filter shape.

describe(
	"buildObserverDispatcher: watch.inputMatches.command — wrapper-aware",
	() => {
		it("matches `git commit` inside `sh -c '…'` (WRAP-1)", async () => {
			let count = 0;
			const obs: Observer = {
				name: "o",
				watch: {
					toolName: "bash",
					inputMatches: { command: /^git\s+commit/ },
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
				bashResult("sh -c 'git commit -m x'", 0),
				makeCtx("/r"),
				0,
			);
			assert.equal(count, 1);
		});

		it("matches `git push` inside `sudo …` (WRAP-2)", async () => {
			let count = 0;
			const obs: Observer = {
				name: "o",
				watch: {
					toolName: "bash",
					inputMatches: { command: /^git\s+push/ },
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
				bashResult("sudo git push", 0),
				makeCtx("/r"),
				0,
			);
			assert.equal(count, 1);
		});

		it("raw unwrapped command still matches (no regression)", async () => {
			let count = 0;
			const obs: Observer = {
				name: "o",
				watch: {
					toolName: "bash",
					inputMatches: { command: /^git\s+commit/ },
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
				bashResult("git commit -m x", 0),
				makeCtx("/r"),
				0,
			);
			assert.equal(count, 1);
		});

		it("quoted text inside `echo '…'` does NOT fire (echo is not a wrapper)", async () => {
			let count = 0;
			const obs: Observer = {
				name: "o",
				watch: {
					toolName: "bash",
					inputMatches: { command: /^git\s+commit/ },
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
			// The walker extracts `echo` as the basename; the quoted arg is
			// text data, not a command ref. Anchored `/^git\s+commit/`
			// matches neither the raw `echo 'git commit'` nor the
			// `echo git commit` ref text.
			await dispatcher.dispatch(
				bashResult("echo 'git commit'", 0),
				makeCtx("/r"),
				0,
			);
			assert.equal(count, 0);
		});

		it("matches an inner ref in a `cd A && git push` chain", async () => {
			let count = 0;
			const obs: Observer = {
				name: "o",
				watch: {
					toolName: "bash",
					inputMatches: { command: /^git\s+push/ },
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
			// Outer raw command starts with `cd` — only the extracted
			// `git push` ref hits the anchored pattern.
			await dispatcher.dispatch(
				bashResult("cd /tmp && git push", 0),
				makeCtx("/r"),
				0,
			);
			assert.equal(count, 1);
		});

		it("inputMatches.path + inputMatches.command both enforced (AND)", async () => {
			// When both keys are present and only one has wrapper analogue
			// (command), make sure the other (path) still fails-closed on
			// non-matching events.
			let count = 0;
			const obs: Observer = {
				name: "o",
				watch: {
					toolName: "bash",
					inputMatches: {
						command: /^git\s+commit/,
						path: /matches-nothing/,
					},
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
			// command matches via wrapper-aware expansion, but path is
			// absent from bash events — AND-semantics still rejects.
			await dispatcher.dispatch(
				bashResult("sh -c 'git commit -m x'", 0),
				makeCtx("/r"),
				0,
			);
			assert.equal(count, 0);
		});

		it("non-bash tool with inputMatches.command skips parse (perf guard)", async () => {
			// inputMatches.command doesn't exist on write/edit events, so
			// the key absence fails fail-closed BEFORE any parseBash call.
			// Pin that behaviour by asserting the observer doesn't fire.
			let count = 0;
			const obs: Observer = {
				name: "o",
				watch: {
					inputMatches: { command: /./ },
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
			await dispatcher.dispatch(writeResult("/r/a", "x"), makeCtx("/r"), 0);
			assert.equal(count, 0);
		});
	},
);

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
		// Observer appendEntry auto-tags with the current agentLoopIndex so
		// rules using `when.happened` can filter by scope. The reader sees
		// the tagged shape via findEntries.
		assert.deepEqual(seenAcross[0]!.data, { n: 1, _agentLoopIndex: 7 });
	});

	it("observerCtx.agentLoopIndex is threaded from dispatch args", async () => {
		let seen = -1;
		const obs: Observer = {
			name: "t",
			onResult: (_e, ctx) => {
				seen = ctx.agentLoopIndex;
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

	it("observer appendEntry auto-injects _agentLoopIndex into object payloads", async () => {
		const host = makeHost();
		const obs: Observer = {
			name: "w",
			onResult: (_e, ctx) => {
				ctx.appendEntry("marker", { foo: "bar" });
			},
		};
		const dispatcher = buildObserverDispatcher(
			resolvePlugins([], {}),
			[obs],
			host,
		);
		await dispatcher.dispatch(bashResult("x", 0), makeCtx("/r"), 9);
		assert.equal(host.appended.length, 1);
		assert.deepEqual(host.appended[0]!.data, {
			foo: "bar",
			_agentLoopIndex: 9,
		});
	});

	it("observer appendEntry wraps primitive / undefined payloads as { value, _agentLoopIndex }", async () => {
		const host = makeHost();
		const obs: Observer = {
			name: "w",
			onResult: (_e, ctx) => {
				ctx.appendEntry("no-data");
				ctx.appendEntry("str", "hello");
				ctx.appendEntry("num", 42);
			},
		};
		const dispatcher = buildObserverDispatcher(
			resolvePlugins([], {}),
			[obs],
			host,
		);
		await dispatcher.dispatch(bashResult("x", 0), makeCtx("/r"), 3);
		assert.equal(host.appended.length, 3);
		assert.deepEqual(host.appended[0]!.data, {
			value: undefined,
			_agentLoopIndex: 3,
		});
		assert.deepEqual(host.appended[1]!.data, {
			value: "hello",
			_agentLoopIndex: 3,
		});
		assert.deepEqual(host.appended[2]!.data, {
			value: 42,
			_agentLoopIndex: 3,
		});
	});

	it("cross-observer: appendEntry invalidates a sibling observer's cached findEntries read (S2/E1)", async () => {
		// Three observers firing on the same event:
		//   1. reader1  — reads "marker", caches the empty list.
		//   2. writer   — appendEntry("marker", …).
		//   3. reader2  — reads "marker" again.
		// Pre-S2: reader2 saw the cached empty list because the cache was
		// not invalidated on write. With S2, writer's appendEntry drops
		// the "marker" cache slot so reader2 re-reads sessionManager and
		// sees the fresh entry.
		const host = makeHost();
		const ctx = makeCtx("/r", host.entries);
		let reader1Count: number | null = null;
		let reader2Count: number | null = null;
		const obs: Observer[] = [
			{
				name: "reader1",
				onResult: (_e, c) => {
					reader1Count = c.findEntries("marker").length;
				},
			},
			{
				name: "writer",
				onResult: (_e, c) => {
					c.appendEntry("marker", { n: 1 });
				},
			},
			{
				name: "reader2",
				onResult: (_e, c) => {
					reader2Count = c.findEntries("marker").length;
				},
			},
		];
		const dispatcher = buildObserverDispatcher(
			resolvePlugins([], {}),
			obs,
			host,
		);
		await dispatcher.dispatch(bashResult("ls", 0), ctx, 5);
		assert.equal(reader1Count, 0, "reader1 before the write sees zero");
		assert.equal(
			reader2Count,
			1,
			"reader2 after the write must see the fresh entry (S2/E1)",
		);
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

// ---------------------------------------------------------------------------
// S3: name validation (user-supplied observers via buildObserverDispatcher)
// ---------------------------------------------------------------------------

describe("buildObserverDispatcher: user observer-name validation (S3)", () => {
	it("throws when a user observer name contains disallowed chars", () => {
		const obs: Observer = {
			name: "bad name",
			onResult: () => {},
		};
		assert.throws(
			() =>
				buildObserverDispatcher(resolvePlugins([], {}), [obs], makeHost()),
			/observer name "bad name".*disallowed/,
		);
	});
});

// Keep the pi `ToolResultEvent` import from appearing unused if future
// refactors remove the event-shape test above.
const _resultTypeKeepalive = null as unknown as ToolResultEvent | null;
void _resultTypeKeepalive;

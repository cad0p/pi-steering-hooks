// SPDX-License-Identifier: MIT
// Part of pi-steering.

/**
 * Tests for `requireKnownState` / `requireKnownCwd`.
 *
 * The wrappers have a tiny surface: fire (return `true`) on any
 * listed walker-state dimension being `"unknown"`, otherwise
 * delegate. The tests pin each arm — fires on unknown cwd, fires on
 * unknown branch when branch is listed, delegates when every
 * dimension is known, and the edge cases (empty dimension list,
 * missing walkerState entirely, async handler).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type {
	PredicateContext,
	PredicateHandler,
	WhenWalkerState,
} from "../schema.ts";
import {
	requireKnownCwd,
	requireKnownState,
} from "./require-known-state.ts";

// ---------------------------------------------------------------------------
// Context builder
// ---------------------------------------------------------------------------

/**
 * Build a minimal {@link PredicateContext} stub with a user-supplied
 * `walkerState` override. All non-walker fields are stubbed to
 * throw-safe defaults; these tests never invoke `exec` /
 * `appendEntry` / `findEntries` on the stub.
 */
function makeCtx(
	walkerState?: Record<string, unknown>,
): PredicateContext {
	return {
		cwd: "/fake",
		tool: "bash",
		input: { tool: "bash", command: "" },
		agentLoopIndex: 0,
		exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
		appendEntry: () => {},
		findEntries: () => [],
		...(walkerState !== undefined
			? {
					walkerState: walkerState as Readonly<WhenWalkerState>,
				}
			: {}),
	};
}

// ---------------------------------------------------------------------------
// requireKnownState / requireKnownCwd
// ---------------------------------------------------------------------------

describe("requireKnownState", () => {
	it("fires when cwd is unknown, bypassing the wrapped handler", async () => {
		let calls = 0;
		const inner: PredicateHandler<boolean> = (_args, _ctx) => {
			calls += 1;
			return false;
		};
		const wrapped = requireKnownState<boolean>(inner, ["cwd"]);
		const ctx = makeCtx({ cwd: "unknown", env: new Map() });

		assert.equal(await wrapped(true, ctx), true);
		assert.equal(await wrapped(false, ctx), true);
		assert.equal(
			calls,
			0,
			"wrapped handler must not run when any listed dimension is unknown",
		);
	});

	it("fires when a listed dimension (branch) is unknown", async () => {
		let calls = 0;
		const inner: PredicateHandler<boolean> = () => {
			calls += 1;
			return false;
		};
		const wrapped = requireKnownState<boolean>(inner, ["branch"]);
		const ctx = makeCtx({
			cwd: "/known",
			env: new Map(),
			branch: "unknown",
		});

		assert.equal(await wrapped(true, ctx), true);
		assert.equal(calls, 0);
	});

	it("delegates to the handler when every listed dimension is known", async () => {
		let seenArgs: string | null = null;
		const inner: PredicateHandler<string> = (args, _ctx) => {
			seenArgs = args;
			return args === "match";
		};
		const wrapped = requireKnownState<string>(inner, ["cwd", "branch"]);
		const ctx = makeCtx({
			cwd: "/repo",
			env: new Map(),
			branch: "feat-foo",
		});

		assert.equal(await wrapped("match", ctx), true);
		assert.equal(seenArgs, "match");
		assert.equal(await wrapped("other", ctx), false);
	});

	it("fires when one of several listed dimensions is unknown", async () => {
		let calls = 0;
		const inner: PredicateHandler<void> = () => {
			calls += 1;
			return false;
		};
		const wrapped = requireKnownState<void>(inner, [
			"cwd",
			"branch",
			"upstream",
		]);
		// cwd + upstream resolved, branch unknown → must fire.
		const ctx = makeCtx({
			cwd: "/repo",
			env: new Map(),
			branch: "unknown",
			upstream: "origin/main",
		});

		assert.equal(await wrapped(undefined, ctx), true);
		assert.equal(calls, 0);
	});

	it("empty dimensions list always delegates to the handler", async () => {
		// Edge case: no dimensions means no "unknown" can trigger a
		// fire, so the wrapper is a passthrough. Documented here so a
		// refactor that short-circuits empty lists (e.g. early
		// `return true`) fails loud.
		let calls = 0;
		const inner: PredicateHandler<boolean> = (args, _ctx) => {
			calls += 1;
			return args;
		};
		const wrapped = requireKnownState<boolean>(inner, []);
		const ctxUnknown = makeCtx({ cwd: "unknown", env: new Map() });
		const ctxKnown = makeCtx({ cwd: "/repo", env: new Map() });

		assert.equal(await wrapped(true, ctxUnknown), true);
		assert.equal(await wrapped(false, ctxUnknown), false);
		assert.equal(await wrapped(true, ctxKnown), true);
		assert.equal(calls, 3);
	});

	it("delegates when walkerState is absent (write / edit tool)", async () => {
		// `write` / `edit` rules have no walker invocation;
		// `ctx.walkerState` is `undefined`. The wrapper must not throw
		// on the undefined access and must forward to the handler.
		let calls = 0;
		const inner: PredicateHandler<boolean> = (args, _ctx) => {
			calls += 1;
			return args;
		};
		const wrapped = requireKnownState<boolean>(inner, ["cwd"]);
		const ctx = makeCtx(undefined);

		assert.equal(await wrapped(true, ctx), true);
		assert.equal(await wrapped(false, ctx), false);
		assert.equal(calls, 2);
	});

	it("awaits async handlers and returns their result verbatim", async () => {
		const inner: PredicateHandler<number> = async (args, _ctx) => {
			// Micro-task gap to ensure the wrapper truly awaits.
			await Promise.resolve();
			return args % 2 === 0;
		};
		const wrapped = requireKnownState<number>(inner, ["cwd"]);
		const ctx = makeCtx({ cwd: "/repo", env: new Map() });

		assert.equal(await wrapped(2, ctx), true);
		assert.equal(await wrapped(3, ctx), false);
	});

	it("preserves handler return value (true) when delegating", async () => {
		// Pins that the wrapper doesn't force-coerce a truthy-but-non-
		// boolean return or swallow the handler's `true` case. Combined
		// with the "other" → false assertion in the 'delegates' test
		// above, both boolean outcomes are covered.
		const inner: PredicateHandler<void> = () => true;
		const wrapped = requireKnownState<void>(inner, ["cwd"]);
		const ctx = makeCtx({ cwd: "/repo", env: new Map() });
		assert.equal(await wrapped(undefined, ctx), true);
	});
});

describe("requireKnownCwd (shorthand)", () => {
	it("behaves identically to requireKnownState(handler, ['cwd'])", async () => {
		let calls = 0;
		const inner: PredicateHandler<boolean> = (args) => {
			calls += 1;
			return args;
		};
		const wrapped = requireKnownCwd<boolean>(inner);
		const ctxUnknown = makeCtx({ cwd: "unknown", env: new Map() });
		const ctxKnown = makeCtx({ cwd: "/repo", env: new Map() });

		assert.equal(await wrapped(false, ctxUnknown), true);
		assert.equal(calls, 0);

		assert.equal(await wrapped(true, ctxKnown), true);
		assert.equal(await wrapped(false, ctxKnown), false);
		assert.equal(calls, 2);
	});
});

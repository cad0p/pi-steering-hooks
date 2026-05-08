// SPDX-License-Identifier: MIT
// Part of the pi-steering work-item-plugin example.

/**
 * Integration tests for `push-requires-tests`.
 *
 * Exercises the observer → rule handoff end-to-end via `loadHarness`:
 *
 *   1. Push without a prior TEST_PASSED_TYPE entry → block.
 *   2. Dispatch an `npm test` success event through the harness →
 *      the observer writes TEST_PASSED_TYPE into the session entries.
 *   3. Push in the same agent loop → allow.
 *
 * Step (2) uses `harness.dispatch` — the same call production uses on
 * `tool_result`. `createRecordingHost` + `mockExtensionContext` share
 * a single entries array so writes via `harness.dispatch` flow back
 * into `harness.evaluate`'s view of the session.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	createRecordingHost,
	expectAllows,
	expectBlocks,
	loadHarness,
	mockExtensionContext,
} from "pi-steering/testing";
import type { Plugin } from "pi-steering";
import {
	npmTestTracker,
	TEST_PASSED_TYPE,
} from "../observers/npm-test-tracker.ts";
import { pushRequiresTests } from "./push-requires-tests.ts";

/**
 * Minimal plugin with just the observer we care about. Keeps the
 * test focused.
 */
const testPlugin: Plugin = {
	name: "test",
	observers: [npmTestTracker],
};

describe("push-requires-tests", () => {
	it("blocks git push when no TEST_PASSED entry exists", async () => {
		const harness = loadHarness({
			config: {
				plugins: [testPlugin],
				rules: [pushRequiresTests],
			},
		});
		await expectBlocks(
			harness,
			{ command: "git push origin feat/x" },
			{ rule: "push-requires-tests" },
		);
	});

	it("does NOT fire on unrelated commands", async () => {
		const harness = loadHarness({
			config: {
				plugins: [testPlugin],
				rules: [pushRequiresTests],
			},
		});
		await expectAllows(harness, { command: "git status" });
	});

	it("allows git push after observer records a TEST_PASSED entry", async () => {
		// Recording host + shared ExtensionContext: writes via
		// host.appendEntry (from the dispatcher) flow into
		// ctx.sessionManager.getEntries so the later evaluate() sees
		// the TEST_PASSED entry the observer recorded. Mirrors the
		// bridge the real pi runtime builds in `src/index.ts`.
		const host = createRecordingHost();
		const ctx = mockExtensionContext("/tmp/test", host.entries);

		const harness = loadHarness({
			config: {
				plugins: [testPlugin],
				rules: [pushRequiresTests],
			},
			host,
		});

		// Simulate: pi emits a tool_result for a successful `npm test`.
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

		// The observer should have written TEST_PASSED_TYPE.
		assert.ok(
			host.entries.some((e) => e.customType === TEST_PASSED_TYPE),
			"observer did not record TEST_PASSED_TYPE",
		);

		// Now the push should be allowed — the rule's
		// `when.happened` finds the entry in the current agent loop.
		const result = await harness.evaluate(
			{
				type: "tool_call",
				toolCallId: "tc2",
				toolName: "bash",
				input: { command: "git push origin feat/x" },
			} as unknown as Parameters<typeof harness.evaluate>[0],
			ctx,
			0,
		);
		assert.equal(result, undefined);
	});
});

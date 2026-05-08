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
 * `tool_result`. The harness's default host captures writes via its
 * internal appendEntry stub; for this test we need real session-
 * entry visibility, so we wire a custom host that backs both
 * `appendEntry` and a replayable entry log used for `findEntries`.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	expectAllows,
	expectBlocks,
	loadHarness,
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
		// Wire a custom session-state store so writes via the
		// dispatcher's appendEntry flow back into findEntries via the
		// ExtensionContext we pass to evaluate(). Mirrors the bridge
		// the real pi runtime builds in `src/index.ts`.
		const sessionEntries: Array<{
			type: "custom";
			customType: string;
			data: unknown;
			timestamp: string;
		}> = [];

		const host = {
			exec: () =>
				Promise.reject(new Error("exec not stubbed in this test")),
			appendEntry: (type: string, data?: unknown) => {
				sessionEntries.push({
					type: "custom",
					customType: type,
					data,
					timestamp: new Date().toISOString(),
				});
			},
		};

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
				// biome-ignore lint/suspicious/noExplicitAny: test-shape
			} as any,
			// Minimal ExtensionContext — evaluator reads only cwd and
			// sessionManager.getEntries here.
			// biome-ignore lint/suspicious/noExplicitAny: test-shape
			{
				cwd: "/tmp/test",
				sessionManager: { getEntries: () => sessionEntries },
				// biome-ignore lint/suspicious/noExplicitAny: test-shape
			} as any,
			0,
		);

		// The observer should have written TEST_PASSED_TYPE.
		assert.ok(
			sessionEntries.some((e) => e.customType === TEST_PASSED_TYPE),
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
				// biome-ignore lint/suspicious/noExplicitAny: test-shape
			} as any,
			// biome-ignore lint/suspicious/noExplicitAny: test-shape
			{
				cwd: "/tmp/test",
				sessionManager: { getEntries: () => sessionEntries },
				// biome-ignore lint/suspicious/noExplicitAny: test-shape
			} as any,
			0,
		);
		assert.equal(result, undefined);
	});
});

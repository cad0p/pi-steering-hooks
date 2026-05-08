// SPDX-License-Identifier: MIT
// Part of the pi-steering work-item-plugin example.

/**
 * Plugin-level integration test.
 *
 * Wires the WHOLE plugin (not just one rule at a time) and exercises
 * a few end-to-end scenarios. Each per-file test already covers unit
 * behavior; this suite's job is to catch wiring-level regressions —
 * e.g. the predicate not being registered, a rule not being listed,
 * the observer's `writes` declaration not threading through.
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
import workItemPlugin, {
	TEST_PASSED_TYPE,
	DESCRIPTION_REVIEWED_TYPE,
} from "./index.ts";

describe("work-item-plugin (end-to-end)", () => {
	it("registers the expected predicates, rules, observers", () => {
		assert.equal(workItemPlugin.name, "work-item");
		assert.ok(workItemPlugin.predicates?.workItemFormat);
		assert.equal(workItemPlugin.rules?.length, 3);
		assert.equal(workItemPlugin.observers?.length, 1);

		const ruleNames = workItemPlugin.rules?.map((r) => r.name);
		assert.deepEqual(ruleNames, [
			"commit-requires-work-item",
			"push-requires-tests",
			"commit-description-check",
		]);

		const observerNames = workItemPlugin.observers?.map((o) => o.name);
		assert.deepEqual(observerNames, ["npm-test-tracker"]);
	});

	it("blocks a commit without a work-item tag", async () => {
		const harness = loadHarness({
			config: { plugins: [workItemPlugin] },
		});
		await expectBlocks(
			harness,
			{ command: 'git commit -m "feat: add thing"' },
			{ rule: "commit-requires-work-item" },
		);
	});

	it("blocks git push when tests haven't passed this loop", async () => {
		const harness = loadHarness({
			config: { plugins: [workItemPlugin] },
		});
		await expectBlocks(
			harness,
			{ command: "git push" },
			{ rule: "push-requires-tests" },
		);
	});

	it("allows a well-formed commit after description-check self-marks", async () => {
		// This test is intentionally the FULL happy-path: block on
		// first commit (description-check fires), self-mark, then
		// allow the second commit that carries a [PROJ-N] tag.
		const host = createRecordingHost();
		const ctx = mockExtensionContext("/tmp/test", host.entries);
		const harness = loadHarness({
			config: { plugins: [workItemPlugin] },
			host,
		});

		// First: commit-description-check fires and self-marks.
		const first = await harness.evaluate(
			{
				type: "tool_call",
				toolCallId: "tc1",
				toolName: "bash",
				input: { command: 'git commit -m "feat: [PROJ-1] work"' },
			} as unknown as Parameters<typeof harness.evaluate>[0],
			ctx,
			1,
		);
		assert.ok(
			first !== undefined && first !== null,
			"first commit should block on the reminder",
		);
		assert.ok(
			host.entries.some(
				(e) => e.customType === DESCRIPTION_REVIEWED_TYPE,
			),
			"DESCRIPTION_REVIEWED_TYPE should be present after onFire",
		);

		// Second: well-formed commit passes. `commit-requires-work-item`
		// also runs; message has the tag so it's fine.
		const second = await harness.evaluate(
			{
				type: "tool_call",
				toolCallId: "tc2",
				toolName: "bash",
				input: { command: 'git commit -m "feat: [PROJ-1] work"' },
			} as unknown as Parameters<typeof harness.evaluate>[0],
			ctx,
			1,
		);
		assert.equal(
			second,
			undefined,
			"second well-formed commit should pass",
		);
	});

	it("dispatch → evaluate: npm test success unblocks git push in the same loop", async () => {
		const host = createRecordingHost();
		const ctx = mockExtensionContext("/tmp/test", host.entries);
		const harness = loadHarness({
			config: { plugins: [workItemPlugin] },
			host,
		});

		// Fire npm test success through the dispatcher — observer
		// writes TEST_PASSED_TYPE into the shared entries store.
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
			7,
		);
		assert.ok(
			host.entries.some((e) => e.customType === TEST_PASSED_TYPE),
			"observer should have written TEST_PASSED_TYPE",
		);

		// Push now allowed — tests passed this loop.
		const pushResult = await harness.evaluate(
			{
				type: "tool_call",
				toolCallId: "tc2",
				toolName: "bash",
				input: { command: "git push" },
			} as unknown as Parameters<typeof harness.evaluate>[0],
			ctx,
			7,
		);
		assert.equal(
			pushResult,
			undefined,
			"push-requires-tests should not fire after npm test succeeded",
		);
	});

	it("does not fire on unrelated commands", async () => {
		const harness = loadHarness({
			config: { plugins: [workItemPlugin] },
		});
		await expectAllows(harness, { command: "ls -la" });
	});
});

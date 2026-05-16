// SPDX-License-Identifier: MIT
// Part of pi-steering-flags.

/**
 * End-to-end test: load the plugin via `defineConfig` + `loadHarness`,
 * drive synthetic bash events through the full evaluator, confirm the
 * predicates wire up through the standard `when.<key>` lookup path.
 *
 * If these fail, the plugin's predicate names / arg shapes are
 * mismatched against how the engine merges plugins. Deeper unit tests
 * live in the per-predicate test files.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { defineConfig } from "pi-steering";
import {
	expectAllows,
	expectBlocks,
	loadHarness,
} from "pi-steering/testing";
import flagsPlugin from "./index.ts";

describe("pi-steering-flags plugin (e2e)", () => {
	it("requiresFlag: blocks when flag is missing, allows when present", async () => {
		const config = defineConfig({
			plugins: [flagsPlugin],
			rules: [
				{
					name: "aws-requires-profile",
					tool: "bash",
					field: "command",
					pattern: /^aws\b/,
					when: { requiresFlag: { flag: "--profile", env: "AWS_PROFILE" } },
					reason: "aws requires --profile",
				},
			],
		});
		const harness = loadHarness({ config });

		await expectBlocks(harness, { command: "aws s3 ls" });

		await expectAllows(harness, {
			command: "aws s3 ls --profile dev",
		});

		await expectAllows(harness, {
			command: "AWS_PROFILE=dev aws s3 ls",
		});
	});

	it("allowlistedFlagsOnly: blocks unknown flags, allows allowlisted", async () => {
		const config = defineConfig({
			plugins: [flagsPlugin],
			rules: [
				{
					name: "cr-allowlisted",
					tool: "bash",
					field: "command",
					pattern: /^cr\b/,
					when: {
						allowlistedFlagsOnly: { allow: ["--all", "--description"] },
					},
					reason: "only --all / --description permitted",
				},
			],
		});
		const harness = loadHarness({ config });

		await expectAllows(harness, {
			command: "cr --all --description foo.md",
		});

		await expectBlocks(harness, {
			command: "cr --publish --description foo.md",
		});
	});

	it("combines with Rule.unless (INFO_ONLY carve-out)", async () => {
		const config = defineConfig({
			plugins: [flagsPlugin],
			rules: [
				{
					name: "cr-allowlisted-help-ok",
					tool: "bash",
					field: "command",
					pattern: /^cr\b/,
					unless: /(^|\s)(-h|--help)\b/,
					when: {
						allowlistedFlagsOnly: { allow: ["--description"] },
					},
					reason: "disallowed flag",
				},
			],
		});
		const harness = loadHarness({ config });

		// --publish would normally fire, but --help carves out.
		await expectAllows(harness, { command: "cr --help --publish" });

		// Without --help, the disallowed flag fires.
		await expectBlocks(harness, { command: "cr --publish" });
	});
});

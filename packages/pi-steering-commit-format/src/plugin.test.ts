// SPDX-License-Identifier: MIT
// Part of pi-steering-commit-format.

/**
 * Tests for the default `commitFormatPlugin`.
 *
 * Pin: registers under name `"commit-format"`; `commitFormat`
 * predicate accepts `["conventional", "jira"]` and validates correctly
 * via the registered registry.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mockContext } from "pi-steering/testing";
import type { PredicateContext } from "pi-steering";
import { commitFormatPlugin } from "./plugin.ts";

function ctxWithCommand(command: string): PredicateContext {
	return mockContext({
		tool: "bash",
		input: { tool: "bash", command },
	});
}

describe("commitFormatPlugin", () => {
	it("registers under the name `commit-format`", () => {
		assert.equal(commitFormatPlugin.name, "commit-format");
	});

	it("exposes a `commitFormat` predicate", () => {
		assert.ok(
			"commitFormat" in commitFormatPlugin.predicates,
			"plugin must register a `commitFormat` predicate",
		);
		assert.equal(
			typeof commitFormatPlugin.predicates.commitFormat,
			"function",
		);
	});

	it("validates a Conventional + JIRA commit (no fire)", async () => {
		const ctx = ctxWithCommand(
			`git commit -m "feat: add login [ABC-123]"`,
		);
		const handler = commitFormatPlugin.predicates.commitFormat;
		assert.equal(
			await handler({ require: ["conventional", "jira"] }, ctx),
			false,
		);
	});

	it("fires on a non-Conventional commit", async () => {
		const ctx = ctxWithCommand(`git commit -m "Update README"`);
		const handler = commitFormatPlugin.predicates.commitFormat;
		assert.equal(
			await handler({ require: ["conventional"] }, ctx),
			true,
		);
	});

	it("fires on a Conventional commit without a JIRA reference", async () => {
		const ctx = ctxWithCommand(`git commit -m "feat: add login"`);
		const handler = commitFormatPlugin.predicates.commitFormat;
		assert.equal(await handler({ require: ["jira"] }, ctx), true);
	});
});

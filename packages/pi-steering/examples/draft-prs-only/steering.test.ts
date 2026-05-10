// SPDX-License-Identifier: MIT
// Part of pi-steering / examples.

/**
 * Smoke test for the draft-prs-only rule pack.
 *
 * Scope: README drift guard. See `force-push-strict/steering.test.ts`
 * for the rationale.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import config from "./steering.ts";

describe("example: draft-prs-only", () => {
	it("exports a SteeringConfig with at least one rule", () => {
		assert.ok(config.rules !== undefined);
		assert.ok(config.rules.length >= 1);
	});

	it("registers pr-create-must-be-draft", () => {
		const names = config.rules!.map((r) => r.name);
		assert.ok(
			names.includes("pr-create-must-be-draft"),
			`expected pr-create-must-be-draft in rules, got: ${names.join(", ")}`,
		);
	});

	it("rule declares an `unless` escape hatch for --draft", () => {
		const rule = config.rules!.find(
			(r) => r.name === "pr-create-must-be-draft",
		);
		assert.ok(rule);
		// Structural check: rule.unless must be declared (as a string
		// pattern or RegExp). Its specific contents are pinned by the
		// engine's own test suite.
		assert.ok(
			"unless" in rule! && rule!.unless !== undefined,
			"rule must declare an `unless` pattern",
		);
	});

	it("does not disable any default rules (additive)", () => {
		assert.ok(
			config.disabledRules === undefined ||
				config.disabledRules.length === 0,
		);
	});
});

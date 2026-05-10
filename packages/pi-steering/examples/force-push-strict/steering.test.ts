// SPDX-License-Identifier: MIT
// Part of pi-steering / examples.

/**
 * Smoke test for the force-push-strict rule pack.
 *
 * Scope: README drift guard. Asserts that `steering.ts` compiles
 * (covered by `tsc --noEmit` in the typecheck script) and that the
 * resolved config has the expected shape. Full behavioral coverage
 * (every pattern, every wrapper form) lives in the engine's own test
 * suite, not here.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import config from "./steering.ts";

describe("example: force-push-strict", () => {
	it("exports a SteeringConfig with at least one rule", () => {
		assert.ok(config.rules !== undefined, "config.rules should be defined");
		assert.ok(
			config.rules.length >= 1,
			"config.rules should have at least one rule",
		);
	});

	it("registers the strict rule name", () => {
		const names = config.rules!.map((r) => r.name);
		assert.ok(
			names.includes("no-force-push-strict"),
			`expected no-force-push-strict in rules, got: ${names.join(", ")}`,
		);
	});

	it("disables the default `no-force-push` so the stricter variant owns the reason message", () => {
		assert.ok(
			config.disabledRules?.includes("no-force-push"),
			"expected disabledRules to include 'no-force-push'",
		);
	});

	it("strict rule has a bash/command shape and a non-empty reason", () => {
		const strict = config.rules!.find((r) => r.name === "no-force-push-strict");
		assert.ok(strict, "no-force-push-strict not found");
		assert.equal(strict!.tool, "bash");
		assert.ok(
			typeof strict!.reason === "string" && strict!.reason.length > 0,
			"reason should be a non-empty string",
		);
	});
});

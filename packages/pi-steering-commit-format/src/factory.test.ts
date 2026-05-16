// SPDX-License-Identifier: MIT
// Part of pi-steering-commit-format.

/**
 * Tests for `commitFormatFactory`.
 *
 * AND semantics across multiple required formats; defensive
 * `!checker` arm fires (force via `as any` cast); empty `require`
 * array returns false (silent-pass per the no-formats-required =
 * no-op convention); missing `-m` returns false.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mockContext } from "pi-steering/testing";
import type { PredicateContext } from "pi-steering";
import { BUILTIN_FORMATS } from "./builtin-formats.ts";
import {
	commitFormatFactory,
	type CommitFormatArgs,
} from "./factory.ts";

/**
 * Build a {@link PredicateContext} stubbed with a `bash`/`command`
 * input shape — the predicate inspects `ctx.input.command`.
 */
function ctxWithCommand(command: string): PredicateContext {
	return mockContext({
		tool: "bash",
		input: { tool: "bash", command },
	});
}

describe("commitFormatFactory — AND semantics", () => {
	it("fires when ALL required formats fail", async () => {
		const handler = commitFormatFactory(BUILTIN_FORMATS);
		const ctx = ctxWithCommand(`git commit -m "Update README"`);
		assert.equal(
			await handler({ require: ["conventional", "jira"] }, ctx),
			true,
		);
	});

	it("fires when ONE of two required formats fails", async () => {
		const handler = commitFormatFactory(BUILTIN_FORMATS);
		// Conventional but no JIRA reference → fire.
		const ctx = ctxWithCommand(`git commit -m "feat: add login"`);
		assert.equal(
			await handler({ require: ["conventional", "jira"] }, ctx),
			true,
		);
	});

	it("does NOT fire when ALL required formats pass", async () => {
		const handler = commitFormatFactory(BUILTIN_FORMATS);
		const ctx = ctxWithCommand(
			`git commit -m "feat: add login [ABC-123]"`,
		);
		assert.equal(
			await handler({ require: ["conventional", "jira"] }, ctx),
			false,
		);
	});

	it("does NOT fire when the only required format passes", async () => {
		const handler = commitFormatFactory(BUILTIN_FORMATS);
		const ctx = ctxWithCommand(`git commit -m "feat: add login"`);
		assert.equal(
			await handler({ require: ["conventional"] }, ctx),
			false,
		);
	});
});

describe("commitFormatFactory — defensive bypass", () => {
	it("fires when require contains a name not in the formats map (`as any` bypass)", async () => {
		// Type-correct callers can't reach this branch — the generic
		// narrows `require` to `keyof F`. JS callers (or `as any` casts)
		// that pass an unknown format name should fail-CLOSED, not
		// silently pass.
		const handler = commitFormatFactory(BUILTIN_FORMATS);
		const ctx = ctxWithCommand(
			`git commit -m "feat: add login [ABC-123]"`,
		);
		const args = {
			require: ["conventional", "nonexistent"],
		} as unknown as CommitFormatArgs<"conventional" | "jira">;
		assert.equal(await handler(args, ctx), true);
	});
});

describe("commitFormatFactory — empty require", () => {
	it("returns false when `require: []` (no formats required)", async () => {
		const handler = commitFormatFactory(BUILTIN_FORMATS);
		const ctx = ctxWithCommand(`git commit -m "feat: add login"`);
		assert.equal(await handler({ require: [] }, ctx), false);
	});
});

describe("commitFormatFactory — missing -m", () => {
	it("returns false when the command has no -m (editor flow)", async () => {
		// Bare `git commit` opens an editor for the message; this
		// predicate doesn't validate that flow. Fail-OPEN here keeps
		// the predicate from blocking every editor commit silently;
		// pair with a separate hook if you want to gate on editor
		// commits.
		const handler = commitFormatFactory(BUILTIN_FORMATS);
		const ctx = ctxWithCommand(`git commit`);
		assert.equal(
			await handler({ require: ["conventional"] }, ctx),
			false,
		);
	});
});

describe("commitFormatFactory — custom format extension", () => {
	it("AND-gates a custom format alongside the builtins", async () => {
		// Worked example of the spread-extension pattern. Pin that
		// custom checkers see the message verbatim and AND with the
		// builtins.
		const customHandler = commitFormatFactory({
			...BUILTIN_FORMATS,
			custom: (msg) => /^\[CUSTOM\]/.test(msg),
		});

		const passing = ctxWithCommand(
			`git commit -m "[CUSTOM] feat: add login [ABC-123]"`,
		);
		// Doesn't pass conventional (`[CUSTOM] ...` doesn't match the
		// `feat:` header), so this fires.
		assert.equal(
			await customHandler(
				{ require: ["custom", "conventional"] },
				passing,
			),
			true,
		);

		// Custom-only requirement passes when the prefix matches.
		const customOnly = ctxWithCommand(
			`git commit -m "[CUSTOM] anything goes"`,
		);
		assert.equal(
			await customHandler({ require: ["custom"] }, customOnly),
			false,
		);
	});
});

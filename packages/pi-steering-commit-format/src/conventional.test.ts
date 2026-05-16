// SPDX-License-Identifier: MIT
// Part of pi-steering-commit-format.

/**
 * Tests for `isConventionalCommit`.
 *
 * Conventional Commits 1.0.0 spec compliance: pass cases for each of
 * the 11 type tokens, optional scope syntax, optional breaking-change
 * `!`. Fail cases: missing colon, missing space after colon, unknown
 * type, leading whitespace.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isConventionalCommit } from "./conventional.ts";

describe("isConventionalCommit — pass cases", () => {
	const TYPES = [
		"feat",
		"fix",
		"docs",
		"style",
		"refactor",
		"perf",
		"test",
		"chore",
		"ci",
		"build",
		"revert",
	] as const;

	for (const type of TYPES) {
		it(`accepts \`${type}: <msg>\``, () => {
			assert.equal(isConventionalCommit(`${type}: example`), true);
		});
	}

	it("accepts optional scope: `feat(scope): msg`", () => {
		assert.equal(isConventionalCommit("feat(auth): add login"), true);
	});

	it("accepts breaking-change `!` without scope: `feat!: msg`", () => {
		assert.equal(isConventionalCommit("feat!: drop legacy login"), true);
	});

	it("accepts breaking-change `!` with scope: `feat(scope)!: msg`", () => {
		assert.equal(
			isConventionalCommit("feat(auth)!: drop legacy login"),
			true,
		);
	});

	it("accepts a multi-word scope segment", () => {
		assert.equal(
			isConventionalCommit("refactor(commit-format): split helpers"),
			true,
		);
	});
});

describe("isConventionalCommit — fail cases", () => {
	it("rejects missing colon", () => {
		assert.equal(isConventionalCommit("feat add login"), false);
	});

	it("rejects missing space after colon", () => {
		assert.equal(isConventionalCommit("feat:add login"), false);
	});

	it("rejects unknown type", () => {
		assert.equal(isConventionalCommit("wibble: do something"), false);
	});

	it("rejects leading whitespace", () => {
		// Anchored regex: leading whitespace is a contract violation
		// (commit messages are read by tools that strip surrounding
		// whitespace, but the format check is on the canonical form).
		assert.equal(isConventionalCommit(" feat: add login"), false);
	});

	it("rejects empty message", () => {
		assert.equal(isConventionalCommit(""), false);
	});

	it("rejects type-only with colon and space but no body", () => {
		// Spec requires a description after `: ` — bare `feat: ` is
		// not a valid commit header.
		assert.equal(isConventionalCommit("feat: "), false);
	});
});

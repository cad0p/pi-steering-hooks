// SPDX-License-Identifier: MIT
// Part of pi-steering-commit-format.

/**
 * Tests for `extractCommitMessage`.
 *
 * The three input shapes from `extract.ts`'s JSDoc each with at least
 * one example; `git commit` (no `-m`) returns null; multi-flag command
 * (`-m foo --amend`) stops at the next flag; nested quotes
 * (`-m "feat: 'x'"`).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { extractCommitMessage } from "./extract.ts";

describe("extractCommitMessage — input shapes", () => {
	it("shape 1: double-quoted `git commit -m \"feat: x\"`", () => {
		assert.equal(
			extractCommitMessage(`git commit -m "feat: x"`),
			"feat: x",
		);
	});

	it("shape 2: single-quoted `git commit -m 'feat: x'`", () => {
		assert.equal(
			extractCommitMessage(`git commit -m 'feat: x'`),
			"feat: x",
		);
	});

	it("shape 3: tokenized `git commit -m feat: x` (quotes stripped)", () => {
		// AST-flatten case: the walker may strip quotes when emitting
		// the raw command text.
		assert.equal(extractCommitMessage(`git commit -m feat: x`), "feat: x");
	});

	it("shape 3 multi-word: `git commit -m feat: foo bar baz`", () => {
		assert.equal(
			extractCommitMessage(`git commit -m feat: foo bar baz`),
			"feat: foo bar baz",
		);
	});
});

describe("extractCommitMessage — boundary cases", () => {
	it("returns null when no -m is present", () => {
		assert.equal(extractCommitMessage(`git commit`), null);
	});

	it("returns null on plain `git status`", () => {
		assert.equal(extractCommitMessage(`git status`), null);
	});

	it("tokenized: stops at the next flag (`-m foo --amend`)", () => {
		assert.equal(
			extractCommitMessage(`git commit -m feat: x --amend`),
			"feat: x",
		);
	});

	it("tokenized: stops at the next short flag (`-m foo -n`)", () => {
		assert.equal(
			extractCommitMessage(`git commit -m feat: x -n`),
			"feat: x",
		);
	});

	it("double-quoted with nested single quotes", () => {
		assert.equal(
			extractCommitMessage(`git commit -m "feat: 'x'"`),
			`feat: 'x'`,
		);
	});

	it("double-quoted preserves trailing content outside the quoted -m", () => {
		// The quoted shape is greedy-non-greedy on the closing `"` —
		// once the quoted span closes, anything after is ignored.
		assert.equal(
			extractCommitMessage(`git commit -m "feat: x" --signoff`),
			"feat: x",
		);
	});

	it("double-quoted handles colons / brackets inside the message", () => {
		assert.equal(
			extractCommitMessage(`git commit -m "feat: add [ABC-123] login"`),
			"feat: add [ABC-123] login",
		);
	});
});

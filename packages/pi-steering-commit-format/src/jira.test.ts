// SPDX-License-Identifier: MIT
// Part of pi-steering-commit-format.

/**
 * Tests for `hasJiraReference`.
 *
 * Bracketed `[ABC-123]` reference detection: multi-letter prefixes
 * (e.g., `[ABCD-1]`), digit-suffix variations, body-text matches
 * (not just header). Negative cases: `JIRA-123` without brackets,
 * `[abc-123]` lowercase, `[A-123]` single letter.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { hasJiraReference } from "./jira.ts";

describe("hasJiraReference — pass cases", () => {
	it("accepts a 3-letter prefix", () => {
		assert.equal(hasJiraReference("[ABC-123]"), true);
	});

	it("accepts a 4-letter prefix", () => {
		assert.equal(hasJiraReference("feat: x [ABCD-1]"), true);
	});

	it("accepts a 2-letter prefix (minimum)", () => {
		assert.equal(hasJiraReference("[XY-9]"), true);
	});

	it("accepts a long digit suffix", () => {
		assert.equal(hasJiraReference("[ORACLE-1234567]"), true);
	});

	it("matches in the message body, not just header", () => {
		const msg = "feat: add login\n\nRefs [ABC-123] for context.";
		assert.equal(hasJiraReference(msg), true);
	});

	it("matches when surrounded by other tokens", () => {
		assert.equal(
			hasJiraReference("chore: tidy up [ABC-1] and [DEF-2]"),
			true,
		);
	});
});

describe("hasJiraReference — fail cases", () => {
	it("rejects unbracketed `JIRA-123`", () => {
		assert.equal(hasJiraReference("ABC-123"), false);
	});

	it("rejects lowercase `[abc-123]`", () => {
		assert.equal(hasJiraReference("[abc-123]"), false);
	});

	it("rejects single-letter prefix `[A-123]`", () => {
		assert.equal(hasJiraReference("[A-123]"), false);
	});

	it("rejects bracketed prefix without digits `[ABC-]`", () => {
		assert.equal(hasJiraReference("[ABC-]"), false);
	});

	it("rejects empty message", () => {
		assert.equal(hasJiraReference(""), false);
	});

	it("rejects bracketed all-digits `[123-456]`", () => {
		assert.equal(hasJiraReference("[123-456]"), false);
	});
});

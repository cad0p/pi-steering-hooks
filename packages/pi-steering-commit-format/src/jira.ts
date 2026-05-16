// SPDX-License-Identifier: MIT
// Part of pi-steering-commit-format.

/**
 * Bracketed JIRA-style ticket reference detector.
 *
 * Matches references like `[ABC-123]`, `[PROJ-1234]`, `[XY-9]` —
 * any uppercase letter prefix of length >= 2 followed by a hyphen
 * and one or more digits, all wrapped in square brackets. Anywhere
 * in the message (header, body, or footer).
 *
 * Internal regex — NOT exported. Same rationale as
 * `CONVENTIONAL_REGEX`: coupling downstream code to the regex would
 * drift on org-specific reference styles.
 */
const JIRA_REGEX = /\[[A-Z]{2,}-\d+\]/;

/**
 * Returns `true` if `message` contains at least one bracketed
 * JIRA-style ticket reference (e.g., `[ABC-123]`).
 *
 * @example
 * hasJiraReference("feat: x [ABC-123]");      // true
 * hasJiraReference("Update [ABCD-1] foo");    // true
 * hasJiraReference("ABC-123");                // false (no brackets)
 * hasJiraReference("[abc-123]");              // false (lowercase)
 * hasJiraReference("[A-123]");                // false (single letter prefix)
 */
export function hasJiraReference(message: string): boolean {
	return JIRA_REGEX.test(message);
}

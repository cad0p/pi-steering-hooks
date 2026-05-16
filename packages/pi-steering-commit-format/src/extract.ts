// SPDX-License-Identifier: MIT
// Part of pi-steering-commit-format.

/**
 * Pull the commit message out of a `git commit -m <msg>` command.
 *
 * Handles three input shapes the walker may emit:
 *
 *   1. Double-quoted: `git commit -m "feat: foo"` — the `-m` value is
 *      a single quoted token preserved by the shell. Captured between
 *      the double-quotes.
 *   2. Single-quoted: `git commit -m 'feat: foo'` — same shape with
 *      single quotes.
 *   3. Tokenized (AST-flattened): the walker may flatten
 *      `git commit -m "feat: foo bar"` to the raw command text
 *      `git commit -m feat: foo bar` (quotes stripped, multi-word
 *      message). Captured greedily after `-m` up to the next flag
 *      (a token starting with `-`) or end-of-string. This shape is
 *      what `ctx.input.command` typically holds for a multi-word
 *      message in pi-steering.
 *
 * Returns null if no `-m` is present (e.g., `git commit` alone, which
 * would open the editor; not a case the format predicate validates).
 *
 * @example
 * extractCommitMessage(`git commit -m "feat: x"`)        // "feat: x"
 * extractCommitMessage(`git commit -m 'feat: x'`)        // "feat: x"
 * extractCommitMessage(`git commit -m feat: x`)          // "feat: x"
 * extractCommitMessage(`git commit -m feat: x --amend`)  // "feat: x" (stops at --amend)
 * extractCommitMessage(`git commit`)                      // null
 */
export function extractCommitMessage(cmd: string): string | null {
	// Shape 1: double-quoted
	const dq = cmd.match(/-m\s+"([\s\S]*?)"/);
	if (dq) return dq[1] ?? null;
	// Shape 2: single-quoted
	const sq = cmd.match(/-m\s+'([\s\S]*?)'/);
	if (sq) return sq[1] ?? null;
	// Shape 3: tokenized — take everything after `-m` until the next flag
	// (a token starting with `-`) or end-of-string. Stops at flags so
	// `git commit -m feat: x --amend` doesn't absorb `--amend` into the
	// message.
	const tokenized = cmd.match(/-m\s+([^-\s][\s\S]*?)(?=\s+-\S|\s*$)/);
	if (tokenized) return tokenized[1]?.trim() ?? null;
	return null;
}

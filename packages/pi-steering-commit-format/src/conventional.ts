// SPDX-License-Identifier: MIT
// Part of pi-steering-commit-format.

/**
 * Conventional Commits 1.0.0 format checker, restricted to the
 * Angular preset's type allowlist.
 *
 * Recognized type tokens (the Angular preset's 11-token set):
 *   feat, fix, docs, style, refactor, perf, test, chore, ci, build, revert
 *
 * The Conventional Commits 1.0.0 spec itself describes the type as
 * "a noun" — not a closed set. Real-world types like `release:`,
 * `merge:`, `wip:` are 1.0.0-conformant but rejected here. Callers
 * needing a different type allowlist should compose their own
 * checker via `commitFormatFactory`; a relaxed type-agnostic 1.0.0
 * checker is a v0.1.x candidate.
 *
 * Optional features per the spec:
 *   - Scope:           `feat(scope): message`
 *   - Breaking change: `feat!: message`  /  `feat(scope)!: message`
 *
 * Returns `true` when the message header matches.
 *
 * Internal regex — NOT exported. The function `isConventionalCommit`
 * is the public surface; coupling downstream code to the regex would
 * drift on Conventional Commits 1.1+ spec changes.
 */
const CONVENTIONAL_REGEX =
	/^(feat|fix|docs|style|refactor|perf|test|chore|ci|build|revert)(\([^)]+\))?!?:\s.+/;

/**
 * Returns `true` if `message` matches the Conventional Commits 1.0.0
 * header format restricted to the Angular preset's type allowlist.
 * Body / footer content is not validated. See the regex JSDoc above
 * for the type-allowlist caveat.
 *
 * @example
 * isConventionalCommit("feat: add login");                 // true
 * isConventionalCommit("feat(auth): add login");           // true
 * isConventionalCommit("feat!: drop legacy login");        // true
 * isConventionalCommit("feat(auth)!: drop legacy login");  // true
 * isConventionalCommit("Update README");                   // false
 * isConventionalCommit("feat:no-space");                   // false
 */
export function isConventionalCommit(message: string): boolean {
	return CONVENTIONAL_REGEX.test(message);
}

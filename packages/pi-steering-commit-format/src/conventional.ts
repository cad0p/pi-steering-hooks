// SPDX-License-Identifier: MIT
// Part of pi-steering-commit-format.

/**
 * Conventional Commits 1.0.0 format checker.
 *
 * Recognized type tokens:
 *   feat, fix, docs, style, refactor, perf, test, chore, ci, build, revert
 *
 * Optional features per the spec:
 *   - Scope:           `feat(scope): message`
 *   - Breaking change: `feat!: message`  /  `feat(scope)!: message`
 *
 * Returns `true` when the message header matches the spec.
 *
 * Internal regex — NOT exported. The function `isConventionalCommit`
 * is the public surface; coupling downstream code to the regex would
 * drift on Conventional Commits 1.1+ spec changes.
 */
const CONVENTIONAL_REGEX =
	/^(feat|fix|docs|style|refactor|perf|test|chore|ci|build|revert)(\([^)]+\))?!?:\s.+/;

/**
 * Returns `true` if `message` matches the Conventional Commits 1.0.0
 * header format. Body / footer content is not validated.
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

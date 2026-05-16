// SPDX-License-Identifier: MIT
// Part of pi-steering-commit-format.

/**
 * pi-steering-commit-format — commit-message format validation
 * predicates for pi-steering rules.
 *
 * Bundled formats:
 *   - Conventional Commits 1.0.0 (`feat: ...`, `fix(scope): ...`, etc.)
 *   - Bracketed JIRA-style ticket references (`[ABC-123]`)
 *
 * Extensible via `commitFormatFactory`: bring your own format
 * checker and combine with `BUILTIN_FORMATS`. Register the result
 * in your own plugin alongside any other predicates you need.
 *
 * Sibling package mirrors the `pi-steering-flags` precedent:
 * opt-in functionality that doesn't belong in pi-steering core.
 *
 * See this package's README for usage examples.
 */

// Standalone helpers — usable from `when.condition` escape hatches
// without touching the predicate factory.
export { isConventionalCommit } from "./conventional.ts";
export { hasJiraReference } from "./jira.ts";
export { extractCommitMessage } from "./extract.ts";

// Predicate factory + types — for building custom format sets.
export {
	commitFormatFactory,
	type FormatChecker,
	type CommitFormatArgs,
} from "./factory.ts";

// Builtin format registry — spread-into-extension base.
export { BUILTIN_FORMATS } from "./builtin-formats.ts";

// Default plugin (named export + default re-export, matching
// pi-steering-flags shape).
export { commitFormatPlugin } from "./plugin.ts";
export { default } from "./plugin.ts";

// NOT exported: CONVENTIONAL_REGEX, JIRA_REGEX (internal-only).

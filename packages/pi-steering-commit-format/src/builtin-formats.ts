// SPDX-License-Identifier: MIT
// Part of pi-steering-commit-format.

import { isConventionalCommit } from "./conventional.ts";
import { hasJiraReference } from "./jira.ts";
import type { FormatChecker } from "./factory.ts";

/**
 * Format checkers built into this package. Use as the spread base when
 * building an extended `commitFormatFactory` call:
 *
 *   commitFormatFactory({ ...BUILTIN_FORMATS, custom: ... })
 *
 * NOT a "default required formats" set — callers pick which formats to
 * AND together via the predicate's `require:` field. This constant is
 * the registry of available checkers, not an opinion about which to require.
 */
export const BUILTIN_FORMATS: Readonly<
	Record<"conventional" | "jira", FormatChecker>
> = {
	conventional: isConventionalCommit,
	jira: hasJiraReference,
};

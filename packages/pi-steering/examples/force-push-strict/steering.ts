// SPDX-License-Identifier: MIT
// Part of pi-steering / examples.

/**
 * Example: force-push-strict rule pack.
 *
 * Equivalent to `steering.json` in this directory but expressed in the
 * v0.1.0 canonical TypeScript form. Drop this file in at
 * `.pi/steering.ts` (or `.pi/steering/index.ts`) to activate.
 *
 * What it enforces: no force pushes of ANY kind, including
 * `--force-with-lease` (which the shipped `DEFAULT_RULES.no-force-push`
 * deliberately allows). Useful on teams where shared-branch history
 * must stay append-only even for "safe" rewrites.
 *
 * Shape:
 *
 *   - `disabledRules: ["no-force-push"]` drops the default rule so
 *     it doesn't fire alongside our stricter one (otherwise the
 *     default's block message would win on `git push --force`).
 *   - `no-force-push-strict` fires on `--force` (any suffix, any
 *     position) AND on `-f`. Matches the same pre-subcommand flag
 *     patterns as the default (`git -C /path push --force`,
 *     `git -c key=val push --force`, `git --git-dir=/x push -f`).
 *
 * Scope note: the `DEFAULT_PLUGINS` git plugin's `no-main-commit`
 * still fires on top of this rule. If that's not wanted, add
 * `disabledRules: ["no-force-push", "no-main-commit"]` or drop the
 * whole git plugin with `disabledPlugins: ["git"]`.
 */

import { defineConfig } from "pi-steering";

export default defineConfig({
	// Disable the shipped default so its less-strict block-reason (
	// "use --force-with-lease if you must") doesn't leak to the LLM
	// alongside our stricter variant.
	//
	// Cast: `defineConfig`'s `AllRuleNames` typo-check union covers
	// plugin + user rules but not `DEFAULT_RULES`. The runtime merge
	// honors the disable; only the compile-time check is narrow. See
	// <https://github.com/cad0p/pi-steering-hooks/issues> for the
	// tracking issue.
	disabledRules: ["no-force-push"] as unknown as [],
	rules: [
		{
			name: "no-force-push-strict",
			tool: "bash",
			field: "command",
			// Mirrors DEFAULT_RULES.no-force-push's pre-subcommand flag
			// slot but WITHOUT the `--force-with-lease` allowance.
			pattern:
				"^git\\b(?:\\s+-{1,2}[A-Za-z]\\S*(?:\\s+\\S+)?)*\\s+push\\b.*(?:--force\\b|\\s-f(?:\\s|$))",
			reason:
				"No force pushes of any kind, including --force-with-lease. Create a new commit, or reset + re-commit via a non-force path.",
		},
	],
});

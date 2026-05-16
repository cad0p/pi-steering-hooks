// SPDX-License-Identifier: MIT
// Part of pi-steering / examples.

/**
 * Example: combined-git-discipline rule pack.
 *
 * Equivalent to `steering.json` in this directory but expressed in the
 * v0.1.0 canonical TypeScript form. Drop this file in at
 * `.pi/steering.ts` (or `.pi/steering/index.ts`) to activate.
 *
 * Combines the strict variants of three common guardrails:
 *
 *   1. `no-force-push-strict` - no force push of any kind (blocks
 *       `--force-with-lease` too; the shipped default allows it).
 *   2. `no-amend` - no `git commit --amend` (rewrites history).
 *   3. `pr-create-must-be-draft` - `gh pr create` must include
 *       `--draft`.
 *
 * Use this as a starting point for teams that want "disciplined PR
 * flow" out of the box. Tweak individual patterns downstream.
 *
 * Scope note: disables the shipped `DEFAULT_RULES.no-force-push` so
 * its less-strict reason message ("--force-with-lease is fine")
 * doesn't leak alongside the strict variant. The other default rules
 * (no-hard-reset, no-rm-rf-slash, no-long-running-commands) and the
 * default git plugin (no-main-commit + branch predicate) stay
 * active.
 */

import { defineConfig } from "pi-steering";

export default defineConfig({
	// Cast: `defineConfig`'s `AllRuleNames` typo-check union covers
	// plugin + user rules but not `DEFAULT_RULES`. Runtime merge
	// honors this disable; only the compile-time check is narrow.
	disabledRules: ["no-force-push"] as unknown as [],
	rules: [
		{
			name: "no-force-push-strict",
			tool: "bash",
			field: "command",
			pattern:
				"^git\\b(?:\\s+-{1,2}[A-Za-z]\\S*(?:\\s+\\S+)?)*\\s+push\\b.*(?:--force\\b|\\s-f(?:\\s|$))",
			reason:
				"No force pushes of any kind, including --force-with-lease.",
		},
		{
			name: "no-amend",
			tool: "bash",
			field: "command",
			pattern:
				"^git\\b(?:\\s+-{1,2}[A-Za-z]\\S*(?:\\s+\\S+)?)*\\s+commit\\b.*--amend\\b",
			reason:
				"Don't rewrite history with --amend. Create a new commit instead.",
		},
		{
			name: "pr-create-must-be-draft",
			tool: "bash",
			field: "command",
			pattern: "^gh\\s+pr\\s+create\\b",
			unless: "--draft\\b",
			reason:
				"PRs must be created as drafts. Mark ready for review only after human approval.",
		},
	],
});

// SPDX-License-Identifier: MIT
// Part of pi-steering / examples.

/**
 * Example: draft-prs-only rule pack.
 *
 * Equivalent to `steering.json` in this directory but expressed in the
 * v0.1.0 canonical TypeScript form. Drop this file in at
 * `.pi/steering.ts` (or `.pi/steering/index.ts`) to activate.
 *
 * What it enforces: `gh pr create` must include `--draft`. Useful on
 * teams that require a human review step before flipping a PR from
 * draft to ready.
 *
 * Scope note: does NOT conflict with any shipped `DEFAULT_RULES`.
 * The rule is additive.
 */

import { defineConfig } from "pi-steering";

export default defineConfig({
	rules: [
		{
			name: "pr-create-must-be-draft",
			tool: "bash",
			field: "command",
			pattern: "^gh\\s+pr\\s+create\\b",
			// `unless` short-circuits the rule: if the command ALSO
			// matches the unless pattern, the rule does NOT fire. Here it
			// means "block gh pr create UNLESS --draft is also present".
			unless: "--draft\\b",
			reason:
				"PRs must be created as drafts. Mark the PR ready for review only after a human has reviewed the diff. Use `gh pr ready <number>` to flip from draft to ready.",
		},
	],
});

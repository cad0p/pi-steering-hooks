// SPDX-License-Identifier: MIT
// Part of @cad0p/pi-steering-hooks.

/**
 * Built-in default rules. Users can add more or disable any of these via
 * `steering.json` (see README).
 *
 * Design notes:
 *   - `reason` messages are written for the agent, not the human: they tell
 *     the agent what it did wrong and what a safer alternative looks like,
 *     so a well-behaved model can recover without asking the user.
 *   - `pattern` strings run against the AST-extracted command string
 *     (`basename + " " + args.join(" ")`) per extracted ref. That means
 *     `sh -c 'git push --force'` is still caught via wrapper expansion.
 *   - `conventional-commits` from samfoy's defaults is intentionally omitted:
 *     it's opinionated project policy, not general safety. Users who want it
 *     can add it to their own `steering.json`.
 */

import type { Rule } from "./schema.ts";

export const DEFAULT_RULES: Rule[] = [
	{
		name: "no-force-push",
		tool: "bash",
		field: "command",
		// Block `git push --force` / `-f`, allow `--force-with-lease`.
		pattern: "\\bgit\\s+push\\b.*(?:--force(?!-with-lease)|\\s-f\\b)",
		reason:
			"Force push rewrites remote history and can destroy teammates' work. Use `git push --force-with-lease` if you must, or create a new commit instead.",
	},
	{
		name: "no-hard-reset",
		tool: "bash",
		field: "command",
		pattern: "\\bgit\\s+reset\\s+--hard\\b",
		reason:
			"Hard reset discards uncommitted changes permanently. Use `git stash` to save work first, or `git reset --soft` to keep changes staged.",
	},
	{
		name: "no-rm-rf-slash",
		tool: "bash",
		field: "command",
		// rm with any flag combo containing both `r` and `f`, operating on `/`.
		pattern: "\\brm\\s+-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*\\s+/(?:\\s|$)",
		reason:
			"Recursive force-delete from root is catastrophic and irreversible. Specify a safe path (e.g. a subdirectory of the project or a temp dir).",
		noOverride: true,
	},
	{
		name: "no-long-running-commands",
		tool: "bash",
		field: "command",
		pattern:
			"\\b(npm\\s+run\\s+dev|npm\\s+start|yarn\\s+start|yarn\\s+dev|npx\\s+.*--watch|webpack\\s+(--watch|serve)|jest\\s+--watch|nodemon|tsc\\s+--watch)\\b",
		reason:
			"Long-running dev servers and watchers block the agent loop. Ask the user to run it manually in another terminal, or use a background-process skill (e.g. tmux-runner) if one is available.",
	},
];

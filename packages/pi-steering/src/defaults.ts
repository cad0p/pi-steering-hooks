// SPDX-License-Identifier: MIT
// Part of pi-steering.

/**
 * Built-in default rules + default plugins for the v2 engine.
 *
 * Ported from v1's `../defaults.ts` with patterns kept IDENTICAL so the
 * safety contract existing users rely on doesn't drift. Each pattern
 * here matches v1 byte-for-byte (string form, not RegExp); the v2
 * evaluator compiles strings at load time via
 * `./evaluator-internals/predicates.ts`.
 *
 * Design notes (preserved from v1):
 *   - `reason` messages are written for the agent, not the human: they
 *     tell the agent what it did wrong and what a safer alternative
 *     looks like, so a well-behaved model can recover without asking
 *     the user.
 *   - `pattern` strings run against the AST-extracted command string
 *     (`basename + " " + args.join(" ")`) per extracted ref. That means
 *     `sh -c 'git push --force'` is still caught via wrapper expansion.
 *     Patterns are anchored with `^` so they match the command name,
 *     not a substring inside an argument — e.g. `echo 'git push
 *     --force'` is correctly NOT flagged because the extracted
 *     command's basename is `echo`, not `git`.
 *   - `conventional-commits` from samfoy's defaults is intentionally
 *     omitted: it's opinionated project policy, not general safety.
 *     Users who want it can add it via their own `.pi/steering.ts` or
 *     install a plugin.
 *
 * Users disable specific defaults via `config.disabledRules: ["<rule-name>"]`
 * or opt out of all defaults + default plugins via
 * `config.disableDefaults: true`.
 */

import type { Plugin, Rule } from "./schema.ts";
import gitPlugin from "./plugins/git/index.ts";

export const DEFAULT_RULES: Rule[] = [
	{
		name: "no-force-push",
		tool: "bash",
		field: "command",
		// Block `git push --force` / `-f`, allow `--force-with-lease`.
		// Anchored so `echo 'git push --force'` (basename=echo) is NOT
		// flagged. The pre-subcommand flag slot
		// `(?:\s+-{1,2}[A-Za-z]\S*(?:\s+\S+)?)*` allows short and long
		// git-flags before the subcommand:
		//   - `git -C /path push --force`
		//   - `git -c key=val push --force`
		//   - `git --git-dir=/x push --force`
		// All three are silent bypasses with a plain `^git\s+push` anchor.
		//
		// Known limit: this pattern over-matches on
		// `git log --grep="push --force"` because `--grep=push` is a
		// single token that still satisfies `\bpush\b`. Real agents don't
		// emit that; if it becomes a problem we'll move to args-array
		// matching.
		pattern:
			"^git\\b(?:\\s+-{1,2}[A-Za-z]\\S*(?:\\s+\\S+)?)*\\s+push\\b.*(?:--force(?!-with-lease)|\\s-f(?:\\s|$))",
		reason:
			"Force push rewrites remote history and can destroy teammates' work. Use `git push --force-with-lease` if you must, or create a new commit instead.",
	},
	{
		name: "no-hard-reset",
		tool: "bash",
		field: "command",
		// Same pre-subcommand flag broadening as `no-force-push` so
		// `git -C /other reset --hard` and `git -c key=val reset --hard`
		// are also caught.
		pattern:
			"^git\\b(?:\\s+-{1,2}[A-Za-z]\\S*(?:\\s+\\S+)?)*\\s+reset\\s+--hard\\b",
		reason:
			"Hard reset discards uncommitted changes permanently. Use `git stash` to save work first, or `git reset --soft` to keep changes staged.",
	},
	{
		name: "no-rm-rf-slash",
		tool: "bash",
		field: "command",
		// rm with recursive AND force flags in any form, operating on `/`.
		// Uses two independent lookaheads so separated flags (`-r -f`),
		// long-form flags (`--recursive --force`), mixed case (`-Rf`),
		// and reversed order (`-fr`) are all caught. Anchored to the
		// basename so `echo 'rm -rf /'` (basename=echo) is NOT flagged.
		pattern:
			"^rm\\b(?=.*(?:-[A-Za-z]*[rR][A-Za-z]*|--recursive))(?=.*(?:-[A-Za-z]*f[A-Za-z]*|--force)).*\\s/(?:\\s|$)",
		reason:
			"Recursive force-delete from root is catastrophic and irreversible. Specify a safe path (e.g. a subdirectory of the project or a temp dir).",
		// HARD block — inherent destructiveness, no override possible.
		// Explicit `noOverride: true` guarantees this even when a layer
		// sets `defaultNoOverride: false`.
		noOverride: true,
	},
	{
		name: "no-long-running-commands",
		tool: "bash",
		field: "command",
		// Covers npm / yarn / pnpm dev + start, npx --watch, webpack dev
		// modes, jest / tsc --watch, nodemon, and the modern
		// bundler/runtime ecosystem (vite, astro, next dev, deno task
		// dev/start/serve, bun dev). Representative, not exhaustive —
		// consumers with other watchers should add them via their own
		// `.pi/steering.ts`.
		pattern:
			"^(?:npm\\s+(?:run\\s+dev|start)|yarn\\s+(?:dev|start)|pnpm\\s+(?:run\\s+)?(?:dev|start)|npx\\s+.*--watch|webpack\\s+(?:--watch|serve)|jest\\s+--watch|nodemon\\b|tsc\\s+--watch|vite(?:\\s+(?:dev|serve|preview))?(?!\\s+[A-Za-z])|astro\\s+(?:dev|preview)|next\\s+dev|deno\\s+task\\s+(?:dev|start|serve)|bun\\s+(?:dev|run\\s+dev))\\b",
		reason:
			"Long-running dev servers and watchers block the agent loop. Ask the user to run it manually in another terminal, or use a background-process tool. Representative — add your own via `.pi/steering.ts` if a framework isn't listed here.",
	},
];

/**
 * Default plugins shipped by the package.
 *
 * Contains the git plugin (`pi-steering/plugins/git`), which
 * contributes:
 *
 *   - Predicates: `branch`, `upstream`, `commitsAhead`,
 *     `hasStagedChanges`, `isClean`, `remote`.
 *   - Rules: `no-main-commit` (overridable).
 *   - Trackers: `branch` (in-chain `git checkout` / `git switch`
 *     awareness for the `branch` predicate).
 *   - Tracker extensions: `cwd.git` (`--git-dir=`, `--work-tree=`
 *     flag parsing on the built-in cwd tracker).
 *
 * Rationale for default-on: git discipline is what the vast
 * majority of steering consumers want - no-main-commit +
 * branch-aware rules cover the common footgun of committing to
 * `main` by accident. Explicit opt-out via `disabledPlugins` or
 * `disableDefaults` is lower friction than requiring every user to
 * remember `import gitPlugin from "pi-steering/plugins/git"` and
 * wire it in themselves.
 *
 * Opt-out paths:
 *
 *   - Per-plugin:    `defineConfig({ disabledPlugins: ["git"] })`
 *   - All defaults:  `defineConfig({ disableDefaults: true })` - drops
 *                     BOTH {@link DEFAULT_RULES} and this list.
 *   - Per-rule:      `defineConfig({ disabledRules: ["no-main-commit"] })`
 *                     - keeps the plugin's predicates + tracker, just
 *                     drops the shipped rule.
 *
 * Adding additional default plugins is a deliberate ship-surface
 * decision - keep the list minimal. Domain-specific plugins (RDS,
 * npm, etc.) stay opt-in.
 */
export const DEFAULT_PLUGINS: Plugin[] = [gitPlugin];

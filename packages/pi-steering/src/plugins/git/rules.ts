// SPDX-License-Identifier: MIT
// Part of pi-steering.

/**
 * Plugin-shipped rules for the git plugin.
 *
 * Rules here ship as SUGGESTED defaults - the plugin is opt-in (users
 * must explicitly import and list it under `plugins: [...]`), so
 * shipping a curated starter set matches the ADR's "distribution unit
 * for rule packs" framing.
 *
 * Users who want the branch predicate but NOT `no-main-commit` can
 * keep it by disabling the rule selectively:
 *
 *   ```ts
 *   defineConfig({
 *     plugins: [gitPlugin],
 *     disabledRules: ["no-main-commit"],
 *   });
 *   ```
 *
 * Rules ride on the branch predicate registered in `./predicates.ts`
 * and the branch tracker in `./branch-tracker.ts`. The tracker makes
 * the rule bypass-proof against the `git checkout main && git commit`
 * pattern: the walker folds the checkout into the branch seen by the
 * commit, so the rule still fires.
 */

import type { Rule } from "../../schema.ts";

/**
 * `no-main-commit` - block direct commits to a protected branch
 * (main / master / mainline / trunk).
 *
 * Fires on:
 *   - `git commit -m "..."` when the current branch is one of the
 *     protected names,
 *   - `git checkout main && git commit ...` (the branch tracker folds
 *     the checkout into the branch state for the commit),
 *   - `sh -c 'git commit ...'` (wrapper expansion),
 *   - `git -C /other commit ...` where the repo at `/other` is on
 *     main (the `branch` predicate queries git at the effective cwd).
 *
 * Does NOT fire on:
 *   - `git commit` while on a feature branch,
 *   - `git log --grep="commit"` (anchored to `git commit`, not
 *     arbitrary git subcommands),
 *   - `echo 'git commit -m "x"'` (extraction anchors to the
 *     basename).
 *
 * Fail-closed on unresolvable branch: if the branch predicate can't
 * determine the current branch (detached HEAD, not a repo, or the
 * tracker collapsed to `unknown` via `git checkout $VAR`), the rule
 * fires by default. Authors who want the allow-through behavior
 * supply the object form explicitly:
 *
 *   `when: { branch: { pattern: /.../, onUnknown: "allow" } }`
 *
 * Override: allowed (the rule is overridable via a
 * `# steering-override: no-main-commit` comment). This is a workflow
 * rule, not an inherent-destructiveness rule - authors override when
 * the commit is intentional (e.g. release process on `main`).
 */
export const noMainCommit = {
	name: "no-main-commit",
	tool: "bash",
	field: "command",
	// Pre-subcommand flag slot mirrors the core defaults so
	// `git -C /path commit ...` is also caught. See the package README's
	// "Pre-subcommand flag slots" note.
	pattern:
		"^git\\b(?:\\s+-{1,2}[A-Za-z]\\S*(?:\\s+\\S+)?)*\\s+commit\\b",
	when: { branch: /^(main|master|mainline|trunk)$/ },
	reason:
		"Don't commit directly to a protected branch (main / master / mainline / trunk). Create a feature branch first: `git checkout -b feat/...`.",
	// Explicit override-OK: workflow rules are intentionally
	// overridable.
	noOverride: false,
} as const satisfies Rule;

/**
 * Suggested rules for the git plugin. Phase 4 ships the one
 * walker-dependent rule (`no-main-commit`). `no-git-worktree` was
 * considered but deferred - it's a pure regex rule with no plugin
 * dependency, and adding it to DEFAULT_RULES rather than the git
 * plugin is a cleaner domain split.
 */
export const rules = [noMainCommit] as const satisfies readonly Rule[];

# no-amend

A rule pack that blocks `git commit --amend`.

## What it enforces

- `git commit --amend` → blocked
- `git commit -m "msg"` → allowed
- `git -C /path commit --amend` → blocked (handles the git pre-subcommand `-C` flag)

The AST backend also sees through wrappers — `sh -c 'git commit --amend'` and `sudo git commit --amend` are blocked.

## Rationale

`--amend` rewrites the last commit's SHA. For code-review workflows that track diffs across pushes, that's a regression:

- Reviewers compare revisions by SHA. An amended commit presents as a brand-new revision with no relation to the previous one, and per-line comments lose their anchor.
- History lineage matters for bisect and blame. Amending mid-review tangles both.
- If you genuinely need to fix the last commit's message or contents, a **follow-up commit** (`git commit -m "fix …"`) preserves continuity. Squash-merge at the end of review collapses the chain.

## Variant: cwd-scoped (`steering.cwd-scoped.json`)

If you want to apply the rule only to specific directory trees (e.g. a monorepo where some sub-projects enforce linear history and others don't), use `when.cwd`:

```json
{
  "rules": [
    {
      "name": "no-amend-in-personal",
      "tool": "bash",
      "field": "command",
      "pattern": "^git\\b(?:\\s+-{1,2}[A-Za-z]\\S*(?:\\s+\\S+)?)*\\s+commit\\b.*--amend\\b",
      "when": { "cwd": "^/home/[^/]+/projects/personal/" },
      "reason": "In personal/shared repos, don't rewrite history. Create a new commit instead."
    }
  ]
}
```

`when.cwd` is the feature that distinguishes this engine from a regex-on-raw approach: it's tested against the **effective** cwd of each extracted command, so even `cd /home/me/projects/personal/site && git commit --amend` — run from a different session cwd — is still caught. The walker handles `&&`, `;`, subshells, and wrapper arguments.

## When to use

- Teams with post-push review (Gerrit, Phabricator, CRUX-style CR tools) where commit-SHA stability matters
- Projects that rely on bisect / blame history continuity
- Any workflow where the agent reaching for `--amend` as a "clean up the last commit" reflex hides work from review

## Install

Drop `steering.json` at `~/.pi/agent/steering.json` (global) or at the root of a project (scoped via walk-up loader). For the cwd-scoped variant, rename `steering.cwd-scoped.json` → `steering.json` and adjust the `when.cwd` regex to match your tree.

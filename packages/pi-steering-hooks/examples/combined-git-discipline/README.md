# combined-git-discipline

A batteries-included rule pack that stacks the three individual PR/git-hygiene examples plus the upstream safety defaults. Drop-in starting point for teams that want disciplined PR workflows.

## What it enforces

From this pack (overrides the default force-push rule):

| Rule | What it blocks |
|---|---|
| `no-force-push-strict` | All `git push --force`, including `--force-with-lease`. See [`../force-push-strict`](../force-push-strict). |
| `no-amend` | `git commit --amend` — preserves review-diff continuity. See [`../no-amend`](../no-amend). |
| `pr-create-must-be-draft` | `gh pr create` without `--draft`. See [`../draft-prs-only`](../draft-prs-only). |

From the engine's built-in defaults (retained — not disabled here):

| Rule | What it blocks |
|---|---|
| `no-hard-reset` | `git reset --hard` — prevents silent loss of uncommitted work. |
| `no-rm-rf-slash` | `rm -rf /` with any flag combination or wrapper. `noOverride: true`. |
| `no-long-running-commands` | `npm run dev`, `tsc --watch`, `next dev`, etc. — stop the agent from blocking itself on a watcher. |

## Precedence: how `disable` interacts with a new rule

The default `no-force-push` rule permits `--force-with-lease`. This pack:

1. Turns the default off via `"disable": ["no-force-push"]`.
2. Adds the stricter `no-force-push-strict` rule in its place.

The loader applies `disable[]` as a union across all config layers and looks up rules by `name`, so the order in which files are loaded doesn't matter — the default disappears and the strict version takes over.

## Why these together

Each rule on its own is reasonable. Stacking them encodes a specific team discipline:

- History is append-only (`no-force-push-strict`, `no-amend`, `no-hard-reset`).
- Code review is gated by the human (`pr-create-must-be-draft`).
- The agent can't shoot everyone in the foot or wedge itself on a dev server (`no-rm-rf-slash`, `no-long-running-commands`).

Use this as a starting point and carve out exceptions with inline override comments (`# steering-override: <rule-name> — <reason>`) for the edge cases that genuinely need them.

## When to use

- Teams that want a disciplined PR workflow without per-agent coaching
- Shared repositories where agent autonomy is useful but history integrity matters
- Starting point for building your own house rules — copy this file, tune the reasons, add more rules

## Install

Drop the file at `~/.pi/agent/steering.json` (global) or at a project root (scoped via walk-up loader). For tighter scoping, add `cwdPattern` to individual rules — see [`../no-amend`](../no-amend) for an example.

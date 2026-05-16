# draft-prs-only

A rule pack that forces `gh pr create` to include `--draft`.

> **v0.1.0 TypeScript form:** see [`steering.ts`](./steering.ts) — drop in at `~/.pi/steering.ts` or `<project-root>/.pi/steering.ts`. The JSON form in [`steering.json`](./steering.json) is still supported for v0.0.x configs.

## What it enforces

- `gh pr create --title "..."` → **blocked**
- `gh pr create --draft --title "..."` → allowed (happy path)
- `gh pr ready 42` → allowed (flipping from draft to ready is fine)
- `gh pr list`, `gh pr view`, everything else → allowed

## How it works

The rule uses two of the schema's predicates in combination:

- `pattern: "^gh\\s+pr\\s+create\\b"` — fires on any `gh pr create` invocation.
- `unless: "--draft\\b"` — exempts the command if `--draft` is present anywhere in the argument list.

`unless` is the escape hatch baked into the schema precisely for "mostly block, but allow the safe variant" rules like this one. No need to write two patterns.

## Why

This rule encodes a simple workflow discipline: *the agent proposes, the human disposes.*

1. Agent produces the diff and opens the PR as a **draft**.
2. Human reviews the diff (and optionally the agent's reasoning).
3. Once satisfied, the human marks it ready with `gh pr ready <n>`.
4. Merge proceeds through whatever normal review/CI path the repo has.

Blocking `gh pr create` without `--draft` prevents the failure mode where an agent publishes a review-ready PR before anyone has looked at it. The rule doesn't block `gh pr ready` because marking an already-reviewed PR ready is a normal, intended human step.

## When to use

- Teams that require human-in-the-loop approval before a PR goes live
- Repos with reviewer rotation / auto-assignment that shouldn't be triggered by half-finished AI work
- Any workflow where "PR exists but is not ready" is a meaningful state

## Install

Drop the file at `~/.pi/agent/steering.json` (global), at `<project-root>/.pi/steering.json` (project-scoped), or merge into an existing `steering.json`.

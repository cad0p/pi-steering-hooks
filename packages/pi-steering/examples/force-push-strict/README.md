# force-push-strict

A rule pack that blocks **every** form of `git push --force`, including `--force-with-lease`.

## What it enforces

- `git push --force` → blocked
- `git push -f` → blocked
- `git push --force-with-lease` → **blocked** (this is the difference from the default)
- `git push origin main` → allowed

The pattern also handles git pre-subcommand flags (`git -C /other push --force`, `git -c key=val push -f`) and wrapper bypasses (`sh -c 'git push --force'`, `sudo xargs git push --force`, …) — all transparently, via the AST backend.

## How it differs from the default

The built-in `no-force-push` rule permits `--force-with-lease` because the lease flag is the documented "safe" way to update a branch after a rebase. That's fine for most teams, but in environments where:

- the branch is shared broadly (`main`, `develop`, long-lived release branches),
- history integrity is a compliance requirement, or
- you want the agent to never reach for any `--force` variant as a first-line fix,

the lease-variant carve-out is an attack surface. This rule pack closes it.

## When to use

- Strict-history environments (shared release branches, regulated contexts)
- Teams that want a single "never force push" discipline without agent-side judgement calls
- As a starting point for more restrictive house rules

## Install

Two equivalent forms. Pick whichever matches your setup.

### v0.1.0+ TypeScript form (preferred)

Copy [`steering.ts`](./steering.ts) to `~/.pi/steering.ts` (or
`<project-root>/.pi/steering.ts`) for a repo-scoped policy. The
TypeScript form participates in compile-time checking via
`defineConfig`.

### v0.0.x JSON form (legacy)

Merge this into your `steering.json`. The `disable` entry turns off the built-in `no-force-push`; the new `no-force-push-strict` rule takes its place:

```json
{
  "disable": ["no-force-push"],
  "rules": [
    {
      "name": "no-force-push-strict",
      "tool": "bash",
      "field": "command",
      "pattern": "^git\\b(?:\\s+-{1,2}[A-Za-z]\\S*(?:\\s+\\S+)?)*\\s+push\\b.*(?:--force\\b|\\s-f(?:\\s|$))",
      "reason": "No force pushes of any kind, including --force-with-lease."
    }
  ]
}
```

Drop the file at `~/.pi/agent/steering.json` for a global policy, or at `<project-root>/.pi/steering.json` for repo-scoped enforcement (the loader walks up from the session cwd and merges every `.pi/steering.json` it finds).

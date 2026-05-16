# pi-steering-commit-format

Commit-message format validation predicates for [pi-steering](https://github.com/cad0p/pi-steering-hooks).

Bundled formats:

- **Conventional Commits 1.0.0** — `feat: `, `fix(scope): `, `refactor!: …`, etc.
- **Bracketed JIRA-style ticket references** — `[ABC-123]`, `[ORACLE-1234]`, etc.

Extensible via `commitFormatFactory` — bring your own format checker and combine with the builtins.

## What this package is

A sibling of `pi-steering` shipping the universal commit-message format checks as a plugin. Mirrors the `pi-steering-flags` precedent: opt-in functionality that doesn't belong in pi-steering core. External plugin authors get a clean import path; consumers that don't need commit-format validation don't pay the surface-area cost.

The package parses commit message strings — it does not walk bash ASTs. No `unbash` / `unbash-walker` dependency.

## Quick start

```ts
// .pi/steering/index.ts
import { defineConfig } from "pi-steering";
import commitFormatPlugin from "pi-steering-commit-format";

export default defineConfig({
  plugins: [commitFormatPlugin],
  rules: [
    {
      name: "require-conventional-commit",
      tool: "bash",
      field: "command",
      pattern: /^git\s+commit\b/,
      when: { commitFormat: { require: ["conventional"] } },
      reason:
        "Commit messages must follow Conventional Commits 1.0.0 (feat: ..., fix(scope): ..., etc.).",
    },
    {
      name: "require-jira-and-conventional",
      tool: "bash",
      field: "command",
      pattern: /^git\s+commit\b/,
      when: { commitFormat: { require: ["conventional", "jira"] } },
      reason:
        "Commit messages must follow Conventional Commits AND include a bracketed JIRA reference (e.g. [ABC-123]).",
    },
  ],
});
```

## Predicate

### `when.commitFormat`

Rule fires (commit BLOCKED) when the commit message fails any required format check.

```ts
commitFormat: {
  require: readonly FormatName[];   // AND across listed formats
}
```

The default plugin ships with two format checkers:

- `"conventional"` — Conventional Commits 1.0.0 header check.
- `"jira"` — at least one bracketed JIRA-style reference (`[ABC-123]`).

Empty `require: []` is a no-op (nothing required → nothing fires).

The predicate inspects `ctx.input.command`, extracts the `-m <msg>` value via `extractCommitMessage`, and runs every required checker. Commands without a `-m` (e.g., bare `git commit`, which would open an editor) are NOT validated by this predicate — the editor flow needs a separate hook.

## License

MIT

# pi-steering-commit-format

Commit-message format validation predicates for [pi-steering](https://github.com/cad0p/pi-steering-hooks).

Bundled formats:

- **Conventional Commits 1.0.0 (Angular preset type allowlist)** — `feat: `, `fix(scope): `, `refactor!: …`, etc. The 11-token Angular preset (`feat|fix|docs|style|refactor|perf|test|chore|ci|build|revert`); 1.0.0-conformant types outside that set (`release:`, `merge:`, …) are rejected.
- **Bracketed JIRA-style ticket references** — `[ABC-123]`, `[PROJ-1234]`, etc.

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
        "Commit messages must follow Conventional Commits 1.0.0 with the Angular preset's type allowlist (feat: ..., fix(scope): ..., etc.).",
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

- `"conventional"` — Conventional Commits 1.0.0 header check, restricted to the Angular preset's 11-token type allowlist (see the package overview above).
- `"jira"` — at least one bracketed JIRA-style reference (`[ABC-123]`).

Empty `require: []` is a no-op (nothing required → nothing fires).

The predicate inspects `ctx.input.command`, extracts the `-m <msg>` value via `extractCommitMessage`, and runs every required checker. Commands without a `-m` (e.g., bare `git commit`, which would open an editor) are NOT validated by this predicate — the editor flow needs a separate hook.

## Combine with custom formats

Use `commitFormatFactory` to build your own predicate that AND-gates the builtins with a custom checker:

```ts
import {
  BUILTIN_FORMATS,
  commitFormatFactory,
} from "pi-steering-commit-format";
import type { Plugin } from "pi-steering";

const myCommitFormat = commitFormatFactory({
  ...BUILTIN_FORMATS,
  custom: (msg) => /^\[CUSTOM\]/.test(msg),
});

export const myPlugin = {
  name: "my-org",
  predicates: { commitFormat: myCommitFormat },
} as const satisfies Plugin;
```

The factory's `require:` arg is type-narrowed to `keyof F`, so TypeScript flags typos at the rule's `when:` slot. Calling with an unknown format name via a JS / `as any` bypass fail-CLOSES (the predicate fires).

`BUILTIN_FORMATS` is the registry of available checkers, NOT a default-required set — callers always pick which formats to AND together via `require:`.

## License

MIT

# pi-steering/plugins/git

Git plugin for [pi-steering](../../../README.md) — branch
awareness, upstream checks, and git-specific cwd tracking on top of
the core steering engine.

> **Default-on.** As of v0.1.0 this plugin is registered
> automatically via [`DEFAULT_PLUGINS`](../../defaults.ts). New
> consumers get the predicates, rules, tracker, and cwd extensions
> without an explicit `import`. Opt out via
> `defineConfig({ disabledPlugins: ["git"] })` or drop all defaults
> with `disableDefaults: true`. See [Disabling](#disabling) below.

## What it ships

| Surface | Names | Purpose |
|---|---|---|
| Predicates | `branch`, `upstream`, `commitsAhead`, `hasStagedChanges`, `isClean`, `remote` | New `when.<key>` slots for rules |
| Rules | `no-main-commit` | Block direct commits to protected branches |
| Trackers | `branch` | Walker-threaded branch state (`git checkout X` advances) |
| Tracker extensions | `cwd.git` | `--git-dir=` / `--work-tree=` flag parsing on top of the built-in cwd tracker |

## Usage

```ts
// .pi/steering.ts
import { defineConfig } from "pi-steering";

export default defineConfig({
  // No explicit `plugins: [gitPlugin]` needed — it's in DEFAULT_PLUGINS.
  rules: [
    // Custom rule layered on top of the plugin's predicates:
    {
      name: "no-push-when-dirty",
      tool: "bash",
      field: "command",
      pattern: "^git\\s+push\\b",
      when: { isClean: false },
      reason: "Stash or commit your working changes before pushing.",
    },
  ],
});
```

Explicit import still works (e.g. in tests driving `loadHarness`
with `includeDefaults: false`):

```ts
import gitPlugin from "pi-steering/plugins/git";

export default defineConfig({
  plugins: [gitPlugin],
  rules: [...],
});
```

### Disabling

Keep the predicates + tracker, drop the shipped rule:

```ts
export default defineConfig({
  disabledRules: ["no-main-commit"],
});
```

Drop the whole git plugin (no `branch` / `upstream` / ... predicates,
no tracker, no cwd extensions, no rule):

```ts
export default defineConfig({
  disabledPlugins: ["git"],
});
```

Drop EVERYTHING shipped — both `DEFAULT_RULES` and
`DEFAULT_PLUGINS`:

```ts
export default defineConfig({
  disableDefaults: true,
});
```

## Predicate reference

### `branch`

Match the current git branch.

```ts
when: { branch: /^main$/ }
when: { branch: "^feat-" }                             // string = regex source
when: { branch: { pattern: /^main$/, onUnknown: "allow" } }
```

Resolution order:
1. `ctx.walkerState.branch` — set by the branch tracker when the
   current bash chain contains `git checkout` / `git switch`. This is
   what makes `git checkout main && git commit` evaluate against
   `main` (not the pre-chain branch).
2. `git branch --show-current` in `ctx.cwd`.

`onUnknown` defaults to `"block"` (fail-closed) — if neither source
resolves, the predicate reports "match" so the rule fires.

### `upstream`

Match the current branch's configured upstream (`git rev-parse
--abbrev-ref @{upstream}`). Same shape as `branch`, no tracker today.

```ts
when: { upstream: /^origin\/main$/ }
when: { upstream: { pattern: "^origin/", onUnknown: "allow" } }
```

### `commitsAhead`

Match the count of commits ahead of a revision (default
`@{upstream}`).

```ts
when: { commitsAhead: { eq: 1 } }                       // exactly one
when: { commitsAhead: { gt: 0 } }                       // at least one
when: { commitsAhead: { gt: 0, lt: 5 } }                // 1..4
when: { commitsAhead: { wrt: "origin/main", eq: 1 } }
```

At least one of `eq` / `gt` / `lt` must be specified. Returns
`false` (rule skips) on exec failure or non-numeric output — pair
with `upstream` for fail-closed behavior.

### `hasStagedChanges` / `isClean`

Boolean predicates.

```ts
when: { hasStagedChanges: true }   // staged changes exist
when: { hasStagedChanges: false }  // no staged changes
when: { isClean: true }            // working tree clean
when: { isClean: false }           // working tree dirty
```

Returns `false` on exec failure. Layer with `upstream` if you need
fail-closed behavior.

### `remote`

Match the `origin` remote URL. Same shape as `branch`.

```ts
when: { remote: /github\.com:org\// }
when: { remote: { pattern: /production/, onUnknown: "block" } }
```

## Shipped rules

### `no-main-commit`

Blocks direct commits to protected branches (`main`, `master`,
`mainline`, `trunk`).

```ts
{
  name: "no-main-commit",
  tool: "bash",
  field: "command",
  pattern: "^git\\b(?:\\s+-{1,2}[A-Za-z]\\S*(?:\\s+\\S+)?)*\\s+commit\\b",
  when: { branch: /^(main|master|mainline|trunk)$/ },
  reason: "Don't commit directly to a protected branch...",
  noOverride: false,
}
```

Overridable via `# steering-override: no-main-commit — <reason>` on
the bash command. Catches `git -C /path commit`, `sh -c 'git
commit'`, and — thanks to the branch tracker — `git checkout main
&& git commit`.

## Authoring new plugins

This directory is the canonical reference for plugin authors. The
file layout separates concerns:

- `branch-tracker.ts` — walker state modifier (one file per tracker).
- `cwd-extensions.ts` — modifiers layering onto existing trackers.
- `predicates.ts` — one handler per `when.<key>` slot.
- `rules.ts` — rule definitions consuming the above.
- `index.ts` — default export assembling the plugin.

Each file has its own test suite; `integration.test.ts` pins end-to-
end wiring through `resolvePlugins` and `buildEvaluator`. Copy-adapt
this layout for your own plugin.

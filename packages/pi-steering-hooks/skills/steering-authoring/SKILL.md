---
name: steering-authoring
description: Author declarative steering rules for pi-steering. Use when the user asks to block or allow agent tool calls, write guardrails for bash/write/edit, author pi steering rules, add rule plugins, or migrate an old .pi/steering.json to the v2 TypeScript config.
---

# pi-steering-hooks

You have `pi-steering` installed. It blocks and allows agent tool calls (bash, write, edit) via declarative rules authored in TypeScript.

## Where things live

- Rules: `.pi/steering/index.ts` (directory form) or `.pi/steering.ts` (single-file form).
- Local plugins: `.pi/steering/plugins/*.ts`, imported into `index.ts`.
- Tests: `.pi/steering/*.test.ts` using `pi-steering/testing`.

The loader walks up from `cwd` to the nearest `.pi/` dir, falling back to `~/.pi/`. See the README for the full precedence order.

## Common operations

| User says | You do |
|---|---|
| "block X" | Add a `Rule` with `tool`, `field`, and `pattern` to the `rules` array. |
| "block X only in dir Y" | Add `when: { cwd: /Y/ }` to the rule. |
| "block X unless on branch Z" | `when: { not: { branch: /Z/ } }` — requires the git plugin. |
| "block X unless `--flag`" | `unless: /--flag\b/`. |
| "require Y before X" | Observer that `appendEntry`s a marker, plus a rule whose `when.condition` reads `findEntries` and checks `turnIndex < ctx.turnIndex`. |
| "add a custom check" | Write a plugin in `.pi/steering/plugins/`, import it into `index.ts`, register it in `plugins: [...]`. |
| "test this rule" | Create `steering.test.ts` using `expectBlocks` / `expectAllows` / `loadHarness`. |
| "migrate my old JSON config" | Run `pi-steering import-json .pi/steering.json -o .pi/steering.ts`. |

## Minimal config

```ts
import { defineConfig } from "pi-steering";

export default defineConfig({
  rules: [
    {
      name: "no-dangerous-command",
      tool: "bash",
      field: "command",
      pattern: /^dangerous-command\b/,
      reason: "don't run this",
    },
  ],
});
```

`DEFAULT_PLUGINS` and `DEFAULT_RULES` (e.g. `no-force-push`, `no-rm-rf-slash`) are included automatically. Disable specific defaults via `disable: ["name"]` or opt out entirely with `disableDefaults: true`.

## Git plugin (branch / upstream / commits-ahead predicates)

```ts
import { defineConfig } from "pi-steering";
import gitPlugin from "pi-steering/plugins/git";

export default defineConfig({
  plugins: [gitPlugin],
  rules: [
    {
      name: "no-main-push",
      tool: "bash",
      field: "command",
      pattern: /^git\s+push\b/,
      when: { branch: /^(main|master|mainline|trunk)$/ },
      reason: "don't push from main",
    },
  ],
});
```

## Testing

```ts
// .pi/steering/steering.test.ts
import { describe, it } from "node:test";
import { expectAllows, expectBlocks, loadHarness } from "pi-steering/testing";
import config from "./index.ts";

describe("my steering config", () => {
  const harness = loadHarness({ config, includeDefaults: true });

  it("blocks dangerous-command", async () => {
    await expectBlocks(harness, { command: "dangerous-command run" });
  });

  it("allows safe commands", async () => {
    await expectAllows(harness, { command: "ls" });
  });
});
```

Run with `node --test --experimental-strip-types '.pi/steering/**/*.test.ts'`.

## Details

Read [the package README](../../README.md) for the full schema, plugin authoring, observer / turn-state patterns, override semantics, and migration notes.

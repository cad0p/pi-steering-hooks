---
name: steering-authoring
description: Author declarative steering rules for pi-steering. Use when the user asks to block or allow agent tool calls, write guardrails for bash/write/edit, author pi steering rules, add rule plugins, or convert a JSON steering config to the TypeScript config.
---

# pi-steering

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
| "require Y before X" | Observer that `appendEntry`s a marker, plus a rule whose `when.happened` gates on it (`{ event, in: "agent_loop" }`). Prefer this to hand-rolled `findEntries` + `agentLoopIndex` comparisons — same semantics, less code. |
| "require Y in a **prior** tool_call, not same-chain" | `when: { happened: { event, in: "agent_loop", notIn: "tool_call" } }`. `notIn` is scope subtraction — it removes the narrower scope from the broader one, so `&&`-chain bypass is blocked. Distinct from clause-level `not` (boolean negation). |
| "invalidate Y when Z happens" | `when: { happened: { event: Y_EVENT, in: "agent_loop", since: Z_EVENT } }`. Y only counts if its latest entry is newer than Z's latest entry in scope. If Z never happened, the clause degrades to a simple presence check. |
| "add a custom check" | Write a plugin in `.pi/steering/plugins/`, import it into `index.ts`, register it in `plugins: [...]`. |
| "change the reason on a built-in rule" | Import the original rule from its plugin, spread it with `{ ...original, name: "new-name", reason: "..." }`, and use `disabledRules: ["original-name"]` + add the replacement. Preserves pattern / when / observer. |
| "test this rule" | Create `steering.test.ts` using `expectBlocks` / `expectAllows` / `loadHarness`. |
| "convert my JSON config to TypeScript" | Run `pi-steering import-json .pi/steering.json -o .pi/steering.ts`. Plugins, observers, and function predicates don't round-trip — author those directly in TS. |
| "publish a pi-steering plugin" | Package as `pi-steering-<domain>` (unscoped) with `keywords: ["pi-package", "pi-steering-package"]` in package.json. peerDep on `pi-steering`. |

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

`DEFAULT_PLUGINS` and `DEFAULT_RULES` (e.g. `no-force-push`, `no-rm-rf-slash`) are included automatically. Disable specific defaults via `disabledRules: ["name"]` or opt out entirely with `disableDefaults: true`.

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

Read [the package README](../../README.md) for the full schema, plugin authoring, observer / turn-state patterns, override semantics, and the JSON-to-TS conversion surface.

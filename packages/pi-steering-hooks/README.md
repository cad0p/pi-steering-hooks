# @cad0p/pi-steering-hooks

Declarative tool-call guardrails for [pi](https://github.com/mariozechner/pi-coding-agent), authored in TypeScript.

Three things that make this package distinct:

- **AST-backed bash inspection.** The evaluator parses every command with [`unbash-walker`](../unbash-walker/) and runs rules against the extracted command structure — not the raw string. `sh -c 'git push --force'`, `cd /repo && git push --force`, and `git push "--force"` are all caught by the same `^git\s+push.*--force` pattern. `echo 'git push --force'` is correctly not flagged. See the [24-case adversarial matrix](../unbash-walker/src/adversarial-matrix.test.ts) for the full pinned behaviour.
- **TypeScript-first config.** Rules, plugins, observers, and trackers all live in `.pi/steering/index.ts`. Plugins are distribution units — `import gitPlugin from "@cad0p/pi-steering-hooks/plugins/git"` gives you `when.branch`, `when.upstream`, `when.commitsAhead`, a walker-threaded branch tracker, and a `no-main-commit` rule you can `disable: [...]` if you don't want it. Everything is unit-testable with the same primitives the engine itself uses.
- **Pi-native turn state.** Observers fire on `tool_result` and write typed entries via `pi.appendEntry`. Predicates read them back via `findEntries` and gate on `entry.turnIndex < ctx.turnIndex` — "must have happened in a prior turn". Rules like "must run `sync` before `cr`" or "must read the CR description before submitting" become 10-line definitions, not custom pi extensions.

Inspired by [samfoy/pi-steering-hooks](https://github.com/samfoy/pi-steering-hooks) (schema DNA, override-comment syntax, default-rule set). See [Relationship to related packages](#relationship-to-related-packages) for how the two have diverged.

## Install

```bash
pi install @cad0p/pi-steering-hooks
```

Requires **Node ≥ 22** — the loader reads `.pi/steering.ts` via native type-stripping (no `tsx` / `ts-node` runtime). On older Node the loader throws with an upgrade message at session start.

### Local install (during the PoC)

Until the first npm publish, install from a local clone:

```bash
git clone https://github.com/cad0p/pi-steering-hooks.git
cd pi-steering-hooks

pnpm install
pnpm --filter @cad0p/pi-steering-hooks build   # dist/ is gitignored — build first

pi install ./packages/pi-steering-hooks
```

Then restart pi.

**After code changes.** Rebuild, then restart pi:

```bash
pnpm --filter @cad0p/pi-steering-hooks build
```

Why both steps matter:

- `pi install <local-path>` only registers the path in settings — it does **not** run a build or any install hook.
- The package is compiled (`"main": "./dist/index.js"`) and `dist/` is gitignored, so edits to `src/` only take effect after a build.
- `/reload` inside pi picks up settings, skills, prompts, and themes — but for compiled extension code, transitive `dist/` imports sit in Node's native ESM cache and are not reliably reloaded. A full pi restart is the safe option after rebuilding.

For tight iteration, run the build in watch mode in a separate terminal and only restart pi when you want to pick up the latest compiled output:

```bash
pnpm --filter @cad0p/pi-steering-hooks build -- --watch
```

## Quick start

Create `.pi/steering.ts` at your project root:

```ts
// .pi/steering.ts
import { defineConfig } from "@cad0p/pi-steering-hooks";

export default defineConfig({
  rules: [
    {
      name: "no-force-push",
      tool: "bash",
      field: "command",
      pattern: /^git\s+push.*--force\b/,
      reason: "Force-push rewrites history. Use --force-with-lease if needed.",
    },
  ],
});
```

What each field does:

- `name` — unique identifier. Shown in the block message, used in override comments and audit entries.
- `tool` — which pi tool to intercept. One of `"bash"`, `"write"`, `"edit"`.
- `field` — which field of the tool's input the pattern tests. Always `"command"` for bash; `"path"` or `"content"` for write/edit.
- `pattern` — regex tested against the AST-extracted command string (`basename + " " + args.join(" ")`) per extracted command reference. Anchor with `^` so `echo 'git push --force'` is not a false positive.
- `reason` — message the agent sees when blocked. Write it for the agent: what it did wrong and what the safe alternative looks like.

With this config, `git push --force`, `sh -c 'git push --force'`, and `cd /repo && git push --force` all block. `git push --force-with-lease` is not matched by this pattern and passes through.

## File layout

Two accepted forms — single-file for simple configs, directory for anything that wants local plugins, split rule files, or co-located tests:

```
.pi/steering.ts              # single-file form

.pi/steering/
├── index.ts                 # required entry point (default export)
├── plugins/my-plugin.ts
├── rules/{git,security}.ts
└── helpers.ts
```

In the directory form, **only `.pi/steering/index.ts` is a config entry point** — other `.ts` files are imports.

**Only `.ts` accepted.** JSON configs are not loaded; use [`fromJSON` / `pi-steering import-json`](#migrating-from-v1-json) to convert. A bare `<ancestor>/steering.ts` (outside a `.pi/` directory) is intentionally not discovered.

**Walk-up precedence.** The loader walks from the session cwd up to `$HOME`, collecting every `.pi/steering/index.ts` or `.pi/steering.ts` it finds. Inner layers (closer to cwd) win on rule-name collisions. `disable` and `disablePlugins` entries are unioned across layers — once a rule is disabled at any layer, no inner layer can re-enable it. `defaultNoOverride` and `disableDefaults` are set by the innermost layer that specifies them.

## Schema reference

Every example below uses `defineConfig` — the recommended authoring path. It threads plugin-registered observer names through to the `rules[i].observer` field as a string literal type so typos become compile errors. `satisfies SteeringConfig` is also available if you don't need the inference.

### `Rule`

```ts
interface Rule {
  name: string;
  tool: "bash" | "write" | "edit";
  field: "command" | "path" | "content";
  pattern: string | RegExp;
  requires?: string | RegExp | PredicateFn;
  unless?: string | RegExp | PredicateFn;
  when?: WhenClause;
  reason: string;
  noOverride?: boolean;
  observer?: Observer | string;
}
```

| Field | Description |
|-------|-------------|
| `name` | Unique identifier. Used in override comments, audit entries, and the `[steering:<name>]` prefix in block reasons. |
| `tool` | Which pi tool to intercept. |
| `field` | Which input field to test. For `bash`, always `"command"`. For `write`/`edit`, `"path"` or `"content"`. |
| `pattern` | Main match predicate. `string` is compiled as a regex at load time. Bash patterns run against the AST-extracted command per extracted ref; write/edit patterns run against the raw field value. |
| `requires` | Optional AND predicate. Rule fires only if this also matches. Accepts a pattern or a function. |
| `unless` | Optional exemption. If this matches, the rule does NOT fire. |
| `when` | Composable predicate block. See [`WhenClause`](#whenclause). |
| `reason` | Message shown to the agent when blocked. Should tell the agent what to do instead. |
| `noOverride` | If `true`, no inline-override escape hatch. If `false`, overrides are explicitly allowed (beats the config-level default). Omitted → inherits `defaultNoOverride` (package default: `true`). |
| `observer` | Observer attached to this rule. Inline definition or a string referencing a named observer from a plugin or the config's top-level `observers: [...]`. |

Example:

```ts
import { defineConfig } from "@cad0p/pi-steering-hooks";

export default defineConfig({
  rules: [
    {
      name: "no-amend-in-personal",
      tool: "bash",
      field: "command",
      pattern: /^git\s+commit\b.*--amend/,
      when: { cwd: /\/personal\// },
      unless: /--allow-amend-marker\b/,
      reason: "Don't rewrite history in personal repos.",
      noOverride: false, // explicit opt-in to overridability
    },
  ],
});
```

### `WhenClause`

```ts
interface WhenClause {
  cwd?: Pattern | { pattern: Pattern; onUnknown?: "allow" | "block" };
  not?: WhenClause;
  condition?: (ctx: PredicateContext) => boolean | Promise<boolean>;
  [pluginKey: string]: unknown; // plugin-registered predicates
}
```

Built-in keys:

- `cwd` — the only walker-backed predicate the engine ships. For bash rules this tests against the *effective cwd of each extracted command* (so `cd ~/personal && git commit --amend` evaluates against `~/personal`, not the session cwd). For write/edit, it tests against the session cwd directly.
- `not` — all nested predicates must FAIL for `not` to succeed. Useful for "mostly block, but allow one specific variant".
- `condition` — escape hatch for one-off logic. Prefer plugin predicates when the check is reusable.

Everything else (`branch`, `upstream`, `commitsAhead`, …) comes from plugins. Using a `when.<key>` with a string/regex value the engine doesn't recognize is a schema error at load time — no silent typos.

Example:

```ts
{
  name: "no-main-push",
  tool: "bash",
  field: "command",
  pattern: /^git\s+push\b/,
  when: {
    branch: /^(main|master|mainline|trunk)$/,
    not: { upstream: /^origin\/fork\b/ },
  },
  reason: "Open a PR instead of pushing directly.",
}
```

### `Observer`

```ts
interface Observer {
  name: string;
  watch?: {
    toolName?: "bash" | "read" | "write" | "edit" | string;
    inputMatches?: Record<string, string | RegExp>;
    exitCode?: number | "success" | "failure" | "any";
  };
  onResult: (event: ToolResultEvent, ctx: ObserverContext) => void | Promise<void>;
}
```

Observers fire on `tool_result` events after the tool runs. Their typical job is to record a marker via `ctx.appendEntry(customType, data)` that a later predicate consults. They see `event.input`, `event.output`, `event.exitCode`, and an `ObserverContext` with `cwd`, `turnIndex`, `appendEntry`, and `findEntries`.

Example:

```ts
import type { Observer } from "@cad0p/pi-steering-hooks";

const syncDone: Observer = {
  name: "sync-done",
  watch: { toolName: "bash", exitCode: "success" },
  onResult: (event, ctx) => {
    const input = event.input as { command?: string };
    if (/\bws\s+sync\b/.test(input.command ?? "")) {
      ctx.appendEntry("steering-sync-done", { turnIndex: ctx.turnIndex });
    }
  },
};
```

### `Plugin`

```ts
interface Plugin {
  name: string;
  predicates?: Record<string, PredicateHandler>;
  rules?: Rule[];
  observers?: Observer[];
  trackers?: Record<string, Tracker<unknown>>;
  trackerExtensions?: Record<string, Record<string, Modifier<unknown> | readonly Modifier<unknown>[]>>;
}
```

A plugin bundles extension points:

- `predicates` — new `when.<key>` slots. Each is a `(args, ctx) => boolean` handler.
- `rules` — rules the plugin ships. Users opt out per-rule with `disable: ["<rule-name>"]`.
- `observers` — reusable observers. Rules reference them by name via `observer: "<observer-name>"`.
- `trackers` — NEW walker state dimensions (e.g. `branch`). Name collisions across plugins are a **hard error**.
- `trackerExtensions` — modifiers layered onto EXISTING trackers (e.g. teach `cwd` how to parse `git --git-dir=…`). Collisions log a warning and keep the first registration.

Plugin loading precedence is first-wins across project-local plugins, `plugins: [...]` declaration order, and `DEFAULT_PLUGINS`. Name collisions on predicates / rules / observers / tracker-extensions log a WARN and keep the first registered entry.

See [Writing custom plugins](#writing-custom-plugins) for a skeleton.

### `SteeringConfig`

```ts
interface SteeringConfig {
  defaultNoOverride?: boolean;
  disable?: string[];
  disablePlugins?: string[];
  disableDefaults?: boolean;
  plugins?: Plugin[];
  rules?: Rule[];
  observers?: Observer[];
}
```

| Field | Description |
|-------|-------------|
| `defaultNoOverride` | Default value for `Rule.noOverride` when a rule doesn't set its own. Package default: `true` (fail-closed). Walk-up: inner layer wins if set. |
| `disable` | Rule names to disable. Union across layers. Applies to both plugin-shipped and user-authored rules. |
| `disablePlugins` | Plugin names to disable entirely. Union across layers. A disabled plugin contributes nothing — no rules, no observers, no predicates, no trackers. |
| `disableDefaults` | Skip `DEFAULT_PLUGINS` and `DEFAULT_RULES`. Inner layer wins if set. |
| `plugins` | Plugins to load. Declaration order matters for first-wins collision handling. |
| `rules` | User-authored rules. |
| `observers` | Top-level observers, referenced from rules by name. |

Full example:

```ts
import { defineConfig } from "@cad0p/pi-steering-hooks";
import gitPlugin from "@cad0p/pi-steering-hooks/plugins/git";

export default defineConfig({
  plugins: [gitPlugin],
  disable: ["no-long-running-commands"],
  rules: [
    {
      name: "no-push-when-dirty",
      tool: "bash",
      field: "command",
      pattern: /^git\s+push\b/,
      when: { isClean: false },
      reason: "Stash or commit your changes before pushing.",
    },
  ],
});
```

## Default rules

The package ships four default rules. All four are anchored to the AST-extracted command basename, so `echo 'rm -rf /'` is not a false positive.

| Name | Tool | Blocks |
|------|------|--------|
| `no-force-push` | bash | `git push --force` / `-f`. Accepts `-C /path`, `-c key=val`, `--git-dir=/x` before `push`. Allows `--force-with-lease`. |
| `no-hard-reset` | bash | `git reset --hard` (with the same pre-subcommand flag broadening). |
| `no-rm-rf-slash` | bash | `rm -rf /` in any flag-letter order (`-rf`, `-fr`, `-Rf`, `--recursive --force`). **`noOverride: true`** — hard block. |
| `no-long-running-commands` | bash | `npm run dev`, `yarn start`, `pnpm dev`, `tsc --watch`, `nodemon`, `vite`, `astro dev`, `next dev`, `deno task dev`, `bun dev` and similar. Blocks watchers and dev servers that would deadlock the agent loop. |

Disable specific defaults by name:

```ts
export default defineConfig({
  disable: ["no-long-running-commands"],
});
```

Opt out of all defaults (both `DEFAULT_RULES` and `DEFAULT_PLUGINS`):

```ts
export default defineConfig({
  disableDefaults: true,
});
```

## The git plugin

Opt-in — not loaded by default. Import and register:

```ts
import { defineConfig } from "@cad0p/pi-steering-hooks";
import gitPlugin from "@cad0p/pi-steering-hooks/plugins/git";

export default defineConfig({
  plugins: [gitPlugin],
});
```

### Predicates

| Key | Arg shape | Purpose |
|-----|-----------|---------|
| `branch` | `Pattern` or `{ pattern, onUnknown }` | Match the current git branch. Reads walker state first (updated by the branch tracker on `git checkout X`), then falls back to `git branch --show-current`. |
| `upstream` | `Pattern` or `{ pattern, onUnknown }` | Match `git rev-parse --abbrev-ref @{upstream}`. |
| `commitsAhead` | `{ wrt?: string, eq?: number, gt?: number, lt?: number }` | Count commits ahead of a revision (default `@{upstream}`). At least one of `eq`/`gt`/`lt` required. |
| `hasStagedChanges` | `true` / `false` | Whether the index has staged changes. |
| `isClean` | `true` / `false` | Whether the working tree is clean. |
| `remote` | `Pattern` or `{ pattern, onUnknown }` | Match the `origin` remote URL. |

### Branch tracker

The plugin registers a `branch` tracker so `git checkout main && git commit` evaluates `when.branch` against `main`, not the pre-checkout branch. Without walker tracking, the predicate would run `git branch --show-current` at tool-call start and miss the `checkout`, producing silent bypasses.

The plugin also extends the core `cwd` tracker to parse `--git-dir=…` / `--work-tree=…` flags on `git` invocations.

### Shipped rule

`no-main-commit` — blocks commits to `main`, `master`, `mainline`, `trunk`:

```ts
{
  name: "no-main-commit",
  tool: "bash",
  field: "command",
  pattern: /^git\b(?:\s+-{1,2}[A-Za-z]\S*(?:\s+\S+)?)*\s+commit\b/,
  when: { branch: /^(main|master|mainline|trunk)$/ },
  reason: "Don't commit directly to a protected branch...",
  noOverride: false,
}
```

Overridable. `git -C /path commit`, `sh -c 'git commit'`, and `git checkout main && git commit` all fire it.

Disable via `disable: ["no-main-commit"]` while keeping the predicates; opt out of the whole plugin with `disablePlugins: ["git"]`.

### Worked examples

```ts
// Block any rewriting-ish git operation when on main.
{
  name: "protect-main",
  tool: "bash",
  field: "command",
  pattern: /^git\s+(?:commit|rebase|reset|push\s+--force)\b/,
  when: { branch: /^(main|master|mainline|trunk)$/ },
  reason: "Switch off main before rewriting history.",
}

// Only allow `push` when the current branch is exactly one commit
// ahead of origin/main — the "PR-shaped branch" check.
{
  name: "cr-one-commit",
  tool: "bash",
  field: "command",
  pattern: /^git\s+push\b/,
  when: {
    not: { commitsAhead: { wrt: "origin/main", eq: 1 } },
  },
  reason: "Your branch must be exactly one commit ahead of origin/main before pushing.",
}
```

See [`src/plugins/git/README.md`](./src/plugins/git/README.md) for the full plugin reference, including arg shapes and `onUnknown` handling.

## Writing custom plugins

Plugins are the distribution unit for reusable checks. Use the git plugin as the reference layout:

```
plugins/my-plugin/
├── index.ts              # default export assembling the plugin
├── predicates.ts         # one handler per `when.<key>` slot
├── rules.ts              # rule definitions
├── <name>-tracker.ts     # optional: new walker state (one file per tracker)
└── cwd-extensions.ts     # optional: modifiers layered on existing trackers
```

Skeleton:

```ts
// plugins/my-plugin/index.ts
import type { Plugin, PredicateHandler } from "@cad0p/pi-steering-hooks";

const myPredicate: PredicateHandler<{ threshold: number }> = async (args, ctx) => {
  // args is whatever the user put under `when.myPredicate`
  // ctx exposes cwd, tool, input, turnIndex, exec, appendEntry, findEntries, walkerState
  const result = await ctx.exec("wc", ["-l", ctx.input.path ?? ""], { cwd: ctx.cwd });
  const lines = Number.parseInt(result.stdout.trim().split(/\s+/)[0] ?? "0", 10);
  return lines > args.threshold;
};

const plugin: Plugin = {
  name: "my-plugin",
  predicates: { myPredicate },
  rules: [
    {
      name: "no-huge-writes",
      tool: "write",
      field: "content",
      pattern: /./,
      when: { myPredicate: { threshold: 1000 } },
      reason: "File would exceed 1000 lines — split it up.",
    },
  ],
};

export default plugin;
```

### `PredicateContext`

The object your handler receives as `ctx`:

| Field | Type | What it gives you |
|-------|------|-------------------|
| `cwd` | `string` | Session cwd, or — for bash rules — the effective cwd of the command (per-ref from the walker). |
| `tool` | `"bash" \| "write" \| "edit"` | Which pi tool is being gated. |
| `input` | `PredicateToolInput` | `{ tool, command? }` for bash; `{ tool, path?, content? }` for write; `{ tool, path?, edits? }` for edit. |
| `turnIndex` | `number` | pi's turn counter for the turn containing this tool-call. |
| `exec` | `(cmd, args, opts?) => Promise<ExecResult>` | Run a command and get `{ stdout, stderr, exitCode }`. **Memoized per `(cmd, args, cwd)` within one tool-call** — two rules asking `git branch --show-current` for the same cwd share the result. No cross-tool-call cache. |
| `appendEntry` | `<T>(type, data?) => void` | Write into pi's session JSONL. |
| `findEntries` | `<T>(type) => Array<{ data: T, timestamp: number }>` | Read prior entries by `customType`. |
| `walkerState` | `Record<string, unknown> \| undefined` | Per-ref walker state. `walkerState.cwd` holds the effective cwd; plugin trackers (like the git plugin's `branch`) add more keys. `undefined` for write/edit rules. |

### Registering a tracker

If your plugin needs new walker-threaded state (like "current branch"), register a `Tracker<T>` under `trackers: { <name>: ... }`. Trackers define modifiers keyed by command basename with `sequential` (propagates forward across the command chain) or `per-command` (applies to that one command only) scope. See [`unbash-walker`](../unbash-walker/README.md) for the Tracker API.

If you just want to layer a flag parser onto an existing tracker (e.g. teach `cwd` about a new tool's `--work-dir=…` flag), use `trackerExtensions: { cwd: { <basename>: <modifier> } }` instead. Tracker-extension collisions on `(tracker, basename)` pairs warn and keep the first registration.

## Observers and turn-state patterns

The most powerful rules aren't pure-match rules. They're sequencing constraints: "don't run B until A has happened". The observer + `findEntries` pattern handles these.

Shape:

1. An **observer** watches `tool_result` events and calls `ctx.appendEntry("marker-name", { turnIndex })` when the precondition has been satisfied.
2. A **rule** guards the dependent tool-call. Its `when.condition` calls `ctx.findEntries("marker-name")` and checks whether an entry exists with `turnIndex < ctx.turnIndex`.

The **strict less-than** is what makes these rules bypass-proof. If the agent runs the precondition AND the dependent command in the same turn, both have `turnIndex = N`; the condition finds no entry with `< N`; block. The agent must run the precondition, let the turn end, then come back in a new turn.

Example — require `ws sync` to have run successfully in a prior turn before `cr` can submit:

```ts
import { defineConfig } from "@cad0p/pi-steering-hooks";
import type { Observer } from "@cad0p/pi-steering-hooks";

const syncDone: Observer = {
  name: "sync-done",
  watch: { toolName: "bash", exitCode: "success" },
  onResult: (event, ctx) => {
    const cmd = (event.input as { command?: string }).command ?? "";
    if (/\bws\s+sync\b/.test(cmd)) {
      ctx.appendEntry("steering-sync-done", { turnIndex: ctx.turnIndex });
    }
  },
};

export default defineConfig({
  observers: [syncDone],
  rules: [
    {
      name: "cr-needs-sync",
      tool: "bash",
      field: "command",
      pattern: /^cr\b/,
      observer: "sync-done", // string reference — type-checked against observer names
      when: {
        condition: (ctx) => {
          const syncs = ctx.findEntries<{ turnIndex: number }>("steering-sync-done");
          return !syncs.some((e) => e.data.turnIndex < ctx.turnIndex);
        },
      },
      reason: "Run `ws sync` in a previous turn before submitting.",
    },
  ],
});
```

Reading the `condition`: "no prior-turn sync entry exists" → rule fires → block. Once a `ws sync` succeeds and the turn ends, the next turn's `cr` call finds the entry and the rule does not fire.

Observer dedup: observers are named and deduped (first-registered wins; later declarations log a WARN). Plugins can ship observers for multiple rules to share.

## Override comments

Any blocked call (unless `noOverride: true`) can be unblocked by adding an inline comment:

```bash
git push --force # steering-override: no-force-push — hotfix revert, coordinated on #infra
```

```ts
// steering-override: no-node-modules-writes — patching upstream bug, tracking in #1234
module.exports.fix = /* ... */;
```

Syntax: `<leader> steering-override: <rule-name> <separator> <reason>`.

- Leaders: `#`, `//`, `/*`, `<!--`, `--`, `%%`, `;;`
- Separators: `—` (em dash), `–` (en dash), `-` (hyphen)

### `defaultNoOverride: true` is the package default

v2 flips the PoC's default. Rules are **hard-block by default** unless you explicitly opt them into overridability:

```ts
{
  name: "flexible-rule",
  tool: "bash", field: "command",
  pattern: /^.../,
  reason: "...",
  noOverride: false, // explicit opt-in — rule IS overridable
}
```

Rationale: turn-state rules ("you must read X first") are semantically un-overridable — an agent adding `# steering-override: cr-description-check — I promise I read it` defeats the purpose. Safer default for all rules. Authors of genuinely overridable rules opt in per-rule.

Effective resolution:

```
effective-noOverride(rule) =
  rule.noOverride ?? config.defaultNoOverride ?? true
```

### Audit trail

When an override is accepted, the extension writes an entry via `pi.appendEntry("steering-override", { rule, reason, command|path, timestamp })`. Overrides are visible in the session transcript and queryable via `findEntries("steering-override")` from other rules.

### Overrides on `write` / `edit`

For `write` and `edit` rules — even rules matching on `path` — the override comment is looked for in the **file body** (the `content` on `write`, or the joined `newText` across `edit`). Path strings have no comment syntax, so this is the only escape hatch for path-matched rules. Set `noOverride: true` on the rule if you want true path-level protection.

## `onUnknown` fail-closed semantics

Some predicates depend on walker-tracked state that can't always be resolved statically — e.g. `cd $VAR && git commit` leaves the cwd tracker in an `unknown` state because `$VAR` isn't expanded at analysis time. The same applies to the git plugin's `branch` when the current command chain contains `git checkout "$BRANCH"`.

When a predicate hits an unresolvable value, it reports the tracker's `unknown` sentinel. The containing rule then applies its `onUnknown` policy: `"block"` (default) treats unknown as a match (fail-closed); `"allow"` treats it as a non-match (rule skips).

```ts
when: {
  cwd: { pattern: /^\/repos\/secure\b/, onUnknown: "allow" },
  branch: { pattern: /^main$/, onUnknown: "block" }, // explicit, same as default
}
```

Default fail-closed is the safer posture: a rule that can't statically prove the agent is NOT in `/repos/secure` blocks. Use `"allow"` only when false positives are more costly than false negatives.

## Testing

The `@cad0p/pi-steering-hooks/testing` subpath is the stable API for rule and plugin authors. It exposes the same primitives the engine uses internally.

### Rule-level tests — `loadHarness` + `expectBlocks` / `expectAllows`

```ts
// .pi/steering/steering.test.ts
import { describe, it } from "node:test";
import {
  expectAllows,
  expectBlocks,
  loadHarness,
} from "@cad0p/pi-steering-hooks/testing";
import config from "./index.ts";

describe("my steering config", () => {
  const harness = loadHarness({ config, includeDefaults: true });

  it("blocks force push", async () => {
    await expectBlocks(harness, { command: "git push --force origin main" }, {
      rule: "no-force-push",
    });
  });

  it("allows safe push", async () => {
    await expectAllows(harness, { command: "git push origin feat/x" });
  });

  it("blocks sh -c wrappers (AST backend, not regex on raw)", async () => {
    await expectBlocks(harness, { command: "sh -c 'git push --force'" }, {
      rule: "no-force-push",
    });
  });
});
```

Shorthand events: `{ command }` for bash, `{ write: { path, content } }` for write, `{ edit: { path, edits } }` for edit. All accept an optional `cwd`.

### Predicate-level tests — `testPredicate`

For plugin authors unit-testing a single predicate handler:

```ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { testPredicate } from "@cad0p/pi-steering-hooks/testing";
import { branch } from "./predicates.ts";

describe("branch predicate", () => {
  it("reads walker state first", async () => {
    const fires = await testPredicate(branch, /^main$/, {
      walkerState: { branch: "main" },
    });
    assert.equal(fires, true);
  });

  it("falls back to git branch --show-current", async () => {
    const fires = await testPredicate(branch, /^feat-/, {
      exec: async () => ({ stdout: "feat-x\n", stderr: "", exitCode: 0 }),
    });
    assert.equal(fires, true);
  });
});
```

`mockContext(options)` is the underlying primitive — use it directly if you need to assert on `getAppendedEntries(ctx)` after the handler runs.

### Observer-level tests — `testObserver`

```ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { testObserver } from "@cad0p/pi-steering-hooks/testing";
import { syncDone } from "./observers.ts";

describe("sync-done observer", () => {
  it("records an entry on ws sync success", async () => {
    const { entries, watchMatched } = await testObserver(
      syncDone,
      { toolName: "bash", input: { command: "ws sync" }, exitCode: 0 },
      { turnIndex: 3 },
    );
    assert.equal(watchMatched, true);
    assert.deepEqual(entries, [
      { customType: "steering-sync-done", data: { turnIndex: 3 } },
    ]);
  });

  it("ignores failed runs", async () => {
    const { entries } = await testObserver(
      syncDone,
      { toolName: "bash", input: { command: "ws sync" }, exitCode: 1 },
    );
    assert.deepEqual(entries, []);
  });
});
```

### Adversarial matrices — `runMatrix` + `formatMatrix`

For pinning a set of bypass attempts in one table:

```ts
import { runMatrix, formatMatrix, loadHarness } from "@cad0p/pi-steering-hooks/testing";
import config from "./index.ts";

const harness = loadHarness({ config, includeDefaults: true });
const result = await runMatrix(harness, [
  { name: "plain",      event: { command: "git push --force" },           expect: { block: true, rule: "no-force-push" } },
  { name: "sh -c wrap", event: { command: "sh -c 'git push --force'" },   expect: { block: true, rule: "no-force-push" } },
  { name: "echo — no fp", event: { command: "echo 'git push --force'" }, expect: "allow" },
  { name: "lease ok",   event: { command: "git push --force-with-lease" }, expect: "allow" },
]);
console.log(formatMatrix(result));
if (result.failed > 0) process.exit(1);
```

`runMatrix` never throws — failures surface in `result.cases`. `formatMatrix` renders an ASCII-friendly report suitable for CI logs.

### Running tests

```bash
node --test --experimental-strip-types '.pi/steering/**/*.test.ts'
```

The `--experimental-strip-types` flag is required on Node 22.0–22.5; Node 22.6+ strips types natively without it.

## Migrating from v1 JSON

One-shot CLI:

```bash
pi-steering import-json .pi/steering.json -o .pi/steering.ts
```

Or as a library call — handy for JSON configs assembled at build time:

```ts
// .pi/steering.ts
import { fromJSON } from "@cad0p/pi-steering-hooks";
import raw from "./steering.json" with { type: "json" };

export default fromJSON(raw);
```

Scope of `fromJSON`:

- Top-level: `disable`, `defaultNoOverride`, `rules`.
- Rule fields: `name`, `tool`, `field`, `pattern` (kept as a string), `requires`, `unless`, `reason`, `noOverride`, `when.cwd` (string).

Rejected (throws `FromJSONError` with a JSONPath-ish location):

- `plugins`, `observers` — not JSON-expressible (function types).
- Function-valued rule fields.
- `when.<customKey>` — plugin predicates have no JSON binding.
- `when.not`, `when.condition` — recursive or function-shaped.

Hitting a rejection means the corresponding rule needs to be authored directly in TypeScript.

## Performance notes

- **Evaluator overhead**: ~4 µs per tool-call at the default 4-rule config, ~6 µs at 50 rules (warm, Node 22 / linux arm64). Against a typical 1–5 s agent turn, this is under 0.001% — effectively invisible.
- **Rule count cost**: ~40 ns per extra rule. The AST pipeline runs once per tool-call, not once per rule.
- **Plugin predicates**: `exec` results are **memoized per `(cmd, args, cwd)` within one tool-call** — two rules asking `git rev-parse @{upstream}` share the result. No cross-tool-call cache; the world can change between turns.
- **`findEntries`**: O(N) scan per call, filtered by `customType`. Indexed per call but not across calls. Long sessions with many entries stay in the low-microsecond range; very long sessions with extremely noisy observers are the pathological case. Prefer narrow `customType` names.

Performance isn't the differentiator — correctness on real agent inputs is. The ~4 µs is low enough to make that correctness essentially free.

## Relationship to related packages

Three choices in the space, with different tradeoffs:

- **[samfoy/pi-steering-hooks](https://github.com/samfoy/pi-steering-hooks)** — JSON-only, session-level cwd, zero runtime dependencies. The lightweight choice when your agent doesn't emit `cd` chains or wrapper commands, and you're comfortable with session-level `when.cwd` scoping.
- **@cad0p/pi-steering-hooks** (this) — TypeScript-first, AST-backed bash inspection, plugin model, stateful turn-scoped rules. The choice when you want correctness against real agent emissions and composable rules that gate on branch, upstream, prior-turn state, and the like.
- **[pi-guard](https://github.com/jdiamond/pi-guard)** — permission prompts, human-in-the-loop UI (allowlists/denylists, prompt-before-run). Operates at a different point of the lifecycle. Steering decides whether the agent *should* run a command given project context; pi-guard decides whether the operator *allows* it. The two compose.

This package shares `unbash-walker` AST infrastructure with pi-guard; once the extraction proposal on pi-guard is resolved, it moves to its own package that both depend on. The schema originated as a fork of samfoy's — basic `pattern` / `requires` / `unless` / `reason` / `noOverride` / `when.cwd` rules migrate between the two, but anything plugin-backed (branch, upstream, observers, turn state) is v2-only.

## Contributing

Open source, MIT. Standard GitHub PR flow. Coding conventions:

- **SSH-signed commits** — `git config commit.gpgsign true` with an SSH signing key configured.
- **Conventional Commits** — `feat(pi-steering-hooks): …`, `fix(...): …`, `docs(...): …`, `test(...): …`. One commit per logical change.
- **Tests required** — new rules, predicates, observers, and plugins all need unit tests. Use the `@cad0p/pi-steering-hooks/testing` primitives.

See the [monorepo README](../../README.md) for the broader plan and roadmap, and [`PUBLISHING.md`](./PUBLISHING.md) for release gate criteria.

## License

MIT. See [`LICENSE`](../../LICENSE).

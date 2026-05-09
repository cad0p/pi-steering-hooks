# pi-steering

AST-backed steering rules for [pi](https://github.com/earendil-works/pi) agents, with stateful predicates and plugin-first composition.

## What this is

A deterministic guardrail layer that sits between your pi agent and the tools it invokes. You declare TypeScript rules that gate `bash` / `write` / `edit` tool calls; the engine parses every command with [`unbash-walker`](../unbash-walker/), walks a per-call tracker state, matches against your rules, and returns a block verdict before pi executes. Observers record state from `tool_result` events so later rules can say "this must have happened first".

Use it when:

- You want to gate commands by structure, not substring — `sh -c 'git push --force'`, `cd /repo && git push --force`, and `git push "--force"` should all trigger the same `^git\s+push.*--force(?!-)` rule, and `echo 'git push --force'` should not.
- You want "must run X before Y" rules that survive across tool calls within the same user prompt.
- You want to ship + version a rule pack as an npm dependency (plugins), not a shared JSON file.

## Install

```bash
pi install pi-steering
```

Requires **Node ≥ 22** — the loader reads `.pi/steering.ts` files via native type-stripping (no `tsx` / `ts-node` runtime). On older Node the loader throws with an upgrade message at session start.

### Local install (during the PoC)

Until the first npm publish, install from a local clone:

```bash
git clone https://github.com/cad0p/pi-steering-hooks.git
cd pi-steering-hooks

pnpm install
pnpm --filter pi-steering build   # dist/ is gitignored — build first

pi install ./packages/pi-steering
```

Then restart pi.

**After code changes.** Rebuild, then restart pi:

```bash
pnpm --filter pi-steering build
```

Why both steps matter:

- `pi install <local-path>` only registers the path in settings — it does **not** run a build or any install hook.
- The package is compiled (`"main": "./dist/index.js"`) and `dist/` is gitignored, so edits to `src/` only take effect after a build.
- `/reload` inside pi picks up settings, skills, prompts, and themes — but for compiled extension code, transitive `dist/` imports sit in Node's native ESM cache and are not reliably reloaded. A full pi restart is the safe option after rebuilding.

## Quick start

Create `.pi/steering/index.ts` at your project root:

```ts
import { defineConfig } from "pi-steering";
import gitPlugin from "pi-steering/plugins/git";

export default defineConfig({
  plugins: [gitPlugin],
  rules: [
    {
      name: "no-force-push",
      tool: "bash",
      field: "command",
      // `(?!-)` rules out `--force-with-lease` — `\b` alone would match
      // it, since `-` is a non-word character and `--force\b` sees a
      // word boundary between `e` and `-`.
      pattern: /^git\s+push.*--force(?!-)/,
      reason: "Force-push rewrites history. Use --force-with-lease if needed.",
    },
  ],
  // Compile-time safety: typo in a rule name below is a TS error.
  // Try changing "no-main-commit" to "no-main-commito" — tsc will reject it.
  disabledRules: ["no-main-commit"],
});
```

With this config:

- `git push --force`, `sh -c 'git push --force'`, and `cd /repo && git push --force` all block.
- `git push --force-with-lease` is not matched.
- The git plugin's `no-main-commit` rule is disabled (you opted out).
- `echo 'git push --force'` correctly does not block — the AST extraction anchors patterns on real command refs, not substrings of arguments.

**Typecheck payoff.** Declare anything that should be typo-checked:

```ts
// @ts-expect-error — "wrong-name" is not a registered rule
disabledRules: ["wrong-name"],
```

This fails at `tsc --noEmit` time — rule / plugin / observer names are threaded through `defineConfig`'s generics and cross-validated.

## How it works

Concrete execution trace — what happens when an agent issues `bash("git push --force && cd /tmp && git log")` under the config above:

```
User prompt sent to pi.

1. pi.on("agent_start") → engine bumps agentLoopIndex from N to N+1.
   One "agent loop" = one user prompt + every tool call it spawns.

2. Agent decides to run the bash tool with:
     command = "git push --force && cd /tmp && git log"

3. pi emits tool_call. Evaluator runs (once per tool_call):

   a. parseBash(command)       → AST
   b. extractAllCommandsFromAST → 3 CommandRefs:
        ref#0: basename="git", args=[push, --force]   (Word[])
        ref#1: basename="cd",  args=[/tmp]
        ref#2: basename="git", args=[log]
   c. expandWrapperCommands    → no wrappers; still 3 refs.
   d. walk(ast, { cwd }, trackers) → per-ref state:
        ref#0 at cwd=/original
        ref#1 at cwd=/original
        ref#2 at cwd=/tmp  (the `cd /tmp` applied)
      Walker-level speculative-entry synthesis runs in the same pass,
      populating `walkerState.events` per ref (see "Chain-aware
      `happened`" below).
   e. For each ref × for each rule, build a Candidate:
        input.command   = ref.text (FLATTENED: "git push --force")
        input.basename  = "git"
        input.args      = ref.node.suffix (Word[] with quote-aware .value)
        cwd             = walkerState.cwd   (per-ref)
        walkerState     = { cwd, branch, …, events }  (all trackers +
                          synthesized events under the reserved `events` key)
        agentLoopIndex  = N+1
   f. Test rule.pattern / requires / unless against ref.text.
      Run when.cwd / when.branch / when.happened / plugin predicates.
      `when.happened` merges real entries (ctx.findEntries) with
      synthesized speculative ones (walkerState.events) by timestamp
      — one unified latest-entry comparison.
   g. First rule that ALL predicates pass on wins.
      Return { block: true, reason: "[steering:no-force-push@user] …" }.
      If the rule defines `onFire`, invoke it first (may writeSession entries,
      which the engine auto-tags with _agentLoopIndex).

4. If no rule blocked, pi executes the command.

5. pi emits tool_result. Dispatcher runs (once per tool_result):

   a. Parse event.input.command via walker. (The dispatcher parses
      independently from step 3 today — sub-millisecond per event.
      Cross-step AST caching is a future optimization.)
   b. For every observer whose `watch` filter matches:
        - `watch.inputMatches.command` matches raw outer command
          OR any ref.text (wrapper-aware, ADR §12).
        - `observer.onResult(event, observerCtx)` fires.
        - observerCtx.appendEntry(type, data) writes an entry —
          auto-tagged with _agentLoopIndex for `when.happened` filtering.
```

The important bits worth stressing:

- **One parse, many rules.** The AST walk happens once per tool call; every rule sees the same extracted refs and walker state. Adding rules is cheap.
- **Per-ref evaluation.** `cd /tmp && git log` evaluates the `git log` rule AT cwd `/tmp`, not at `/original`. Walker trackers (cwd by default; branch via the git plugin) update state as refs flow through the command chain.
- **Source-tagged reasons.** Block reasons carry `[steering:<rule>@<source>]` where source is `user` or the shipping plugin name. The agent can see both what fired and where to look it up.
- **First match wins.** Rule order matters within a layer, and inner config layers beat outer ones on rule-name collision.

## Authoring rules

### Rule shape

```ts
interface Rule {
  name: string;                                 // unique; shown in block reason
  tool: "bash" | "write" | "edit";
  field: "command" | "path" | "content";        // which input field pattern tests
  pattern: string | RegExp;                     // main match
  requires?: Pattern | PredicateFn;             // AND extra
  unless?: Pattern | PredicateFn;               // exemption
  when?: WhenClause;                            // composable predicates
  reason: string;                               // message to the agent
  noOverride?: boolean;                         // default: true (fail-closed)
  observer?: Observer | string;                 // name-ref to a shipped observer
  writes?: readonly string[];                   // declared session-entry types
  onFire?: (ctx: PredicateContext) => void;     // side-effect hook on block
}
```

The **pattern** tests against the flattened `basename + " " + args.join(" ")` of each extracted command ref (bash). Anchor with `^` so substrings of arguments don't accidentally match. For write/edit, the pattern tests `path` or `content` directly.

The **reason** is written for the agent. Include what was blocked and what the safe alternative is — the agent reads it and acts on it.

### `WhenClause`

```ts
interface WhenClause {
  cwd?: Pattern | { pattern: Pattern; onUnknown?: "allow" | "block" };
  happened?: {
    event: string;
    in: "agent_loop" | "session";
    since?: string;  // optional invalidation sentinel
  };
  not?: WhenClause;
  condition?: (ctx: PredicateContext) => boolean | Promise<boolean>;

  // Plugin-registered keys:
  [customKey: string]: unknown;
}
```

Built-ins:

- **`cwd`** — rule fires only when the command's effective cwd matches. For bash, this is the per-ref cwd from the walker (so `cd ~/personal && git commit` evaluates against `~/personal`). For write/edit, it's the session cwd.
- **`happened`** — fires when an entry of `event` has NOT occurred in `in` scope. `"agent_loop"` filters by `_agentLoopIndex === ctx.agentLoopIndex` (one user prompt + its tool calls); `"session"` scans the whole session JSONL. Invert via `not`. Optional `since` acts as an invalidation sentinel — see "Temporal ordering with `happened.since`" below. Chain-aware for `&&` bash chains — see "Chain-aware `happened`" below.
- **`not`** — boolean NOT over a nested clause.
- **`condition`** — escape hatch for one-off logic. Prefer plugin predicates when the logic is reusable.

Plugin predicates fill the `[customKey: string]` slot. `when.branch: /^main$/` is valid only if a plugin registered `branch` under `predicates`.

### Predicate context

`PredicateFn`s and plugin `PredicateHandler`s receive a `PredicateContext`:

```ts
interface PredicateContext {
  cwd: string;                                  // effective cwd for this ref
  tool: "bash" | "write" | "edit";
  input: PredicateToolInput;                    // tool-shaped input
  agentLoopIndex: number;                       // current agent loop counter
  exec: (cmd, args, opts?) => Promise<ExecResult>;  // memoized per (cmd, args, cwd)
  appendEntry<T>(type: string, data?: T): void;
  findEntries<T>(type: string): Array<{ data: T; timestamp: number }>;
  walkerState?: Record<string, unknown>;        // tracker snapshot
}
```

`exec` is memoized per `(cmd, args, cwd)` within a single tool_call — two rules reading the same git state don't re-fork git. No cross-call cache.

`PredicateToolInput.args` on bash gives you the `Word[]` suffix — quote-aware; `.value` is the lexical unwrapped value, `.text` is the raw source. Use this when a predicate needs to read `-m "feat: x"` without losing the quoted content.

### `onFire`

`Rule.onFire` runs after all predicates pass and BEFORE the block verdict is returned. Use it for self-marking patterns:

```ts
{
  name: "commit-description-check",
  pattern: /^git\s+commit\b/,
  when: { happened: { event: "description-reviewed", in: "agent_loop" } },
  reason: "Re-read the commit message first.",
  writes: ["description-reviewed"],
  onFire: (ctx) => ctx.appendEntry("description-reviewed", {}),
}
```

First commit per agent loop blocks + self-marks. Second commit in the same loop: the self-mark satisfies `when.happened`, commit passes.

`onFire` errors are caught, logged, and the block still returns. The block already passed every predicate; a broken self-mark should not invalidate it.

### Observers

```ts
interface Observer {
  name: string;                                  // deduped across plugins
  writes?: readonly string[];
  watch?: ObserverWatch;
  onResult(event, ctx): void | Promise<void>;
}

interface ObserverWatch {
  toolName?: string;
  inputMatches?: Record<string, Pattern>;
  exitCode?: number | "success" | "failure" | "any";
}
```

Observers fire on matching `tool_result` events. `watch.inputMatches.command` is **wrapper-aware** — a regex for `/^npm\s+test/` matches both `npm test` and `sh -c 'npm test'`.

`observerCtx.appendEntry` auto-tags writes with `_agentLoopIndex`. Don't inject that tag yourself. Use `ctx.findEntries<Payload>(type)` to read prior entries back.

### `writes` declarations

Both `Rule.writes` and `Observer.writes` are optional string-literal arrays naming the custom session-entry event types the handler may `appendEntry`. They have **zero runtime cost** — the engine never reads them at dispatch time. Their sole purpose is compile-time cross-referencing inside {@link defineConfig}:

```ts
// observer ships the event
const syncObserver = {
  name: "ws-sync-tracker",
  writes: ["ws-sync-done"],
  watch: { toolName: "bash", inputMatches: { command: /^sync\b/ }, exitCode: "success" },
  onResult: (_event, ctx) => ctx.appendEntry("ws-sync-done", {}),
} as const satisfies Observer;

export default defineConfig({
  observers: [syncObserver],
  rules: [{
    name: "cr-needs-sync",
    tool: "bash", field: "command",
    pattern: /^cr\b/,
    // `event` is type-narrowed to the union of all declared `writes`
    // across plugins + user observers. A typo like "ws-sync-don" is
    // rejected by the compiler.
    when: { happened: { event: "ws-sync-done", in: "agent_loop" } },
    reason: "Run sync first.",
  }],
});
```

When you skip declaring `writes`, the observer's produced events stay out of the `AllWrites` union and `when.happened.event` references to them are rejected as typos. The failure mode biases toward catching real typos (a plugin typo producing a non-firing rule turns into a compile error) at the cost of requiring each producer to enumerate its events once.

### Temporal ordering with `happened.since`

Sometimes "X happened" isn't enough — a later event should invalidate it. `happened.since` adds an optional invalidation sentinel:

```ts
{
  name: "cr-needs-fresh-sync",
  pattern: /^cr\b/,
  when: {
    happened: {
      event: "ws-sync-done",
      in: "agent_loop",
      since: "upstream-failed",
    },
  },
  reason: "Upstream failed after your last sync. Re-sync before cr.",
}
```

Semantics: the event counts as "happened" only if its most-recent entry in scope is strictly newer than the most-recent `since` entry. If `since` has never been written in scope, the clause degrades to the simple presence check — so adding `since` is safe even when the invalidator isn't in play yet.

Contrast with a hand-rolled `condition:` handler doing the same comparison: `since` is declarative, cross-checked at compile time (both `event` and `since` are constrained to the `Writes` union), and shared across rules without duplicating helper code. Reach for `condition` only when the comparison isn't "my event after their event" — e.g. counting, content matching, or quorum across multiple invalidators.

### Chain-aware `happened`

Agents frequently chain related commands in one tool_call:

```bash
sync && cr --description notes.md
```

The naive evaluation path blocks this chain: the evaluator runs BEFORE execution, so when it sees `cr`, the observer hasn't written `ws-sync-done` yet. Rule fires, block, retry, same block — an infinite loop.

pi-steering resolves this via a walker-level **speculative-entry synthesis pass**. For every ref in an unconditionally-`&&`-reachable segment, every observer declaring `writes: [event]` and matching the ref (via the shared `watch` filter) contributes a synthetic entry into the next ref's `walkerState.events[event]`. The built-in `when.happened` then merges these synthetic entries with real session entries by timestamp — so a speculative `ws-sync-done` entry satisfies the rule exactly as a real one would, and the chain is allowed.

`&&` short-circuits on the prior's failure, so the speculative decision is safe: either the prior succeeds (and writes the event, retroactively justifying the allow), or it fails and the current ref never runs. Synthetic entries carry `speculative: true` so plugin predicates wanting pure historical semantics can filter them out; the built-in `happened` treats real and speculative entries identically.

**Which joiners qualify:**

| Joiner | Speculative allow? | Reason |
|---|---|---|
| `A && B` | ✅ | B runs only if A succeeded |
| `A ; B`  | ❌ | B runs regardless of A |
| `A \| B` | ❌ | pipeline, no ordering |
| `A \|\| B` | ❌ | B runs only if A FAILED |

**Authoring requirement.** Observers participating in chain-aware allow must declare `watch.inputMatches.command`. An observer matching every bash event isn't a strong enough signal to grant the allow.

Worked example:

```ts
const syncObserver = {
  name: "ws-sync-tracker",
  writes: ["ws-sync-done"],
  watch: { toolName: "bash", inputMatches: { command: /^sync\b/ }, exitCode: "success" },
  onResult: (_e, ctx) => ctx.appendEntry("ws-sync-done", {}),
} as const satisfies Observer;

const crNeedsSync = {
  name: "cr-needs-sync",
  tool: "bash", field: "command",
  pattern: /^cr\b/,
  when: { happened: { event: "ws-sync-done", in: "agent_loop" } },
  reason: "Run `sync` first.",
} as const satisfies Rule;

// Given the pair above:
// bash `sync && cr ...` → allowed (cr has prior-&& ref matching the sync observer)
// bash `cr ...`         → blocked (no prior && ref, observer hasn't fired yet)
// bash `sync ; cr ...`  → blocked (semicolon doesn't short-circuit)
```

### Compile-time safety via `defineConfig`

```ts
import { defineConfig } from "pi-steering";

export default defineConfig({
  plugins: [gitPlugin, myPlugin],
  rules: [
    {
      name: "must-read-docs",
      tool: "bash", field: "command",
      pattern: /^npm\s+publish/,
      observer: "description-read",               // ← typo-checked against plugin + inline observers
      when: { happened: { event: "doc-read", in: "agent_loop" } },  // ← event literal checked against writes
      reason: "Read the release notes before publishing.",
    },
  ],
  disabledRules: ["no-main-commit"],                // ← typo-checked against rule names
  disabledPlugins: ["git"],                         // ← typo-checked against plugin names
});
```

**Authoring gotcha.** For cross-reference checking to work, TypeScript must preserve literal types. Use `as const satisfies` on reusable constants:

```ts
// ✅ works
const myRule = { name: "x", writes: ["thing"], ... } as const satisfies Rule;

// ❌ widens to `name: string` + `writes: readonly string[]` — breaks inference
const myRule: Rule = { name: "x", writes: ["thing"], ... };
```

See [`src/v2/schema.ts`](./src/v2/schema.ts) `Rule.writes` JSDoc for the full footgun explanation.

## Writing plugins

A plugin is a named bundle of predicates / rules / observers / trackers / tracker extensions. Users opt in via `plugins: [...]`.

### Shape

```ts
interface Plugin {
  name: string;
  predicates?: Record<string, PredicateHandler>;
  rules?: Rule[];
  observers?: Observer[];
  trackers?: Record<string, Tracker<unknown>>;           // new state dimensions
  trackerExtensions?: Record<string, Record<string, Modifier<unknown> | readonly Modifier<unknown>[]>>;
}
```

### Canonical file layout (ADR §13)

```
src/
├── index.ts                              # default export: Plugin; re-exports
├── index.test.ts                         # plugin-level integration
├── predicates/
│   ├── <predicate>.ts
│   └── <predicate>.test.ts
├── observers/
│   ├── <observer>.ts                     # exports TYPE constant + mark helper + observer
│   └── <observer>.test.ts
└── rules/
    ├── <rule-or-group>.ts
    └── <rule-or-group>.test.ts
```

### Observer encapsulation convention (ADR §14)

Every observer file exports three things:

1. A `<EVENT>_EVENT` constant — the session-entry event literal.
2. A `mark<Event>(ctx)` helper — encapsulates the shape of what gets written.
3. The observer itself, using the helper.

Rules that consume the event import the EVENT constant, never the raw string. When no observer corresponds (self-marking rule only), the constant + helper live in the rule file instead.

See [`examples/work-item-plugin/src/observers/npm-test-tracker.ts`](./examples/work-item-plugin/src/observers/npm-test-tracker.ts) for a complete file following this pattern.

### Typed predicate handlers

```ts
import { definePredicate } from "pi-steering";

interface BranchArgs {
  pattern: RegExp;
  onUnknown?: "allow" | "block";
}

export const branch = definePredicate<BranchArgs>(async (args, ctx) => {
  // args is narrowed to BranchArgs here.
  return args.pattern.test(await resolveBranch(ctx));
});
```

`definePredicate<T>` is a zero-cost type helper — pure pass-through at runtime. Use it so plugin authors can declare typed arg shapes without having to cast at the plugin registration site.

### The canonical reference

[`examples/work-item-plugin/`](./examples/work-item-plugin/) is a compact, domain-generic plugin that demonstrates every v0.1.0 authoring pattern in one place. Read it top-to-bottom — the structure is meant to be copied.

Production plugins in this repo:

- [`src/plugins/git`](./src/plugins/git) — the canonical plugin reference for trackers + tracker extensions. Ships `branch` / `upstream` / `commitsAhead` predicates, a `branchTracker`, a `--git-dir` / `--work-tree` cwd extension, and the `no-main-commit` rule.

## Walker extensibility

Plugin authors who need a new walker state dimension (something beyond `cwd` / `branch`) register a `Tracker<T>` under `Plugin.trackers`. The engine composes trackers at config load and feeds the merged map into unbash-walker's `walk()`.

Tracker authoring is a larger topic — see the [unbash-walker README](../unbash-walker/) for the full `Tracker<T>` / `Modifier<T>` API. Plugins extend an existing tracker (e.g. layering a `--git-dir=…` parser on the core cwd tracker) via `Plugin.trackerExtensions`. Name collisions on `Plugin.trackers` are a hard error; modifier collisions log a WARN and keep the first-registered.

Most users never need this — plugin-registered predicates alone cover 90% of use cases.

## Testing rules

The package exports a `pi-steering/testing` subpath with primitives that exercise the full pipeline without booting pi:

```ts
import { loadHarness, expectBlocks, expectAllows, testPredicate, testObserver }
  from "pi-steering/testing";
```

### Harness-level

```ts
const harness = loadHarness({
  config: { plugins: [myPlugin], rules: [...] },
});

await expectBlocks(
  harness,
  { command: "git push --force" },
  { rule: "no-force-push" },
);

await expectAllows(harness, { command: "git push" });
```

`loadHarness` runs the same `resolvePlugins` + `buildEvaluator` + `buildObserverDispatcher` path as production. `expectBlocks` / `expectAllows` accept bash/write/edit shorthand plus full `ToolCallEvent` shapes. Optional `rule` / `reason` fields on `expectBlocks` narrow the assertion.

### Unit-level

```ts
// Predicate in isolation:
const fires = await testPredicate(branch, /^main$/, {
  walkerState: { branch: "main" },
});

// Observer in isolation:
const { entries, watchMatched } = await testObserver(
  myObserver,
  { toolName: "bash", input: { command: "npm test" }, output: {}, exitCode: 0 },
);
```

`testPredicate` builds a `PredicateContext` (see `MockContextOptions` for knobs — `exec` stub, `entries`, walker state, etc.) and calls the handler. `testObserver` does the same for observers, returning the `appendEntry` captures and whether the `watch` filter accepted the event.

### Adversarial matrices

For bug-pinning tables:

```ts
import { runMatrix, formatMatrix } from "pi-steering/testing";

const result = await runMatrix(harness, [
  { name: "raw",           event: { command: "git push --force" },           expect: "block" },
  { name: "subshell",      event: { command: "sh -c 'git push --force'" },   expect: "block" },
  { name: "sudo",          event: { command: "sudo git push --force" },      expect: "block" },
  { name: "quoted-arg",    event: { command: "git push '--force'" },         expect: "block" },
  { name: "false-friend",  event: { command: "echo 'git push --force'" },    expect: "allow" },
]);
console.log(formatMatrix(result));
```

The `examples/work-item-plugin` tests use exactly this pattern.

## CLI

### `pi-steering list`

Walk up from cwd, load every `.pi/steering/index.ts` / `.pi/steering.ts` layer, and print the resolved state:

```bash
$ pi-steering list
Resolved config: 1 plugin, 2 rules, 0 observers.

git  [pi-steering/plugins/git]
  no-main-commit            bash  when: branch

User (.pi/steering/index.ts):
  no-force-push             bash

Disabled: (none)
```

JSON output for machine consumers:

```bash
pi-steering list --format=json
```

No config → "No steering config found." and exit 0.

### `pi-steering import-json`

One-shot migration from a v0.0.x JSON config to a v0.1.0 TypeScript config:

```bash
pi-steering import-json .pi/steering.json -o .pi/steering/index.ts
```

Emits a `defineConfig({...})` module using JSON-literal rendering. Rule patterns come across verbatim; `requires` / `unless` / override semantics are preserved. See [Migrating from v0.0.0-poc](#migrating-from-v000-poc) for the full migration.

## Migrating from v0.0.0-poc

The v0.1.0 release introduces several breaking changes. If you authored a config or plugin against v0.0.0-poc, update in this order:

### 1. Package rename

`@cad0p/pi-steering-hooks` → `pi-steering` (unscoped).

```diff
// package.json
  "dependencies": {
-   "@cad0p/pi-steering-hooks": "*"
+   "pi-steering": "*"
  }
```

```diff
// every import
- import { defineConfig } from "@cad0p/pi-steering-hooks";
+ import { defineConfig } from "pi-steering";
```

Subpath imports (`pi-steering/plugins/git`, `pi-steering/testing`) follow the same rename.

### 2. Upstream pi package rename

`@mariozechner/pi-coding-agent` → `@earendil-works/pi-coding-agent`.

Only affects plugin authors who import pi types directly (`ExtensionAPI`, `ExtensionContext`, `ToolCallEvent`, etc.). Config authors using only this package's re-exports don't need to change anything.

### 3. `turnIndex` → `agentLoopIndex`

The engine's monotonic counter is now bumped on `pi.on("agent_start")` (one agent loop = one user prompt + its tool calls), not `turn_start`. Renamed everywhere:

```diff
- ctx.turnIndex
+ ctx.agentLoopIndex

- if (entry.data._turnIndex === ctx.turnIndex) { ... }
+ if (entry.data._agentLoopIndex === ctx.agentLoopIndex) { ... }
```

Grep your config for `turnIndex` and rename every occurrence.

### 4. `when.happened.in`: `"turn"` → `"agent_loop"`

```diff
  when: {
-   happened: { event: "doc-read", in: "turn" }
+   happened: { event: "doc-read", in: "agent_loop" }
  }
```

The engine throws a hard error with a migration hint if `in: "turn"` is seen. Unknown `in` values now throw at eval time with the offending rule name.

### 5. `when.happened.type` → `when.happened.event`

```diff
  when: {
-   happened: { type: "doc-read", in: "agent_loop" }
+   happened: { event: "doc-read", in: "agent_loop" }
  }
```

The field name changed because `type` collided with standard TypeScript reading (type aliases, union discriminants). `event` reads as `happened: { event: X, in: Y }` — "the X event happened in Y scope" — and pairs naturally with the `_EVENT` suffix convention for event-literal constants (e.g. `DOC_READ_EVENT`).

This rename is independent of the `"turn"` → `"agent_loop"` rename above: if you track master between PR #3 and PR #4 you may have already moved to `in: "agent_loop"` while still using `type:` — run this rename separately.

### 6. Block reason format

Block reasons changed from `[steering:<name>]` to `[steering:<name>@<source>]`:

```diff
- [steering:no-force-push] Force-push rewrites history. …
+ [steering:no-force-push@user] Force-push rewrites history. …
```

Source is `user` for user-authored rules, and the plugin name for plugin-shipped rules. **Update any CI grep that parses block reasons.** Tests using `expectBlocks({ rule: "no-force-push" })` work unchanged — the `rule:` matcher strips the source.

### 7. Auto-tagged session entries

The engine now auto-tags every `appendEntry` write with `_agentLoopIndex`, including `steering-override` audit entries. If your code parses session JSONL for overrides, accept the extra field:

```diff
  // Old shape:
  { ruleName: "no-force-push", command: "…" }

  // New shape:
  { ruleName: "no-force-push", command: "…", _agentLoopIndex: 3 }
```

### 8. Array / Date / Error payloads wrap

The auto-tag wrapper merges into plain objects, but **wraps non-plain-object payloads** as `{ value: <payload>, _agentLoopIndex: N }`. Affected: arrays, `Date`, `Map`, `Set`, `Error`, class instances.

```diff
  observer.onResult = (_, ctx) => {
    ctx.appendEntry("my-list", [1, 2, 3]);
  };

  // Read back:
- const arr = ctx.findEntries<number[]>("my-list")[0].data;
+ const arr = ctx.findEntries<{ value: number[]; _agentLoopIndex: number }>("my-list")[0].data.value;
```

Migration tip: if you care about backwards-compat, switch to writing a plain object: `ctx.appendEntry("my-list", { items: [1, 2, 3] })` — that merges cleanly.

### 9. `disable` / `disablePlugins` renamed

The two selective opt-out lists on `SteeringConfig` were renamed to
past-participle form for shape-at-a-glance readability — lists read
as "these things are disabled" (predicates on state), while the
boolean `disableDefaults` flag keeps its imperative action form:

```diff
  defineConfig({
-   disable: ["no-main-commit"],
+   disabledRules: ["no-main-commit"],
-   disablePlugins: ["git"],
+   disabledPlugins: ["git"],
    disableDefaults: true,   // unchanged — imperative flag stays imperative
  });
```

The TypeScript compiler will point you at every site that needs
updating. `.pi/steering.json` (v1 JSON) continues to use the old
`disable` key; only the TypeScript surface changed.

### 10. Nothing-new-to-do (additive)

These are new in v0.1.0 but don't require migration:

- **`Rule.writes`** / **`Observer.writes`** — optional arrays; purely type-level plumbing through `defineConfig`.
- **`Rule.onFire`** — optional hook; omit if you don't need self-marking.
- **`input.args`** / **`input.basename`** on bash predicate inputs — in addition to the existing `input.command`.
- **`definePredicate<T>`** helper — purely ergonomic; existing `PredicateHandler<T>` manual casts still work.
- **Wrapper-aware observer matching** — `watch.inputMatches.command` now fires against wrapped refs (`sh -c`, `sudo`, `xargs`, `env`). If you tuned a regex hoping wrappers would NOT match, you need to adjust.

### Quick migration checklist

```
[ ] package.json:       @cad0p/pi-steering-hooks → pi-steering
[ ] imports:            @cad0p/pi-steering-hooks → pi-steering
[ ] pi types (plugin):  @mariozechner/…           → @earendil-works/…
[ ] grep -r turnIndex       → rename to agentLoopIndex
[ ] grep -r "in: \"turn\""  → "in: \"agent_loop\""
[ ] grep -r "happened: { type"  → rename `type` to `event`
[ ] CI grep for block reasons → add @source support
[ ] session-JSONL parsers     → tolerate _agentLoopIndex field
[ ] pnpm -r typecheck         → green
[ ] pnpm -r test              → green
```

## Override comments

For overridable rules (`noOverride: false`), the agent can annotate a tool call with an inline comment to bypass the block:

```bash
git commit -m "release" # steering-override: no-main-commit
```

The engine parses the comment before AST extraction (so the override persists across wrappers). Overrides are recorded as `steering-override` session entries for audit.

**Default is `noOverride: true` (fail-closed).** Rules must explicitly opt INTO overridability. Set `defaultNoOverride: false` at config top-level to flip the default if your guardrails are mostly advisory.

## Security and trust boundaries

pi-steering is a guardrail layer, not a sandbox. Several parts of the system execute arbitrary code your config authors control, and a few state surfaces are trusted by convention rather than enforced. Understand these boundaries before running pi under an untrusted config tree.

### Config execution

`.pi/steering/index.ts` (and the `.pi/steering.ts` shorthand) is **arbitrary TypeScript executed at `session_start` with your full user privileges**. The loader walks from `cwd` up to `$HOME`, importing every `.pi/steering/` directory it finds along the way, and merges them inner-first.

Implication: running pi inside a directory hierarchy whose steering configs you don't trust is equivalent to running `node -e '…'` with that same file. Symlinks in the walk-up chain are followed — a symlinked `.pi/steering/` landing in an unexpected directory executes as if it had been placed there directly.

Only run pi in directory hierarchies whose steering configs you trust.

### Plugin trust

Plugins register predicates (`when.<key>` handlers), observers, and `onFire` hooks — all of which **run arbitrary code during the evaluator's hot path**. A malicious or buggy plugin can:

- Shell out via `ctx.exec` (with the same privileges as pi).
- Forge session entries via `ctx.appendEntry`, which later rules consult via `when.happened`.
- Throw in unexpected places — S1 catches most throws, but the cost of a predicate that always throws is that the rule it belongs to never fires.

A malicious plugin can trivially defeat any guardrail ship with your config. Review plugin source before adding it to `plugins: [...]` the same way you'd review any third-party dependency.

### Session JSONL trust

`when.happened` reads entries tagged via `appendEntry`. The write path (`createAppendEntry`) is engine-controlled — every write gets the current `_agentLoopIndex` stamped on it automatically, and names go through S3 validation.

The **read path (`findEntries`) treats every tagged entry in the session JSONL as authentic**. Entries written OUTSIDE the engine (direct JSONL writes by another pi extension, hand-edited session files, a `pi.appendEntry` call from non-steering code) can forge type tags and trick `when.happened` into thinking an event occurred when it didn't — bypassing rules that gate on that event.

This is the out-of-band trust boundary. Within the steering engine, the invariant holds; cross-extension and external writes are outside the engine's reach.

### Fail-open on load errors

If your steering config fails to load at `session_start` (a plugin throws during import, a syntax error in `index.ts`, `pnpm` fails to resolve a dependency), pi-steering **disables itself for the session**. Tools execute unsteered for the rest of the conversation.

This is a deliberate fail-open for loader errors, not fail-closed: blocking every tool on a loader bug would leave every pi session unusable until the config was fixed. Fail-open-on-load + fail-closed-per-tool (S1) is the compromise.

Check startup logs for `[pi-steering] Failed to load steering config: …` if rules stop firing unexpectedly.

### Block-reason tag trust

The `[steering:<name>@<source>]` tag prepended to every block reason is only as trustworthy as your plugin authors. The S3 name-validation fix (regex-constrained rule / plugin / observer names) prevents tag SPOOFING — a name like `phony] ALL CLEAR [real` would have forged the tag; now it throws at load time.

Beyond the tag shape, the contents are plugin-authored. A plugin shipping a rule with `reason: "[steering:other-rule@other-plugin] …"` can make its block look like it came from another plugin. The guardrail here is plugin trust (see above), not the tag machinery.

## Performance notes

### `when.happened` scaling

The built-in `when.happened` predicate filters session entries by `customType` via `ctx.findEntries`. Cost is **O(N_session_entries) per unique `customType` per tool_call** — entries are scanned on first read per customType and cached for the rest of the phase (S2 invalidates the cache on writes, see the ADR).

Example: a 5000-entry session with 6 distinct `when.happened` rules costs roughly 600 µs per tool_call on findEntries alone. Typical sessions (< 500 entries) are fine; long-running multi-day sessions may notice the overhead as the JSONL grows.

Future versions will add a session-manager-side index keyed by `customType`, moving the cost from O(N) to O(entries-of-that-type). For now, if you hit the scaling edge, consider:

- Consolidating `when.happened` rules that share a `type`.
- Rotating / truncating the session JSONL between work sessions.

## Further reading

- [`examples/work-item-plugin/`](./examples/work-item-plugin/) — canonical plugin reference.
- [`src/plugins/git/`](./src/plugins/git) — production plugin with trackers and tracker extensions.
- [`../unbash-walker/`](../unbash-walker/) — the AST walker.
- Design decisions behind every field, flag, and semantic covered above are recorded in the repo's ADR log (napkin vault).

## Relationship to related packages

- **[`unbash-walker`](../unbash-walker/)** — the AST + tracker utility this package is built on. Will eventually be extracted to its own repo; during the PoC it lives alongside as a workspace package.
- **[`samfoy/pi-steering-hooks`](https://github.com/samfoy/pi-steering-hooks)** — inspired schema DNA, override-comment syntax, and the default-rule set. Diverged: AST-backed evaluation instead of raw-string; plugin system; observer + turn-state machinery; TypeScript-only config; walker-threaded trackers.

## License

MIT. See `LICENSE`.

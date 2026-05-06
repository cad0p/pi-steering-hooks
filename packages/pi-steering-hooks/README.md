# @cad0p/pi-steering-hooks

AST-backed steering hooks for [pi](https://github.com/mariozechner/pi-coding-agent) — evaluates rules against bash command ASTs instead of raw strings, supports per-rule `when.cwd` predicates, and audits inline overrides.

Inspired by [samfoy/pi-steering-hooks](https://github.com/samfoy/pi-steering-hooks) (schema + override-comment + defaults); the evaluator backend is swapped out for an AST pipeline (via [`unbash-walker`](../unbash-walker/)) so rules survive quoting tricks, wrapper commands, and `cd`-prefixed chains.

## What this gets you

Three capabilities you don't get from a regex-on-raw steering engine:

### 1. AST-aware bash matching — not regex on raw strings

The evaluator parses every bash command with [`unbash`](https://github.com/webpro-nl/unbash), extracts each command ref, recursively expands known wrappers (`sh -c`, `bash -c`, `sudo`, `xargs`, `env`, …), and runs each rule against each ref individually. A pattern like `^git\s+push.*--force` therefore has a stable meaning: it matches when `git` is the command being invoked, not when `git push --force` happens to appear somewhere in the raw text.

Concrete cases where AST matching gives the right answer and regex-on-raw doesn't:

| Command | AST backend | Regex on raw |
|---------|-------------|--------------|
| `echo 'git push --force'` | allow (echo of a quoted string) | **false positive — blocks** |
| `sh -c 'git push --force'` | **block** (wrapper unwrapped) | silent bypass — allows |
| `sudo git push --force` | **block** (sudo wrapper unwrapped) | ok |
| `git push "--force"` | **block** (AST treats `--force` as a single arg regardless of quoting) | bypass if pattern requires `\s` before `--force` |

The first two rows are the interesting ones: a regex engine sees text, so it can't tell a command argument apart from a string being printed. See [`unbash-walker`'s 24-case adversarial matrix](../unbash-walker/src/adversarial-matrix.test.ts) for the full set — quoting tricks, wrapper bypasses, and word-splitting edge cases all pinned as tests.

### 2. Per-command effective cwd

`when.cwd` is tested against the **effective cwd of each extracted command**, not the session cwd. Chained commands with intermediate `cd`s get evaluated at the directory each command actually runs under.

Given this command:

```bash
cd /tmp/A && git push --force && cd /tmp/B && git commit --amend
```

And these two cwd-scoped rules:

```json
[
  {
    "name": "no-force-push-in-A",
    "tool": "bash", "field": "command",
    "pattern": "^git\\s+push.*--force",
    "when": { "cwd": "^/tmp/A" },
    "reason": "Tree A is shared; no force pushes."
  },
  {
    "name": "no-amend-in-B",
    "tool": "bash", "field": "command",
    "pattern": "^git\\s+commit.*--amend",
    "when": { "cwd": "^/tmp/B" },
    "reason": "Tree B uses review-by-SHA; don't amend."
  }
]
```

`no-force-push-in-A` fires on the `git push --force` with its effective cwd `/tmp/A`, **not** on the session cwd and **not** on the final cwd `/tmp/B`. If that rule is overridden inline, evaluation advances and `no-amend-in-B` fires on the `git commit --amend` at `/tmp/B`. A regex-on-raw engine checking `cwd` against the session directory catches neither reliably.

### 3. One steering at a time, with progressive override

When a single tool call could violate multiple rules, the first matching rule blocks and evaluation stops. Overriding it advances evaluation to the next violation — so the agent addresses one concern at a time, and the block reason always names exactly the rule to satisfy next. See [Rule precedence and multi-rule events](#rule-precedence-and-multi-rule-events) for a worked example.

## Install

> During the PoC, the package is `private: true` and lives inside the monorepo. Once published:
>
> ```bash
> pi install @cad0p/pi-steering-hooks
> ```

For local development inside this repo, it's picked up automatically as a workspace package.

## Quick start

Drop a `steering.json` in `~/.pi/agent/` (the global baseline):

```json
{
  "rules": [
    {
      "name": "no-amend-in-personal",
      "tool": "bash",
      "field": "command",
      "pattern": "^git\\s+commit\\b.*--amend",
      "reason": "Don't rewrite history in personal repos.",
      "when": { "cwd": "/personal/" }
    }
  ]
}
```

Any `cd ~/personal/foo && git commit --amend` — no matter how it's wrapped — now gets blocked. `git commit --amend` in a work tree is unaffected.

You can also drop a `.pi/steering.json` in any ancestor directory between `$HOME` and the session cwd. Inner layers override outer ones by rule `name`. The project-local location follows pi's extension convention — same place `.pi/extensions/` and `.pi/settings.json` live.

## Rule schema

```ts
interface Rule {
  name: string;          // unique id, used in override comments and audit logs
  tool: "bash" | "write" | "edit";
  field: "command" | "path" | "content";
  pattern: string;       // regex string
  requires?: string;     // optional AND-predicate regex
  unless?: string;       // optional exemption regex
  when?: { cwd?: string }; // regex against effective cwd (per-command for bash)
  reason: string;        // message shown to the agent when blocked
  noOverride?: boolean;  // hard block — no escape hatch
}
```

| Field | Description |
|-------|-------------|
| `name` | Unique id. Appears in block reason, override comments, and audit entries. |
| `tool` | Which pi tool to intercept — `bash`, `write`, or `edit`. |
| `field` | For `bash`: always `command`. For `write`/`edit`: `path` or `content`. |
| `pattern` | Regex matched against the AST-extracted command string (`basename + " " + args.join(" ")`). **Anchor with `^` to match the basename; unanchored patterns match inside joined args.** For `write`/`edit`, applied to the raw field value. |
| `requires` | Optional. Must ALSO match. |
| `unless` | Optional. Exemption — if this matches, the rule does not fire. |
| `when.cwd` | Optional. Tested against the command's effective cwd (via [`effectiveCwd`](../unbash-walker/src/effective-cwd.ts)) for bash, or `ctx.cwd` for write/edit. |
| `reason` | Human- and agent-readable message shown when blocked. Write it for the *agent*. |
| `noOverride` | If `true`, no override escape hatch. If `false`, override always allowed (explicit opt-in — beats `defaultNoOverride`). Omitted: falls back to the config-level `defaultNoOverride`, which itself defaults to `false`. See [Config-level override default](#config-level-override-default). |

The `when` key is nested for forward extensibility: predicates like `branch`, `env`, or `time-of-day` can be added as peer keys under `when` without another schema migration. Unknown keys under `when` are reserved for future use — the current evaluator ignores them and emits a one-time `console.warn` per rule so authors notice typos.

Note: `defaultNoOverride` is a [**`SteeringConfig`**](#config-level-override-default) field, not a `Rule` field — it lives at the top level of `steering.json`, alongside `disable` and `rules`.

## Writing your own patterns

When authoring a `bash` rule, anchor the pattern with `^` so it tests against the extracted command string (`basename + " " + args.join(" ")`), not against a substring floating inside joined args.

Why it matters: the AST extractor identifies the actual command — not text that *looks* like a command inside a quoted argument. Example:

```bash
echo 'git push --force'
```

This runs `echo`, not `git`. The extractor gives us `basename = echo`, `args = ["git push --force"]`, so the stringified form becomes `echo git push --force`. A pattern anchored with `^git\s+push` correctly sees `echo` at the start and does not fire. The same pattern without the anchor — `\bgit\s+push` — would match the quoted text inside the `echo` argument and produce a false positive.

Guidelines for bash rules:

- **Anchor with `^`** for the common case: "block this command". `^git\s+push.*--force` blocks `git push --force` and wrapped variants, not echoed strings that happen to contain the text.
- **Use `\b` only when matching sub-arguments** (flags, targets) after the basename has already been anchored. `^git\s+push\b.*\b--force\b` is fine; `\bgit\s+push\b.*\b--force\b` is not.
- **Pre-subcommand flag slots** (`git -C /path push --force`): the built-in defaults use `^git\b(?:\s+-{1,2}[A-Za-z]\S*(?:\s+\S+)?)*\s+push\b...` to accept `-C /path`, `-c key=val`, `--git-dir=/x` and similar. Copy that shape for your own `git`-subcommand rules.

For `write` and `edit` rules, anchoring is not needed — `pattern` runs on the raw field value (`path` or `content`), not a joined command string.

## Default rules

| Name | Tool | Blocks |
|------|------|--------|
| `no-force-push` | bash | `git push --force` / `git push -f`. Allows `--force-with-lease`. |
| `no-hard-reset` | bash | `git reset --hard`. |
| `no-rm-rf-slash` | bash | `rm -rf /` (any flag-letter order). **`noOverride: true`** — hard block. |
| `no-long-running-commands` | bash | `npm run dev`, `yarn start`, `tsc --watch`, `nodemon`, etc. — blocks dev servers and watchers that deadlock the agent loop. |

All defaults are anchored to the extracted command basename (`^git...`), so `echo 'git push --force'` is not a false positive.

Disable any default via `steering.json`:

```json
{ "disable": ["no-long-running-commands"] }
```

## Config composition

Precedence, outermost-first (later layers override earlier ones by rule `name`):

1. Built-in `DEFAULT_RULES`
2. `$HOME/.pi/agent/steering.json` (global baseline)
3. `<ancestor>/.pi/steering.json` between `$HOME` and the session cwd (outermost first)
4. `./.pi/steering.json` at the session cwd

`disable[]` entries are additive (union across all layers) — once a rule is disabled at any layer, no downstream layer can re-enable it by omission.

Malformed JSON in one layer is treated as an empty config for that layer; other layers still load. The loader is best-effort by design.

## Rule precedence and multi-rule events

Within a single tool call, rules are evaluated in the **merged list order** described above (defaults first, then global, then ancestor layers outer→inner, then cwd). A single event that could violate multiple rules only ever surfaces one at a time:

1. The first rule whose pattern matches **any** extracted command blocks the tool call and stops evaluation.
2. Other rules are not evaluated for that event.
3. If the first matching rule is **overridden** via an inline comment, evaluation continues to the next rule — which will still block if it also matches.

**Rationale.** Sequential attention lets the agent address one violation at a time; the block reason names exactly the rule to satisfy next. A command firing two rules is usually a sign of defense-in-depth overlap (e.g. `no-force-push` and `no-push`) — the most conservative rule (earliest in precedence) wins. After an operator acknowledges and overrides that rule, any remaining rule violations still surface one by one.

A concrete example. With the defaults enabled plus a user rule `no-push` that blocks any `git push`:

```bash
# Both no-force-push (default) and no-push (user) would match; only the
# former surfaces.
$ git push --force origin main
[steering:no-force-push] ...

# Overriding the force-push rule advances evaluation to the next rule,
# which also blocks.
$ git push --force origin main # steering-override: no-force-push — hotfix
[steering:no-push] ...

# Overriding both unblocks the call (and audits both overrides).
$ git push --force origin main \
    # steering-override: no-force-push — hotfix \
    # steering-override: no-push — emergency channel
```

## Override comments

Any blocked command (unless `noOverride: true`) can be unblocked by adding an inline comment:

```bash
git push --force # steering-override: no-force-push — hotfix revert, coordinated on #infra
```

Syntax: `<leader> steering-override: <rule-name> <sep> <reason>`

- Leaders: `#`, `//`, `/*`, `<!--`, `--`, `%%`, `;;`
- Separators: `—` (em dash), `–` (en dash), `-` (hyphen)

When accepted, the extension calls `pi.appendEntry("steering-override", { rule, reason, command|path, timestamp })` so overrides are auditable from the session transcript. `noOverride: true` rules skip this path entirely — the command stays blocked regardless of comments.

### Config-level override default

By default, rules without an explicit `noOverride` field allow inline override comments. To tighten this for a whole config layer, set `defaultNoOverride` in `steering.json`:

```json
{
  "defaultNoOverride": true,
  "rules": [
    { "name": "strict-rule", "tool": "bash", "field": "command", "pattern": "^...", "reason": "..." },
    { "name": "flexible-rule", "tool": "bash", "field": "command", "pattern": "^...", "reason": "...", "noOverride": false }
  ]
}
```

Effective `noOverride` for each rule:

```
effective-noOverride(rule) =
  rule.noOverride ?? mergedConfig.defaultNoOverride ?? false
```

- Per-rule `noOverride` (either `true` or `false`) always wins. `noOverride: false` is a deliberate opt-in that keeps the rule overridable even when `defaultNoOverride: true` is set.
- A rule that omits `noOverride` falls back to the config-level default.
- If no layer sets `defaultNoOverride`, the effective default is `false` — preserving the prior behavior for configs that don't touch the field.

**Walk-up merge.** `defaultNoOverride` merges with the same "inner layer wins" semantic as `disable`/`rules`: an inner layer's `defaultNoOverride` replaces the running value, and a layer that doesn't set the field leaves the running value unchanged. An explicit `defaultNoOverride: false` at an inner layer is a deliberate opt-out — distinct from omitting the field.

Useful for "strict-by-default" trees where every rule should be a hard block unless specifically marked overridable.

### Override semantics for write/edit path rules

For `write` and `edit` rules, the override comment is looked for in the **file body** (the `content` for `write`, or the joined `newText` across edits) — regardless of which field the rule matches.

This is intentional: path strings have no comment syntax, so a rule like

```json
{ "tool": "write", "field": "path", "pattern": "/node_modules/" }
```

would otherwise have no escape hatch at all. Instead, a write into `node_modules/foo.js` can still be overridden by including an inline comment in the file body:

```js
// steering-override: no-node-modules-writes — patching upstream bug, tracking in #1234
module.exports.fix = ...
```

The comment still records intent and populates the audit log, which is the point. But it also means path-targeted rules have an implicit content-based escape hatch: anyone willing to add a comment to the file body can bypass the rule. If you want hard path-level protection (no escape hatch at all), set `noOverride: true` on the rule.

## Relationship to [`samfoy/pi-steering-hooks`](https://github.com/samfoy/pi-steering-hooks)

This package originated as a fork of samfoy's and shares its schema DNA. The two have since diverged enough that we treat them as sibling approaches rather than a fork-and-PR-back. Discussion of the split lives on [samfoy#2](https://github.com/samfoy/pi-steering-hooks/issues/2) — cwd-aware rules as a motivating example.

- **Borrowed**: rule shape (`pattern` / `requires` / `unless` / `reason` / `noOverride`), override-comment syntax, most of the default-rule list.
- **Changed**: the evaluator backend. samfoy runs regex on the raw command string; this package runs regex on AST-extracted command refs (post wrapper-expansion, with effective cwd per ref).
- **Added**: `when.cwd` predicate. Per-command effective cwd via [`unbash-walker`](../unbash-walker/). `write` and `edit` tool support.

Two-track approach:

- **Track S** (samfoy upstream) — contribute the smaller, schema-level improvements (walk-up + merge + `session_start`, session-level `when: { cwd }`) that fit samfoy's regex-on-raw model. These PRs land in his repo.
- **Track P** (this package) — the AST-backed sibling. Keeps its own release cadence and exposes the `when.cwd` / per-command effective-cwd features that only make sense with the AST pipeline.

Both approaches are legitimate. samfoy's is simpler, faster, and covers the 80% case. This package trades some runtime cost for closing the documented silent-bypass classes.

## Relationship to [`pi-guard`](https://github.com/jdiamond/pi-guard)

`pi-guard` is a *permission* system (prompt-before-run, allowlists/denylists). This package is a *steering* system (block-with-reason, inline overrides, audit log). They operate at different points of the lifecycle and compose: pi-guard decides whether the agent is *allowed* to run a command; pi-steering-hooks decides whether the agent *should* run it given project context.

We share AST infrastructure via [`unbash-walker`](../unbash-walker/) — ported from pi-guard's [`src/ast/`](https://github.com/jdiamond/pi-guard/tree/main/src/ast) module. During the PoC phase, `unbash-walker` is vendored in this monorepo (same `workspace:*` build); once the extraction proposal on pi-guard is resolved, it moves to its own package that both projects depend on. See [the repo README](../../README.md) for the roadmap and [`PUBLISHING.md`](./PUBLISHING.md) for the gate criteria.

## Status

PoC, private. See the [monorepo README](../../README.md) for the broader plan and roadmap.

## License

MIT. See [`LICENSE`](../../LICENSE).

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

### Performance

The AST pipeline costs ~4 µs per tool-call with the default 4-rule config and ~6 µs at 50 rules (warm, measured on Node 22 / linux arm64). Against a typical 1–5 s agent turn (network + inference), evaluator overhead is under 0.001% — effectively invisible. The 4 µs of parse cost closes the silent-bypass classes that regex-on-raw has on common agent emissions (`cd X && git push --force`, `sh -c '...'`, quoted args).

Rule count is close to free: the AST pipeline runs once per tool call (not once per rule), so adding rules adds only ~40 ns of regex work each. Against `samfoy/pi-steering-hooks@0.2.0`'s shipped evaluator — which compiles the regex on every call — this package is faster beyond ~8 rules and ~3.8× faster at 50 rules.

Performance is not the differentiator though. The reason to choose the AST path is correctness on real agent inputs; the runtime cost is just low enough to make that correctness essentially free.

## Install

> During the PoC, the package is `private: true` and lives inside the monorepo. Once published:
>
> ```bash
> pi install @cad0p/pi-steering-hooks
> ```

### Local install during the PoC

To try the PoC against a real pi session in another workspace (or against your existing extensions, to see how it interacts):

```bash
# 1. Build the monorepo first so dist/ exists
cd /path/to/pi-steering-hooks   # this repo
pnpm install && pnpm -r build

# 2. Install the package into a target project as a local pi extension
cd /path/to/your-project
pi install /path/to/pi-steering-hooks/packages/pi-steering-hooks -l

# 3. Verify
pi list   # should include @cad0p/pi-steering-hooks
```

The `-l` flag registers the extension in the project-local `./.pi/settings.json` (rather than the global `~/.pi/agent/settings.json`), so the install is scoped to this one project. Use `pi remove /path/... -l` to undo.

**For isolated testing** (skip all other extensions including anything auto-discovered):

```bash
pi --no-extensions --extension /path/to/pi-steering-hooks/packages/pi-steering-hooks/dist/index.js
```

This loads only our extension, bypassing any existing steering hooks you have installed globally or per-project. Useful for A/B comparison against an existing setup.

**Rules file location.** After installing, place your `steering.json` at:
- `~/.pi/agent/steering.json` for a global baseline that applies everywhere.
- `<project-root>/.pi/steering.json` for project-specific rules. This is the convention used across the pi ecosystem (`.pi/extensions/`, `.pi/skills/`, etc.).
- Anywhere between the session cwd and `$HOME`: each ancestor's `.pi/steering.json` is collected and merged. Inner layers override outer ones by rule name; `disable[]` unions across layers.

For developers of this monorepo: the package is auto-picked-up as a pnpm workspace — no manual install needed for repo-local testing.

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
| `when.cwd` | Optional. Tested against the command's effective cwd (computed by `unbash-walker`'s [`walk`](../unbash-walker/src/tracker.ts) function over the built-in [`cwdTracker`](../unbash-walker/src/trackers/cwd.ts)) for bash, or `ctx.cwd` for write/edit. |
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

Both packages expose the same rule schema (`pattern`, `requires`, `unless`, `reason`, `noOverride`, `when.cwd`). They differ in how `pattern` is evaluated and what `when.cwd` matches against:

| | `@samfp/pi-steering-hooks` | `@cad0p/pi-steering-hooks` (this) |
|---|---|---|
| Evaluator | Regex against the raw command string | Regex against AST-extracted commands, after wrapper expansion (`sh -c`, `sudo`, `xargs`, …) |
| `cd /repo && git push --force` | Silent bypass (anchored pattern) or false-positive (unanchored) | Caught |
| `sh -c 'git push --force'` | Silent bypass | Caught |
| `echo 'git push --force'` | False positive if the pattern is unanchored | Correctly not triggered |
| `git push "--force"` | False negative if the pattern expects unquoted `--force` | Caught |
| `when.cwd` predicate | Session-launch directory only (does not re-evaluate after `cd`) | Per-command effective cwd (tracks `cd` across the command chain) |
| Overhead per call | <1 µs (if regex cached) or ~20 µs (shipped today, compiles per call) | ~4 µs at the default 4-rule config, ~6 µs at 50 rules |
| Runtime dependencies | zero | `unbash-walker` (which depends only on `unbash`) |

`samfoy/pi-steering-hooks` is the lightweight choice when your agent doesn't emit `cd` chains or `sh -c`-style wrappers and you're comfortable with session-level cwd scoping. This package is the choice when you want correctness guarantees against the ways real agents emit bash — especially when rules should gate on the directory a command actually runs in, not the directory pi was launched from.

The packages share a schema deliberately so rules migrate without edits. Moving from samfoy to this package is a dependency swap; moving back is the same, with the caveat that session-level `when.cwd` can only approximate command-level scoping.

Two-track contribution model:

- **Track S** (samfoy upstream) — contribute the schema-level improvements (walk-up + merge + `session_start` loader) that fit samfoy's regex-on-raw model. PRs land in his repo.
- **Track P** (this package) — the AST-backed sibling. Keeps its own release cadence and exposes the features that only make sense with the AST pipeline.

Both approaches are legitimate. samfoy's is simpler and has a smaller surface area. This package trades ~3 µs per tool call for closing the documented silent-bypass classes and for command-level cwd scoping.

## Relationship to [`pi-guard`](https://github.com/jdiamond/pi-guard)

`pi-guard` is a *permission* system (prompt-before-run, allowlists/denylists). This package is a *steering* system (block-with-reason, inline overrides, audit log). They operate at different points of the lifecycle and compose: pi-guard decides whether the agent is *allowed* to run a command; pi-steering-hooks decides whether the agent *should* run it given project context.

We share AST infrastructure via [`unbash-walker`](../unbash-walker/) — ported from pi-guard's [`src/ast/`](https://github.com/jdiamond/pi-guard/tree/main/src/ast) module. During the PoC phase, `unbash-walker` is vendored in this monorepo (same `workspace:*` build); once the extraction proposal on pi-guard is resolved, it moves to its own package that both projects depend on. See [the repo README](../../README.md) for the roadmap and [`PUBLISHING.md`](./PUBLISHING.md) for the gate criteria.

## Status

PoC, private. See the [monorepo README](../../README.md) for the broader plan and roadmap.

## License

MIT. See [`LICENSE`](../../LICENSE).

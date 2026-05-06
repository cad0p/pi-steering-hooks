# @cad0p/pi-steering-hooks

AST-backed steering hooks for [pi](https://github.com/mariozechner/pi-coding-agent) — evaluates rules against bash command ASTs instead of raw strings, supports per-rule `when.cwd` predicates, and audits inline overrides.

Inspired by [samfoy/pi-steering-hooks](https://github.com/samfoy/pi-steering-hooks) (schema + override-comment + defaults); the evaluator backend is swapped out for an AST pipeline (via [`unbash-walker`](../unbash-walker/)) so rules survive quoting tricks, wrapper commands, and `cd`-prefixed chains.

## Why AST over regex-on-raw

samfoy's evaluator runs regex directly against the raw command string. That works well for the common case, but has four known silent-bypass classes once the agent starts chaining or wrapping commands (pinned by [`unbash-walker`'s adversarial matrix](../unbash-walker/src/adversarial-matrix.test.ts)) — e.g. `sh -c 'git push --force'`, `echo something | sudo xargs git push --force`, or `cd ~/personal && git commit --amend` (where samfoy's `cwd` check sees the *session* cwd, not the cwd that `git commit` actually runs under).

This package parses the command with [`unbash`](https://github.com/webpro-nl/unbash), extracts every command ref, recursively expands known wrappers (`sh -c`, `bash -c`, `sudo`, `xargs`, `env`, …), and runs each rule against each ref with that ref's *effective* cwd. The rule still pays a small runtime cost, but the semantics are deterministic.

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

You can also drop a `steering.json` in any ancestor directory between `$HOME` and the session cwd. Inner layers override outer ones by rule `name`.

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
| `noOverride` | If `true`, no override escape hatch. Defaults to `false`. |

The `when` key is nested for forward extensibility: predicates like `branch`, `env`, or `time-of-day` can be added as peer keys under `when` without another schema migration. Unknown keys under `when` are reserved for future use — the current evaluator ignores them and emits a one-time `console.warn` per rule so authors notice typos.

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

Samfoy's `conventional-commits` default is intentionally omitted — it's project policy rather than general safety. Add it back to your own config if you want it.

## Config composition

Precedence, outermost-first (later layers override earlier ones by rule `name`):

1. Built-in `DEFAULT_RULES`
2. `$HOME/.pi/agent/steering.json` (global baseline)
3. Ancestor `steering.json` between `$HOME` and the session cwd (outermost first)
4. `./steering.json` at the session cwd

`disable[]` entries are additive (union across all layers) — once a rule is disabled at any layer, no downstream layer can re-enable it by omission.

Malformed JSON in one layer is treated as an empty config for that layer; other layers still load. The loader is best-effort by design.

## Override comments

Any blocked command (unless `noOverride: true`) can be unblocked by adding an inline comment:

```bash
git push --force # steering-override: no-force-push — hotfix revert, coordinated on #infra
```

Syntax: `<leader> steering-override: <rule-name> <sep> <reason>`

- Leaders: `#`, `//`, `/*`, `<!--`, `--`, `%%`, `;;`
- Separators: `—` (em dash), `–` (en dash), `-` (hyphen)

When accepted, the extension calls `pi.appendEntry("steering-override", { rule, reason, command|path, timestamp })` so overrides are auditable from the session transcript. `noOverride: true` rules skip this path entirely — the command stays blocked regardless of comments.

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

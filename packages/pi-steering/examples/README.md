# Rule-pack examples

Curated rule-pack examples for common workflows. Each subdirectory
ships both a v0.1.0 TypeScript config (`steering.ts`) and the
legacy v0.0.x JSON form (`steering.json`). Each has its own README
with rationale.

| Example | What it enforces | Best for |
|---------|------------------|----------|
| [force-push-strict](./force-push-strict) | No force pushes of any kind (not even `--force-with-lease`) | Shared branches, strict-history teams |
| [no-amend](./no-amend) | No `git commit --amend`. Includes a cwd-scoped variant | Review-driven workflows where commit-SHA stability matters |
| [draft-prs-only](./draft-prs-only) | `gh pr create` requires `--draft` | Teams that require human review before marking ready |
| [combined-git-discipline](./combined-git-discipline) | All three above | Starting point for disciplined PR teams |
| [work-item-plugin](./work-item-plugin) | Canonical example PLUGIN (not a rule-pack). See the plugin's own README. | Authors writing a new plugin |

Each rule-pack directory has smoke tests (`steering.test.ts`) that
verify the config compiles under the current `defineConfig` API and
exposes the expected shape. Behavioural coverage (every pattern,
every wrapper form) lives in the engine's own test suite.

## How to use

### v0.1.0+ (TypeScript, preferred)

1. **Copy** `steering.ts` from an example directory into one of:
   - `~/.pi/steering.ts` (or `~/.pi/steering/index.ts`) — applies globally.
   - `<your-project>/.pi/steering.ts` — applies to this project tree (walk-up loader).
2. **Tweak** as needed — the exported default is a plain
   [`SteeringConfig`](../src/schema.ts), so you can add rules,
   merge with other packs by spreading, or import a plugin.
3. **Verify** the rule is active by running `pi` in the target
   directory; the rules load on `session_start`.

### v0.0.x (JSON, legacy)

Each example also ships a `steering.json` for teams still on the v0
format. Copy it to `~/.pi/agent/steering.json` or
`<your-project>/.pi/steering.json`. The loader accepts both formats;
v0.1.0-only features (plugins, observers, `when.<predicate>`) are
TypeScript-only.

## Verifying a rule works

The quickest smoke-check: run the example's blocked command inside a
pi session and confirm the agent surfaces the `[steering:<rule-name>@<source>] …` block message. Each example directory's
`steering.test.ts` pins the config's structural contract; the engine's
own test suite exercises the rules against realistic inputs.

See the [package README](../README.md) for the schema details
(`pattern`, `requires`, `unless`, `when.cwd`, `reason`,
`noOverride`) and the [repo README](../../../README.md) for the
overall architecture.

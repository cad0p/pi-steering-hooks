# Rule-pack examples

Curated `steering.json` examples for common workflows. Each subdirectory has its own README with rationale.

| Example | What it enforces | Best for |
|---------|------------------|----------|
| [force-push-strict](./force-push-strict) | No force pushes of any kind (not even `--force-with-lease`) | Shared branches, strict-history teams |
| [no-amend](./no-amend) | No `git commit --amend`. Includes a cwd-scoped variant | Review-driven workflows where commit-SHA stability matters |
| [draft-prs-only](./draft-prs-only) | `gh pr create` requires `--draft` | Teams that require human review before marking ready |
| [combined-git-discipline](./combined-git-discipline) | All three above plus upstream defaults | Starting point for disciplined PR teams |

## How to use

1. **Copy** the `steering.json` from an example directory into one of:
   - `~/.pi/agent/steering.json` — applies globally
   - `<your-project>/steering.json` — applies to this project tree (and subdirectories, via the walk-up loader)
2. **Merge** with any existing rules — rules are looked up by `name`, so later layers override earlier ones. `disable[]` unions across layers.
3. **Verify** the rule is active by running `pi` in the target directory; the rules load on `session_start`.

## Verifying a rule works

The quickest smoke-check: run the example's blocked command inside a pi session and confirm the agent surfaces the `[steering:<rule-name>] …` block message. The engine's own test suite (`src/examples.test.ts`) exercises each example's rules against realistic inputs — a good read-through for seeing exactly what does and doesn't fire.

See the [package README](../README.md) for the schema details (`pattern`, `requires`, `unless`, `cwdPattern`, `reason`, `noOverride`) and the [repo README](../../../README.md) for the overall architecture.

# Publishing plan (deferred)

Both packages (`unbash-walker` and `pi-steering`) are currently `private: true` in their `package.json`. This is intentional.

## Gate criteria

Before the first npm publish, both of these must be true:

1. **PR [#1](https://github.com/cad0p/pi-steering-hooks/pull/1) is reviewed and merged** to `master` (currently draft; awaiting human review).
2. One of:
   a. The extraction proposal has been filed on [`jdiamond/pi-guard`](https://github.com/jdiamond/pi-guard) and jdiamond has responded (accept/decline/defer), OR
   b. Two weeks have elapsed since the proposal was filed.

The two-week timeout exists to keep the publishing decision unblocked when upstream maintainers are busy or on leave; it isn't a deadline for jdiamond.

## What changes at publish time

- `packages/unbash-walker/package.json`: drop `"private": true`, bump version from `0.0.0-poc.0` to `0.1.0`.
- `packages/pi-steering-hooks/package.json`: same change; swap `"unbash-walker": "workspace:*"` to `"unbash-walker": "^0.1.0"` once `unbash-walker` (or its jdiamond-owned equivalent) is on npm.
- Add GitHub Actions workflows from [`cad0p/semver-calver-release/examples/basic-npm-package`](https://github.com/cad0p/semver-calver-release/tree/main/examples/basic-npm-package) (adjust `main` → `master` in branch triggers).
- Detach the fork relationship from [`samfoy/pi-steering-hooks`](https://github.com/samfoy/pi-steering-hooks) on GitHub (the packages no longer share code).

## Known pre-publish cleanups

- None at this time — the review-fix loops across Phases 0–3 have addressed all known blockers. Any issues surfaced during PR #1 review will be listed here as they come up.

## v1 API stability considerations

These are API-surface decisions to revisit before cutting v1.0 (after shipping as 0.x to gather real usage).

### `BashContext` couples consumers to `unbash-walker`'s `CommandRef`

The `prepareBashContext(command, sessionCwd): BashContext` helper exposes `refs: readonly CommandRef[]` and `cwdMap: ReadonlyMap<CommandRef, string>` in its return type. `CommandRef` is defined in `unbash-walker` and carries unbash's AST node shape. Downstream consumers who keep a `BashContext` across evaluations are transitively coupled to:

- `unbash-walker`'s exported `CommandRef` type (stable within this monorepo today, but `unbash-walker` is slated for extraction into its own package per [[pi-guard-contribution]]).
- `unbash`'s `Command` node type inside `CommandRef.node`.

**Why it's in the public API today.** `prepareBashContext` + `evaluateBashRuleWithContext` is the hot-path alternative to `evaluateBashRule` for callers evaluating many rules against one command — the split avoids re-parsing per rule. Exposing the context lets those callers reuse work across rules.

**Options to revisit at v1.0.**

1. **Keep as-is.** `unbash-walker` ownership transition happens first (via the extraction proposal to jdiamond); `CommandRef` stabilizes there. v1.0 re-exports it from this package as a stable type.
2. **Opaque handle.** Make `BashContext` a nominal type with no enumerable fields. Consumers pass it through but can't introspect. Requires a second helper for any consumer that needs to look at individual refs.
3. **Flatten the context into plain data.** Pre-stringify everything into `{ commands: readonly { text: string; cwd: string }[] }` with no AST references. Simplest, loses downstream utility (consumers who want wrapper-expansion metadata have to re-parse).

For 0.x: keep as-is; mark the type `@experimental` in JSDoc. For v1.0: decide based on how consumers end up using it.

### `Rule.when` is open for future predicates

`Rule.when` is typed as `{ cwd?: string }` today. Additional predicates (`branch`, `env`, `time-of-day`) were flagged as future work by samfoy (and we agree). At v1.0, consider either:

- Adding known predicates as optional peers (`branch?: string`, etc.). Schema grows but stays flat.
- Keeping `cwd` as the only built-in and documenting `when.<key>` as an extension point for custom evaluators.

Only affects v1.0 if predicates beyond `cwd` land before it.

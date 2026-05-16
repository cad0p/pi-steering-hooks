# Example: dynamic-reason + walker-unknown-cwd

Worked example tying together two pi-steering primitives:

- `requireKnownCwd` (from `pi-steering`) — the predicate-handler wrap that fires runtime-cwd predicates fail-closed when the walker can't statically resolve cwd. Used by gitPlugin's `isClean`, `hasStagedChanges`, `remote`, `upstream`, `commitsAhead`.
- `walkerUnknownCwdReason` (from `pi-steering`) — the agent-facing reason text helper for the walker-unknown-cwd branch.

Together these give external plugin authors the ergonomics story for runtime-cwd predicates: every gitPlugin runtime-cwd predicate inherits the engine's fail-closed `onUnknown: "block"` semantics for free, and the `walkerUnknownCwdReason` helper produces a useful agent-facing message that distinguishes "the predicate fired because the state is genuinely bad" from "the predicate fired because the walker couldn't tell".

## Pattern

The rule's `reason` is a `ReasonFn` (not a static string). It branches on `ctx.walkerState?.cwd === "unknown"`:

```ts
reason: (ctx) => {
  if (ctx.walkerState?.cwd === "unknown") {
    // Walker couldn't statically resolve cwd. The
    // requireKnownCwd-wrap fired the predicate. Produce a generic
    // explanation via the helper, then append retry guidance.
    return (
      walkerUnknownCwdReason(ctx, "working tree status") +
      " Run from inside the package directory with a literal path."
    );
  }
  // Walker statically resolved cwd; the predicate genuinely fired
  // (working tree is dirty). Domain-specific reason.
  return "Working tree has uncommitted changes. Commit or stash before deploying.";
},
```

The agent gets a useful next-step in both cases instead of a generic "rule blocked" message.

## When to use this pattern

When your rule consumes any `requireKnownCwd`-wrapped predicate from a plugin (gitPlugin's `isClean` / `hasStagedChanges` / `remote` / `upstream` / `commitsAhead`, or any external plugin's runtime-cwd predicate built on `requireKnownCwd`).

Without the two-branch ReasonFn, a rule with a static `reason: "..."` would print the same message in both cases — uninformative when the trigger was a dynamic-cwd target the walker bailed on.

## Cross-references

- `requireKnownCwd` JSDoc — `packages/pi-steering/src/helpers/require-known-state.ts`. Read for the wrap semantics and when NOT to wrap a predicate.
- `walkerUnknownCwdReason` JSDoc — `packages/pi-steering/src/helpers/walker-unknown-cwd-reason.ts`. Read for the helper's signature, the `verifying` arg contract, and a worked rule snippet.
- gitPlugin runtime-cwd predicates — `packages/pi-steering/src/plugins/git/predicates.ts`. Each has a `@see {@link walkerUnknownCwdReason}` cross-link in its JSDoc, surfacing the helper at the predicate's hover location.

## Run the tests

```bash
pnpm --filter @examples/dynamic-reason-runtime-cwd test
```

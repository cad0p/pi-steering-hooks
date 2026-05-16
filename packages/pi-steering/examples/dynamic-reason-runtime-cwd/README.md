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

The agent gets a useful next-step in both cases instead of a
generic "rule blocked" message.

The rule is gated by `when: { isClean: false }` — NOT
`when: { not: { isClean: true } }`. See the next subsection.

## Why `isClean: false`, not `not: { isClean: true }`

Both shapes look equivalent at first glance ("the working tree is
NOT clean"). They are not, because gitPlugin's `isClean` is
`requireKnownCwd`-wrapped: under walker-unknown cwd, the wrap returns
`true` unconditionally (so the engine fires the rule fail-closed,
matching the `onUnknown: "block"` policy). Wrapping that wrap in
`not:` inverts the fail-closed `true` to `false` — silent
fail-OPEN.

Truth table for the four states this rule must handle (predicate
result `→` rule-fires? after `when:` evaluation):

| state                       | `isClean` returns | `when: { isClean: false }`         | `when: { not: { isClean: true } }`  |
|-----------------------------|-------------------|------------------------------------|-------------------------------------|
| walker-unknown cwd          | `true` (wrap)     | fires ✅ (fail-closed)              | does NOT fire ❌ (fail-OPEN)         |
| walker-known + clean        | `true` (impl)     | does NOT fire ✅                    | does NOT fire ✅                     |
| walker-known + dirty        | `false` (impl)    | fires ✅                            | fires ✅                             |
| walker-known + git fails    | `false` (impl)    | does NOT fire ❌ (fail-OPEN)        | fires ✅ (fail-closed, opposite)     |

The two shapes agree on the static-cwd happy-path rows but diverge
on TWO branches in OPPOSITE directions:

- On the **walker-unknown** branch — the case the `requireKnownCwd`
  wrap exists for in the first place — `{ isClean: false }` is
  fail-closed and `{ not: { isClean: true } }` is fail-OPEN. This
  is the more common cwd-uncertainty case in agentic flows and the
  reason `{ isClean: false }` is the canonical shape.
- On the **walker-known + git-fails** branch (e.g., `cwd` resolves
  to a non-repo, `git status` exits non-zero so
  `getWorkingTreeClean` returns `null` and the handler short-circuits
  to `false`), the polarity flips: `{ isClean: false }` is fail-OPEN
  and `{ not: { isClean: true } }` is fail-closed. Neither shape is
  fail-closed across BOTH branches standalone — `{ isClean: false }`
  covers walker-unknown but loses git-fails, while
  `{ not: { isClean: true } }` covers git-fails but loses
  walker-unknown.

For full fail-closed coverage across both branches, pair `isClean`
with an `upstream` check exactly as gitPlugin's `predicates.ts`
JSDoc directs ("Non-zero exit returns `false` (unknown); pair with
an `upstream` check for fail-closed behavior."). The git-fails
branch is rare in practice — if `cwd` is known the package is
typically a real git repo — but it should be explicit, not implied.

Rule of thumb for any future plugin author copying this example:
over a `requireKnownCwd`-wrapped predicate, prefer the predicate's
documented inverted shape (e.g., `isClean: false`,
`hasStagedChanges: false`) to `not: { ... }`. gitPlugin's
`predicates.ts` JSDoc documents both polarities of every wrapped
predicate exactly so this anti-pattern is unnecessary.

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

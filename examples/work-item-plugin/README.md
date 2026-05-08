# work-item-plugin — example plugin for pi-steering

> **Note**: this is a READABLE REFERENCE, not a plugin for production use. The rules and patterns are domain-generic on purpose — copy the structure, swap the specifics.

A compact plugin that demonstrates every authoring pattern the v0.1.0 release ships. Reading the source top-to-bottom is the fastest way to understand how to build one of these.

## What's in the box

```
examples/work-item-plugin/
├── package.json                # peerDep on pi-steering
├── tsconfig.json               # extends repo base
├── README.md                   # (this file)
└── src/
    ├── index.ts                # default export: Plugin
    ├── index.test.ts           # end-to-end plugin tests
    ├── predicates/
    │   ├── work-item-format.ts       # workItemFormat + [PROJ-N] regex
    │   └── work-item-format.test.ts
    ├── observers/
    │   ├── npm-test-tracker.ts       # observer + TEST_PASSED_TYPE + helper
    │   └── npm-test-tracker.test.ts
    └── rules/
        ├── commit-requires-work-item.ts
        ├── commit-requires-work-item.test.ts
        ├── push-requires-tests.ts
        ├── push-requires-tests.test.ts
        ├── commit-description-check.ts
        └── commit-description-check.test.ts
```

## What each piece demonstrates

| File | Concept |
| --- | --- |
| `predicates/work-item-format.ts` | `definePredicate<T>` for typed arg shapes. Quote-aware `input.args` access (ADR §9). |
| `observers/npm-test-tracker.ts` | Observer encapsulation convention (ADR §14): export `<EVENT>_TYPE` + `mark<Event>(ctx)` helper + the observer. |
| `rules/commit-requires-work-item.ts` | Plugin predicate consumed from `when.<key>`. `not:` inversion. |
| `rules/push-requires-tests.ts` | Observer → rule coupling via shared type constant. `when.happened: { in: "agent_loop" }` gating. |
| `rules/commit-description-check.ts` | Self-marking rule with `Rule.onFire` (ADR §6). Constant + helper co-located with the rule when no observer corresponds (ADR §14). |
| `index.ts` | `as const satisfies Plugin` to preserve literal types for `defineConfig`'s compile-time cross-reference checking (ADR §7). |

## ADR references

The canonical references for every pattern this plugin demonstrates live in the repo's ADR log (napkin vault):

- §6 — `Rule.onFire` side-effect hook (self-marking pattern)
- §7 — `Observer.writes` and `Rule.writes` declarations (compile-time type constraints)
- §9 — `PredicateToolInput.args` + `basename` (quote-aware structured access)
- §10 — `definePredicate<T>` helper (typed variance cast)
- §14 — Observer encapsulation convention (type + helper + consumer pattern)
- §15 — This example plugin's goals

## Running the tests

```sh
# From the repo root:
pnpm install
pnpm --filter @examples/work-item-plugin test
```

The `pretest` script builds `pi-steering` first, so the example resolves
the package through its emitted `dist/` exports. On a fresh clone this
adds a few seconds on the first run; subsequent runs skip the rebuild if
nothing changed.

Or `pnpm -r test` runs all packages' suites including this one.

## Consuming this plugin from your own config

```ts
// .pi/steering/index.ts
import { defineConfig } from "pi-steering";
import workItemPlugin from "@examples/work-item-plugin";

export default defineConfig({
  plugins: [workItemPlugin],
});
```

In a real project, you'd replace `@examples/work-item-plugin` with your own published plugin that follows this same layout.

## The rules, in one paragraph each

**`commit-requires-work-item`** — intercepts `git commit -m "..."` and blocks unless the message carries a `[PROJ-N]` token. Uses the `workItemFormat` predicate under `when.not` (the predicate returns "work-item is present" as TRUE; we invert it to mean "fire when missing").

**`push-requires-tests`** — intercepts `git push`. Blocks unless `npm test` has succeeded in the current agent loop. The `npm-test-tracker` observer writes `TEST_PASSED_TYPE` on every successful `npm test`; the rule consults via `when.happened: { in: "agent_loop" }`.

**`commit-description-check`** — self-marking reminder. First `git commit` per agent loop blocks with a "re-read your description" message and self-marks via `onFire`. Second `git commit` in the same loop passes (the self-mark satisfies `when.happened`). A new agent loop resets the reminder.

## What's intentionally missing

- **A `Tracker`** — the git plugin (`packages/pi-steering-hooks/src/plugins/git/`) is the canonical reference for tracker + trackerExtension authoring. This plugin keeps the surface minimal.
- **Production-grade regexes** — the `[PROJ-N]` pattern is a placeholder. Real adopters replace with their project's actual ticket format (e.g. `JIRA-\d+`, `AWF-\d+`).
- **Override customization** — each rule uses the engine defaults around `noOverride`. See the main README's "Authoring rules" section for how overrides work.

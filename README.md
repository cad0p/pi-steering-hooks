# pi-steering-hooks — PoC monorepo

PoC workspace for two related packages:

- **[`packages/pi-steering-hooks/`](packages/pi-steering-hooks/)** — AST-backed steering engine for [pi](https://github.com/earendil-works/pi-coding-agent). Deterministic tool-call guardrails with command-level effective-cwd scoping. Eventual npm package: `@cad0p/pi-steering-hooks`.
- **[`packages/unbash-walker/`](packages/unbash-walker/)** — utility for walking [unbash](https://github.com/webpro-nl/unbash) ASTs. Planned to be extracted into its own repo once the PoC proves the value.

Both packages are currently `private: true`. Publishing is gated on PoC completion and upstream-coordination decisions (see "Status" below).

## Why a monorepo?

`unbash-walker` is general-purpose infrastructure — it's useful to any agent or tool that inspects bash commands (permission systems, steering engines, shell linters). `@cad0p/pi-steering-hooks` is one of several consumers we expect.

During the PoC, keeping both in one repo lets us:

- Iterate on the API of `unbash-walker` while its only consumer evolves too.
- Prove the "extraction is valuable" thesis with working code before asking an upstream to absorb the split.
- Keep `workspace:*` as the dependency spec — swapping to a published version later is a one-line change.

Once the PoC ships and the extraction path is clear, `unbash-walker` moves out.

## Architecture

```
┌──────────────────────────────────────────────┐
│  unbash  (bash AST parser, 3rd-party)        │
└──────────────────────────────────────────────┘
                     ▲
                     │
┌──────────────────────────────────────────────┐
│  unbash-walker  (this repo, Phase 1)          │
│    extractAllCommandsFromAST                 │
│    expandWrapperCommands                     │
│    effectiveCwd                              │
│    CommandRef + basename normalization       │
└──────────────────────────────────────────────┘
                     ▲
                     │
┌──────────────────────────────────────────────┐
│  @cad0p/pi-steering-hooks  (this repo,       │
│                             Phase 2)          │
│    rule schema (pattern / requires /         │
│      unless / when.cwd / reason)             │
│    walk-up + merge + session_start loader    │
│    inline override comments + audit          │
└──────────────────────────────────────────────┘
```

## Getting started

> **To try the PoC against a real pi session in another workspace** (e.g. replacing existing steering hooks) — see [`packages/pi-steering-hooks/README.md`](packages/pi-steering-hooks/README.md#local-install-during-the-poc). That's the consumer-facing path. The section below is for developers of this monorepo.

```bash
pnpm install
pnpm -r typecheck
pnpm -r build
pnpm -r test

# Isolated end-to-end smoke test: drives the built extension with
# synthetic tool_call events and asserts block/allow + audit behavior.
# Runs without an LLM, so it's deterministic and CI-safe.
node scripts/smoke.mjs
```

Requires Node ≥ 20 and [pnpm](https://pnpm.io/) ≥ 10.

## Status

**PoC complete, awaiting review.** `unbash-walker` is ported and tested; the steering engine is wired up with default rules, config walk-up + merge, and inline override audit; four example rule packs ship with per-example READMEs and smoke tests; end-to-end extension-contract smoke test against a real pi session passes.

- [x] Phase 0 — Scaffold pnpm monorepo
- [x] Phase 1 — Port `unbash-walker` from [jdiamond/pi-guard](https://github.com/jdiamond/pi-guard) + adversarial test matrix
- [x] Phase 2 — Build the steering engine
- [x] Phase 3 — Port rule-pack examples
- [x] Phase 4 — READMEs, docs, publish-decision gate

Both packages remain `private: true`. See [`packages/pi-steering-hooks/PUBLISHING.md`](packages/pi-steering-hooks/PUBLISHING.md) for the gate criteria before the first npm publish. PR [#1](https://github.com/cad0p/pi-steering-hooks/pull/1) carries the full PoC as a single draft review — awaiting human sign-off before anything ships.

## What's next

Two coordination tracks run in parallel once the PoC is reviewed:

- **Extraction proposal to [`jdiamond/pi-guard`](https://github.com/jdiamond/pi-guard)** — propose factoring `src/ast/` into a shared `unbash-walker` package that both pi-guard and this repo depend on. A basename-normalization bugfix is planned to land first as a smaller good-faith contribution. A fallback plan exists in case the extraction isn't accepted (publish `unbash-walker` independently and keep pi-guard's fork as-is).
- **Scoped PRs to [`samfoy/pi-steering-hooks`](https://github.com/samfoy/pi-steering-hooks)** — contribute the smaller, schema-level improvements (walk-up + merge + `session_start`, session-level `when: { cwd }`) that fit samfoy's regex-on-raw model. The divergent features (AST backend, per-command `when.cwd`, `write`/`edit` tool support) stay in this repo's sibling package.

Publishing decisions wait on both of these reaching a resolution or a two-week timeout, as documented in [`PUBLISHING.md`](packages/pi-steering-hooks/PUBLISHING.md).

## Related projects

- [samfoy/pi-steering-hooks](https://github.com/samfoy/pi-steering-hooks) — this repo's history originates here. A simpler, regex-based steering package with session-level cwd. Both approaches are legitimate; pick based on need.
- [jdiamond/pi-guard](https://github.com/jdiamond/pi-guard) — permission system for pi. Its `src/ast/` module is the source we port from for `unbash-walker`. An extraction proposal is planned once the PoC demonstrates the value.

## License

MIT. Code ported from upstream projects retains dual credit in the files it touches. See [`LICENSE`](LICENSE).

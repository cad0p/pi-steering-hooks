# @cad0p/pi-steering-hooks

AST-backed steering hooks for [pi](https://github.com/mariozechner/pi-coding-agent) — deterministic tool-call guardrails with command-level effective-cwd scoping.

## Status

**Scaffolded. Implementation arrives in Phase 2.**

This package is currently an empty shell inside the [`pi-steering-hooks` PoC monorepo](../../README.md). It will be filled in with:

- [samfoy/pi-steering-hooks](https://github.com/samfoy/pi-steering-hooks)-inspired rule schema (`pattern`, `requires`, `unless`, `reason`, `noOverride`, override-comment)
- Regex evaluated against AST-extracted command strings (via [`unbash-walker`](../unbash-walker/README.md))
- Per-command `cwdPattern` predicate using `effectiveCwd`
- Config walk-up + merge + `session_start` loader
- Inline override comments with audit logging

The design contrasts with samfoy's upstream package (simple regex, session-level cwd) by adding an AST backend and command-level scoping. Both approaches are legitimate — pick based on need.

## Why `private: true` for now

This package is not yet published to npm. Publishing is gated on:

1. PoC end-to-end works (all phases complete, examples pass smoke tests)
2. Upstream extraction decision on [`unbash-walker`](../unbash-walker/README.md) is resolved

See the [repo-level README](../../README.md) for the broader plan.

## License

MIT. Dual credit for ported code lands with the implementation.

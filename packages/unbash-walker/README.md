# unbash-walker

Utility for walking [unbash](https://github.com/webpro-nl/unbash) ASTs.

## Status

**Scaffolded. Implementation arrives in Phase 1.**

This package is currently an empty shell inside the [`pi-steering-hooks` PoC monorepo](../../README.md). It will be filled in with:

- `extractAllCommandsFromAST` — collect every `CommandRef` from an unbash `Script`, honoring pipelines, logical operators, and subshells.
- `expandWrapperCommands` — recursively unwrap `sh -c`, `bash -c`, `zsh -c`, `sudo`, `env`, `xargs`, `nice`, `nohup`, `strace`, `find -exec`, `fd -x`.
- `effectiveCwd` — walk a `Script` and return a `Map<CommandRef, string>` giving the effective working directory for each command (honoring `cd` in `&&`/`;` chains and subshell boundaries).
- `CommandRef` and helper types, plus basename normalization.

Source of the initial port: [jdiamond/pi-guard](https://github.com/jdiamond/pi-guard) `src/ast/*`. MIT-licensed, dual credit will be added when code lands.

## Future standalone-ness

`unbash-walker` is intentionally structured as a standalone package even though it currently lives inside `cad0p/pi-steering-hooks`. Once the PoC proves the value and the extraction proposal on `jdiamond/pi-guard` is resolved, it is expected to move into its own repo and publish as `unbash-walker` (or a scoped equivalent).

## License

MIT (to be finalized with dual credit in Phase 1).

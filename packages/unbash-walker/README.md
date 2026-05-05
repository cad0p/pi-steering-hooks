# unbash-walker

Utility for walking [unbash](https://github.com/webpro-nl/unbash) ASTs — command extraction, wrapper expansion, and effective-cwd resolution.

## Install

```sh
pnpm add unbash-walker unbash
# or
npm install unbash-walker unbash
```

`unbash` is a peer concern: you'll need it to produce the `Script` that `unbash-walker` consumes. `unbash-walker` also re-exports `parse` and the core types for convenience.

## Quick look

```ts
import {
  parse,
  extractAllCommandsFromAST,
  expandWrapperCommands,
  effectiveCwd,
  getBasename,
  getCommandArgs,
} from "unbash-walker";

const raw = "cd /home/me/repo && sudo sh -c 'git push --force'";
const script = parse(raw);

const refs = extractAllCommandsFromAST(script, raw);
const { commands } = expandWrapperCommands(refs);
const cwdOf = effectiveCwd(script, "/tmp");

for (const cmd of commands) {
  const name = getBasename(cmd);
  const args = getCommandArgs(cmd);
  const cwd = cwdOf.get(cmd) ?? "/tmp";
  console.log(`${cwd} :: ${name} ${args.join(" ")}`);
}
```

## API

| Export | Kind | What it does |
| --- | --- | --- |
| `parse` | re-export from `unbash` | Parse a bash string into a `Script` AST. |
| `extractAllCommandsFromAST(script, source)` | fn | Flatten a `Script` into the list of `CommandRef`s that actually run — walks `AndOr`, `Pipeline`, `Subshell`, `BraceGroup`, control flow, and recurses into `$(...)` / `<(...)` / `` `...` ``. |
| `expandWrapperCommands(commands)` | fn | Given extracted `CommandRef`s, recursively reveal sub-commands of `sh -c`, `bash -c`, `zsh -c`, `sudo`, `env`, `xargs`, `nice`, `nohup`, `strace`, `find -exec`, `fd -x` / `--exec`. Originals are kept alongside expansions so rules can match either level. |
| `WRAPPER_COMMANDS` | const | The wrapper registry `expandWrapperCommands` consults — exposed so callers can extend it. |
| `effectiveCwd(script, initialCwd, refs?)` | fn | Compute a `Map<CommandRef, string>` of cwd-as-the-command-starts for every command in the script. Honors subshell isolation, brace-group propagation, and pipeline per-peer subshells; resolves `cd ABS`, `cd REL`, `cd ~`, `cd ~/x`, `cd` (no args) and treats `cd -` as a no-op. Pass `refs` (from your own `extractAllCommandsFromAST` call) to get the Map keyed by your refs; omit for fresh refs. See "Known limitations" below. |
| `getCommandName` / `getCommandArgs` / `getBasename` / `isBareAssignment` | fn | Read the parts of a `CommandRef`. `getBasename` strips any leading path (`/usr/bin/git` → `git`). |
| `formatCommand(cmd, options?)` | fn | Re-serialize a `CommandRef` as a single-line display string with length-aware shrinking and path-aware elision. |
| `CommandRef` | type | `{ node: Command; source: string; group: number; joiner?: "\|" \| "&&" \| "\|\|" \| ";" }` |

## What this is not

- **Not a parser.** `unbash` handles parsing; this package operates on its output.
- **Not a pi extension, hook, or rule engine.** It's general-purpose AST infrastructure. Guardrail and permission packages (pi-guard, samfoy/pi-steering-hooks, cad0p/pi-steering-hooks) build their logic on top of it.
- **Not a shell.** It doesn't execute commands or model every bash semantic. It models enough structure to power guardrails and auditing tools. `pushd`/`popd`, `eval`, `source`, and `env -C` are out of scope today; see `effective-cwd.ts` for the current coverage list.

## `effectiveCwd` — known limitations

Static analysis; some bash constructs are deliberately under- or over-approximated so callers can make safe policy decisions:

- **Unresolvable `cd` targets** (`cd $VAR`, `cd "$HOME/x"`, `cd $(pwd)`) — the target is computed at runtime, so we stop propagating cd effects. The `cd` itself is recorded at the pre-cd cwd; subsequent commands see the pre-cd cwd unchanged.
- **`if` / `case` branches** — exactly one branch runs at runtime; we propagate a cwd forward only if *all* branches agree. Otherwise we fall back to the pre-branch cwd. Commands inside each branch still see that branch's own cwd.
- **`while` / `for` / `select`** — the body may iterate zero times; we never propagate body cwd forward. Commands inside the body are walked (and recorded) from the loop's starting cwd.
- **Background `&`** — treated like `;` (cd effects propagate). In real bash, `cd /x &` runs in a backgrounded subshell and cmd would see the initial cwd. This is a deliberate over-match: a guardrail sees the more conservative cwd and fires cwdPattern checks.
- **`cd -`** — treated as a no-op (we don't track OLDPWD).
- **Not modelled at all:** `pushd`/`popd`, `eval`, `source`/`.`, `env -C DIR cmd`, function bodies (walked only when defined, not when invoked).

## Acknowledgments

The command-extraction and wrapper-expansion logic was originally authored by [Jason Diamond](https://github.com/jdiamond) as part of [pi-guard](https://github.com/jdiamond/pi-guard). This package is a refactor-and-extraction of that work with the addition of an `effectiveCwd` walker and a `getBasename` helper. Both the original files and the additions are MIT-licensed. File headers carry dual credit.

## Status

PoC phase. The package is `private: true` inside the [`pi-steering-hooks` monorepo](../../README.md) until two things line up:

1. The end-to-end PoC (the `@cad0p/pi-steering-hooks` steering engine consuming this package) demonstrates the value.
2. The extraction proposal on [jdiamond/pi-guard](https://github.com/jdiamond/pi-guard) has been resolved — either `unbash-walker` is adopted upstream and moves to its own repo, or we publish it under the `cad0p` scope.

## License

MIT. See file headers for dual-credit.

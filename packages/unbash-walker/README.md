# unbash-walker

Utility for walking [unbash](https://github.com/webpro-nl/unbash) ASTs — command extraction, wrapper expansion, and an extensible per-command state tracker (cwd, branch, and more).

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
  walk,
  cwdTracker,
  getBasename,
  getCommandArgs,
} from "unbash-walker";

const raw = "cd /home/me/repo && sudo sh -c 'git push --force'";
const script = parse(raw);

const refs = extractAllCommandsFromAST(script, raw);
const { commands } = expandWrapperCommands(refs);
const state = walk(script, { cwd: "/tmp" }, { cwd: cwdTracker }, commands);

for (const cmd of commands) {
  const name = getBasename(cmd);
  const args = getCommandArgs(cmd);
  const cwd = state.get(cmd)?.cwd ?? "/tmp";
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
| `walk(script, initialState, trackers, refs?)` | fn | Thread a registry of named state trackers through the AST and return a `Map<CommandRef, Snapshot>` where each snapshot carries every tracker's value AT THAT COMMAND. Handles subshell isolation, brace-group propagation, pipeline per-peer isolation, and conservative control-flow branch merging. Pass `refs` (from your own `extractAllCommandsFromAST` call) to get the Map keyed by your refs; omit for fresh refs. |
| `cwdTracker` | const | Built-in tracker for command cwd. Models `cd ABS`, `cd REL`, `cd ~`, `cd ~/x`, `cd` (no args), `cd -` (no-op), and per-command cwd overrides for `git -C DIR`, `make -C DIR`, `env -C DIR`. See "Known limitations" below. |
| `Tracker<T>` / `Modifier<T>` / `isStaticallyResolvable(word)` | types, fn | Author your own tracker dimensions — register modifiers keyed by command basename with `scope: "sequential" \| "per-command"`. Return `undefined` from `apply` to signal "can't resolve statically"; the walker substitutes the tracker's `unknown` sentinel. |
| `getCommandName` / `getCommandArgs` / `getBasename` / `isBareAssignment` | fn | Read the parts of a `CommandRef`. `getBasename` strips any leading path (`/usr/bin/git` → `git`). |
| `formatCommand(cmd, options?)` | fn | Re-serialize a `CommandRef` as a single-line display string with length-aware shrinking and path-aware elision. |
| `CommandRef` | type | `{ node: Command; source: string; group: number; joiner?: "\|" \| "&&" \| "\|\|" \| ";" }` |

## What this is not

- **Not a parser.** `unbash` handles parsing; this package operates on its output.
- **Not a pi extension, hook, or rule engine.** It's general-purpose AST infrastructure. Guardrail and permission packages (pi-guard, samfoy/pi-steering-hooks, cad0p/pi-steering-hooks) build their logic on top of it.
- **Not a shell.** It doesn't execute commands or model every bash semantic. It models enough structure to power guardrails and auditing tools. `pushd`/`popd`, `eval`, `source`, and `git --git-dir=/path` are out of scope today; see `src/trackers/cwd.ts` for the current coverage list.

## `cwdTracker` — known limitations

Static analysis; some bash constructs are deliberately under- or over-approximated so callers can make safe policy decisions:

- **Unresolvable `cd` targets** (`cd $VAR`, `cd "$HOME/x"`, `cd $(pwd)`) — the target is computed at runtime, so we stop propagating cd effects. The `cd` itself is recorded at the pre-cd cwd; subsequent commands see the pre-cd cwd unchanged.
- **`if` / `case` branches** — exactly one branch runs at runtime; we propagate a cwd forward only if *all* branches agree. Otherwise we fall back to the pre-branch cwd. Commands inside each branch still see that branch's own cwd.
- **`while` / `for` / `select`** — the body may iterate zero times; we never propagate body cwd forward. Commands inside the body are walked (and recorded) from the loop's starting cwd.
- **Background `&`** — treated like `;` (cd effects propagate). In real bash, `cd /x &` runs in a backgrounded subshell and cmd would see the initial cwd. This is a deliberate over-match: a guardrail sees the more conservative cwd and fires `when.cwd` checks.
- **`cd -`** — treated as a no-op (we don't track OLDPWD).
- **Not modelled at all:** function bodies (walked only when defined, not when invoked). The following out-of-scope constructs are pinned by tests so any future change is deliberate:
  - **`pushd` / `popd`** — not treated as cd. `pushd /A && y` leaves `y` at the pre-pushd cwd. Guardrails that want to catch these should write explicit rules against the commands.
  - **`git --git-dir=/path`, `git --work-tree=/path`** — narrower than `-C`; not modelled today. Follow-up.
  - **`eval "..."`** — the string argument is not re-parsed. Only `eval` itself is extracted; commands inside the string are invisible. Match the eval string directly (`^eval\b.*git\s+push`) or block eval outright.
  - **`source script.sh` / `. script.sh`** — external files are never read. `source` is extracted as a normal command; any cd effects the sourced script would perform at runtime are opaque to the walker.
  - **Heredoc bodies** — heredoc content is treated as data (redirect payload on the owning command), so `cd` written inside a heredoc body is never extracted or walked. This is correct behavior, not over-match: heredoc bodies in real bash are stdin, not commands.
  - **Wrapper-expansion interaction for `env -C DIR cmd`** — the outer `env` ref is recorded at DIR, but the surfaced inner `cmd` ref has no entry in the walk result (consumers fall back to the session cwd). Lifting this requires wrapper expansion to consult the cwd tracker when computing inner refs — tracked as a follow-up.

## Acknowledgments

Built on top of [`unbash`](https://github.com/webpro-nl/unbash) by [Lars Kappert](https://github.com/webpro) (also maintainer of [knip](https://github.com/webpro-nl/knip)). `unbash-walker` is strictly a consumer — `unbash` handles every piece of parsing.

The command-extraction and wrapper-expansion logic was originally authored by [Jason Diamond](https://github.com/jdiamond) as part of [pi-guard](https://github.com/jdiamond/pi-guard). This package is a refactor-and-extraction of that work with the addition of a `walk` tracker API, a built-in `cwdTracker`, and a `getBasename` helper. Both the original files and the additions are MIT-licensed. File headers carry dual credit.

## Status

PoC phase. The package is `private: true` inside the [`pi-steering-hooks` monorepo](../../README.md) until two things line up:

1. The end-to-end PoC (the `pi-steering` steering engine consuming this package) demonstrates the value.
2. The extraction proposal on [jdiamond/pi-guard](https://github.com/jdiamond/pi-guard) has been resolved — either `unbash-walker` is adopted upstream and moves to its own repo, or we publish it under the `cad0p` scope.

## License

MIT. See file headers for dual-credit.

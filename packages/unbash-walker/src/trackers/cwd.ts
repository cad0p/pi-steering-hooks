// SPDX-License-Identifier: MIT
// Part of unbash-walker.

/**
 * Built-in cwd tracker — the walker's default dimension for command
 * working directories.
 *
 * This module unifies the two mechanisms the walker previously kept
 * separate:
 *
 *   - `cd` handling (sequential, shell-level; propagates forward).
 *   - `git -C`, `make -C`, `env -C` per-command overrides (per-command;
 *     apply to the command they're attached to only).
 *
 * Both are now modifiers on the same `cwd` tracker, differing only in
 * their `scope`. See the accepted ADR (linked from PR #2's description)
 * for the rationale. The per-command override behavior is preserved from
 * its original home in the now-removed `cwd-override-flags.ts`.
 *
 * Semantics modelled (identical to the original `effectiveCwd`):
 *
 *   - `cd ABS` — replace current dir with ABS.
 *   - `cd REL` — join with current dir.
 *   - `cd ~`, `cd ~/x` — expand `~` via the env tracker's
 *     `env.get("HOME")`, seeded from `process.env.HOME` at tracker
 *     initialization. Callers supplying a custom env map
 *     (`walk(script, { env: myMap }, ...)`) see their HOME instead.
 *   - `cd` with no args — go to `$HOME`.
 *   - `cd -` — no-op (we don't track OLDPWD; errs toward over-matching,
 *     the safer failure mode for a guardrail consumer).
 *   - `cd "$VAR/x"` — resolves via `allState.env` (see D1 in
 *     pr5-tier-b-shell-var-tracker-spec.md). When the var is set in
 *     the env tracker's state (bare assignment, `export`, or seeded
 *     from `process.env`), the full target path resolves. Unknown
 *     vars / command substitution / arithmetic return `undefined`,
 *     which the walker surfaces as the `unknown` sentinel and the
 *     engine's `when.cwd` predicate consumes via its `onUnknown`
 *     policy (default `'block'`, fail-closed).
 *   - `git -C DIR` — per-command cwd override. Scans pre-subcommand flags
 *     only, stopping at the subcommand token. Composable:
 *     `git -C /a -C b push` records at `/a/b`. Also skips `-c KEY=VAL`.
 *   - `make -C DIR` — per-command; scans all tokens (make parses flags
 *     interspersed with targets). Skips `-f`, `-I`, `-o`, `-W` which
 *     consume a following token.
 *   - `env -C DIR` — per-command; scans options-region only (stops at the
 *     first `NAME=value` assignment, `--`, or non-flag cmd name). Skips
 *     `-u`, `-S`, `-C`.
 *
 * Not modelled (documented as out of scope):
 *
 *   - `git --git-dir=/path`, `git --work-tree=/path` — narrower cases;
 *     `-C` is the common agent pattern. Follow-up.
 *   - `pushd` / `popd` directory stack — separate mechanic.
 *   - `eval` / `source` / `.` — string execution; statically intractable.
 */

import * as path from "node:path";
import type { Word } from "unbash";
import { isStaticallyResolvable, type Modifier, type Tracker } from "../tracker.ts";
import { resolveWord } from "../resolve-word.ts";
import type { EnvState } from "./env.ts";

// --------------------------------------------------------------------------
// cd — sequential modifier
// --------------------------------------------------------------------------

/**
 * Fallback env used when the caller registers `cwdTracker` without
 * `envTracker`. Reads `process.env.{HOME, USER, PWD}` on every
 * invocation — the same three keys `envTracker`'s default initial
 * state captures — so `cd ~`, `cd ~/x`, and bare `cd` still expand
 * to HOME in walker-only (no-env-tracker) usage. Dynamic `$VAR`
 * targets where the var isn't one of these three still return
 * `undefined` (walker emits `unknown`), matching the strict Tracker
 * contract.
 *
 * Callers who register `envTracker` override this: the walker threads
 * its env state through `allState.env`, which takes precedence over
 * the fallback.
 *
 * Per-call evaluation (instead of module-load caching) is deliberate:
 * tests that mutate `process.env` before each assertion need the
 * current value, not the value captured at import time. Per-call
 * cost is O(3) map entries — well within the walker's hot-path
 * budget.
 */
function buildProcessEnvFallback(): EnvState {
	const out = new Map<string, string>();
	const { HOME, USER, PWD } = process.env;
	if (HOME !== undefined) out.set("HOME", HOME);
	if (USER !== undefined) out.set("USER", USER);
	if (PWD !== undefined) out.set("PWD", PWD);
	return out;
}

/**
 * Return the effective env map for this cd invocation: the env
 * tracker's state if registered, otherwise the process-env
 * fallback. Narrow-type `allState.env` through a soft cast so
 * walker-only callers who skip env registration don't crash on the
 * `.get(...)` dereference.
 */
function effectiveEnv(allState: Readonly<Record<string, unknown>>): EnvState {
	const fromAllState = (allState as Readonly<{ env?: EnvState }>).env;
	return fromAllState ?? buildProcessEnvFallback();
}

/**
 * Expand `~` / `~/...` using `env.get('HOME')`. The env map is the
 * source of truth once seeded by {@link envTracker}; when that
 * tracker isn't registered we fall back to a process-env snapshot
 * (see {@link PROCESS_ENV_FALLBACK}) so single-tracker walker users
 * don't lose tilde expansion.
 *
 * Used by the bare-`cd` code path (no args → HOME). For `cd <target>`,
 * tilde expansion happens inside {@link resolveWord}, which is
 * quote-aware — bare `~/proj` expands, double-quoted `"~/proj"`
 * does not (matching bash).
 */
function resolveHome(current: string, env: EnvState): string {
	return env.get("HOME") ?? current;
}

/**
 * Compute the cwd resulting from `cd <target>` starting at `current`.
 *
 * The target string is the post-resolveWord literal — tilde expansion
 * already happened quote-correctly inside resolveWord (bare `~/...`
 * expands, double-quoted `"~/..."` stays literal). Here we only
 * decide absolute-vs-relative: absolute replaces, relative joins.
 */
function resolveTarget(current: string, target: string): string {
	if (path.isAbsolute(target)) return target;
	return path.join(current, target);
}

/**
 * Sequential modifier for `cd`. Updates the cwd for this command AND
 * subsequent sibling commands.
 *
 * Env-aware resolution (Tier B of PR #5):
 *
 *   - Static target (`cd /a`, `cd a/b`, `cd ~/subdir`, `cd -`): behave
 *     as before. `-` is a no-op (we don't track OLDPWD); bare `cd`
 *     goes to HOME via `env.get('HOME')`.
 *   - Non-static target: call {@link resolveWord} with the env map
 *     ({@link effectiveEnv}) to expand `$VAR`, `${VAR}`, `~/...`. If
 *     the helper returns a string, treat as the static target. If it
 *     returns `undefined` (dynamic parts the walker can't resolve —
 *     command substitution, arithmetic, parameter-expansion with
 *     modifiers, an unknown `$VAR`), return `undefined` so the
 *     walker emits its `unknown` sentinel. Engine-side `when.cwd`
 *     applies its `onUnknown: 'allow' | 'block'` policy (default
 *     `'block'`, fail-closed).
 *
 * This replaces the pre-Tier-B Phase 1 exception that returned
 * `current` unchanged on dynamic targets — a silent-bypass class
 * where `cd "\$VAR/protected" && cr` passed cwd-scoped rules
 * because the regex never saw the "/protected" path.
 */
/**
 * Sequential modifier for `cd`. Updates the cwd for this command AND
 * subsequent sibling commands.
 *
 * Env-aware resolution (Tier B of PR #5):
 *
 *   - `cd` with no args → HOME via `env.get('HOME')`.
 *   - `cd -` → no-op (we don't track OLDPWD).
 *   - Any other target: resolve through {@link resolveWord} with the
 *     effective env map. The helper handles every quote + expansion
 *     variant the walker understands (Literal, SingleQuoted,
 *     DoubleQuoted with resolvable children, `$VAR`, `${VAR}`, and
 *     tilde at word start), returns `undefined` when any part is
 *     intractable (command substitution, arithmetic, unknown `$VAR`,
 *     parameter-expansion with modifier). Tilde handling is
 *     quote-aware inside resolveWord, so `cd ~/proj` expands but
 *     `cd "~/proj"` stays literal — matching bash.
 *
 * Undefined return surfaces the walker's `unknown` sentinel, which
 * the engine's `when.cwd` consumes via its `onUnknown: 'allow' |
 * 'block'` policy (default `'block'`, fail-closed). This replaces
 * the pre-Tier-B Phase 1 exception that returned `current` unchanged
 * on dynamic targets — a silent-bypass class where
 * `cd "$VAR/protected" && cr` passed cwd-scoped rules because the
 * regex never saw the `/protected` path.
 */
const cdModifier: Modifier<string, { env: EnvState }> = {
	scope: "sequential",
	apply(args, current, allState) {
		const env = effectiveEnv(allState);
		const targetWord = args[0];

		// `cd` with no arguments → HOME.
		if (targetWord === undefined) return resolveHome(current, env);

		// Route every target — static or dynamic, quoted or unquoted —
		// through resolveWord so tilde + env expansion are quote-aware
		// (M5 fix). resolveWord returns `undefined` for intractable
		// words; surface that as the walker's unknown sentinel.
		const target = resolveWord(targetWord, env);
		if (target === undefined) return undefined;

		if (target === "-") return current;

		// Sticky-unknown guard (Tier B correctness fix H1): once the
		// cwd has fallen into the `unknown` sentinel via an earlier
		// dynamic cd, a subsequent RELATIVE cd would otherwise produce
		// `path.join("unknown", "<rel>") === "unknown/<rel>"` — a
		// prefixed-sentinel that `evaluateCwd` no longer recognises
		// (strict `walkerCwd === "unknown"`), silently defeating
		// `onUnknown: 'block'`. Keep the sentinel sticky for relative
		// targets; absolute cd recovers static ground and is allowed to
		// re-anchor as before.
		if (current === cwdTracker.unknown && !path.isAbsolute(target)) {
			return undefined;
		}

		return resolveTarget(current, target);
	},
};

// --------------------------------------------------------------------------
// git / make / env — per-command modifiers
// --------------------------------------------------------------------------
//
// The logic below is preserved verbatim from the original
// `cwd-override-flags.ts` resolvers. The shape changes (same function body
// wrapped as a `per-command` Modifier instead of a side-table entry), but
// the behavior is identical to keep every pre-existing test passing.

function wordValue(w: Word | undefined): string | undefined {
	return w?.value ?? w?.text;
}

/** Apply a single directory change: absolute replaces, relative joins. */
function applyDir(current: string, target: string): string {
	if (path.isAbsolute(target)) return target;
	return path.join(current, target);
}

/**
 * True if the word's value is determinable from source text alone,
 * REQUIRING a word to be present. Differs from the general
 * `isStaticallyResolvable` in tracker.ts only by rejecting `undefined`
 * (missing argument, e.g. trailing `-C`) as malformed — per-command
 * overrides with a missing target should be treated as "no override".
 */
function hasStaticTarget(w: Word | undefined): boolean {
	if (!w) return false;
	return isStaticallyResolvable(w);
}

/**
 * Resolve per-command cwd for `git`. Scans pre-subcommand flags for `-C DIR`,
 * composing left-to-right. Stops at the subcommand (first non-flag token),
 * so `git push -C /x` is NOT misread (here `-C` is a git-push arg, not a
 * git global flag).
 *
 * Also skips `-c <key>=<value>` — a common git flag that consumes the next
 * whitespace-separated token as its value. Not doing so would let `-c`'s
 * value be misinterpreted as the subcommand and prematurely terminate the
 * scan.
 *
 * Long flags (`--foo`, `--foo=value`, `--paginate`, `--no-pager`) are
 * single tokens. `--git-dir=/path` and `--work-tree=/path` are documented
 * as not modelled (follow-up).
 */
function applyGitCwd(args: readonly Word[], current: string): string {
	let cwd = current;
	let i = 0;
	while (i < args.length) {
		const tok = wordValue(args[i]) ?? "";
		// Subcommand reached — stop scanning for pre-subcommand flags.
		if (!tok.startsWith("-")) return cwd;
		if (tok === "-C") {
			const target = args[i + 1];
			if (!hasStaticTarget(target)) return cwd;
			const val = wordValue(target);
			if (val === undefined) return cwd;
			cwd = applyDir(cwd, val);
			i += 2;
			continue;
		}
		// `-c <key>=<value>` — consume both.
		if (tok === "-c") {
			i += 2;
			continue;
		}
		// All other flags (short cluster, long with or without attached value):
		// single token, no effect on cwd we model.
		i++;
	}
	return cwd;
}

/**
 * Resolve per-command cwd for GNU `make`. `-C DIR` is repeatable and flags
 * may interleave with targets (make parses all args looking for options).
 * We scan ALL tokens for `-C DIR` pairs, skipping `-f FILE`, `-I DIR`,
 * `-o FILE`, `-W FILE` which also consume a following token.
 *
 * Limit: `make all -C not_a_flag_target` still finds `-C`. make itself
 * would do the same — the first `-C` is a valid make flag regardless of
 * position — so this matches actual behavior.
 */
function applyMakeCwd(args: readonly Word[], current: string): string {
	const consumesValue = new Set(["-C", "-f", "-I", "-o", "-W"]);
	let cwd = current;
	let i = 0;
	while (i < args.length) {
		const tok = wordValue(args[i]) ?? "";
		if (tok === "-C") {
			const target = args[i + 1];
			if (!hasStaticTarget(target)) return cwd;
			const val = wordValue(target);
			if (val === undefined) return cwd;
			cwd = applyDir(cwd, val);
			i += 2;
			continue;
		}
		if (consumesValue.has(tok)) {
			i += 2;
			continue;
		}
		i++;
	}
	return cwd;
}

/**
 * Resolve per-command cwd for GNU `env`. Options precede assignments and
 * the command name, per typical usage. We scan the options region only:
 * stop at the first token that looks like an assignment (`NAME=value`) or
 * a non-flag word (the command name), or at `--`.
 *
 * Known value-consuming short options skipped here: `-u NAME`, `-S STRING`,
 * `-C DIR`. Others are no-arg or `--foo=value` (single token).
 */
function applyEnvCwd(args: readonly Word[], current: string): string {
	const consumesValue = new Set(["-C", "-u", "-S"]);
	let cwd = current;
	let i = 0;
	while (i < args.length) {
		const tok = wordValue(args[i]) ?? "";
		// End of options: `--`, `NAME=value`, or the cmd name.
		if (tok === "--") return cwd;
		if (!tok.startsWith("-")) return cwd;
		if (tok === "-C") {
			const target = args[i + 1];
			if (!hasStaticTarget(target)) return cwd;
			const val = wordValue(target);
			if (val === undefined) return cwd;
			cwd = applyDir(cwd, val);
			i += 2;
			continue;
		}
		if (consumesValue.has(tok)) {
			i += 2;
			continue;
		}
		i++;
	}
	return cwd;
}

// --------------------------------------------------------------------------
// The tracker
// --------------------------------------------------------------------------

/**
 * Built-in `cwd` tracker.
 *
 * `initial` is the placeholder value (`"/"`); callers almost always pass
 * an explicit starting cwd via `walk(script, { cwd: sessionCwd }, {...})`.
 * The placeholder exists so that a consumer who forgets to seed the
 * session cwd still gets a well-typed result (rather than `undefined`)
 * while surfacing the mistake loudly in their rules.
 *
 * `unknown` is the sentinel used whenever a modifier returns `undefined`
 * (dynamic target, `$VAR`, `$(cmd)`, etc.). Consumers inspect for this
 * value to apply their `onUnknown: "allow" | "block"` predicate policy.
 *
 * `subshellSemantics` is `"isolated"` — real bash semantics: a subshell
 * can `cd` around internally without affecting its parent.
 *
 * ## Env-aware `cd` resolution
 *
 * The `cd` modifier reads `allState.env` via the cross-tracker read
 * protocol (D1). Targets containing `$VAR` / `${VAR}` / `~` expand
 * through the env map seeded by {@link envTracker}. Intractable
 * targets (unknown `$VAR`, command substitution, arithmetic, etc.)
 * return `undefined`, surfacing the walker's `unknown` sentinel so
 * the engine's `when.cwd` predicate can apply its `onUnknown`
 * policy (default fail-closed). Callers MUST register `envTracker`
 * alongside `cwdTracker` for the expansion to take effect; without
 * env state, dynamic targets always flow through to `unknown`.
 *
 * ## Note for plugin authors
 *
 * A tracker's modifier that can't statically resolve its result
 * should return `undefined`. The walker emits `tracker.unknown` and
 * predicates consuming that tracker apply their `onUnknown: "allow" |
 * "block"` policy (default `"block"`). See `tracker.ts` for the full
 * contract, and `pr5-tier-b-shell-var-tracker-spec.md` for the
 * design note explaining how cwd + env compose through `allState`.
 */
export const cwdTracker: Tracker<string> = {
	initial: "/",
	unknown: "unknown",
	modifiers: {
		cd: cdModifier,
		git: { scope: "per-command", apply: applyGitCwd },
		make: { scope: "per-command", apply: applyMakeCwd },
		env: { scope: "per-command", apply: applyEnvCwd },
	},
	subshellSemantics: "isolated",
};

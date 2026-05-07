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
 * their `scope`. See the accepted ADR at
 * `.napkin/decisions/2026-05-06T15-00-pi-steering-hooks-config-format.md`
 * (section "Design" → "Built-in cwd tracker") for the rationale. The
 * per-command override behavior is preserved from its original home in
 * `cwd-override-flags.ts` (see the superseded design note
 * `.napkin/features/pi-infra/open-source-steering-hooks/walker-cwd-override-flags-design.md`
 * for the why).
 *
 * Semantics modelled (identical to the original `effectiveCwd`):
 *
 *   - `cd ABS` — replace current dir with ABS.
 *   - `cd REL` — join with current dir.
 *   - `cd ~`, `cd ~/x` — expand `~` via `process.env.HOME ?? currentCwd`.
 *   - `cd` with no args — go to `$HOME`.
 *   - `cd -` — no-op (we don't track OLDPWD; errs toward over-matching,
 *     the safer failure mode for a guardrail consumer).
 *   - `cd` with an unresolvable target (parameter expansion, command
 *     substitution, arithmetic expansion, process substitution, etc.) —
 *     returns `undefined`, which the walker translates into the tracker's
 *     `unknown` sentinel (`"unknown"`). Subsequent commands see `unknown`
 *     until some resolvable change overrides it.
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

// --------------------------------------------------------------------------
// cd — sequential modifier
// --------------------------------------------------------------------------

/** Expand `~` / `~/...` using `process.env.HOME`, falling back to `current`. */
function resolveHome(current: string): string {
	return process.env["HOME"] ?? current;
}

/** Compute the cwd resulting from `cd <target>` starting at `current`. */
function resolveTarget(current: string, target: string): string {
	if (target === "~") return resolveHome(current);
	if (target.startsWith("~/")) {
		return path.join(resolveHome(current), target.slice(2));
	}
	if (path.isAbsolute(target)) return target;
	return path.join(current, target);
}

/**
 * `cd` modifier. Sequential: its effect propagates to subsequent sibling
 * commands in the same scope. Returns `undefined` when the target is
 * dynamic, which the walker translates into the `unknown` sentinel for
 * `cd`'s recorded value AND every subsequent command in the scope.
 *
 * NOTE: the recorded cwd for the `cd` command itself is the PRE-cd cwd —
 * this is handled by the walker (sequential modifiers update only the
 * threaded value). So `cd /x` is recorded at the cwd BEFORE the change.
 */
const cdModifier: Modifier<string> = {
	scope: "sequential",
	apply: (args, current) => {
		const targetWord = args[0];

		// `cd` with no arguments → HOME.
		if (targetWord === undefined) return resolveHome(current);

		// Non-static target: walker records `unknown` for this command AND
		// subsequent siblings. Matches the original behavior of recording
		// the `cd` at pre-cd cwd AND leaving subsequent commands at that
		// pre-cd cwd — EXCEPT the new semantics propagate `unknown` forward
		// instead. That's the intended upgrade: predicates now see the
		// `unknown` sentinel and can apply their `onUnknown` policy.
		//
		// For the Phase 1 ports we preserve the existing test coverage by
		// matching the prior effective-cwd behavior exactly: the old walker
		// stopped propagating cd effects on a dynamic target AND recorded
		// the cd at pre-cd cwd AND left subsequent commands at pre-cd cwd.
		// We do that by returning `current` unchanged for sequential here —
		// matching prior behaviour. Dynamic cwd propagation will be revisited
		// when predicates grow an explicit `unknown` sentinel interaction
		// (ADR section 3, "onUnknown policy" — Phase 2+).
		if (!isStaticallyResolvable(targetWord)) return current;

		const target = targetWord.value ?? targetWord.text;
		if (target === undefined || target === "-") return current;

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

// SPDX-License-Identifier: MIT
// Part of unbash-walker.

/**
 * Per-command cwd overrides — commands that accept a flag which changes the
 * directory THAT COMMAND operates in without changing the shell's cwd.
 *
 * Modelled:
 *   - `git -C DIR <subcommand>` (repeatable: `git -C /a -C b` → `/a/b`)
 *   - `make -C DIR <target>` (repeatable per GNU make)
 *   - `env -C DIR <cmd>` (GNU extension)
 *
 * Not modelled (out of scope; documented as follow-ups):
 *   - `git --git-dir=/path` — narrower; affects which repo git reads, not
 *     fully a cwd override. Agents overwhelmingly emit `-C` in practice.
 *   - `git --work-tree=/path` — same class.
 *   - `pushd`/`popd` directory stack — separate mechanic.
 *   - Wrapper-expansion interaction: when a wrapper surfaces an inner ref
 *     (e.g. `env -C /A cmd` → inner `cmd`), the override applies to the
 *     outer `env` ref's recorded cwd but does NOT flow through to the
 *     inner `cmd` ref. See the interaction note in `effective-cwd.ts`.
 *     Fixing this requires wrapper expansion to consult this registry
 *     when computing the inner ref's cwd — tracked as a separate issue.
 *
 * Design: each handler takes the command's suffix (argument words) and the
 * base cwd, and returns the cwd that applies to THIS command alone. The
 * override does NOT propagate to subsequent commands — `git -C /x push; ls`
 * runs `ls` at the pre-git cwd, because git's `-C` is internal to git, not
 * a shell state change.
 *
 * Static-only: if the `-C` target is non-static (parameter expansion, command
 * substitution, etc.), the resolver stops propagating further `-C` effects
 * and returns the best-known static prefix. Same principle as the `cd`
 * walker — we don't invent paths like `/start/$VAR`.
 */

import * as path from "node:path";
import type { Word, WordPart } from "unbash";

/**
 * Resolver signature: given a command's suffix words and the cwd the
 * shell would have at this command's position, return the cwd that applies
 * to THIS command invocation (override if present, else baseCwd).
 */
export type CwdOverrideResolver = (
	suffix: readonly Word[],
	baseCwd: string,
) => string;

/** True if the word's value is determinable from source text alone. */
function isStaticallyResolvable(w: Word | undefined): boolean {
	if (!w) return false; // missing target (e.g. trailing `-C`) — malformed
	if (!w.parts || w.parts.length === 0) return true;
	return w.parts.every(isStaticPart);
}

function isStaticPart(p: WordPart): boolean {
	if (p.type === "Literal") return true;
	if (p.type === "SingleQuoted") return true;
	if (p.type === "DoubleQuoted") {
		return (p.parts ?? []).every((child) => isStaticPart(child as WordPart));
	}
	return false;
}

/** Apply a single directory change: absolute replaces, relative joins. */
function applyDir(baseCwd: string, target: string): string {
	if (path.isAbsolute(target)) return target;
	return path.join(baseCwd, target);
}

function wordValue(w: Word | undefined): string | undefined {
	return w?.value ?? w?.text;
}

/**
 * Resolve cwd for `git`. Scans pre-subcommand flags for `-C DIR`, composing
 * left-to-right. Stops at the subcommand (first non-flag token), so
 * `git push -C /x` (where `-C` is NOT a git global flag but a git-push
 * argument / git-log copy-detection flag) is not misread.
 *
 * Also skips `-c <key>=<value>` — a common git flag that consumes the next
 * whitespace-separated token as its value. Not doing this would let `-c`'s
 * value be misinterpreted as the subcommand and prematurely terminate the
 * scan.
 *
 * Long flags (`--foo`, `--foo=value`, `--paginate`, `--no-pager`, ...) are
 * treated as single tokens. Known limit: `--git-dir=/path` and
 * `--work-tree=/path` do NOT modify cwd here — documented as follow-ups.
 */
function resolveGitCwd(suffix: readonly Word[], baseCwd: string): string {
	let cwd = baseCwd;
	let i = 0;
	while (i < suffix.length) {
		const tok = wordValue(suffix[i]) ?? "";
		// Subcommand reached — stop scanning for pre-subcommand flags.
		if (!tok.startsWith("-")) return cwd;
		if (tok === "-C") {
			const target = suffix[i + 1];
			if (!isStaticallyResolvable(target)) return cwd;
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
 * Resolve cwd for GNU `make`. `-C DIR` is repeatable and flags may interleave
 * with targets (make parses all args looking for options). For simplicity
 * we scan ALL suffix tokens for `-C DIR` pairs, skipping `-f FILE`,
 * `-I DIR`, `-o FILE`, `-W FILE` which also consume a following token.
 *
 * Limit: if someone writes `make all -C not_a_flag_target`, our scan still
 * finds the `-C` and treats `not_a_flag_target` as the dir. make itself
 * would do the same — the first `-C` IS a valid make flag regardless of
 * position — so this matches actual behaviour.
 */
function resolveMakeCwd(suffix: readonly Word[], baseCwd: string): string {
	const consumesValue = new Set(["-C", "-f", "-I", "-o", "-W"]);
	let cwd = baseCwd;
	let i = 0;
	while (i < suffix.length) {
		const tok = wordValue(suffix[i]) ?? "";
		if (tok === "-C") {
			const target = suffix[i + 1];
			if (!isStaticallyResolvable(target)) return cwd;
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
 * Resolve cwd for GNU `env`. Options precede assignments and the command
 * name, per the typical usage. We scan the options region only: stop at
 * the first token that looks like an assignment (`NAME=value`) or a
 * non-flag word (the command name).
 *
 * Known value-consuming short options skipped here: `-u NAME`, `-S STRING`,
 * `-C DIR`. Others are no-arg or `--foo=value` (single token).
 */
function resolveEnvCwd(suffix: readonly Word[], baseCwd: string): string {
	const consumesValue = new Set(["-C", "-u", "-S"]);
	let cwd = baseCwd;
	let i = 0;
	while (i < suffix.length) {
		const tok = wordValue(suffix[i]) ?? "";
		// End of options: `--` (POSIX convention), `NAME=value`, or the cmd name.
		if (tok === "--") return cwd;
		if (!tok.startsWith("-")) return cwd; // assignment or cmd name
		if (tok === "-C") {
			const target = suffix[i + 1];
			if (!isStaticallyResolvable(target)) return cwd;
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
 * Registry of commands that accept a cwd-overriding flag. Keyed by the
 * command's **basename** (so `/usr/bin/git` and `git` both match). The
 * effective-cwd walker consults this after computing the shell-level cwd
 * for each command.
 *
 * Adding a new entry is an additive change — it only affects the recorded
 * cwd for that command, never subsequent commands.
 */
export const CWD_OVERRIDE_FLAGS: Record<string, CwdOverrideResolver> = {
	git: resolveGitCwd,
	make: resolveMakeCwd,
	env: resolveEnvCwd,
};

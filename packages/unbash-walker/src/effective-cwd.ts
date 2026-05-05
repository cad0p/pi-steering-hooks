// SPDX-License-Identifier: MIT
// Effective-cwd walker over unbash ASTs. Part of unbash-walker.

import * as path from "node:path";
import type {
	AndOr,
	BraceGroup,
	Command,
	CompoundList,
	Node,
	Pipeline,
	Script,
	Statement,
	Subshell,
	Word,
	WordPart,
} from "unbash";
import { extractAllCommandsFromAST } from "./extract.ts";
import type { CommandRef } from "./types.ts";

/**
 * For each command in the script, compute the working directory in which it
 * would execute given `initialCwd` as the shell's starting directory.
 *
 * Semantics modelled:
 *   - `cd ABS` — replace current dir with ABS
 *   - `cd REL` — join with current dir
 *   - `cd ~`, `cd ~/x` — expand `~` via `process.env.HOME ?? initialCwd`
 *   - `cd` with no args — go to `$HOME`
 *   - `cd -` — no-op (we don't track OLDPWD; errs toward over-matching, which
 *     is the safer failure mode for a guardrail consumer)
 *   - `cd` with an unresolvable target (parameter expansion, command
 *     substitution, arithmetic expansion, process substitution, etc.) — the
 *     target can't be computed statically, so we stop propagating cd effects
 *     from this point. The `cd` command itself is recorded at the pre-cd cwd,
 *     and subsequent commands see the pre-cd cwd unchanged (conservative:
 *     avoids inventing a bogus path like `/start/$VAR`).
 *   - `A && B`, `A || B`, `A ; B`, `A\nB` — left-to-right; cd effects propagate
 *   - `A | B` — each pipeline peer runs in its own subshell; no cd effect
 *     escapes out or across peers
 *   - `(A; B)` — subshell; cd effects are isolated to the subshell body
 *   - `{ A; B; }` — group; cd effects DO propagate to surrounding scope
 *   - control flow (if / while / for / select / case) — conservative
 *     branch-merge: walk every branch/body so inner commands are recorded,
 *     but only propagate cd effects out of the construct when all branches
 *     agree on a final cwd (if/case), or never (while/for/select: body
 *     may run zero times). If/case fall back to the post-clause cwd when
 *     branches disagree; while/for/select fall back to the pre-loop cwd.
 *
 * Not modelled (out of scope — documented for future work):
 *   - `pushd`/`popd` directory stack
 *   - `eval` / `source` / `.` string execution
 *   - `env -C DIR cmd` (env's per-command cwd override)
 *   - background `&` separator (treated like `;`)
 *
 * The returned map is keyed by CommandRef—those refs are freshly created by
 * this function. Iterate the map (`for (const [ref, cwd] of map)`) or read
 * `Array.from(map.keys())` to enumerate commands; do **not** try to look up
 * refs obtained from a separate `extractAllCommandsFromAST` call on the same
 * tree, since CommandRef identity is per-extraction. If you need to correlate
 * with external refs, match on `ref.node` (the underlying unbash Command node
 * is shared across extractions of the same AST).
 *
 * The effective cwd recorded for a `cd` command is the cwd **as it starts**,
 * i.e. before its own effect is applied. For `cd A && cmd B && cd C`, `cmd B`
 * sees cwd = A, not C.
 */
export function effectiveCwd(
	script: Script,
	initialCwd: string,
): Map<CommandRef, string> {
	const refs = extractAllCommandsFromAST(script, "");
	const byNode = new Map<Command, string>();
	walk(script, initialCwd, byNode);

	const result = new Map<CommandRef, string>();
	for (const ref of refs) {
		const cwd = byNode.get(ref.node);
		if (cwd !== undefined) result.set(ref, cwd);
	}
	return result;
}

/**
 * Walk a node, recording each Command's effective cwd into `byNode`, and
 * return the cwd that results after executing the node (to let the caller
 * thread cwd through a sequence).
 */
function walk(
	node: Script | Node | undefined,
	cwd: string,
	byNode: Map<Command, string>,
): string {
	if (!node) return cwd;

	switch (node.type) {
		case "Script":
		case "CompoundList":
			return walkSequence((node as Script | CompoundList).commands, cwd, byNode);

		case "Statement":
			// Statement wraps a single command/pipeline/subshell/etc.
			return walk((node as Statement).command, cwd, byNode);

		case "AndOr":
			// `A && B`, `A || B` — cd effects propagate left-to-right regardless
			// of operator. We don't try to reason about runtime truth.
			return walkSequence((node as AndOr).commands, cwd, byNode);

		case "Pipeline":
			// Each peer runs in its own subshell; no cd propagation across peers
			// and none back to the outer scope.
			for (const peer of (node as Pipeline).commands) {
				walk(peer, cwd, byNode);
			}
			return cwd;

		case "Subshell": {
			// Subshell: cd effects are isolated.
			walk((node as Subshell).body, cwd, byNode);
			return cwd;
		}

		case "BraceGroup":
			// Brace group: cd effects DO propagate.
			return walk((node as BraceGroup).body, cwd, byNode);

		case "Command":
			return handleCommand(node as Command, cwd, byNode);

		case "If": {
			const n = node as Extract<Node, { type: "If" }>;
			// Bash runs exactly one branch (then XOR else), chosen at runtime.
			// The clause's commands always execute, so thread cwd through it.
			// Then walk each branch from the post-clause cwd. If all branches
			// agree on a final cwd, propagate it; otherwise fall back to the
			// post-clause cwd (conservative: avoids inventing a cwd that may
			// not hold for this particular run).
			const clauseCwd = walk(n.clause, cwd, byNode);
			const thenCwd = walk(n.then, clauseCwd, byNode);
			const elseCwd = n.else ? walk(n.else, clauseCwd, byNode) : clauseCwd;
			return thenCwd === elseCwd ? thenCwd : clauseCwd;
		}

		case "While": {
			const n = node as Extract<Node, { type: "While" }>;
			// The body may run zero or more times. Walk it so inner commands
			// get recorded at their apparent cwd, but don't propagate the
			// body's cwd forward — the body may not have executed at all.
			const clauseCwd = walk(n.clause, cwd, byNode);
			walk(n.body, clauseCwd, byNode);
			return clauseCwd;
		}

		case "For":
		case "Select": {
			const n = node as Extract<Node, { type: "For" | "Select" }>;
			// Body iterates zero or more times; don't propagate cd effects out.
			walk(n.body, cwd, byNode);
			return cwd;
		}

		case "Case": {
			const n = node as Extract<Node, { type: "Case" }>;
			// Exactly one case item runs (or none). Walk each from the
			// pre-case cwd; if all items agree on a final cwd, thread it
			// forward; otherwise fall back to the pre-case cwd.
			const itemCwds = n.items.map((item) => walk(item.body, cwd, byNode));
			if (itemCwds.length === 0) return cwd;
			const first = itemCwds[0]!;
			return itemCwds.every((c) => c === first) ? first : cwd;
		}

		case "Function":
			// A function definition doesn't change cwd. We don't descend into the
			// body — it only runs when called, and callers may invoke it anywhere.
			return cwd;

		default:
			// Coproc, TestCommand, Arithmetic*, etc. — no cwd effects we model.
			return cwd;
	}
}

/** Walk a sequence of nodes (Script/CompoundList/AndOr children) threading cwd. */
function walkSequence(
	nodes: readonly Node[],
	cwd: string,
	byNode: Map<Command, string>,
): string {
	let c = cwd;
	for (const n of nodes) {
		c = walk(n, c, byNode);
	}
	return c;
}

/** Record the command's effective cwd (cwd-as-it-starts) and, if it's a
 *  `cd`, compute the resulting cwd for subsequent commands. */
function handleCommand(
	node: Command,
	cwd: string,
	byNode: Map<Command, string>,
): string {
	byNode.set(node, cwd);

	const name = node.name?.value ?? node.name?.text;
	if (name !== "cd") return cwd;

	const targetWord = node.suffix[0];

	// `cd` with no arguments → HOME (or initialCwd if HOME unset)
	if (targetWord === undefined) {
		return resolveHome(cwd);
	}

	// If the target is statically unresolvable (contains parameter/command/
	// arithmetic expansion, process substitution, etc.), stop propagating cd
	// effects. Record this `cd` at the pre-cd cwd and return cwd unchanged.
	if (!isStaticallyResolvable(targetWord)) {
		return cwd;
	}

	const target = targetWord.value ?? targetWord.text;
	if (target === undefined || target === "-") {
		// `cd -`: jumps to OLDPWD, which we don't track. No-op.
		return cwd;
	}

	return resolveTarget(cwd, target);
}

/**
 * True if this word's value can be determined from the source text alone
 * (no runtime expansion). Pure literals and single-quoted strings qualify.
 * Double-quoted strings qualify only if every inner part is itself static.
 * ParameterExpansion / CommandExpansion / ArithmeticExpansion / SimpleExpansion
 * (`$VAR`) / ProcessSubstitution / BraceExpansion / ExtendedGlob / ANSI-C /
 * LocaleString etc. are all treated as unresolvable — we do not invent values
 * for them.
 */
function isStaticallyResolvable(w: Word | undefined): boolean {
	if (!w) return true; // no arg = HOME, resolvable
	if (!w.parts || w.parts.length === 0) return true; // pure literal
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

/** Expand `~` / `~/...` using `process.env.HOME`, falling back to `cwd`. */
function resolveHome(cwd: string): string {
	return process.env["HOME"] ?? cwd;
}

/** Compute the cwd resulting from `cd <target>` starting at `cwd`. */
function resolveTarget(cwd: string, target: string): string {
	if (target === "~") return resolveHome(cwd);
	if (target.startsWith("~/")) {
		return path.join(resolveHome(cwd), target.slice(2));
	}
	if (path.isAbsolute(target)) return target;
	return path.join(cwd, target);
}

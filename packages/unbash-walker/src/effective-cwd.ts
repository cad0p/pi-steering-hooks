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
 *   - `A && B`, `A || B`, `A ; B`, `A\nB` — left-to-right; cd effects propagate
 *   - `A | B` — each pipeline peer runs in its own subshell; no cd effect
 *     escapes out or across peers
 *   - `(A; B)` — subshell; cd effects are isolated to the subshell body
 *   - `{ A; B; }` — group; cd effects DO propagate to surrounding scope
 *   - control flow (if / while / for / select / case) — body runs in current
 *     scope, cd effects propagate (conservative)
 *
 * Not modelled (out of scope — documented for future work):
 *   - `pushd`/`popd` directory stack
 *   - `eval` / `source` / `.` string execution
 *   - `env -C DIR cmd` (env's per-command cwd override)
 *   - background `&` separator (treated like `;`)
 *
 * The returned map is keyed by CommandRef (as returned by
 * `extractAllCommandsFromAST`), so callers can look up the effective cwd for
 * any extracted command without re-walking the tree.
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
			// Conservative: propagate the clause's cwd into both branches; take
			// the last-branch cwd forward. Runtime picks one branch; static
			// analysis can't know which, so we thread like a sequence.
			let c = walk(n.clause, cwd, byNode);
			c = walk(n.then, c, byNode);
			if (n.else) c = walk(n.else, c, byNode);
			return c;
		}

		case "While": {
			const n = node as Extract<Node, { type: "While" }>;
			let c = walk(n.clause, cwd, byNode);
			c = walk(n.body, c, byNode);
			return c;
		}

		case "For":
		case "Select": {
			const n = node as Extract<Node, { type: "For" | "Select" }>;
			return walk(n.body, cwd, byNode);
		}

		case "Case": {
			const n = node as Extract<Node, { type: "Case" }>;
			let c = cwd;
			for (const item of n.items) {
				c = walk(item.body, c, byNode);
			}
			return c;
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

	const args = node.suffix.map((w) => w.value ?? w.text);

	// `cd` with no arguments → HOME (or initialCwd if HOME unset)
	if (args.length === 0) {
		return resolveHome(cwd);
	}

	const target = args[0];
	if (target === undefined || target === "-") {
		// `cd -`: jumps to OLDPWD, which we don't track. No-op.
		return cwd;
	}

	return resolveTarget(cwd, target);
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

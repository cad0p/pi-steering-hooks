// SPDX-License-Identifier: MIT
// Tests for the built-in `env` tracker. Part of unbash-walker.
//
// These tests exercise envTracker through the generalized `walk` API
// the same way cwdTracker tests do — via the `walk` entrypoint with
// the real unbash parser. The `walk` integration shows that the
// walker's bare-assignment synthesis in handleCommand correctly
// routes prefix-only commands into the envTracker modifier.
//
// Most tests seed an explicit initial env map instead of leaning on
// the process-env default — the tests shouldn't depend on whatever
// HOME/USER/PWD the test runner inherits.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { parse as parseBash } from "unbash";
import { extractAllCommandsFromAST } from "../extract.ts";
import { getBasename } from "../resolve.ts";
import { walk } from "../tracker.ts";
import { envTracker, type EnvState } from "./env.ts";

/**
 * Walk `raw` with env tracker seeded from `initial`. Returns the
 * final env state for each extracted command, keyed by basename-
 * order.
 */
type WalkerState = { env: EnvState };

function walkEnv(raw: string, initial?: EnvState) {
	const ast = parseBash(raw);
	return walk<WalkerState>(
		ast,
		{ env: initial ?? new Map() },
		{ env: envTracker },
	);
}

/** Extract `(name, envMap)` tuples in AST order, preserving duplicates. */
function envByOrder(
	raw: string,
	initial?: EnvState,
): Array<[string, EnvState]> {
	const map = walkEnv(raw, initial);
	return Array.from(map, ([ref, snap]) => [getBasename(ref), snap.env]);
}

/** Env map at the LAST command in the script. */
function finalEnv(raw: string, initial?: EnvState): EnvState {
	const ordered = envByOrder(raw, initial);
	const last = ordered[ordered.length - 1];
	if (!last) throw new Error(`no commands extracted from: ${raw}`);
	return last[1];
}

describe("envTracker via walk", () => {
	describe("bare assignment", () => {
		it("`FOO=bar; cmd` — cmd sees FOO=bar", () => {
			const env = finalEnv("FOO=bar; cmd");
			assert.equal(env.get("FOO"), "bar");
		});

		it("`FOO=bar && cmd` — cmd sees FOO=bar (AndOr propagation)", () => {
			const env = finalEnv("FOO=bar && cmd");
			assert.equal(env.get("FOO"), "bar");
		});

		it("multiple bare assignments on one line: `A=1 B=2; cmd`", () => {
			const env = finalEnv("A=1 B=2; cmd");
			assert.equal(env.get("A"), "1");
			assert.equal(env.get("B"), "2");
		});

		it("quoted value: `FOO=\"some value\"; cmd`", () => {
			const env = finalEnv('FOO="some value"; cmd');
			assert.equal(env.get("FOO"), "some value");
		});

		it("single-quoted value: `FOO='literal'; cmd`", () => {
			const env = finalEnv("FOO='literal'; cmd");
			assert.equal(env.get("FOO"), "literal");
		});

		it("empty value: `FOO=; cmd`", () => {
			const env = finalEnv("FOO=; cmd");
			assert.equal(env.get("FOO"), "");
		});

		it("dynamic value `FOO=$OTHER` — skipped; FOO not set", () => {
			const env = finalEnv("FOO=$OTHER; cmd");
			assert.equal(env.has("FOO"), false);
		});

		it("dynamic value `FOO=$(pwd)` — skipped; FOO not set", () => {
			const env = finalEnv("FOO=$(pwd); cmd");
			assert.equal(env.has("FOO"), false);
		});

		it("compound append `FOO+=append` — skipped; prior FOO unchanged (H2)", () => {
			// Correctness fix H2: the parser attaches `append: true` to
			// `AssignmentPrefix` for `FOO+=v`. Before the fix,
			// synthesizeAssignmentWords ignored the flag and emitted
			// `FOO=v`, silently REPLACING the existing FOO value. We now
			// skip append-shape assignments; true append semantics can be
			// added later once multi-hop env resolution is in scope.
			const env = finalEnv("FOO=initial; FOO+=append; cmd");
			assert.equal(
				env.get("FOO"),
				"initial",
				"FOO+=append must not overwrite FOO; compound-append is skipped",
			);
		});

		it("compound append `FOO+=append` with no prior FOO — skipped; FOO absent (H2)", () => {
			// Complement of the prior pin: without a pre-existing FOO,
			// the skip leaves the env untouched rather than surfacing an
			// incorrect empty scalar.
			const env = finalEnv("FOO+=append; cmd");
			assert.equal(env.has("FOO"), false);
		});

		it("array init `FOO=(a b c)` — skipped; scalar FOO absent (H3)", () => {
			// Correctness fix H3: parser emits `p.value === undefined` +
			// `p.array !== undefined` for array init. Previously the
			// synthesis produced `{name: "FOO", value: ""}` and stored an
			// empty scalar, spuriously flipping `env.has("FOO")`
			// predicates. We don't model bash arrays — skip.
			const env = finalEnv("FOO=(a b c); cmd");
			assert.equal(
				env.has("FOO"),
				false,
				"array init must not surface as a scalar; skipped entirely",
			);
		});

		it("array-index `FOO[0]=value` — skipped; scalar FOO absent (H4)", () => {
			// Correctness fix H4: parser emits `p.index === "0"`. Bash
			// would write to the array slot, leaving the scalar FOO
			// untouched. Previously the walker wrote to the scalar; we
			// now skip array-index assignments.
			const env = finalEnv("FOO[0]=value; cmd");
			assert.equal(
				env.has("FOO"),
				false,
				"array-index assignment must not overwrite scalar FOO",
			);
		});

		it("prefix assignment `A=1 cmd; cmd2` — cmd2 does NOT see A (per-command scope)", () => {
			// `A=1 cmd` is a prefix assignment on `cmd` (one-shot env for cmd
			// only). The env tracker must NOT propagate this to cmd2.
			const ordered = envByOrder("A=1 cmd; cmd2");
			const cmd2 = ordered.find(([n]) => n === "cmd2");
			assert.ok(cmd2, "cmd2 extracted");
			assert.equal(cmd2[1].has("A"), false, "A must not leak from prefix assignment");
		});

		it("bare assignment propagates into the NEXT command but not the assignment itself (recorded pre-sequential)", () => {
			// cmd records the POST-assignment env; the bare-assignment
			// "command" itself records the PRE-assignment env (matching
			// the Tracker contract's "record the pre-sequential value for
			// sequential modifiers" rule).
			//
			// Note: `getBasename` returns the variable name ("FOO") for
			// bare-assignment commands, because `getCommandName` in
			// resolve.ts falls back to `prefix[0].name`. The walker itself
			// uses the stricter `commandBasename` (returns "" when
			// `node.name` is absent) for dispatch, which is why the
			// envTracker's `""`-keyed modifier fires. We match on
			// `"FOO"` here because that's the external API we're asserting
			// against.
			const ordered = envByOrder("FOO=bar; cmd");
			const bareAssign = ordered.find(([n]) => n === "FOO");
			const cmd = ordered.find(([n]) => n === "cmd");
			assert.ok(bareAssign, "bare assignment appears with basename 'FOO'");
			assert.ok(cmd, "cmd extracted");
			assert.equal(bareAssign[1].has("FOO"), false, "assignment itself pre-recorded");
			assert.equal(cmd[1].get("FOO"), "bar", "cmd sees the assignment");
		});
	});

	describe("export", () => {
		it("`export FOO=bar; cmd` — cmd sees FOO=bar", () => {
			const env = finalEnv("export FOO=bar; cmd");
			assert.equal(env.get("FOO"), "bar");
		});

		it("`export FOO=\"some value\"; cmd`", () => {
			const env = finalEnv('export FOO="some value"; cmd');
			assert.equal(env.get("FOO"), "some value");
		});

		it("`export FOO` (no value) — no-op", () => {
			const env = finalEnv("export FOO; cmd");
			assert.equal(env.has("FOO"), false);
		});

		it("`export FOO=$VAR` (dynamic value) — no-op", () => {
			const env = finalEnv("export FOO=$VAR; cmd");
			assert.equal(env.has("FOO"), false);
		});

		it("multiple exports: `export A=1 B=2; cmd`", () => {
			const env = finalEnv("export A=1 B=2; cmd");
			assert.equal(env.get("A"), "1");
			assert.equal(env.get("B"), "2");
		});

		it("`export -n FOO; cmd` (un-export flag) — FOO still present if previously set", () => {
			// We model presence-only; -n flag doesn't delete from map.
			const env = finalEnv("FOO=bar; export -n FOO; cmd");
			assert.equal(env.get("FOO"), "bar");
		});

		it("`export -p` (print flag) — no-op", () => {
			const env = finalEnv("FOO=bar; export -p; cmd");
			assert.equal(env.get("FOO"), "bar");
		});
	});

	describe("unset", () => {
		it("`FOO=bar; unset FOO; cmd` — cmd does NOT see FOO", () => {
			const env = finalEnv("FOO=bar; unset FOO; cmd");
			assert.equal(env.has("FOO"), false);
		});

		it("`unset FOO BAR; cmd` — multiple names", () => {
			const env = finalEnv("FOO=1; BAR=2; unset FOO BAR; cmd");
			assert.equal(env.has("FOO"), false);
			assert.equal(env.has("BAR"), false);
		});

		it("`unset -v FOO; cmd` — flag skipped, FOO unset", () => {
			const env = finalEnv("FOO=bar; unset -v FOO; cmd");
			assert.equal(env.has("FOO"), false);
		});

		it("`unset -f FOO; cmd` — function-only flag leaves scalar FOO intact (M7)", () => {
			// Correctness fix M7: bash's `unset -f` clears functions only
			// and leaves the scalar NAME untouched. Previously the walker
			// skipped the `-f` flag and still deleted the scalar, silently
			// dropping FOO. The modifier now short-circuits when -f is
			// present — functions aren't tracked, nothing to do.
			const env = finalEnv("FOO=bar; unset -f FOO; cmd");
			assert.equal(
				env.get("FOO"),
				"bar",
				"scalar FOO must survive `unset -f FOO` — -f targets functions, not scalars",
			);
		});

		it("`unset $VAR; cmd` (dynamic name) — no-op for that name", () => {
			const env = finalEnv("FOO=bar; unset $VAR; cmd");
			assert.equal(env.get("FOO"), "bar");
		});

		it("`unset NOT_SET; cmd` — no-op (was never set)", () => {
			const env = finalEnv("unset NOT_SET; cmd");
			assert.equal(env.has("NOT_SET"), false);
		});
	});

	describe("subshell isolation", () => {
		it("`(FOO=bar); cmd` — cmd does NOT see FOO", () => {
			const env = finalEnv("(FOO=bar); cmd");
			assert.equal(env.has("FOO"), false);
		});

		it("`(FOO=bar; inner) && cmd` — inner sees FOO, cmd does not", () => {
			const ordered = envByOrder("(FOO=bar; inner) && cmd");
			const inner = ordered.find(([n]) => n === "inner");
			const cmd = ordered.find(([n]) => n === "cmd");
			assert.ok(inner && cmd, "both extracted");
			assert.equal(inner[1].get("FOO"), "bar", "inner sees FOO");
			assert.equal(cmd[1].has("FOO"), false, "cmd doesn't see subshell's FOO");
		});

		it("outer env seeds into subshell: `A=x; (B=y; inner)` — inner sees both", () => {
			const ordered = envByOrder("A=x; (B=y; inner)");
			const inner = ordered.find(([n]) => n === "inner");
			assert.ok(inner);
			assert.equal(inner[1].get("A"), "x", "outer A visible inside");
			assert.equal(inner[1].get("B"), "y", "subshell B set inside");
		});

		it("`(unset FOO); cmd` — outer FOO preserved", () => {
			const env = finalEnv("FOO=bar; (unset FOO); cmd");
			assert.equal(env.get("FOO"), "bar");
		});
	});

	describe("pipeline isolation", () => {
		it("`FOO=bar | cmd` — cmd does NOT see FOO (pipeline peers are subshells)", () => {
			// Note: `FOO=bar | cmd` is odd shell — the left peer is an
			// assignment-only command, which produces no output. Pipeline
			// peers still run in subshells and env changes don't escape.
			const ordered = envByOrder("FOO=bar | cmd");
			const cmd = ordered.find(([n]) => n === "cmd");
			assert.ok(cmd);
			assert.equal(cmd[1].has("FOO"), false);
		});
	});

	describe("brace-group propagation", () => {
		it("`{ FOO=bar; inner; } && cmd` — inner + cmd both see FOO", () => {
			const ordered = envByOrder("{ FOO=bar; inner; } && cmd");
			const inner = ordered.find(([n]) => n === "inner");
			const cmd = ordered.find(([n]) => n === "cmd");
			assert.ok(inner && cmd);
			assert.equal(inner[1].get("FOO"), "bar");
			assert.equal(cmd[1].get("FOO"), "bar");
		});
	});

	describe("initial seeding", () => {
		const ORIG = { HOME: process.env["HOME"], USER: process.env["USER"], PWD: process.env["PWD"] };

		beforeEach(() => {
			process.env["HOME"] = "/tmp/home";
			process.env["USER"] = "alice";
			process.env["PWD"] = "/tmp/pwd";
		});
		afterEach(() => {
			for (const k of ["HOME", "USER", "PWD"] as const) {
				if (ORIG[k] === undefined) delete process.env[k];
				else process.env[k] = ORIG[k];
			}
		});

		it("envTracker.initial captures HOME/USER/PWD from process.env at module load", () => {
			// The tracker was created at module load — before we mutated
			// process.env in beforeEach. So we assert against ORIG (the
			// values captured at file import): if any of HOME/USER/PWD
			// was set at import time, the module-load seed must have
			// captured at least one of them. If none was set, we fall
			// back to a shape check (defensive, empty-env case).
			//
			// This replaces a prior assertion that only checked
			// `typeof initial.get === "function"` — true for any Map,
			// so a regression in seedFromProcessEnv that returned an
			// empty map would have stayed green.
			const initial = envTracker.initial;
			assert.ok(initial instanceof Map, "initial must be a Map");

			const any = ORIG.HOME ?? ORIG.USER ?? ORIG.PWD;
			if (any === undefined) {
				// No env vars set at import time; seeding produced an empty
				// map. Accept either size:0 or the shape-only assertion.
				return;
			}

			const seeded =
				(ORIG.HOME !== undefined && initial.get("HOME") === ORIG.HOME) ||
				(ORIG.USER !== undefined && initial.get("USER") === ORIG.USER) ||
				(ORIG.PWD !== undefined && initial.get("PWD") === ORIG.PWD);
			assert.ok(
				seeded,
				"at least one of HOME/USER/PWD must match process.env as captured at module load",
			);
		});

		it("explicit initial overrides the default: walk with a seeded env", () => {
			const env = finalEnv("cmd", new Map([["WS", "/workspace"]]));
			assert.equal(env.get("WS"), "/workspace");
		});

		it("explicit initial with `unset` removes the seeded entry", () => {
			const env = finalEnv(
				"unset WS; cmd",
				new Map([["WS", "/workspace"]]),
			);
			assert.equal(env.has("WS"), false);
		});
	});

	describe("control flow (conservative merge)", () => {
		// The walker's `mergeBranches` uses `===` (reference equality) to
		// decide when branches "agree" on a value. String-valued trackers
		// (cwd) benefit: two branches that assign the same literal path
		// produce the same string, agreement propagates. Map-valued
		// trackers (env) fall back: two branches that assign the same
		// FOO=a produce different Map instances, so agreement never holds
		// structurally. This is the safe default for guardrails —
		// conservative fallback to the pre-construct env — but it does
		// mean `if ...; then FOO=a; else FOO=a; fi; cmd` does NOT leak
		// FOO=a out of the if.
		//
		// Tighter merging (structural equality per tracker) is a v0.2+
		// follow-up. Until then, rule authors who need env post-if should
		// lift the assignment out of the branches.

		it("if/else branches that agree on an env: `if ...; then FOO=a; else FOO=a; fi; cmd` — fallback (conservative)", () => {
			const env = finalEnv(
				"if test -f x; then FOO=a; else FOO=a; fi; cmd",
			);
			assert.equal(
				env.has("FOO"),
				false,
				"Map reference inequality triggers the conservative pre-if fallback",
			);
		});

		it("if/else branches that disagree: `if ...; then FOO=a; else FOO=b; fi; cmd`", () => {
			const env = finalEnv(
				"if test -f x; then FOO=a; else FOO=b; fi; cmd",
			);
			assert.equal(env.has("FOO"), false);
		});

		it("while loop: `while ...; do FOO=bar; done; cmd` — body may not iterate", () => {
			const env = finalEnv("while true; do FOO=bar; done; cmd");
			assert.equal(env.has("FOO"), false);
		});
	});
});

// SPDX-License-Identifier: MIT
// Tests for the built-in `cwd` tracker. Part of unbash-walker.
//
// These tests exercise `cwdTracker` through the generalized `walk` API
// and cover every scenario previously pinned by `effective-cwd.test.ts`
// and `cwd-override-flags.test.ts`. The public surface changed (the
// walker is now generic); the observable behavior is preserved.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { parse as parseBash } from "unbash";
import { extractAllCommandsFromAST } from "../extract.ts";
import { getBasename, getCommandArgs } from "../resolve.ts";
import { walk } from "../tracker.ts";
import { expandWrapperCommands } from "../wrappers.ts";
import { cwdTracker } from "./cwd.ts";

// --------------------------------------------------------------------------
// Helpers that wrap `walk` so each test reads like the original
// effectiveCwd-based tests — the only difference is we reach into the
// returned WalkResult to pluck the `.cwd` field.
// --------------------------------------------------------------------------

/** Walk `raw` with the built-in cwd tracker seeded at `initial`. */
function walkCwd(raw: string, initial: string) {
	const ast = parseBash(raw);
	return walk(ast, { cwd: initial }, { cwd: cwdTracker });
}

/** Map "name" → cwd for easier assertions; first occurrence wins on dupes. */
function cwdByName(raw: string, initial: string): Record<string, string> {
	const map = walkCwd(raw, initial);
	const out: Record<string, string> = {};
	for (const [ref, snap] of map) {
		const name = getBasename(ref);
		if (!(name in out)) out[name] = snap.cwd;
	}
	return out;
}

/** Return an ordered list of [name, cwd] tuples — preserves duplicates. */
function cwdByOrder(raw: string, initial: string): Array<[string, string]> {
	const map = walkCwd(raw, initial);
	return Array.from(map, ([ref, snap]) => [getBasename(ref), snap.cwd]);
}

// --------------------------------------------------------------------------
// Tests ported from effective-cwd.test.ts — behavior must be preserved.
// --------------------------------------------------------------------------

describe("cwdTracker via walk", () => {
	const ORIG_HOME = process.env["HOME"];
	beforeEach(() => {
		process.env["HOME"] = "/home/me";
	});
	afterEach(() => {
		if (ORIG_HOME === undefined) delete process.env["HOME"];
		else process.env["HOME"] = ORIG_HOME;
	});

	it("baseline: every command sees the initial cwd when there is no cd", () => {
		const cwds = cwdByName("echo hi && ls -la | wc -l", "/start");
		assert.equal(cwds["echo"], "/start");
		assert.equal(cwds["ls"], "/start");
		assert.equal(cwds["wc"], "/start");
	});

	it("`cd A && cmd` — cmd sees A", () => {
		const cwds = cwdByName("cd /x && cmd", "/start");
		assert.equal(cwds["cmd"], "/x");
	});

	it("`cd A; cd B; cmd` — cmd sees B", () => {
		const cwds = cwdByName("cd /x; cd /y; cmd", "/start");
		assert.equal(cwds["cmd"], "/y");
	});

	it("cmd1 sees A and cmd2 sees B in `cd A && cmd1 && cd B && cmd2`", () => {
		const ordered = cwdByOrder(
			"cd /x && cmd1 && cd /y && cmd2",
			"/start",
		);
		assert.equal(ordered[0]?.[0], "cd");
		assert.equal(ordered[0]?.[1], "/start");
		assert.equal(ordered[1]?.[0], "cmd1");
		assert.equal(ordered[1]?.[1], "/x");
		assert.equal(ordered[2]?.[0], "cd");
		assert.equal(ordered[2]?.[1], "/x");
		assert.equal(ordered[3]?.[0], "cmd2");
		assert.equal(ordered[3]?.[1], "/y");
	});

	it("relative cd joins onto current cwd", () => {
		const cwds = cwdByName("cd a && cd b && cmd", "/start");
		assert.equal(cwds["cmd"], "/start/a/b");
	});

	it("`cd ~` expands via process.env.HOME", () => {
		const cwds = cwdByName("cd ~ && cmd", "/start");
		assert.equal(cwds["cmd"], "/home/me");
	});

	it("`cd ~/repo` joins onto HOME", () => {
		const cwds = cwdByName("cd ~/projects/app && cmd", "/start");
		assert.equal(cwds["cmd"], "/home/me/projects/app");
	});

	it("`cd -` is treated as a no-op (OLDPWD not tracked)", () => {
		const cwds = cwdByName("cd /x && cd - && cmd", "/start");
		assert.equal(cwds["cmd"], "/x");
	});

	it("subshell isolation: `(cd A && x) && y` — x sees A, y sees initial", () => {
		const ordered = cwdByOrder("(cd /x && inner) && outer", "/start");
		const inner = ordered.find(([n]) => n === "inner");
		const outer = ordered.find(([n]) => n === "outer");
		assert.equal(inner?.[1], "/x");
		assert.equal(outer?.[1], "/start");
	});

	it("brace-group propagation: `{ cd A; x; } && y` — both x and y see A", () => {
		const ordered = cwdByOrder(
			"{ cd /x; inner; } && outer",
			"/start",
		);
		const inner = ordered.find(([n]) => n === "inner");
		const outer = ordered.find(([n]) => n === "outer");
		assert.equal(inner?.[1], "/x");
		assert.equal(outer?.[1], "/x");
	});

	it("pipeline isolation: `cd A | x` — x sees initial", () => {
		const cwds = cwdByName("cd /x | echo hi", "/start");
		assert.equal(cwds["echo"], "/start");
	});

	it("pipeline isolation across peers: `x | cd A | y` — y sees initial", () => {
		const ordered = cwdByOrder("alpha | cd /x | beta", "/start");
		const alpha = ordered.find(([n]) => n === "alpha");
		const beta = ordered.find(([n]) => n === "beta");
		assert.equal(alpha?.[1], "/start");
		assert.equal(beta?.[1], "/start");
	});

	it("nested subshell inside AndOr: `cd A && cmd1 && (cd B && x) && cmd2`", () => {
		const ordered = cwdByOrder(
			"cd /x && cmd1 && (cd /y && inner) && cmd2",
			"/start",
		);
		const cmd1 = ordered.find(([n]) => n === "cmd1");
		const inner = ordered.find(([n]) => n === "inner");
		const cmd2 = ordered.find(([n]) => n === "cmd2");
		assert.equal(cmd1?.[1], "/x");
		assert.equal(inner?.[1], "/y");
		assert.equal(cmd2?.[1], "/x", "cd in subshell must not leak out");
	});

	it("records the `cd` command's own cwd as the cwd BEFORE the cd takes effect", () => {
		const ordered = cwdByOrder(
			"cd /x && cd /y && cmd",
			"/start",
		);
		// first cd: /start, second cd: /x, cmd: /y
		assert.equal(ordered[0]?.[1], "/start");
		assert.equal(ordered[1]?.[1], "/x");
		assert.equal(ordered[2]?.[1], "/y");
	});

	it("`cd` with no args goes to HOME", () => {
		const cwds = cwdByName("cd && cmd", "/start");
		assert.equal(cwds["cmd"], "/home/me");
	});

	it("returned map exposes a CommandRef-keyed view of every extracted command", () => {
		const raw = "a && b | c";
		const ast = parseBash(raw);
		const map = walk(ast, { cwd: "/start" }, { cwd: cwdTracker });
		for (const [ref, snap] of map) {
			assert.ok(ref.node, "CommandRef must carry its AST node");
			assert.equal(typeof ref.group, "number");
			assert.equal(typeof snap.cwd, "string");
		}
		const names = Array.from(map.keys()).map((r) => getBasename(r));
		assert.deepEqual(names, ["a", "b", "c"]);
	});

	describe("caller-supplied refs[]", () => {
		it("when refs are passed, the returned Map's keys ARE those refs (===)", () => {
			const raw = "cd /x && cmd1 && cd /y && cmd2";
			const ast = parseBash(raw);
			const externalRefs = extractAllCommandsFromAST(ast, raw);
			const map = walk(
				ast,
				{ cwd: "/start" },
				{ cwd: cwdTracker },
				externalRefs,
			);

			const mapKeys = Array.from(map.keys());
			assert.equal(
				mapKeys.length,
				externalRefs.length,
				"every external ref should appear in the result map",
			);
			for (const ref of externalRefs) {
				assert.ok(
					mapKeys.includes(ref),
					`external ref for ${getBasename(ref)} must be a key by identity`,
				);
			}
		});

		it("when refs are passed, values are correct per external ref", () => {
			const raw = "cd /x && cmd1 && cd /y && cmd2";
			const ast = parseBash(raw);
			const externalRefs = extractAllCommandsFromAST(ast, raw);
			const map = walk(
				ast,
				{ cwd: "/start" },
				{ cwd: cwdTracker },
				externalRefs,
			);

			const byName = new Map<string, string>();
			for (const ref of externalRefs) {
				const snap = map.get(ref);
				assert.ok(snap !== undefined, `${getBasename(ref)} should have a snapshot`);
				byName.set(getBasename(ref), snap.cwd);
			}
			assert.equal(byName.get("cmd1"), "/x");
			assert.equal(byName.get("cmd2"), "/y");
		});

		it("omitting refs preserves pre-existing behavior (fresh refs as keys)", () => {
			const raw = "cd /x && cmd";
			const ast = parseBash(raw);
			const externalRefs = extractAllCommandsFromAST(ast, raw);
			const map = walk(ast, { cwd: "/start" }, { cwd: cwdTracker });

			// Keys are NOT the external refs (different extraction), but they
			// share the underlying Command nodes.
			const mapKeys = Array.from(map.keys());
			for (const ref of externalRefs) {
				assert.ok(
					!mapKeys.includes(ref),
					"without passing refs, external refs should NOT be identity keys",
				);
			}
			const nodesInMap = mapKeys.map((r) => r.node);
			for (const ref of externalRefs) {
				assert.ok(
					nodesInMap.includes(ref.node),
					"but the underlying AST nodes should be shared",
				);
			}
		});
	});

	describe("unresolvable cd targets", () => {
		it("`cd $VAR && cmd` — cmd sees initial cwd (parameter expansion)", () => {
			const cwds = cwdByName("cd $VAR && cmd", "/start");
			assert.equal(cwds["cmd"], "/start");
			assert.notStrictEqual(
				cwds["cmd"],
				cwdTracker.unknown,
				"Phase 1 preserves prior behavior: cd with dynamic target keeps current cwd, does NOT emit unknown sentinel. Phase 2 flips this simultaneously with onUnknown:block predicate default.",
			);
		});

		it('`cd "$HOME/x" && cmd` — cmd sees initial cwd (double-quoted expansion)', () => {
			const cwds = cwdByName('cd "$HOME/x" && cmd', "/start");
			assert.equal(cwds["cmd"], "/start");
		});

		it("`cd 'literal-with-$VAR' && cmd` — single-quoted is statically resolvable", () => {
			const cwds = cwdByName("cd 'literal-with-$VAR' && cmd", "/start");
			assert.equal(cwds["cmd"], "/start/literal-with-$VAR");
		});

		it("`cd $(pwd) && cmd` — cmd sees initial cwd (command substitution)", () => {
			const cwds = cwdByName("cd $(pwd) && cmd", "/start");
			assert.equal(cwds["cmd"], "/start");
		});

		it("the unresolvable `cd` itself is still recorded at the pre-cd cwd", () => {
			const ordered = cwdByOrder("cd $VAR && cmd", "/start");
			const cd = ordered.find(([n]) => n === "cd");
			assert.equal(cd?.[1], "/start");
		});
	});

	describe("control-flow branch merge", () => {
		it("`if ...; then cd /a; else cd /b; fi; cmd` — branches disagree → cmd sees initial cwd", () => {
			const cwds = cwdByName(
				"if test -f x; then cd /a; else cd /b; fi; cmd",
				"/start",
			);
			assert.equal(cwds["cmd"], "/start");
		});

		it("`if ...; then cd /a; else cd /a; fi; cmd` — branches agree → cmd sees /a", () => {
			const cwds = cwdByName(
				"if test -f x; then cd /a; else cd /a; fi; cmd",
				"/start",
			);
			assert.equal(cwds["cmd"], "/a");
		});

		it("`if ...; then cd /a; fi; cmd` (no else) — branches disagree → cmd sees initial cwd", () => {
			const cwds = cwdByName(
				"if test -f x; then cd /a; fi; cmd",
				"/start",
			);
			assert.equal(cwds["cmd"], "/start");
		});

		it("`while true; do cd /loop; done; cmd` — loop may not have run → cmd sees initial cwd", () => {
			const cwds = cwdByName(
				"while true; do cd /loop; done; cmd",
				"/start",
			);
			assert.equal(cwds["cmd"], "/start");
		});

		it("`for i in a b; do cd /loop; done; cmd` — body may not iterate → cmd sees initial cwd", () => {
			const cwds = cwdByName(
				"for i in a b; do cd /loop; done; cmd",
				"/start",
			);
			assert.equal(cwds["cmd"], "/start");
		});

		it("`case $x in a) cd /a ;; b) cd /a ;; esac; cmd` — items agree → cmd sees /a", () => {
			const cwds = cwdByName(
				"case $x in a) cd /a ;; b) cd /a ;; esac; cmd",
				"/start",
			);
			assert.equal(cwds["cmd"], "/a");
		});

		it("`case $x in a) cd /a ;; b) cd /b ;; esac; cmd` — items disagree → cmd sees initial cwd", () => {
			const cwds = cwdByName(
				"case $x in a) cd /a ;; b) cd /b ;; esac; cmd",
				"/start",
			);
			assert.equal(cwds["cmd"], "/start");
		});

		it("commands INSIDE an if branch still see their branch's cwd", () => {
			const ordered = cwdByOrder(
				"if test -f x; then cd /a && inner1; else cd /b && inner2; fi; cmd",
				"/start",
			);
			const inner1 = ordered.find(([n]) => n === "inner1");
			const inner2 = ordered.find(([n]) => n === "inner2");
			const cmd = ordered.find(([n]) => n === "cmd");
			assert.equal(inner1?.[1], "/a", "inner1 runs after cd /a in then-branch");
			assert.equal(inner2?.[1], "/b", "inner2 runs after cd /b in else-branch");
			assert.equal(cmd?.[1], "/start", "branches disagree → cmd sees pre-if cwd");
		});
	});

	describe("background & (documented over-match)", () => {
		it("`cd /x & cmd` — cmd sees /x (we treat & like ;)", () => {
			// In real bash, `cd /x &` runs cd in a backgrounded subshell. The
			// walker does NOT isolate backgrounded commands — documented
			// over-match, safer for guardrails.
			const cwds = cwdByName("cd /x & cmd", "/start");
			assert.equal(cwds["cmd"], "/x");
		});
	});

	describe("external / out-of-scope constructs (documented over-match)", () => {
		it("subshell isolation (reconfirm): `(cd /A && x) && y` — x sees /A, y sees initial", () => {
			const ordered = cwdByOrder("(cd /A && x) && y", "/start");
			const inner = ordered.find(([n]) => n === "x");
			const outer = ordered.find(([n]) => n === "y");
			assert.equal(inner?.[1], "/A");
			assert.equal(outer?.[1], "/start");
		});

		it("heredoc body (reconfirm): `cat <<EOF ... EOF\\ny` — `cd` inside the heredoc is DATA, y sees initial", () => {
			const cwds = cwdByName("cat <<EOF\ncd /A\nEOF\ny", "/start");
			assert.equal(cwds["y"], "/start");
			assert.equal(cwds["cd"], undefined, "cd inside heredoc body is not extracted at all");
		});

		it("pushd: `pushd /A && y` — we don't model the directory stack, y sees initial", () => {
			const cwds = cwdByName("pushd /A && y", "/start");
			assert.equal(cwds["y"], "/start", "y sees initial cwd; pushd is not modelled");
			assert.equal(cwds["pushd"], "/start");
		});

		it("env -C: `env -C /A y` — env records at /A; wrapper-expanded y still falls back", () => {
			// The env ref's recorded cwd is /A (per-command override). Wrapper-
			// expanded inner refs (the surfaced `y`) still have no Map entry —
			// wrapper expansion + cwd-override interaction remains a follow-up.
			const src = "env -C /A y";
			const script = parseBash(src);
			const refs = extractAllCommandsFromAST(script, src);
			const { commands } = expandWrapperCommands(refs);
			const map = walk(script, { cwd: "/start" }, { cwd: cwdTracker }, commands);

			const env = commands.find((c) => getBasename(c) === "env");
			const y = commands.find((c) => getBasename(c) === "y");
			assert.ok(env, "env ref present");
			assert.ok(y, "y ref surfaces via wrapper expansion");
			assert.equal(map.get(env)?.cwd, "/A", "env records at /A via -C override");
			assert.equal(
				map.get(y),
				undefined,
				"wrapper-expanded y has no Map entry → consumer falls back to sessionCwd (follow-up)",
			);
			assert.deepEqual(
				getCommandArgs(env),
				["-C", "/A", "y"],
				"env's args are preserved so guardrails can also write a raw-pattern rule if they want",
			);
		});

		it("eval: `eval \"cd /A && y\"` — the string arg is opaque, y is invisible to the walker", () => {
			const src = `eval "cd /A && y"`;
			const script = parseBash(src);
			const refs = extractAllCommandsFromAST(script, src);
			const { commands } = expandWrapperCommands(refs);
			const map = walk(script, { cwd: "/start" }, { cwd: cwdTracker }, commands);

			const names = commands.map(getBasename);
			assert.deepEqual(names, ["eval"], "only eval extracted; y is invisible");
			assert.equal(map.get(commands[0]!)?.cwd, "/start");
		});

		it("source: `source script.sh` — the sourced file is opaque; source is extracted as a normal command", () => {
			const cwds = cwdByName("source script.sh && y", "/start");
			assert.equal(cwds["source"], "/start");
			assert.equal(cwds["y"], "/start", "y sees pre-source cwd; foo.sh's cd effect is opaque");
		});

		it("dot-source: `. script.sh` — same opacity as `source`", () => {
			const cwds = cwdByName(". script.sh && y", "/start");
			assert.equal(cwds["y"], "/start");
		});
	});

	describe("per-command cwd overrides (`git -C`, `make -C`, `env -C`)", () => {
		it("git -C: `git -C /x push` records push's cwd as /x; no propagation", () => {
			const ordered = cwdByOrder("git -C /x push && ls", "/start");
			assert.equal(ordered[0]?.[0], "git");
			assert.equal(ordered[0]?.[1], "/x", "git records at /x");
			assert.equal(ordered[1]?.[0], "ls");
			assert.equal(ordered[1]?.[1], "/start", "ls after git -C: cwd did NOT propagate");
		});

		it("git -C relative path joins onto shell cwd", () => {
			const cwds = cwdByName("git -C sub push", "/start");
			assert.equal(cwds["git"], "/start/sub");
		});

		it("git -C composition: `git -C /a -C b push` records at /a/b", () => {
			const cwds = cwdByName("git -C /a -C b push", "/start");
			assert.equal(cwds["git"], "/a/b");
		});

		it("cd then git -C: override wins over shell cd for that command", () => {
			const ordered = cwdByOrder("cd /Y && git -C /x push && ls", "/start");
			const git = ordered.find(([n]) => n === "git");
			const ls = ordered.find(([n]) => n === "ls");
			assert.equal(git?.[1], "/x", "git's -C overrides the shell cwd from cd");
			assert.equal(ls?.[1], "/Y", "ls sees the cd target; git's -C didn't propagate");
		});

		it("git -C with non-static target: stops propagating, records at shell cwd", () => {
			const cwds = cwdByName("cd /Y && git -C $VAR push", "/start");
			assert.equal(cwds["git"], "/Y", "conservative fallback to the shell cwd when -C is dynamic");
		});

		it("subshell isolation + git -C: `(cd /A && git -C /x push)` records at /x", () => {
			const cwds = cwdByName("(cd /A && git -C /x push) && ls", "/start");
			assert.equal(cwds["git"], "/x", "git's -C wins inside the subshell");
			assert.equal(cwds["ls"], "/start", "subshell isolation means ls sees the outer cwd");
		});

		it("git push -C /x: -C after subcommand is NOT a global flag, no override", () => {
			const cwds = cwdByName("git push -C /x", "/start");
			assert.equal(cwds["git"], "/start", "-C after subcommand is not the global git flag");
		});

		it("make -C: `make -C /x all` records at /x", () => {
			const cwds = cwdByName("make -C /x all", "/start");
			assert.equal(cwds["make"], "/x");
		});

		it("make -C: order-agnostic, `make all -C /x` still records at /x", () => {
			const cwds = cwdByName("make all -C /x", "/start");
			assert.equal(cwds["make"], "/x");
		});

		it("env -C: `env -C /A cmd` records env's cwd at /A", () => {
			const cwds = cwdByName("env -C /A cmd", "/start");
			assert.equal(cwds["env"], "/A");
		});

		it("absolute path via full command path: `/usr/bin/git -C /x push` still recognized", () => {
			const cwds = cwdByName("/usr/bin/git -C /x push", "/start");
			assert.equal(cwds["git"], "/x");
		});
	});
});

// --------------------------------------------------------------------------
// Tests ported from cwd-override-flags.test.ts — unit-level coverage of the
// git/make/env per-command resolvers. We now exercise them through `walk`
// so the tests pin the SAME behavior via the public API.
// --------------------------------------------------------------------------

/** Exercise a single one-command script through `walk` and return the
 *  recorded cwd for that command. */
function singleCmdCwd(cmd: string, initial: string): string {
	const ast = parseBash(cmd);
	const map = walk(ast, { cwd: initial }, { cwd: cwdTracker });
	const first = Array.from(map.values())[0];
	if (!first) throw new Error(`no command extracted from: ${cmd}`);
	return first.cwd;
}

describe("cwdTracker per-command modifiers (via walk)", () => {
	const ORIG_HOME = process.env["HOME"];
	beforeEach(() => {
		process.env["HOME"] = "/home/me";
	});
	afterEach(() => {
		if (ORIG_HOME === undefined) delete process.env["HOME"];
		else process.env["HOME"] = ORIG_HOME;
	});

	describe("git", () => {
		it("no -C: returns baseCwd unchanged", () => {
			assert.equal(singleCmdCwd("git push origin main", "/start"), "/start");
		});

		it("-C with absolute path: replaces baseCwd", () => {
			assert.equal(singleCmdCwd("git -C /x push", "/start"), "/x");
		});

		it("-C with relative path: joins onto baseCwd", () => {
			assert.equal(singleCmdCwd("git -C sub push", "/start"), "/start/sub");
		});

		it("multiple -C compose left-to-right: -C /a -C b → /a/b", () => {
			assert.equal(singleCmdCwd("git -C /a -C b push", "/start"), "/a/b");
		});

		it("multiple -C all relative: base/a/b", () => {
			assert.equal(singleCmdCwd("git -C a -C b push", "/start"), "/start/a/b");
		});

		it("-C after subcommand: ignored (not a git flag there)", () => {
			assert.equal(singleCmdCwd("git push -C /x", "/start"), "/start");
		});

		it("-C before other pre-subcommand flag, then subcommand", () => {
			assert.equal(
				singleCmdCwd("git -C /x --no-pager push", "/start"),
				"/x",
			);
		});

		it("-c key=val skipped; -C still recognized", () => {
			assert.equal(
				singleCmdCwd("git -c color.ui=never -C /x push", "/start"),
				"/x",
			);
		});

		it("-C with non-static target: stops propagating, returns best prefix", () => {
			assert.equal(singleCmdCwd("git -C $HOME push", "/start"), "/start");
		});

		it("-C with non-static AFTER a static -C: keeps static prefix", () => {
			assert.equal(
				singleCmdCwd("git -C /a -C $VAR push", "/start"),
				"/a",
			);
		});

		it("trailing -C with no argument: malformed, returns baseCwd", () => {
			assert.equal(singleCmdCwd("git -C", "/start"), "/start");
		});

		it("subcommand with no pre-flags: returns baseCwd", () => {
			assert.equal(singleCmdCwd("git status", "/start"), "/start");
		});
	});

	describe("make", () => {
		it("no -C: returns baseCwd", () => {
			assert.equal(singleCmdCwd("make all", "/start"), "/start");
		});

		it("-C DIR: replaces baseCwd", () => {
			assert.equal(singleCmdCwd("make -C /x all", "/start"), "/x");
		});

		it("-C and target order-agnostic: `make all -C /x` still resolves", () => {
			assert.equal(singleCmdCwd("make all -C /x", "/start"), "/x");
		});

		it("repeatable -C: composes left-to-right", () => {
			assert.equal(singleCmdCwd("make -C /a -C b all", "/start"), "/a/b");
		});

		it("-f FILE skipped; does not confuse -C scan", () => {
			assert.equal(
				singleCmdCwd("make -f Makefile.dev -C /x all", "/start"),
				"/x",
			);
		});
	});

	describe("env", () => {
		it("no -C: returns baseCwd", () => {
			assert.equal(singleCmdCwd("env cmd", "/start"), "/start");
		});

		it("-C DIR cmd: replaces baseCwd", () => {
			assert.equal(singleCmdCwd("env -C /x cmd", "/start"), "/x");
		});

		it("stops at first assignment: `env -C /x VAR=val cmd`", () => {
			assert.equal(singleCmdCwd("env -C /x VAR=val cmd", "/start"), "/x");
		});

		it("stops at cmd name (non-flag): `env -u X -C /y cmd -C /z`", () => {
			assert.equal(
				singleCmdCwd("env -u X -C /y cmd -C /z", "/start"),
				"/y",
			);
		});

		it("-- terminates options", () => {
			assert.equal(singleCmdCwd("env -- cmd -C /z", "/start"), "/start");
		});
	});
});

// SPDX-License-Identifier: MIT
// Effective-cwd walker tests. Part of unbash-walker.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { parse as parseBash } from "unbash";
import { effectiveCwd } from "./effective-cwd.ts";
import { extractAllCommandsFromAST } from "./extract.ts";
import { expandWrapperCommands } from "./wrappers.ts";
import { getBasename, getCommandArgs } from "./resolve.ts";

/** Map "name" → cwd for easier assertions; if the same name appears twice,
 *  returns the first occurrence. Use `cwdByOrder` for scripts with repeats. */
function cwdByName(raw: string, initial: string): Record<string, string> {
	const ast = parseBash(raw);
	const map = effectiveCwd(ast, initial);
	const out: Record<string, string> = {};
	for (const [ref, cwd] of map) {
		const name = getBasename(ref);
		if (!(name in out)) out[name] = cwd;
	}
	return out;
}

/** Return an ordered list of [name, cwd] tuples — preserves duplicates. */
function cwdByOrder(raw: string, initial: string): Array<[string, string]> {
	const ast = parseBash(raw);
	const map = effectiveCwd(ast, initial);
	return Array.from(map, ([ref, cwd]) => [getBasename(ref), cwd]);
}

describe("effectiveCwd", () => {
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
		// Order: cd, cmd1, cd, cmd2
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
		const map = effectiveCwd(ast, "/start");
		// Every key is a CommandRef (has .node, .source, .group).
		for (const [ref, cwd] of map) {
			assert.ok(ref.node, "CommandRef must carry its AST node");
			assert.equal(typeof ref.group, "number");
			assert.equal(typeof cwd, "string");
		}
		const names = Array.from(map.keys()).map((r) => getBasename(r));
		assert.deepEqual(names, ["a", "b", "c"]);
	});

	describe("caller-supplied refs[]", () => {
		it("when refs are passed, the returned Map's keys ARE those refs (===)", () => {
			const raw = "cd /x && cmd1 && cd /y && cmd2";
			const ast = parseBash(raw);
			const externalRefs = extractAllCommandsFromAST(ast, raw);
			const map = effectiveCwd(ast, "/start", externalRefs);

			const mapKeys = Array.from(map.keys());
			assert.equal(
				mapKeys.length,
				externalRefs.length,
				"every external ref should appear in the cwd map",
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
			const map = effectiveCwd(ast, "/start", externalRefs);

			const byName = new Map<string, string>();
			for (const ref of externalRefs) {
				const cwd = map.get(ref);
				assert.ok(cwd !== undefined, `${getBasename(ref)} should have a cwd`);
				byName.set(getBasename(ref), cwd);
			}
			assert.equal(byName.get("cmd1"), "/x");
			assert.equal(byName.get("cmd2"), "/y");
		});

		it("omitting refs preserves pre-existing behavior (fresh refs as keys)", () => {
			const raw = "cd /x && cmd";
			const ast = parseBash(raw);
			const externalRefs = extractAllCommandsFromAST(ast, raw);
			const map = effectiveCwd(ast, "/start");

			// Map keys are NOT the external refs (different extraction), but they
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
			// Implicit else is "no-op" = post-clause cwd. Then-branch cwd = /a;
			// they disagree; cmd must see the initial cwd.
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
			// In real bash, `cd /x &` runs cd in a backgrounded subshell; cmd
			// sees the initial cwd. Our walker does NOT isolate backgrounded
			// commands — it threads cd effects through & the same way it does
			// through `;`. This is a documented over-match (safer failure mode
			// for a guardrail: report /x for cmd even though cmd won't actually
			// run there, triggering a more conservative when.cwd check).
			//
			// This test pins the current behavior. If semantics ever change to
			// model background as subshell-like isolation, update this test and
			// the 'Not modelled' list in effective-cwd.ts at the same time.
			const cwds = cwdByName("cd /x & cmd", "/start");
			assert.equal(cwds["cmd"], "/x");
		});
	});

	// Pin the walker's behavior for bash constructs that are out-of-scope by
	// design. Each of these is a "conservative over-match": the walker prefers
	// reporting the pre-construct cwd (or surfacing the inner command under
	// fallback-to-session-cwd at the consumer layer) over silently tracking a
	// cwd change that might be wrong at runtime. A guardrail built on top
	// fires `when.cwd` checks more aggressively rather than less.
	describe("external / out-of-scope constructs (documented over-match)", () => {
		it("subshell isolation (reconfirm): `(cd /A && x) && y` — x sees /A, y sees initial", () => {
			// Already covered above; re-pinned here as part of the explicit
			// edge-case coverage story we hand reviewers. Subshells are the
			// one construct we DO model fully (via `Subshell` AST nodes),
			// because unbash surfaces them as a dedicated node type. Other
			// entries in this describe are the cases we deliberately don't
			// model.
			const ordered = cwdByOrder("(cd /A && x) && y", "/start");
			const inner = ordered.find(([n]) => n === "x");
			const outer = ordered.find(([n]) => n === "y");
			assert.equal(inner?.[1], "/A");
			assert.equal(outer?.[1], "/start");
		});

		it("heredoc body (reconfirm): `cat <<EOF ... EOF\\ny` — `cd` inside the heredoc is DATA, y sees initial", () => {
			// unbash represents the heredoc body as a redirect payload attached
			// to `cat`, not as executable commands. That means the `cd /A`
			// inside the body never reaches extract/walker — y correctly sees
			// the initial cwd. This is the correct behavior, not over-match:
			// the heredoc body in real bash is stdin for `cat`, not commands
			// to execute. Adversarial-matrix case 20 covers the extract side;
			// this pins the effective-cwd side.
			const cwds = cwdByName("cat <<EOF\ncd /A\nEOF\ny", "/start");
			assert.equal(cwds["y"], "/start");
			assert.equal(cwds["cd"], undefined, "cd inside heredoc body is not extracted at all");
		});

		it("pushd: `pushd /A && y` — we don't model the directory stack, y sees initial", () => {
			// Real bash would push /A onto the stack and y would run under /A.
			// We treat pushd as any other command — it's extracted with args
			// [/A] but doesn't mutate the walker's cwd state. Guardrails that
			// want to cover pushd/popd should add explicit rules against the
			// commands themselves rather than relying on when.cwd.
			const cwds = cwdByName("pushd /A && y", "/start");
			assert.equal(cwds["y"], "/start", "y sees initial cwd; pushd is not modelled");
			assert.equal(cwds["pushd"], "/start");
		});

		it("env -C: `env -C /A y` — inner y surfaces via wrapper expansion; walker falls back to session cwd", () => {
			// env is a known wrapper, so expandWrapperCommands surfaces `y` as
			// a separate CommandRef. But we don't interpret env's `-C DIR`
			// flag — that target never reaches the walker, and the surfaced
			// `y` ref doesn't exist in the original Script, so the
			// effectiveCwd Map has no entry for it. The steering engine falls
			// back to `sessionCwd` for refs without a Map entry (see
			// index.ts's `cwdMap.get(ref) ?? sessionCwd`), which is the
			// conservative choice: y is matched under the session's cwd, not
			// the runtime `-C` target.
			const src = "env -C /A y";
			const script = parseBash(src);
			const refs = extractAllCommandsFromAST(script, src);
			const { commands } = expandWrapperCommands(refs);
			const cwds = effectiveCwd(script, "/start", commands);

			const env = commands.find((c) => getBasename(c) === "env");
			const y = commands.find((c) => getBasename(c) === "y");
			assert.ok(env, "env ref present");
			assert.ok(y, "y ref surfaces via wrapper expansion");
			assert.equal(cwds.get(env), "/start", "env sees pre-command cwd");
			assert.equal(
				cwds.get(y),
				undefined,
				"wrapper-expanded y has no Map entry → consumer falls back to sessionCwd",
			);
			assert.deepEqual(
				getCommandArgs(env),
				["-C", "/A", "y"],
				"env's args are preserved so guardrails that want to catch `env -C` can write a pattern against the env ref",
			);
		});

		it("eval: `eval \"cd /A && y\"` — the string arg is opaque, y is invisible to the walker", () => {
			// eval's argument is a string literal; we don't recursively re-parse
			// the string as bash. Only `eval` itself is extracted — y never
			// surfaces as a CommandRef. Guardrails that want to catch what eval
			// might run must either match the eval string pattern directly
			// (e.g. `^eval\b.*git\s+push`) or block eval outright.
			const src = `eval "cd /A && y"`;
			const script = parseBash(src);
			const refs = extractAllCommandsFromAST(script, src);
			const { commands } = expandWrapperCommands(refs);
			const cwds = effectiveCwd(script, "/start", commands);

			const names = commands.map(getBasename);
			assert.deepEqual(names, ["eval"], "only eval extracted; y is invisible");
			assert.equal(cwds.get(commands[0]!), "/start");
		});

		it("source: `source script.sh` — the sourced file is opaque; source is extracted as a normal command", () => {
			// We never read external files. `source foo.sh` is extracted as a
			// command with basename `source` and args [foo.sh]; whatever foo.sh
			// would do to cwd at runtime is invisible. Subsequent commands in
			// the same script see the pre-source cwd. Guardrails treating
			// `source`/`.` as equivalent to arbitrary command execution should
			// block them outright at the command level.
			const cwds = cwdByName("source script.sh && y", "/start");
			assert.equal(cwds["source"], "/start");
			assert.equal(cwds["y"], "/start", "y sees pre-source cwd; foo.sh's cd effect is opaque");
		});

		it("dot-source: `. script.sh` — same opacity as `source`", () => {
			// POSIX spelling of `source`. Same story: the sourced file is data
			// from our perspective.
			const cwds = cwdByName(". script.sh && y", "/start");
			assert.equal(cwds["y"], "/start");
		});
	});
});

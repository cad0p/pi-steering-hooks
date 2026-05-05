// SPDX-License-Identifier: MIT
// Effective-cwd walker tests. Part of unbash-walker.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { parse as parseBash } from "unbash";
import { effectiveCwd } from "./effective-cwd.ts";
import { getBasename } from "./resolve.ts";

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
});

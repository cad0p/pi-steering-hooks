// SPDX-License-Identifier: MIT
// Unit tests for cwd-override-flags. Part of unbash-walker.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { parse as parseBash } from "unbash";
import { CWD_OVERRIDE_FLAGS } from "./cwd-override-flags.ts";

/** Parse a single command line and return its suffix Word[] for handing
 *  to the resolvers. The first element of the Script is a Statement whose
 *  command is the Command we want. */
function suffixOf(cmd: string): readonly any[] {
	const ast = parseBash(cmd);
	const stmt = ast.commands[0];
	// Statement → command. Walk AndOr if present.
	let node: any = (stmt as any).command ?? stmt;
	if (node.type === "AndOr") node = node.commands[0];
	if (node.type === "Statement") node = node.command;
	if (node.type === "Pipeline") node = node.commands[0];
	if (node.type !== "Command") {
		throw new Error(`Expected Command, got ${node.type}`);
	}
	return node.suffix;
}

describe("CWD_OVERRIDE_FLAGS", () => {
	const ORIG_HOME = process.env["HOME"];
	beforeEach(() => {
		process.env["HOME"] = "/home/me";
	});
	afterEach(() => {
		if (ORIG_HOME === undefined) delete process.env["HOME"];
		else process.env["HOME"] = ORIG_HOME;
	});

	describe("git", () => {
		const git = CWD_OVERRIDE_FLAGS["git"]!;

		it("no -C: returns baseCwd unchanged", () => {
			assert.equal(git(suffixOf("git push origin main"), "/start"), "/start");
		});

		it("-C with absolute path: replaces baseCwd", () => {
			assert.equal(git(suffixOf("git -C /x push"), "/start"), "/x");
		});

		it("-C with relative path: joins onto baseCwd", () => {
			assert.equal(git(suffixOf("git -C sub push"), "/start"), "/start/sub");
		});

		it("multiple -C compose left-to-right: -C /a -C b → /a/b", () => {
			assert.equal(git(suffixOf("git -C /a -C b push"), "/start"), "/a/b");
		});

		it("multiple -C all relative: base/a/b", () => {
			assert.equal(git(suffixOf("git -C a -C b push"), "/start"), "/start/a/b");
		});

		it("-C after subcommand: ignored (not a git flag there)", () => {
			// `git push -C /x` — -C is not a global git flag here; git parses
			// it as a git-push argument (which it isn't, so git errors at
			// runtime). The walker must not treat it as a cwd override.
			assert.equal(git(suffixOf("git push -C /x"), "/start"), "/start");
		});

		it("-C before other pre-subcommand flag, then subcommand", () => {
			assert.equal(
				git(suffixOf("git -C /x --no-pager push"), "/start"),
				"/x",
			);
		});

		it("-c key=val skipped; -C still recognized", () => {
			assert.equal(
				git(suffixOf("git -c color.ui=never -C /x push"), "/start"),
				"/x",
			);
		});

		it("-C with non-static target: stops propagating, returns best prefix", () => {
			// $HOME is a parameter expansion — walker must not invent a path.
			assert.equal(git(suffixOf("git -C $HOME push"), "/start"), "/start");
		});

		it("-C with non-static AFTER a static -C: keeps static prefix", () => {
			assert.equal(
				git(suffixOf("git -C /a -C $VAR push"), "/start"),
				"/a",
			);
		});

		it("trailing -C with no argument: malformed, returns baseCwd", () => {
			assert.equal(git(suffixOf("git -C"), "/start"), "/start");
		});

		it("subcommand with no pre-flags: returns baseCwd", () => {
			assert.equal(git(suffixOf("git status"), "/start"), "/start");
		});
	});

	describe("make", () => {
		const make = CWD_OVERRIDE_FLAGS["make"]!;

		it("no -C: returns baseCwd", () => {
			assert.equal(make(suffixOf("make all"), "/start"), "/start");
		});

		it("-C DIR: replaces baseCwd", () => {
			assert.equal(make(suffixOf("make -C /x all"), "/start"), "/x");
		});

		it("-C and target order-agnostic: `make all -C /x` still resolves", () => {
			// make accepts -C anywhere; walker scans all tokens.
			assert.equal(make(suffixOf("make all -C /x"), "/start"), "/x");
		});

		it("repeatable -C: composes left-to-right", () => {
			assert.equal(make(suffixOf("make -C /a -C b all"), "/start"), "/a/b");
		});

		it("-f FILE skipped; does not confuse -C scan", () => {
			assert.equal(
				make(suffixOf("make -f Makefile.dev -C /x all"), "/start"),
				"/x",
			);
		});
	});

	describe("env", () => {
		const env = CWD_OVERRIDE_FLAGS["env"]!;

		it("no -C: returns baseCwd", () => {
			assert.equal(env(suffixOf("env cmd"), "/start"), "/start");
		});

		it("-C DIR cmd: replaces baseCwd", () => {
			assert.equal(env(suffixOf("env -C /x cmd"), "/start"), "/x");
		});

		it("stops at first assignment: `env -C /x VAR=val cmd`", () => {
			assert.equal(env(suffixOf("env -C /x VAR=val cmd"), "/start"), "/x");
		});

		it("stops at cmd name (non-flag): `env -u X -C /y cmd -C /z`", () => {
			// -C after the cmd is an arg to cmd, not to env.
			assert.equal(
				env(suffixOf("env -u X -C /y cmd -C /z"), "/start"),
				"/y",
			);
		});

		it("-- terminates options", () => {
			assert.equal(env(suffixOf("env -- cmd -C /z"), "/start"), "/start");
		});
	});
});

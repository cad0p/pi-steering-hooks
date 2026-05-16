// SPDX-License-Identifier: MIT
// Part of pi-steering.
//
// Unit tests for refToText. The function is a thin wrapper around
// unbash-walker's getBasename / getCommandArgs; these tests pin the
// exact rendered shape observer-watch patterns see so a future
// refactor that accidentally changes spacing (e.g. drops the trim)
// doesn't silently break every `watch.inputMatches.command` in the
// wild.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parse } from "unbash-walker";
import { extractAllCommandsFromAST } from "unbash-walker";
import { refToText } from "./ref-text.ts";

function refsFor(command: string) {
	const script = parse(command);
	return extractAllCommandsFromAST(script, command);
}

describe("refToText", () => {
	it("renders bare command with no args", () => {
		const [ref] = refsFor("alpha");
		assert.equal(refToText(ref!), "alpha");
	});

	it("renders command with single arg", () => {
		const [ref] = refsFor("git push");
		assert.equal(refToText(ref!), "git push");
	});

	it("renders command with multiple args, space-joined", () => {
		const [ref] = refsFor("git push origin main --force");
		assert.equal(refToText(ref!), "git push origin main --force");
	});

	it("trims trailing space from empty args list", () => {
		const [ref] = refsFor("noop");
		assert.equal(
			refToText(ref!),
			"noop",
			"no trailing space when args is empty",
		);
	});

	it("basename strips path prefix", () => {
		const [ref] = refsFor("/usr/local/bin/cr --all");
		assert.equal(
			refToText(ref!),
			"cr --all",
			"rendered command uses basename, not absolute path",
		);
	});
});

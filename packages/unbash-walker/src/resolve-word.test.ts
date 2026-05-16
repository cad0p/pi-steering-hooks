// SPDX-License-Identifier: MIT
// Tests for the env-aware Word resolver. Part of unbash-walker.
//
// These tests exercise `resolveWord` against the full range of
// WordPart types unbash produces, using the unbash parser to
// construct realistic words rather than hand-building AST nodes.
// The parser gives us confidence that the helper handles what
// real agent-emitted commands look like.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parse as parseBash } from "unbash";
import type { Word } from "unbash";
import { extractAllCommandsFromAST } from "./extract.ts";
import { resolveWord } from "./resolve-word.ts";

/**
 * Parse `cd X` and pluck the `X` word — the simplest reliable
 * way to obtain a fully-formed Word from the parser across every
 * WordPart variant the tests care about. Uses the walker's own
 * `extractAllCommandsFromAST` to traverse the parser's nested AST
 * shape so the test file doesn't depend on the internal Statement
 * vs Command union.
 */
function wordFromCdArg(src: string): Word {
	const raw = `cd ${src}`;
	const script = parseBash(raw);
	const refs = extractAllCommandsFromAST(script, raw);
	const cmd = refs[0]?.node;
	if (!cmd) throw new Error(`no command extracted from \`${raw}\``);
	const word = cmd.suffix[0];
	if (!word) throw new Error(`no suffix word in \`${raw}\``);
	return word;
}

describe("resolveWord", () => {
	describe("literals", () => {
		it("plain literal", () => {
			const w = wordFromCdArg("/tmp/pkg");
			assert.equal(resolveWord(w, new Map()), "/tmp/pkg");
		});

		it("single-quoted literal", () => {
			const w = wordFromCdArg("'/tmp/pkg'");
			assert.equal(resolveWord(w, new Map()), "/tmp/pkg");
		});

		it("single-quoted text is NOT expanded", () => {
			const w = wordFromCdArg("'literal-with-$VAR'");
			assert.equal(
				resolveWord(w, new Map([["VAR", "expanded"]])),
				"literal-with-$VAR",
			);
		});

		it("double-quoted plain text", () => {
			const w = wordFromCdArg('"/tmp/pkg"');
			assert.equal(resolveWord(w, new Map()), "/tmp/pkg");
		});
	});

	describe("simple expansion ($NAME)", () => {
		it("resolves from env map", () => {
			const w = wordFromCdArg("$WS");
			assert.equal(
				resolveWord(w, new Map([["WS", "/workspace"]])),
				"/workspace",
			);
		});

		it("undefined → undefined", () => {
			const w = wordFromCdArg("$UNDEFINED");
			assert.equal(resolveWord(w, new Map()), undefined);
		});

		it("inside double-quoted with suffix literal", () => {
			const w = wordFromCdArg('"$WS/pkg"');
			assert.equal(
				resolveWord(w, new Map([["WS", "/workspace"]])),
				"/workspace/pkg",
			);
		});

		it("inside double-quoted with prefix and suffix", () => {
			const w = wordFromCdArg('"/root/$NAME/child"');
			assert.equal(
				resolveWord(w, new Map([["NAME", "middle"]])),
				"/root/middle/child",
			);
		});

		it("positional parameter $1 → undefined", () => {
			const w = wordFromCdArg("$1");
			assert.equal(resolveWord(w, new Map([["1", "/nope"]])), undefined);
		});
	});

	describe("brace expansion (${NAME})", () => {
		it("resolves from env map", () => {
			const w = wordFromCdArg("${WS}");
			assert.equal(
				resolveWord(w, new Map([["WS", "/workspace"]])),
				"/workspace",
			);
		});

		it("inside double-quoted", () => {
			const w = wordFromCdArg('"${WS}/pkg"');
			assert.equal(
				resolveWord(w, new Map([["WS", "/workspace"]])),
				"/workspace/pkg",
			);
		});

		it("undefined → undefined", () => {
			const w = wordFromCdArg("${UNDEFINED}");
			assert.equal(resolveWord(w, new Map()), undefined);
		});

		it("${VAR:-default} (with operator) → undefined (deferred)", () => {
			const w = wordFromCdArg('"${VAR:-/default}"');
			assert.equal(
				resolveWord(w, new Map([["VAR", "/x"]])),
				undefined,
				"parameter expansion with modifier is deferred per env-tracker-deferred-scope",
			);
		});

		it("${VAR#pattern} → undefined (deferred)", () => {
			const w = wordFromCdArg('"${VAR#/prefix}"');
			assert.equal(resolveWord(w, new Map([["VAR", "/prefix/x"]])), undefined);
		});

		it("${#VAR} length form → undefined (deferred)", () => {
			const w = wordFromCdArg('"${#VAR}"');
			assert.equal(resolveWord(w, new Map([["VAR", "abc"]])), undefined);
		});
	});

	describe("tilde expansion", () => {
		it("bare ~", () => {
			const w = wordFromCdArg("~");
			assert.equal(
				resolveWord(w, new Map([["HOME", "/home/me"]])),
				"/home/me",
			);
		});

		it("~/subdir", () => {
			const w = wordFromCdArg("~/proj/app");
			assert.equal(
				resolveWord(w, new Map([["HOME", "/home/me"]])),
				"/home/me/proj/app",
			);
		});

		it("HOME missing → ~ / ~/... become undefined (fail-closed via walker unknown sentinel)", () => {
			// Before the cd~-absent-HOME fix, expandTildeIfLeading fell back
			// to the literal string. Callers then saw `~/proj` as a path,
			// which silently bypassed `when.cwd` guards. Now resolveWord
			// returns undefined — the cd modifier propagates, the walker
			// emits unknown, and engine's onUnknown: "block" fires.
			const w = wordFromCdArg("~/proj");
			assert.equal(resolveWord(w, new Map()), undefined);

			const bare = wordFromCdArg("~");
			assert.equal(resolveWord(bare, new Map()), undefined);
		});

		it("quoted tilde is NOT expanded", () => {
			// Per bash: quoted tildes stay literal. We match that.
			const w = wordFromCdArg('"~/proj"');
			assert.equal(
				resolveWord(w, new Map([["HOME", "/home/me"]])),
				"~/proj",
			);
		});

		it("~user — unsupported, returns literal", () => {
			const w = wordFromCdArg("~alice/docs");
			assert.equal(
				resolveWord(w, new Map([["HOME", "/home/me"]])),
				"~alice/docs",
			);
		});

		it("interior ~ is literal (not at word start)", () => {
			const w = wordFromCdArg("/a/~");
			assert.equal(resolveWord(w, new Map([["HOME", "/home/me"]])), "/a/~");
		});
	});

	describe("intractable forms → undefined", () => {
		it("command substitution $(…)", () => {
			const w = wordFromCdArg("$(pwd)");
			assert.equal(resolveWord(w, new Map()), undefined);
		});

		it("command substitution inside double-quoted", () => {
			const w = wordFromCdArg('"$(pwd)/x"');
			assert.equal(resolveWord(w, new Map()), undefined);
		});

		it("arithmetic expansion $((…))", () => {
			const w = wordFromCdArg('"/x$((1+1))"');
			assert.equal(resolveWord(w, new Map()), undefined);
		});

		it("backtick command substitution", () => {
			const w = wordFromCdArg("`pwd`");
			assert.equal(resolveWord(w, new Map()), undefined);
		});

		it("process substitution <(…)", () => {
			const w = wordFromCdArg("<(echo /x)");
			assert.equal(resolveWord(w, new Map()), undefined);
		});

		it("extended glob @(…)", () => {
			const w = wordFromCdArg("@(a|b)");
			assert.equal(resolveWord(w, new Map()), undefined);
		});

		it("brace expansion {…}", () => {
			const w = wordFromCdArg("{a,b}");
			assert.equal(resolveWord(w, new Map()), undefined);
		});

		it("ANSI-C quoted $'…'", () => {
			// `$'...'` parses as an AnsiCQuoted part. Could in principle be
			// resolved statically (the content IS known at parse time, modulo
			// escape-sequence semantics) but resolveWord treats it as
			// intractable for v0.1.0 — a rule author who cares about escape-
			// sequence semantics can extend in a plugin later.
			const w = wordFromCdArg("$'hello\\n'");
			assert.equal(resolveWord(w, new Map()), undefined);
		});

		it('locale-aware string $"…"', () => {
			// `$"..."` parses as a LocaleString part. Similarly tractable in
			// principle (the fallback string is static) but treated as
			// intractable here because localization substitution is runtime-
			// dependent on `LC_MESSAGES`.
			const w = wordFromCdArg('$"hello"');
			assert.equal(resolveWord(w, new Map()), undefined);
		});
	});

	describe("empty env", () => {
		it("all expansions miss → undefined on any $VAR", () => {
			const w = wordFromCdArg('"$FOO/bar"');
			assert.equal(resolveWord(w, new Map()), undefined);
		});

		it("static word still resolves", () => {
			const w = wordFromCdArg("/literal");
			assert.equal(resolveWord(w, new Map()), "/literal");
		});
	});

	describe("multi-part words", () => {
		it("Literal + ${VAR} + Literal", () => {
			// Bash treats `/a${VAR}/b` as a single word with 3 parts.
			const w = wordFromCdArg("/a${VAR}/b");
			assert.equal(
				resolveWord(w, new Map([["VAR", "MID"]])),
				"/aMID/b",
			);
		});

		it("concatenated $VAR$VAR2", () => {
			const w = wordFromCdArg("$A$B");
			assert.equal(
				resolveWord(
					w,
					new Map([
						["A", "one"],
						["B", "two"],
					]),
				),
				"onetwo",
			);
		});

		it("one undefined part makes the whole word intractable", () => {
			const w = wordFromCdArg("$A$B");
			assert.equal(
				resolveWord(w, new Map([["A", "one"]])),
				undefined,
			);
		});
	});
});

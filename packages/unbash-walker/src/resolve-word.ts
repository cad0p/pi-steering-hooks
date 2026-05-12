// SPDX-License-Identifier: MIT
// Part of unbash-walker.

/**
 * resolveWord — static + env-aware Word resolution.
 *
 * Extends {@link isStaticallyResolvable} with env-map lookup: a
 * `$NAME` / `${NAME}` reference resolves to `env.get("NAME")`, and
 * `~` at word start resolves to `env.get("HOME")`. Everything else
 * that isn't a pure literal / single-quoted / double-quoted-with-
 * resolvable-children is treated as intractable — the function
 * returns `undefined` and the caller applies its own fallback.
 *
 * Typical caller is a walker modifier (`cd` today; future plugin
 * modifiers) that has access to an env snapshot via the
 * cross-tracker `allState` protocol (see
 * {@link import("./tracker.ts").Modifier}). Passing the env map
 * explicitly keeps the helper pure — no `process.env` reads
 * inside, so plugin authors can seed their own env state for
 * testing and sandboxing.
 *
 * Scope (v0.1.0 — bundled with the envTracker):
 *
 *   - ✅ Literal, SingleQuoted. DoubleQuoted if every inner part
 *        resolves.
 *   - ✅ `$NAME` (SimpleExpansion) via env lookup.
 *   - ✅ `${NAME}` (ParameterExpansion with no operator / index /
 *        slice / replace / length / indirect) via env lookup.
 *   - ✅ Leading `~` / `~/…` via `env.get("HOME")`.
 *   - ❌ `${NAME:-default}`, `${NAME#pattern}`, … (parameter-
 *        expansion with modifiers) → undefined.
 *   - ❌ Command substitution, arithmetic expansion, process
 *        substitution, ext-glob, brace expansion, ANSI-C,
 *        locale-quoted → undefined.
 *
 * Deferred classes are documented inline (see the scope list
 * above) and graduate to this helper when a motivating use case
 * lands. The underlying AST is already typed, so adding a case is
 * structural (new `WordPart.type` arm → helper or undefined) —
 * no re-architecture.
 */

import type { Word, WordPart } from "unbash";
import { isIdentifierName } from "./internal/identifier.ts";

/**
 * Resolve a {@link Word} to its runtime string value using the
 * given env snapshot for `$VAR` / `${VAR}` / `~` expansion.
 *
 * Returns `undefined` when the word contains any part the helper
 * cannot statically evaluate (command substitution, parameter
 * expansion with modifiers, arithmetic, process substitution,
 * brace expansion, ext-glob, ANSI-C, locale-quoted, or a `$VAR`
 * whose NAME is absent from `env`).
 *
 * This is the exact semantics downstream rules need: a failure
 * to resolve propagates as `undefined`, which the caller's
 * modifier converts into the tracker's `unknown` sentinel (see
 * the {@link Tracker} contract).
 *
 * @example
 *   // `cd "$WS/pkg"` with env = { WS: "/workspace" }
 *   resolveWord(wordFromTarget, new Map([["WS", "/workspace"]]))
 *   // → "/workspace/pkg"
 *
 *   // `cd "$UNDEFINED/pkg"` with empty env
 *   resolveWord(wordFromTarget, new Map())
 *   // → undefined
 *
 *   // `cd $(pwd)` — command substitution is never resolvable
 *   resolveWord(wordFromTarget, env)
 *   // → undefined
 */
export function resolveWord(
	word: Word,
	env: ReadonlyMap<string, string>,
): string | undefined {
	// No parts: the word is a simple literal. Use `value` (lexical
	// value, unquoted) if present, otherwise fall back to `text`
	// (raw source). This matches the fallback path in the walker's
	// legacy `wordValue` helper.
	if (!word.parts || word.parts.length === 0) {
		const bare = word.value ?? word.text;
		// Tilde expansion at word start: `~`, `~/…`. Only applies when
		// the token actually starts with `~` in the raw source — if a
		// user writes `"~"` the parser produces a SingleQuoted /
		// DoubleQuoted part, not a bare word, so we don't accidentally
		// expand quoted tildes here.
		return expandTildeIfLeading(bare, env);
	}

	let out = "";
	for (let i = 0; i < word.parts.length; i++) {
		const part = word.parts[i]!;
		const resolved = resolvePart(part, env);
		if (resolved === undefined) return undefined;
		// Tilde expansion only applies to the very first part AND only
		// when that part is a bare Literal that starts with `~` — same
		// semantic rule as bash (quoted `~` is not expanded).
		if (i === 0 && part.type === "Literal") {
			const expanded = expandTildeIfLeading(resolved, env);
			if (expanded === undefined) return undefined;
			out += expanded;
		} else {
			out += resolved;
		}
	}
	return out;
}

/**
 * Apply tilde expansion to a leading `~` using `env.get("HOME")`.
 *
 * Semantics:
 *   - `~` alone → HOME, or `undefined` if HOME is absent (walker
 *     emits unknown sentinel → engine fail-closes via `onUnknown`).
 *   - `~/rest` → `HOME + "/" + rest`, or `undefined` if HOME absent.
 *   - `~user` / `~user/rest` → returned unchanged (we don't model
 *     arbitrary user HOME directories; cd would fail at runtime
 *     on a nonexistent user). Documented known limit — narrow
 *     enough that flipping it to `undefined` is left as a
 *     follow-up if it becomes an agent-bypass class.
 *   - No leading `~` → returns input unchanged.
 *
 * Not exported — only internal to `resolveWord`. The function is
 * defined outside `resolveWord` to keep the hot path inside the
 * parts-loop short (no closure).
 */
function expandTildeIfLeading(
	s: string,
	env: ReadonlyMap<string, string>,
): string | undefined {
	if (s.length === 0) return s;
	if (s[0] !== "~") return s;
	if (s === "~") {
		const home = env.get("HOME");
		return home ?? undefined;
	}
	if (s.startsWith("~/")) {
		const home = env.get("HOME");
		if (home === undefined) return undefined;
		return home + s.slice(1);
	}
	// `~user` / `~user/rest` — unsupported; returned unchanged.
	return s;
}

/**
 * Resolve a single {@link WordPart} against the env map. Returns
 * the concatenable string slice contributed by this part, or
 * `undefined` if the part is intractable.
 */
function resolvePart(
	part: WordPart,
	env: ReadonlyMap<string, string>,
): string | undefined {
	switch (part.type) {
		case "Literal":
		case "SingleQuoted":
			return part.value;

		case "DoubleQuoted": {
			// Double-quoted strings concatenate their inner parts. If ANY
			// inner part is intractable, the whole word is intractable.
			let out = "";
			for (const child of part.parts) {
				const resolved = resolvePart(child as WordPart, env);
				if (resolved === undefined) return undefined;
				out += resolved;
			}
			return out;
		}

		case "SimpleExpansion": {
			// `$NAME` form. Parser preserves the raw text `$NAME`; the
			// name is everything after the leading `$`. Special forms
			// `$@`, `$*`, `$#`, `$?`, `$$`, `$!`, `$0`…`$9` are not
			// modelled — they behave as intractable.
			const raw = part.text;
			if (!raw.startsWith("$")) return undefined;
			const name = raw.slice(1);
			if (!isIdentifierName(name)) return undefined;
			return env.get(name);
		}

		case "ParameterExpansion": {
			// `${NAME}` form. We accept ONLY the bare shape with none of
			// bash's parameter-expansion operators. Anything with
			// `operator` (`:-`, `#`, `%`, `/`, `^`, …), `slice`,
			// `replace`, `length`, `indirect`, or `index` is deferred
			// (see env-tracker-deferred-scope.md).
			if (
				part.operator !== undefined ||
				part.slice !== undefined ||
				part.replace !== undefined ||
				part.length === true ||
				part.indirect === true ||
				part.index !== undefined
			) {
				return undefined;
			}
			if (!isIdentifierName(part.parameter)) return undefined;
			return env.get(part.parameter);
		}

		// Intractable categories — see file-header comment.
		case "CommandExpansion":
		case "ArithmeticExpansion":
		case "ProcessSubstitution":
		case "ExtendedGlob":
		case "BraceExpansion":
		case "AnsiCQuoted":
		case "LocaleString":
			return undefined;

		default:
			return undefined;
	}
}

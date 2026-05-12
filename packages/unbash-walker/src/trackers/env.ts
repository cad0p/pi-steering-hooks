// SPDX-License-Identifier: MIT
// Part of unbash-walker.

/**
 * Built-in env tracker — walker state for shell variable assignments
 * the walker can statically resolve.
 *
 * Scope (v0.1.0):
 *
 *   - ✅ Bare assignment as its own command: `FOO=value`
 *   - ✅ `export FOO=value`
 *   - ✅ `unset FOO`
 *   - ✅ Seeded from `process.env.HOME`, `process.env.USER`,
 *        `process.env.PWD` at tracker initialization (so `cd ~`
 *        and `cd "$HOME/x"` resolve on the first walk).
 *   - ❌ `readonly FOO=value` — attribute-bearing, deferred.
 *   - ❌ `local FOO=value` — function scope not modelled.
 *   - ❌ `declare` / `typeset` — attribute semantics deferred.
 *   - ❌ `source` / `.` — opaque file inclusion.
 *   - ❌ Function-body walking — function definitions don't execute.
 *   - ❌ Compound assignment shapes (skipped at the parser-prefix
 *        synthesis step in `tracker.ts:synthesizeAssignmentWords`):
 *        - `FOO+=value` (append) — no-op; a future version may read
 *          `allState.env` and do `env.set(NAME, old + value)` once
 *          multi-hop env resolution lands.
 *        - `FOO=(a b c)` (array init) — we don't track bash arrays;
 *          skipped so scalar FOO is untouched.
 *        - `FOO[0]=value` (array-index assignment) — same.
 *
 * The full deferred-scope rationale lives in the file-level
 * header above and the per-class notes on each modifier below,
 * including the trigger criteria for graduating each class out
 * of "deferred" into a future `pi-steering-env` plugin or a
 * v0.1.x additive extension.
 *
 * Subshell semantics: `"isolated"` — matches bash, where env
 * changes inside `(A; B)` don't escape to the outer scope. The
 * walker handles this generically via `subshellSemantics` on
 * every tracker.
 *
 * Prefix assignments (`FOO=bar cmd`) are NOT handled here: those
 * are one-shot env for that single command, not a shell-state
 * mutation. The evaluator's `PredicateToolInput.envAssignments`
 * surface already exposes them per-ref; plugin predicates read
 * that directly.
 */

import type { Word } from "unbash";
import { type Modifier, type Tracker } from "../tracker.ts";
import { resolveWord } from "../resolve-word.ts";

/**
 * Shape of the env tracker's state: a read-only map from variable
 * name to its statically-resolved value. `ReadonlyMap` so consumers
 * can hand it to plugin predicates without worrying about
 * accidental mutation.
 */
export type EnvState = ReadonlyMap<string, string>;

/**
 * Shared empty env passed to {@link resolveWord} for assignment
 * RHS resolution. v0.1.0 doesn't thread the current env map
 * through the assignment modifiers (see D1 deferral note in
 * {@link bareAssignModifier}'s JSDoc); a constant empty map is
 * the right shape to signal "no lookup" to `resolveWord`.
 */
const EMPTY_ENV: EnvState = new Map();

/**
 * Resolve a synthesized assignment Word (shape: Literal("NAME=") +
 * RHS parts) into `{ name, value }`. Returns `undefined` when:
 *   - the word's RHS isn't statically resolvable (dynamic value),
 *   - the word doesn't conform to the `NAME=VALUE` shape,
 *   - or NAME is not a valid bash identifier.
 *
 * Uses {@link resolveWord} to concatenate the synthesized parts,
 * which correctly unquotes double-quoted values and rejects
 * parameter expansions. The result is then split on the FIRST
 * `=` — same splitting rule as raw token parsing, but applied
 * after static resolution so `FOO="value with=sign"` resolves
 * to name="FOO" / value="value with=sign" cleanly.
 */
function resolveAssignmentWord(
	word: Word,
	env: EnvState,
): { name: string; value: string } | undefined {
	const resolved = resolveWord(word, env);
	if (resolved === undefined) return undefined;
	return parseAssignmentToken(resolved);
}

// --------------------------------------------------------------------------
// Assignment parsing
// --------------------------------------------------------------------------

/**
 * Split a "NAME=VALUE" token into `{ name, value }`. Returns
 * `undefined` when the token is malformed or NAME isn't a valid
 * bash identifier.
 *
 * We deliberately accept only `NAME=VALUE` form. `NAME+=VALUE`
 * (append), `NAME[i]=VALUE` (array), and `NAME=(…)` (array init)
 * are deferred — they live in the same "not modelled" bucket as
 * `readonly` / `declare`.
 */
function parseAssignmentToken(
	raw: string,
): { name: string; value: string } | undefined {
	const eq = raw.indexOf("=");
	if (eq <= 0) return undefined;
	const name = raw.slice(0, eq);
	if (!isIdentifierName(name)) return undefined;
	const value = raw.slice(eq + 1);
	return { name, value };
}

function isIdentifierName(name: string): boolean {
	if (name.length === 0) return false;
	const first = name.charCodeAt(0);
	if (!isIdentStart(first)) return false;
	for (let i = 1; i < name.length; i++) {
		if (!isIdentCont(name.charCodeAt(i))) return false;
	}
	return true;
}

function isIdentStart(c: number): boolean {
	return (
		(c >= 65 && c <= 90) ||
		(c >= 97 && c <= 122) ||
		c === 95
	);
}

function isIdentCont(c: number): boolean {
	return isIdentStart(c) || (c >= 48 && c <= 57);
}

/**
 * Build a new map from `current` with the given entry set.
 *
 * `ReadonlyMap` doesn't expose mutation, but we intentionally
 * construct a fresh `Map` so the new reference signals "state
 * changed" to downstream consumers (e.g. a future memoization
 * layer doing reference-equality diffs on per-ref state).
 */
function withSet(
	current: EnvState,
	name: string,
	value: string,
): EnvState {
	const next = new Map(current);
	next.set(name, value);
	return next;
}

function withDelete(current: EnvState, names: readonly string[]): EnvState {
	let changed = false;
	for (const n of names) {
		if (current.has(n)) {
			changed = true;
			break;
		}
	}
	if (!changed) return current;
	const next = new Map(current);
	for (const n of names) next.delete(n);
	return next;
}

// --------------------------------------------------------------------------
// Modifiers
// --------------------------------------------------------------------------

/**
 * Bare assignment: the "command" is an assignment-prefix-only
 * statement (`FOO=value`). In unbash's AST these appear as a Command
 * with `name === undefined` and a non-empty `prefix`. Routing them
 * into this modifier happens in {@link handleCommand} — the walker
 * synthesizes one Word per prefix entry (raw text `"NAME=VALUE"`,
 * `parts` concatenating `Literal("NAME=")` + the RHS's original
 * parts) so static-resolvability checks reflect dynamic RHS values
 * (`FOO=$VAR` → word resolves to `undefined`; `FOO=bar` → word
 * resolves to `"FOO=bar"`). The modifier registers on basename `""`
 * so the walker reaches it through the same basename-keyed dispatch
 * every other tracker uses.
 *
 * Multiple prefix assignments on one line — `A=1 B=2` — arrive
 * here as multiple synthetic Words. We process them in order so
 * both assignments land.
 *
 * Dynamic values like `FOO=$OTHER` are skipped in this pass —
 * `resolveWord` with an empty env returns `undefined` for any
 * parameter expansion / command substitution / arithmetic, which
 * the modifier reads as "not statically known, skip". Cross-reading
 * the current env via `allState.env` to resolve such values is
 * deferred — the canonical Tier B use case is `WS=/ws; cd "$WS/..."`,
 * not `FOO=$BAR; cd "$FOO"`. If agent patterns surface the multi-hop
 * case, a follow-up can read `allState.env` and pass it to
 * `resolveWord` here.
 *
 * Double-quoted values (`FOO="some value"`) resolve through
 * `resolveWord` to their unquoted inner string (`"some value"`) —
 * the Word's inner `DoubleQuoted` part concatenates static child
 * parts to the unquoted value, matching the shell's own behavior.
 */
const bareAssignModifier: Modifier<EnvState> = {
	scope: "sequential",
	apply: (args, current) => {
		let next = current;
		for (const w of args) {
			const resolved = resolveAssignmentWord(w, EMPTY_ENV);
			if (resolved === undefined) continue;
			next = withSet(next, resolved.name, resolved.value);
		}
		return next;
	},
};

/**
 * `export NAME=VALUE` / `export NAME` / `export -p` / …
 *
 * We accept:
 *   - `export NAME=VALUE` → write to env map (same as bare).
 *   - `export NAME`       → no-op (we don't track the
 *                            exported-without-value attribute).
 *
 * Flags (`-n`, `-p`, `-f`) are skipped. `-n NAME` (un-export)
 * leaves the value in the env map — we model env presence, not
 * the exported-bit attribute.
 *
 * Dynamic values and dynamic names (`export "FOO=$BAR"`,
 * `export $NAME=x`) are no-ops.
 */
const exportModifier: Modifier<EnvState> = {
	scope: "sequential",
	apply: (args, current) => {
		let next = current;
		for (const w of args) {
			const raw = w.value ?? w.text;
			if (raw === undefined) continue;
			// Skip flags — bash's `export` accepts `-n`, `-p`, `-f`, `--`.
			// `-n NAME` takes the following arg but since we don't model
			// the exported-bit attribute, skipping the flag and NOT
			// consuming the next arg is the right call: `export -n FOO`
			// leaves FOO in the env map, matching our "presence only"
			// semantics.
			if (raw === "--") continue;
			if (raw.startsWith("-")) continue;
			// `export NAME=VALUE` — resolve through the shared static-word
			// helper so double-quoted values unquote correctly and dynamic
			// values skip cleanly. `export NAME` (bare export, no value)
			// produces a resolved string with no `=`, which
			// parseAssignmentToken rejects — matching our "we don't track
			// the exported-bit attribute" stance.
			const resolved = resolveAssignmentWord(w, EMPTY_ENV);
			if (resolved === undefined) continue;
			next = withSet(next, resolved.name, resolved.value);
		}
		return next;
	},
};

/**
 * `unset NAME [NAME2 ...]`
 *
 * Removes each statically-named var from the env map.
 *
 * Flag handling:
 *   - `-v NAME` (scalar-unset, the default) — skipped as a flag,
 *     NAME still consumed normally.
 *   - `-f NAME` (function-unset) — bash clears functions only and
 *     leaves the scalar NAME untouched. We short-circuit the entire
 *     modifier invocation on `-f` so the scalar env map survives;
 *     functions aren't tracked at all, so there's nothing to do.
 *   - `-x NAME` — bash errors; we accept and still process NAME.
 *     Fail-open here is consistent with the walker's "over-match on
 *     error chains is fine" stance for guardrail use.
 *
 * Dynamic names bail on that name only; other names in the same
 * command still apply.
 */
const unsetModifier: Modifier<EnvState> = {
	scope: "sequential",
	apply: (args, current) => {
		// If any arg is `-f`, bash's function-only unset applies. We
		// don't track functions — short-circuit so the scalar env is
		// untouched. This fixes a prior bug where `unset -f FOO` would
		// delete the scalar FOO alongside a phantom function clear.
		for (const w of args) {
			const raw = w.value ?? w.text;
			if (raw === "-f") return current;
		}
		const names: string[] = [];
		for (const w of args) {
			const raw = w.value ?? w.text;
			if (raw === undefined) continue;
			if (raw === "--") continue;
			// `-v`, `-x`: skip the flag, keep scanning. No consume-next.
			// `-f` handled above; we never reach this loop when it's present.
			if (raw.startsWith("-")) continue;
			// Resolve to reject dynamic names (`unset $VAR`) and single-
			// quoted forms alike via the shared helper. Double-quoted
			// literal names (`unset "FOO"`) unquote to valid identifiers
			// and are accepted.
			const resolved = resolveWord(w, EMPTY_ENV);
			if (resolved === undefined) continue;
			if (!isIdentifierName(resolved)) continue;
			names.push(resolved);
		}
		if (names.length === 0) return current;
		return withDelete(current, names);
	},
};

// --------------------------------------------------------------------------
// The tracker
// --------------------------------------------------------------------------

/**
 * Seed the initial env state from `process.env` at tracker
 * construction time. We pick the three keys agents most commonly
 * reference in chains — `HOME` (for `~` expansion), `USER` (for
 * user-scoped paths), `PWD` (for `$PWD/x` references). A caller
 * that wants different seeding (tests, sandboxed walks) can
 * override via `walk(…, { env: myMap }, …)` — the walker's
 * standard per-dimension seeding.
 */
function seedFromProcessEnv(): EnvState {
	const out = new Map<string, string>();
	const { HOME, USER, PWD } = process.env;
	if (HOME !== undefined) out.set("HOME", HOME);
	if (USER !== undefined) out.set("USER", USER);
	if (PWD !== undefined) out.set("PWD", PWD);
	return out;
}

/**
 * The `unknown` sentinel for env state. Distinct frozen empty
 * map — consumers discriminate via reference equality
 * (`state === envTracker.unknown`), NOT structural emptiness (an
 * initial walk with no `HOME`/`USER`/`PWD` in the process also
 * produces an empty map, but one that MAY be mutated by
 * subsequent assignments).
 *
 * In practice the env tracker's modifiers never return
 * `undefined` — every modifier's handling of a dynamic arg is to
 * skip that arg and keep the rest (no-op for intractable names).
 * So `unknown` is declared for API completeness but not expected
 * to surface in normal walks. Kept here so a future modifier
 * that CAN signal "env fully scrambled" (e.g. a future `eval`
 * handler) has a well-typed sentinel to return.
 */
const UNKNOWN_ENV: EnvState = Object.freeze(new Map<string, string>());

/**
 * Built-in `env` tracker. Register alongside `cwdTracker` to get
 * `$VAR` / `${VAR}` / `~` expansion in cd targets. Plugin
 * predicates reading walker state can consult
 * `ctx.walkerState.env.get("NAME")` directly.
 *
 * Initial seeding pulls from `process.env.{HOME, USER, PWD}`.
 * Override via `walk(script, { env: new Map(...) }, { env:
 * envTracker })` for deterministic tests.
 */
export const envTracker: Tracker<EnvState> = {
	initial: seedFromProcessEnv(),
	unknown: UNKNOWN_ENV,
	modifiers: {
		// Bare-assignment commands have basename "". The walker
		// dispatches on `""` when node.name is absent and node.prefix
		// is non-empty (see handleCommand's bare-assignment branch).
		"": bareAssignModifier,
		export: exportModifier,
		unset: unsetModifier,
	},
	subshellSemantics: "isolated",
};

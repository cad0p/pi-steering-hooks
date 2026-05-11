// SPDX-License-Identifier: MIT
// Part of pi-steering-flags.

/**
 * Low-level helpers for inspecting `ctx.input.args` / `ctx.input.envAssignments`.
 *
 * These compose with the plugin's `requiresFlag` / `allowlistedFlagsOnly`
 * predicates and are exported for rule authors reaching for
 * `when.condition` escape-hatch logic.
 *
 * All helpers are quote-aware: they read `.value` first (the walker's
 * resolved value after quote removal) before falling back to `.text`
 * (the raw source slice).
 */

import type { Word } from "pi-steering";

/**
 * Read a word's resolved value with a fallback to its text form.
 * Handles both forms consistently so callers can ignore the split.
 */
function wordValue(w: Word | undefined): string {
	if (w === undefined) return "";
	return w.value ?? w.text ?? "";
}

/**
 * Read-only iteration over a Word-array that tolerates either an array
 * of Word or undefined. Hoisted so all helpers share the same empty-
 * input handling.
 */
function* iterWords(words: readonly Word[] | undefined): IterableIterator<Word> {
	if (words === undefined) return;
	for (const w of words) yield w;
}

/**
 * `true` if `args` contains `flag` as a bare token or as the key of an
 * attached-value `flag=value` token.
 *
 * Quote-aware (reads `.value` first, falls back to `.text`).
 *
 * @example
 *   hasFlag([W("--profile"), W("dev")], "--profile");    // true  (bare)
 *   hasFlag([W("--profile=dev")], "--profile");          // true  (attached)
 *   hasFlag([W("--profile-foo")], "--profile");          // false (prefix collision avoided)
 */
export function hasFlag(
	args: readonly Word[] | undefined,
	flag: string,
): boolean {
	const prefix = `${flag}=`;
	for (const w of iterWords(args)) {
		const t = wordValue(w);
		if (t === flag) return true;
		if (t.startsWith(prefix)) return true;
	}
	return false;
}

/**
 * Value associated with `flag` in `args`, or `null` if the flag is
 * absent or present-but-valueless.
 *
 * Recognizes two forms:
 *   - attached: `--flag=value`  \u2192 returns `"value"`
 *   - separated: `--flag value` \u2192 returns the NEXT token's value
 *
 * The separated form does NOT inspect whether the next token looks
 * like a flag \u2014 some CLIs accept `--flag --next-flag` and treat
 * `--next-flag` as the value. Callers who want a strict form should
 * post-check the return value.
 */
export function getFlagValue(
	args: readonly Word[] | undefined,
	flag: string,
): string | null {
	const prefix = `${flag}=`;
	const argsArr = args ?? [];
	for (let i = 0; i < argsArr.length; i++) {
		const t = wordValue(argsArr[i]);
		if (t.startsWith(prefix)) return t.slice(prefix.length);
		if (t === flag) {
			const next = argsArr[i + 1];
			if (next === undefined) return null;
			const nextVal = wordValue(next);
			return nextVal === "" ? null : nextVal;
		}
	}
	return null;
}

/**
 * `true` if `envAssignments` contains a shell env-var assignment
 * matching `name`. Shell env prefixes (`VAR=value cmd ...`) are
 * extracted by the walker into a separate slot on `ctx.input`; this
 * helper reads them directly without scanning the arg list.
 *
 * The comparison is literal on the variable name \u2014 `hasEnvAssignment`
 * does NOT match partial prefixes (e.g. `AWS_PROFILE=x` does not
 * satisfy `AWS`).
 *
 * @example
 *   // ctx.input.envAssignments for `AWS_PROFILE=dev aws s3 ls`
 *   hasEnvAssignment([W("AWS_PROFILE=dev")], "AWS_PROFILE"); // true
 *   hasEnvAssignment([W("AWS_PROFILE=dev")], "AWS");         // false
 */
export function hasEnvAssignment(
	envAssignments: readonly Word[] | undefined,
	name: string,
): boolean {
	const prefix = `${name}=`;
	for (const w of iterWords(envAssignments)) {
		const t = wordValue(w);
		if (t.startsWith(prefix)) return true;
	}
	return false;
}

/**
 * Info-only flag regex matching `-h` / `--help` / `-v` / `--version`.
 * Exported as a convenience for rule authors who want a `Rule.unless`
 * carve-out for help / version invocations that should never trigger
 * the guardrail.
 *
 * @example
 *   import { INFO_ONLY } from "pi-steering-flags";
 *   {
 *     name: "cr-allowlisted-flags-only",
 *     pattern: /^cr\b/,
 *     unless: INFO_ONLY,
 *     when: { allowlistedFlagsOnly: { allow: ["--description"] } },
 *   }
 */
export const INFO_ONLY = /(^|\s)(-h|--help|-v|--version)\b/;

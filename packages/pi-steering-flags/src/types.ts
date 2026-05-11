// SPDX-License-Identifier: MIT
// Part of pi-steering-flags.

import type { Word } from "pi-steering";

/**
 * Shape accepted by `when.requiresFlag`.
 *
 * At least one of {@link flag} / {@link flags} / {@link env} / {@link envs}
 * MUST be specified. The predicate fires (rule BLOCKS — i.e. the flag
 * is MISSING) when none of the listed flag / env equivalents appear in
 * `ctx.input.args` / `ctx.input.envAssignments`.
 *
 * @example
 * // Single flag (shorthand).
 * when: { requiresFlag: "--profile" }
 *
 * // Single flag, object form.
 * when: { requiresFlag: { flag: "--profile" } }
 *
 * // One of several alternative flags (short + long form).
 * when: { requiresFlag: { flags: ["--profile", "-p"] } }
 *
 * // Flag OR equivalent env var (e.g. `AWS_PROFILE=x aws ...`).
 * when: { requiresFlag: { flag: "--profile", env: "AWS_PROFILE" } }
 *
 * // Multiple envs.
 * when: {
 *   requiresFlag: { flag: "--region", envs: ["AWS_REGION", "AWS_DEFAULT_REGION"] }
 * }
 */
export interface RequiresFlagArgs {
	/** Single required flag (e.g. `"--profile"`). */
	flag?: string;
	/** Any one of these flags satisfies. Treated as OR. */
	flags?: readonly string[];
	/** Env-var name that also satisfies (shell form: `VAR=value cmd ...`). */
	env?: string;
	/** Env-var names that also satisfy. Treated as OR. */
	envs?: readonly string[];
}

/**
 * Shape accepted by `when.allowlistedFlagsOnly`.
 *
 * The predicate fires (rule BLOCKS) when any token in `ctx.input.args`
 * looks like a flag (`startsWith("-")`) and is NOT in {@link allow},
 * NOT matched by an auto-derived `--flag=` prefix of an allowed flag,
 * and NOT matched by an explicit {@link allowPrefixes} entry.
 *
 * @example
 * when: {
 *   allowlistedFlagsOnly: {
 *     allow: ["--all", "--description", "--reviewers", "-h", "--help"],
 *     // `--description=...` and `--reviewers=...` are auto-allowed
 *     // because those flags are in `allow` and start with `--`.
 *     // Use `allowPrefixes` only for non-`--` prefix matches.
 *   },
 * }
 */
export interface AllowlistedFlagsOnlyArgs {
	/** Bare flag tokens that are always allowed. */
	allow: readonly string[];
	/**
	 * Token prefixes that count as allowed (useful for short-flag
	 * attached-value forms like `-ofoo`). Tokens in {@link allow} that
	 * start with `--` are AUTOMATICALLY treated as allowed prefixes
	 * under their `=` form \u2014 only supply this for cases where prefix
	 * matching differs from that default.
	 */
	allowPrefixes?: readonly string[];
}

/**
 * Re-export for plugin author ergonomics: when building helpers on top
 * of this plugin's primitives, match the public `Word` shape pi-steering
 * exposes rather than reimporting from `unbash-walker`.
 */
export type { Word };

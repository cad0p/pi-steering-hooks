// SPDX-License-Identifier: MIT
// Part of @cad0p/pi-steering-hooks.

/**
 * Rule schema for the steering engine.
 *
 * Samfoy-inspired (pattern / requires / unless / reason / noOverride +
 * inline override comment), with two additions that justify the AST backend:
 *
 *   - `pattern` for the `bash` tool is applied to the AST-extracted command
 *     string (`name + " " + args.join(" ")`) — not the raw input. This avoids
 *     the silent-bypass classes that regex-on-raw-text has (quoted args,
 *     `sh -c` / `bash -c`, nested `sudo xargs`, …).
 *   - `when.cwd` is tested against the *effective* cwd of the command.
 *     For bash, that's the cwd computed by unbash-walker's `walk` function
 *     over the built-in `cwdTracker` (so `cd ~/personal && git commit --amend`
 *     sees `~/personal`). For write/edit, `when.cwd` tests against the
 *     session cwd directly.
 */

/** A single steering rule evaluated per tool call. */
export interface Rule {
	/** Unique rule identifier. Used in override comments and audit logs. */
	name: string;
	/** Which pi tool to intercept. */
	tool: "bash" | "write" | "edit";
	/**
	 * Which field of the tool input to test. Included for forward compatibility
	 * with richer rules; current evaluator derives the test target from `tool`
	 * but readers/authors benefit from the explicit declaration.
	 */
	field: "command" | "path" | "content";
	/**
	 * Regex pattern string. For the `bash` tool, applied to the AST-extracted
	 * command string (`name + " " + args.join(" ")`) per extracted command —
	 * NOT the raw user-supplied command string. For `write` / `edit`, applied
	 * to the raw field value.
	 */
	pattern: string;
	/** Optional: additional regex that must also match (AND condition). */
	requires?: string;
	/** Optional: regex exemption — if this matches, rule doesn't fire. */
	unless?: string;
	/**
	 * Optional predicates that must all match for the rule to fire.
	 *
	 * Nested for future extensibility: predicates like `branch`, `env`, or
	 * `time-of-day` can be added as peer keys without another schema
	 * migration. Unknown keys under `when` are reserved for future use and
	 * are ignored by the current evaluator (a one-time console.warn is
	 * emitted per rule so authors notice typos).
	 */
	when?: {
		/**
		 * Regex tested against the effective cwd of the command.
		 * For the `bash` tool: uses `walk` + `cwdTracker` from unbash-walker
		 * per command ref. For `write` / `edit`: uses the session cwd
		 * directly. Rule only fires if this matches.
		 */
		cwd?: string;
	};
	/** Message shown to the agent when blocked. Should be actionable. */
	reason: string;
	/** If true, no override escape hatch. Hard block. */
	noOverride?: boolean;
}

/**
 * `steering.json` contents. Merged across the global baseline, any ancestor
 * directories between `$HOME` and the session cwd, and the session cwd itself
 * (outermost-first, inner layers override by rule name).
 */
export interface SteeringConfig {
	/** Disable specific default rules by name. Additive across layers. */
	disable?: string[];
	/** Additional custom rules. Later layers override earlier ones by `name`. */
	rules?: Rule[];
	/**
	 * Config-level fallback for {@link Rule.noOverride} when a rule does not
	 * specify the field itself. Lets a whole config layer opt into a
	 * "strict-by-default" posture without repeating `noOverride: true` on
	 * every rule.
	 *
	 * Semantics (see README → "Config-level override default" for the full
	 * treatment):
	 *
	 *   effective-noOverride(rule) =
	 *     rule.noOverride ?? mergedConfig.defaultNoOverride ?? false
	 *
	 * - A rule with its own `noOverride` (true OR false) is unaffected — per-rule
	 *   settings always win. `noOverride: false` is a meaningful explicit
	 *   opt-in that forces overrides to be allowed regardless of the
	 *   config-level default.
	 * - A rule that omits `noOverride` falls back to this config-level default
	 *   when it's set, or `false` otherwise (preserving backward compatibility
	 *   for configs that never set the field).
	 *
	 * Merge (walk-up, outermost → innermost): inner layer's
	 * `defaultNoOverride` replaces the running value; a layer that doesn't set
	 * the field leaves the running value alone. The implicit default when no
	 * layer sets it is `false`.
	 */
	defaultNoOverride?: boolean;
}

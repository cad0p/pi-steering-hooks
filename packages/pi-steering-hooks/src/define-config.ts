// SPDX-License-Identifier: MIT
// Part of pi-steering.

/**
 * `defineConfig` — compile-time-typed config builder.
 *
 * Two supported authoring styles per the accepted ADR ("Design →
 * `defineConfig` and compile-time inference"):
 *
 *   1. **`defineConfig`** — uses `const`-generics on plugins / observers
 *      to infer the union of observer names, then constrains
 *      {@link Rule.observer} string references to that union. Typos in
 *      `observer: "description-read"` (when the plugin registers
 *      `description-reads`) produce a compile error.
 *
 *   2. **`satisfies SteeringConfig`** — plain TypeScript construct users
 *      can fall back to when they don't want the generic inference
 *      complexity. Gets shape validation but no cross-reference name
 *      checking.
 *
 * The function itself does minimal runtime work — it just returns the
 * config unchanged. All the value is in the types.
 *
 * Generics threaded through (ADR §8):
 *   - `AllObserverNames<P, Inline>` — for `Rule.observer` string refs.
 *   - `AllWrites<P, R, Inline>`     — for `Rule.when.happened.type`.
 *   - `AllRuleNames<P, R>`          — for `config.disabledRules`.
 *   - `AllPluginNames<P>`           — for `config.disabledPlugins`.
 *
 * All four helpers are exported from this module but NOT re-exported
 * from the package root; they're internal plumbing, not user-facing
 * API. Stable enough that plugin authors who import them directly can
 * rely on their shape within a single minor version, but the contract
 * is "use via defineConfig".
 */

import type {
	Observer,
	Plugin,
	Rule,
	SteeringConfig,
} from "./schema.ts";

/**
 * Extract the union of observer names registered across:
 *   - every plugin's `observers: Observer[]` array, AND
 *   - the top-level inline `observers: Observer[]` array.
 *
 * Used to constrain string references in {@link Rule.observer} so typos
 * surface as compile errors in `defineConfig` call sites.
 *
 * Falls back to `never` when no observers are registered (correct:
 * string references should be rejected entirely when there's nothing
 * to reference).
 */
export type AllObserverNames<
	P extends readonly Plugin[],
	Inline extends readonly Observer[],
> =
	| ObserversFromPlugins<P>
	| ObserversFromInline<Inline>;

/**
 * Distribute over the tuple of plugins to union each plugin's
 * observer names. `Plugin.observers` is optional — a plugin that
 * doesn't declare any contributes `never`.
 */
type ObserversFromPlugins<P extends readonly Plugin[]> =
	P extends readonly [infer First, ...infer Rest]
		? First extends Plugin
			? (First["observers"] extends infer O
					? O extends readonly Observer[]
						? ObserversFromInline<O>
						: never
					: never)
					| (Rest extends readonly Plugin[]
						? ObserversFromPlugins<Rest>
						: never)
			: never
		: never;

/** Project an Observer[] tuple to the union of its `name` literals. */
type ObserversFromInline<O extends readonly Observer[]> =
	O extends readonly (infer Element)[]
		? Element extends { name: infer N extends string }
			? N
			: never
		: never;

// ---------------------------------------------------------------------------
// AllPluginNames — union of plugin `.name` literals across loaded plugins.
// ---------------------------------------------------------------------------

/**
 * Extract the union of plugin names registered in the `plugins` tuple.
 *
 * Used to constrain {@link SteeringConfig.disabledPlugins} so typos
 * surface as compile errors.
 *
 * Falls back to `never` when no plugins are registered — typing
 * `disabledPlugins` against an empty registry rejects every string (a
 * deliberate fail-closed choice: the only valid value is the empty
 * tuple, matching the user's stated intent).
 */
export type AllPluginNames<P extends readonly Plugin[]> =
	P extends readonly [infer First, ...infer Rest]
		? First extends { name: infer N extends string }
			? N | (Rest extends readonly Plugin[] ? AllPluginNames<Rest> : never)
			: Rest extends readonly Plugin[]
				? AllPluginNames<Rest>
				: never
		: never;

// ---------------------------------------------------------------------------
// AllRuleNames — union of rule `.name` literals across plugins + user rules.
// ---------------------------------------------------------------------------

/**
 * Extract the union of rule names across:
 *   - every plugin's `rules: Rule[]` array, AND
 *   - the top-level inline `rules: Rule[]` array.
 *
 * Used to constrain {@link SteeringConfig.disabledRules} so typos surface as
 * compile errors. Falls back to `never` when no rules are registered.
 */
export type AllRuleNames<
	P extends readonly Plugin[],
	R extends readonly Rule[],
> =
	| RuleNamesFromPlugins<P>
	| RuleNamesFromInline<R>;

type RuleNamesFromPlugins<P extends readonly Plugin[]> =
	P extends readonly [infer First, ...infer Rest]
		? First extends Plugin
			? (First["rules"] extends infer Rs
					? Rs extends readonly Rule[]
						? RuleNamesFromInline<Rs>
						: never
					: never)
					| (Rest extends readonly Plugin[]
						? RuleNamesFromPlugins<Rest>
						: never)
			: never
		: never;

type RuleNamesFromInline<R extends readonly Rule[]> =
	R extends readonly (infer Element)[]
		? Element extends { name: infer N extends string }
			? N
			: never
		: never;

// ---------------------------------------------------------------------------
// AllWrites — union of `writes[]` literals across rules + observers.
// ---------------------------------------------------------------------------

/**
 * Extract the union of session-entry custom types declared via `writes`
 * arrays across:
 *   - every plugin's `rules: Rule[]` (rule-side writes via `onFire`),
 *   - every plugin's `observers: Observer[]` (observer-side writes),
 *   - the top-level inline `rules`, AND
 *   - the top-level inline `observers`.
 *
 * Used to constrain {@link WhenClause.happened} `type` so typos
 * (e.g., `happened: { type: "sync-don" }` when the observer writes
 * `"sync-done"`) surface as compile errors.
 *
 * Authors who omit `writes` on a rule/observer don't contribute to the
 * union — the rule's write is undeclared, and any downstream
 * `when.happened.type` referencing it will be rejected. Matches the
 * "declare your writes" discipline that `writes[]` encourages.
 */
export type AllWrites<
	P extends readonly Plugin[],
	R extends readonly Rule[],
	Inline extends readonly Observer[] = readonly [],
> =
	| WritesFromPluginRules<P>
	| WritesFromPluginObservers<P>
	| WritesFromRules<R>
	| WritesFromObservers<Inline>;

type WritesFromRules<R extends readonly Rule[]> =
	R extends readonly (infer Element)[]
		? Element extends { writes: infer W }
			? W extends readonly (infer S)[]
				? S extends string
					? S
					: never
				: never
			: never
		: never;

type WritesFromObservers<O extends readonly Observer[]> =
	O extends readonly (infer Element)[]
		? Element extends { writes: infer W }
			? W extends readonly (infer S)[]
				? S extends string
					? S
					: never
				: never
			: never
		: never;

type WritesFromPluginRules<P extends readonly Plugin[]> =
	P extends readonly [infer First, ...infer Rest]
		? First extends Plugin
			? (First["rules"] extends infer Rs
					? Rs extends readonly Rule[]
						? WritesFromRules<Rs>
						: never
					: never)
					| (Rest extends readonly Plugin[]
						? WritesFromPluginRules<Rest>
						: never)
			: never
		: never;

type WritesFromPluginObservers<P extends readonly Plugin[]> =
	P extends readonly [infer First, ...infer Rest]
		? First extends Plugin
			? (First["observers"] extends infer Os
					? Os extends readonly Observer[]
						? WritesFromObservers<Os>
						: never
					: never)
					| (Rest extends readonly Plugin[]
						? WritesFromPluginObservers<Rest>
						: never)
			: never
		: never;

// ---------------------------------------------------------------------------
// DefineConfigInput
// ---------------------------------------------------------------------------

/**
 * Config author surface — the shape `defineConfig` accepts. Matches
 * {@link SteeringConfig} but with `const`-generic tuple slots on
 * `plugins` / `rules` / `observers` so tuple literal types survive
 * through the call and drive name inference.
 *
 * Generic constraints:
 *   - `disabledRules` / `disabledPlugins` typed against the rule / plugin
 *     name unions — typos rejected at compile time.
 *   - `rules[].when.happened.type` typed against `AllWrites` — typos
 *     rejected at compile time.
 */
export interface DefineConfigInput<
	P extends readonly Plugin[],
	Inline extends readonly Observer[],
	R extends readonly Rule<
		AllObserverNames<P, Inline>,
		AllWrites<P, R, Inline>
	>[],
> {
	defaultNoOverride?: boolean;
	disabledRules?: readonly AllRuleNames<P, R>[];
	disabledPlugins?: readonly AllPluginNames<P>[];
	disableDefaults?: boolean;
	plugins?: P;
	rules?: R;
	observers?: Inline;
}

/**
 * Build a {@link SteeringConfig} with cross-reference name checking.
 *
 * Observer references in {@link Rule.observer} are typed against the
 * union of observer names gathered from `plugins[*].observers` AND the
 * top-level `observers` array — a typo produces a compile error.
 *
 * The `disabledRules` / `disabledPlugins` arrays are typed against the unions
 * of registered rule / plugin names — typos rejected.
 *
 * `rules[].when.happened.type` is typed against the union of all
 * `writes` declarations across plugin rules, plugin observers, user
 * rules, and user observers — typos rejected.
 *
 * Runtime behavior: returns a shallow copy of the input with optional
 * fields normalized from `readonly` arrays to mutable arrays (the
 * {@link SteeringConfig} shape doesn't constrain mutability). The
 * return value is safe to pass to the loader / buildConfig.
 *
 * ## Authoring pattern — preserving observer/plugin names for inference
 *
 * For compile-time typo detection on rule `observer` references, declare
 * your observers and plugins with `as const satisfies` so TypeScript
 * preserves the literal `name` values through to `AllObserverNames`:
 *
 *     const myObs = {
 *       name: "description-read",
 *       onResult: (event, ctx) => { ... },
 *     } as const satisfies Observer;
 *
 *     const myPlugin = {
 *       name: "my-plugin",
 *       observers: [{ name: "sync-done", onResult: ... }],
 *     } as const satisfies Plugin;
 *
 * Authors who prefer type annotations (`const myObs: Observer = ...`)
 * get widened `name: string`, which collapses `AllObserverNames` to
 * `string` and silently disables typo detection. Use `as const satisfies`
 * to keep the inference.
 *
 * ## Behavior with no observers declared
 *
 * When no plugins contribute observers AND no inline `observers[]` is
 * passed, `AllObserverNames` resolves to `never`, which causes ANY
 * string `observer` reference on a Rule to be a compile error. This is
 * deliberate — fail-closed on unknown observer names. For configs that
 * deliberately reference observers by name without registering them
 * inline (e.g., deferred to runtime), use `satisfies SteeringConfig`
 * as a fallback; you lose typo detection but regain flexibility.
 *
 * @example
 *   export default defineConfig({
 *     plugins: [gitPlugin],
 *     observers: [descriptionReadObserver],
 *     rules: [
 *       { name: "must-read-docs", ..., observer: "description-read" },
 *     ],
 *   });
 */
export function defineConfig<
	const P extends readonly Plugin[] = [],
	const Inline extends readonly Observer[] = [],
	const R extends readonly Rule<
		AllObserverNames<P, Inline>,
		AllWrites<P, R, Inline>
	>[] = [],
>(config: DefineConfigInput<P, Inline, R>): SteeringConfig {
	// Runtime work is minimal: copy the supplied config, widening the
	// `readonly` tuple slots back to plain arrays for downstream
	// consumers (loader, evaluator) that don't care about the tuple
	// literal types. The generic machinery's job is done at the call
	// site — once we return, we return plain SteeringConfig.
	const out: SteeringConfig = {};
	if (config.defaultNoOverride !== undefined) {
		out.defaultNoOverride = config.defaultNoOverride;
	}
	if (config.disabledRules !== undefined) {
		out.disabledRules = [...config.disabledRules];
	}
	if (config.disabledPlugins !== undefined) {
		out.disabledPlugins = [...config.disabledPlugins];
	}
	if (config.disableDefaults !== undefined) {
		out.disableDefaults = config.disableDefaults;
	}
	if (config.plugins !== undefined) {
		// Cast: `readonly Plugin[]` → `Plugin[]` (shape is identical;
		// the loader never mutates the array, but SteeringConfig
		// doesn't require readonly).
		out.plugins = [...config.plugins];
	}
	if (config.rules !== undefined) {
		out.rules = [...config.rules] as Rule[];
	}
	if (config.observers !== undefined) {
		out.observers = [...config.observers];
	}
	return out;
}

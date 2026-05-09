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
 *   - `AllWrites<P, R, Inline>`     — for `Rule.when.happened.event`.
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

// ---------------------------------------------------------------------------
// Type-level plumbing: project `name` / `writes` literals off tuples of
// rules, observers, or plugins.
// ---------------------------------------------------------------------------

/**
 * Pull a single projection off every element of an array type.
 *
 *   - `K = "name"`   — value is the element's `name` literal
 *                       (`{ name: N }` → `N`).
 *   - `K = "writes"` — value is each element of the element's
 *                       `writes` tuple (`{ writes: readonly [..., S] }`
 *                       → `S`).
 *
 * Elements missing the field (optional `writes`, widened `name`)
 * contribute `never`. Non-tuple `T` inputs short-circuit to `never`.
 */
type ProjectField<T, K extends "name" | "writes"> =
	T extends readonly (infer E)[]
		? E extends Record<K, infer V>
			? K extends "writes"
				? V extends readonly (infer S extends string)[]
					? S
					: never
				: V extends string
					? V
					: never
			: never
		: never;

/**
 * Walk a tuple of plugins and union a {@link ProjectField} projection
 * across every plugin's `Source` array (`"rules"` or `"observers"`).
 *
 * Replaces four near-identical recursive walkers that differed only in
 * `(Source, K)` pair — see git blame for the pre-R2 shape.
 */
type FromPluginField<
	P extends readonly Plugin[],
	Source extends "rules" | "observers",
	K extends "name" | "writes",
> = P extends readonly [infer First, ...infer Rest]
	? (
			First extends Plugin
				? First[Source] extends infer X
					? X extends readonly (Rule | Observer)[]
						? ProjectField<X, K>
						: never
					: never
				: never
		)
			| (Rest extends readonly Plugin[]
					? FromPluginField<Rest, Source, K>
					: never)
	: never;

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
	| FromPluginField<P, "observers", "name">
	| ProjectField<Inline, "name">;

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
	| FromPluginField<P, "rules", "name">
	| ProjectField<R, "name">;

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
 * Used to constrain {@link WhenClause.happened} `event` so typos
 * (e.g., `happened: { event: "sync-don" }` when the observer writes
 * `"sync-done"`) surface as compile errors.
 *
 * Authors who omit `writes` on a rule/observer don't contribute to the
 * union — the rule's write is undeclared, and any downstream
 * `when.happened.event` referencing it will be rejected. Matches the
 * "declare your writes" discipline that `writes[]` encourages.
 */
export type AllWrites<
	P extends readonly Plugin[],
	R extends readonly Rule[],
	Inline extends readonly Observer[] = readonly [],
> =
	| FromPluginField<P, "rules", "writes">
	| FromPluginField<P, "observers", "writes">
	| ProjectField<R, "writes">
	| ProjectField<Inline, "writes">;

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
 *   - `rules[].when.happened.event` and `rules[].when.happened.since`
 *     are both typed against `AllWrites` — typos rejected at compile
 *     time.
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
 * `rules[].when.happened.event` and `rules[].when.happened.since` are
 * both typed against the union of all `writes` declarations across
 * plugin rules, plugin observers, user rules, and user observers —
 * typos rejected. (The `since` field on the `Writes` union enforces
 * the same contract as `event`: the sentinel event must be known to
 * the config, not a free-form string.)
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

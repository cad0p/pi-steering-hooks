// SPDX-License-Identifier: MIT
// Part of @cad0p/pi-steering-hooks.

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

/**
 * Config author surface — the shape `defineConfig` accepts. Matches
 * {@link SteeringConfig} but with `const`-generic tuple slots on
 * `plugins` / `rules` / `observers` so tuple literal types survive
 * through the call and drive name inference.
 */
export interface DefineConfigInput<
	P extends readonly Plugin[],
	Inline extends readonly Observer[],
	R extends readonly Rule<AllObserverNames<P, Inline>>[],
> {
	defaultNoOverride?: boolean;
	disable?: readonly string[];
	disablePlugins?: readonly string[];
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
	const R extends readonly Rule<AllObserverNames<P, Inline>>[] = [],
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
	if (config.disable !== undefined) out.disable = [...config.disable];
	if (config.disablePlugins !== undefined) {
		out.disablePlugins = [...config.disablePlugins];
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

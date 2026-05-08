// SPDX-License-Identifier: MIT
// Part of @cad0p/pi-steering-hooks.

/**
 * Plugin merger — flatten a list of plugins + a SteeringConfig into a
 * single `ResolvedPluginState` the evaluator and observer dispatcher can
 * drive off directly.
 *
 * Per the accepted ADR ("Design → Plugin schema" and "Precedence:
 * first-wins everywhere"):
 *
 *   - predicates / rules / observers — first-registered wins on name
 *     collision; later entries logged as WARNings.
 *   - trackers — HARD ERROR on name collision (two plugins claiming the
 *     same state dimension is always a bug, not a soft-override).
 *   - trackerExtensions — later plugins can layer modifiers onto an
 *     existing tracker under a `(tracker, basename)` slot. Multiple
 *     entries under the same slot are preserved in registration order.
 *     Extensions targeting an unregistered tracker are warned about and
 *     ignored.
 *   - config.disable / config.disablePlugins — filter rules and whole
 *     plugins by name. `config.disableDefaults` is the caller's problem:
 *     the caller chooses whether to include DEFAULT_PLUGINS in the input
 *     list (handled upstream by the extension runtime).
 *
 * The composed trackers map returned here is what the runtime passes to
 * `walk()`; the raw `trackers` map from individual plugins is kept on
 * the result as well for introspection / tests.
 */

import type { Modifier, Tracker } from "unbash-walker";
import type {
	Observer,
	Plugin,
	PredicateHandler,
	Rule,
	SteeringConfig,
} from "./schema.ts";

/**
 * Soft warning surfaced during plugin resolution. The runtime logs these
 * at startup; tests consume the array directly.
 */
export interface PluginResolveWarning {
	/**
	 * Discriminator for what kind of collision / misconfiguration fired.
	 *
	 *   - `"predicate-collision"`  — two plugins register `when.<same-key>`.
	 *   - `"observer-collision"`   — two observers share the same name.
	 *   - `"rule-collision"`       — two plugin-shipped rules share a name.
	 *   - `"plugin-disabled"`      — a plugin was skipped via `disablePlugins`.
	 *   - `"extension-orphan"`     — trackerExtension targets a tracker no
	 *                                plugin registers.
	 *   - `"rule-disabled"`        — a rule was removed via `config.disable`.
	 */
	kind:
		| "predicate-collision"
		| "observer-collision"
		| "rule-collision"
		| "plugin-disabled"
		| "extension-orphan"
		| "rule-disabled";
	message: string;
}

/**
 * Fully-resolved plugin state: the evaluator + observer dispatcher drive
 * off this shape. All maps / arrays are freshly built and safe for the
 * caller to stash on the extension closure.
 */
export interface ResolvedPluginState {
	/** Plugin-registered predicate handlers, keyed by `when.<key>`. */
	predicates: Record<string, PredicateHandler>;

	/** Observers in registration order, deduped by name. */
	observers: Observer[];

	/**
	 * Plugin-declared trackers (NOT yet composed with trackerExtensions).
	 * Exposed for introspection and tests; the runtime should use
	 * {@link composedTrackers} when calling {@link walk}.
	 */
	trackers: Record<string, Tracker<unknown>>;

	/**
	 * Modifiers layered on by `trackerExtensions`, keyed by
	 * `[trackerName][basename]`. Multiple modifiers under one slot are
	 * appended in registration order. Consumers typically use
	 * {@link composedTrackers} instead.
	 */
	trackerModifiers: Record<
		string,
		Record<string, Modifier<unknown>[]>
	>;

	/**
	 * Trackers after applying {@link trackerModifiers} on top of each
	 * plugin's own `modifiers` map. This is the map that gets passed to
	 * unbash-walker's `walk()` at evaluation time.
	 */
	composedTrackers: Record<string, Tracker<unknown>>;

	/** Plugin-shipped rules in registration order, deduped by name. */
	rules: Rule[];

	/** Non-fatal issues observed during merge. */
	warnings: PluginResolveWarning[];
}

/**
 * Treat either a single Modifier or an array of them as an array, without
 * allocating when the input is already an array. Returns a fresh array
 * so callers can mutate safely.
 */
function toModifierList<T>(
	value: Modifier<T> | readonly Modifier<T>[],
): Modifier<T>[] {
	return Array.isArray(value) ? [...value] : [value as Modifier<T>];
}

/**
 * Build a new tracker with `extras` modifiers appended to the tracker's
 * own `modifiers` map. Existing basename entries become arrays with the
 * extras appended; new basenames land as their own entries.
 *
 * Intentionally non-mutating — the input tracker may be shared across
 * test runs or plugin registrations, so we copy before layering.
 */
function composeTracker(
	tracker: Tracker<unknown>,
	extras: Record<string, Modifier<unknown>[]> | undefined,
): Tracker<unknown> {
	if (!extras || Object.keys(extras).length === 0) return tracker;

	const merged: Record<string, Modifier<unknown> | Modifier<unknown>[]> = {};
	// Start with the tracker's own modifiers (shallow-copy the values so
	// we don't mutate the original map when we append extras below).
	for (const [basename, mod] of Object.entries(tracker.modifiers)) {
		merged[basename] = Array.isArray(mod)
			? [...(mod as Modifier<unknown>[])]
			: mod;
	}
	for (const [basename, mods] of Object.entries(extras)) {
		const existing = merged[basename];
		if (existing === undefined) {
			// Fresh basename: preserve array form when multiple extras land
			// together, collapse to single when there's just one.
			merged[basename] = mods.length === 1 ? mods[0]! : [...mods];
			continue;
		}
		const existingList = Array.isArray(existing)
			? (existing as Modifier<unknown>[])
			: [existing as Modifier<unknown>];
		merged[basename] = [...existingList, ...mods];
	}

	return {
		...tracker,
		modifiers: merged,
	};
}

/**
 * Merge a list of plugins together, applying the config's `disable` /
 * `disablePlugins` filters along the way.
 *
 * The caller is responsible for composing the plugin list — including
 * whether to prepend DEFAULT_PLUGINS. This function does not consult
 * `config.disableDefaults`; that decision sits one layer up in the
 * extension runtime.
 *
 * Collision semantics per the ADR:
 *   - predicate / observer / plugin-shipped-rule name collision — first
 *     wins, WARN logged.
 *   - tracker name collision — THROWS.
 *   - trackerExtension targeting an unregistered tracker — WARN,
 *     extension ignored.
 *
 * `knownBuiltinTrackers` lists tracker names the caller guarantees are
 * injected at a later wiring stage (e.g. the evaluator's built-in
 * `cwd` tracker). Extensions targeting these names are KEPT in
 * `trackerModifiers` (so the caller can compose them onto the built-in
 * tracker) without emitting an orphan warning. Omitted / empty list
 * means "no built-ins" — every extension must target a
 * plugin-registered tracker.
 */
export function resolvePlugins(
	plugins: readonly Plugin[],
	config: SteeringConfig,
	knownBuiltinTrackers: readonly string[] = [],
): ResolvedPluginState {
	const warnings: PluginResolveWarning[] = [];
	const disabledPlugins = new Set(config.disablePlugins ?? []);
	const disabledRules = new Set(config.disable ?? []);

	// Filter plugins honoring `disablePlugins`. Record disabled ones so
	// callers see them in the warning log (handy for debugging a rule
	// that inexplicably stopped firing).
	const activePlugins: Plugin[] = [];
	for (const plugin of plugins) {
		if (disabledPlugins.has(plugin.name)) {
			warnings.push({
				kind: "plugin-disabled",
				message: `plugin "${plugin.name}" disabled via config.disablePlugins`,
			});
			continue;
		}
		activePlugins.push(plugin);
	}

	// --- trackers ----------------------------------------------------------
	// Hard-error on name collisions: two plugins claiming the same state
	// dimension is always a bug.
	const trackers: Record<string, Tracker<unknown>> = {};
	const trackerOwner = new Map<string, string>(); // trackerName -> pluginName
	for (const plugin of activePlugins) {
		if (!plugin.trackers) continue;
		for (const [name, tracker] of Object.entries(plugin.trackers)) {
			const prior = trackerOwner.get(name);
			if (prior !== undefined) {
				throw new Error(
					`[pi-steering-hooks] tracker name collision: ` +
						`both plugins "${prior}" and "${plugin.name}" register ` +
						`a tracker called "${name}". Two plugins claiming the ` +
						`same state dimension is always a bug — rename one ` +
						`tracker or disable one plugin.`,
				);
			}
			trackerOwner.set(name, plugin.name);
			trackers[name] = tracker;
		}
	}

	// --- tracker extensions ----------------------------------------------
	// Modifiers to layer onto trackers, keyed by [trackerName][basename].
	// Registration order is preserved — matches
	// `Tracker.modifiers: Record<basename, Modifier | Modifier[]>`'s "apply
	// left-to-right" semantics.
	const trackerModifiers: Record<
		string,
		Record<string, Modifier<unknown>[]>
	> = {};
	const builtins = new Set(knownBuiltinTrackers);
	for (const plugin of activePlugins) {
		if (!plugin.trackerExtensions) continue;
		for (const [trackerName, basenameMap] of Object.entries(
			plugin.trackerExtensions,
		)) {
			if (!(trackerName in trackers) && !builtins.has(trackerName)) {
				warnings.push({
					kind: "extension-orphan",
					message:
						`plugin "${plugin.name}" extends tracker "${trackerName}" ` +
						`but no plugin registers it; extension ignored`,
				});
				continue;
			}
			const trackerBucket =
				trackerModifiers[trackerName] ??
				(trackerModifiers[trackerName] = {});
			for (const [basename, mods] of Object.entries(basenameMap)) {
				const list = toModifierList<unknown>(mods);
				const existing = trackerBucket[basename];
				if (existing === undefined) {
					trackerBucket[basename] = list;
				} else {
					existing.push(...list);
				}
			}
		}
	}

	// Compose extensions ON TOP of each tracker's own modifiers map.
	const composedTrackers: Record<string, Tracker<unknown>> = {};
	for (const [name, tracker] of Object.entries(trackers)) {
		composedTrackers[name] = composeTracker(tracker, trackerModifiers[name]);
	}

	// --- predicates --------------------------------------------------------
	const predicates: Record<string, PredicateHandler> = {};
	const predicateOwner = new Map<string, string>();
	for (const plugin of activePlugins) {
		if (!plugin.predicates) continue;
		for (const [key, handler] of Object.entries(plugin.predicates)) {
			const prior = predicateOwner.get(key);
			if (prior !== undefined) {
				warnings.push({
					kind: "predicate-collision",
					message:
						`duplicate predicate "when.${key}" — plugins "${prior}" ` +
						`(kept) and "${plugin.name}" (ignored); first-registered wins`,
				});
				continue;
			}
			predicateOwner.set(key, plugin.name);
			predicates[key] = handler;
		}
	}

	// --- observers ---------------------------------------------------------
	const observers: Observer[] = [];
	const observerOwner = new Map<string, string>();
	for (const plugin of activePlugins) {
		if (!plugin.observers) continue;
		for (const observer of plugin.observers) {
			const prior = observerOwner.get(observer.name);
			if (prior !== undefined) {
				warnings.push({
					kind: "observer-collision",
					message:
						`duplicate observer "${observer.name}" — plugins "${prior}" ` +
						`(kept) and "${plugin.name}" (ignored); first-registered wins`,
				});
				continue;
			}
			observerOwner.set(observer.name, plugin.name);
			observers.push(observer);
		}
	}

	// --- rules -------------------------------------------------------------
	// Plugin-shipped rules; config.rules stay in their own slot on the
	// caller side. `config.disable` filters BOTH plugin rules and config
	// rules, so we apply it here for plugin rules and the runtime applies
	// it again on the config side.
	const rules: Rule[] = [];
	const ruleOwner = new Map<string, string>();
	for (const plugin of activePlugins) {
		if (!plugin.rules) continue;
		for (const rule of plugin.rules) {
			if (disabledRules.has(rule.name)) {
				warnings.push({
					kind: "rule-disabled",
					message: `rule "${rule.name}" (from plugin "${plugin.name}") disabled via config.disable`,
				});
				continue;
			}
			const prior = ruleOwner.get(rule.name);
			if (prior !== undefined) {
				warnings.push({
					kind: "rule-collision",
					message:
						`duplicate rule "${rule.name}" — plugins "${prior}" ` +
						`(kept) and "${plugin.name}" (ignored); first-registered wins`,
				});
				continue;
			}
			ruleOwner.set(rule.name, plugin.name);
			rules.push(rule);
		}
	}

	return {
		predicates,
		observers,
		trackers,
		trackerModifiers,
		composedTrackers,
		rules,
		warnings,
	};
}

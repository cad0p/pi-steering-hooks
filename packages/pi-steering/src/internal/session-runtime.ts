// SPDX-License-Identifier: MIT
// Part of pi-steering.

/**
 * Internal module \u2014 not part of the package's public API.
 *
 * This module holds the per-session wiring that `register()` uses to
 * spin up an evaluator + observer dispatcher from a walk-up steering
 * config. It is intentionally NOT re-exported from `index.ts` or any
 * other public entry point; consumers building their own extensions
 * should go through `loadHarness` (subpath `pi-steering/testing`)
 * or call `buildEvaluator` / `buildObserverDispatcher` directly.
 *
 * The sole reason this lives outside `register()` is so the two-pass
 * `disableDefaults` merge can be unit-tested without standing up a
 * pi runtime stub. `src/index.test.ts` imports from this path
 * directly \u2014 the `internal/` boundary lets us keep that test coverage
 * without freezing the helper as public API.
 */

import { DEFAULT_PLUGINS, DEFAULT_RULES } from "../defaults.ts";
import {
	buildEvaluator,
	type EvaluatorRuntime,
	type EvaluatorHost,
} from "../evaluator.ts";
import { buildConfig, loadConfigs } from "../loader.ts";
import {
	buildObserverDispatcher,
	type ObserverDispatcher,
} from "../observer-dispatcher.ts";
import { resolvePlugins } from "../plugin-merger.ts";
import type { SteeringConfig } from "../schema.ts";

/**
 * Build the per-session evaluator + observer dispatcher from the walk-
 * up config rooted at `cwd`. Two-pass merge so `disableDefaults: true`
 * in any layer is honored before defaults are injected:
 *
 *   1. `loadConfigs(cwd)` \u2014 async IO, read every layer from cwd \u2192
 *      $HOME.
 *   2. `buildConfig(layers)` with NO defaults \u2014 lets us peek at the
 *      merged `disableDefaults` flag without DEFAULT_RULES /
 *      DEFAULT_PLUGINS polluting the result.
 *   3. Re-run `buildConfig(layers, defaults?)` with defaults
 *      conditional on `disableDefaults`, producing the effective
 *      config.
 *   4. Apply `config.disabledRules` to the merged `rules` \u2014 the plugin
 *      merger handles this for plugin-shipped rules, but
 *      `buildConfig` leaves user/default rules in `config.rules`
 *      untouched on the assumption that the caller (this function)
 *      filters them before handing off to `buildEvaluator`.
 *
 * Factored out of `register()` so the wiring is unit-testable without
 * a pi runtime stub.
 */
export async function buildSessionRuntime(
	cwd: string,
	host: EvaluatorHost,
): Promise<{
	evaluator: EvaluatorRuntime;
	dispatcher: ObserverDispatcher;
	config: SteeringConfig;
}> {
	const rawLayers = await loadConfigs(cwd);
	// First merge without defaults: we only need `disableDefaults` at
	// this point, and layering defaults in would make the check
	// meaningless (defaults shouldn't themselves opt into
	// `disableDefaults`).
	const probe = buildConfig(rawLayers);
	const defaults: SteeringConfig | undefined = probe.disableDefaults
		? undefined
		: { rules: DEFAULT_RULES, plugins: DEFAULT_PLUGINS };
	const merged = buildConfig(rawLayers, defaults);

	// Apply `disabledRules` to the merged rule set. Plugin-shipped rules
	// are filtered inside `resolvePlugins`; user / default rules go
	// through `config.rules` on the evaluator side, so we filter them
	// here to keep the semantic consistent across both sources.
	const disabled = new Set(merged.disabledRules ?? []);
	const filteredConfig: SteeringConfig = { ...merged };
	if (merged.rules !== undefined) {
		const kept = merged.rules.filter((r) => !disabled.has(r.name));
		if (kept.length > 0) filteredConfig.rules = kept;
		else delete filteredConfig.rules;
	}

	const resolved = resolvePlugins(
		filteredConfig.plugins ?? [],
		filteredConfig,
		// `cwd` is injected by the evaluator (the built-in `cwdTracker`);
		// extensions targeting it are valid and must not be treated as
		// orphans. Any other built-in tracker the evaluator introduces
		// later should be added here.
		["cwd"],
	);
	const evaluator = buildEvaluator(filteredConfig, resolved, host);
	const dispatcher = buildObserverDispatcher(
		resolved,
		filteredConfig.observers ?? [],
		host,
	);
	return { evaluator, dispatcher, config: filteredConfig };
}

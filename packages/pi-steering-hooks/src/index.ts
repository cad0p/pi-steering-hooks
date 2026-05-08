// SPDX-License-Identifier: MIT
// Part of @cad0p/pi-steering-hooks.
//
// @cad0p/pi-steering-hooks — deterministic steering hooks for pi agents.
// Inspired by @samfp/pi-steering-hooks (schema, override-comment,
// defaults). AST backend + command-level effective-cwd via
// unbash-walker. This file is the thin wiring layer between pi's
// extension API and the v2 engine (loader + plugin-merger + evaluator
// + observer-dispatcher).

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { DEFAULT_PLUGINS, DEFAULT_RULES } from "./v2/defaults.ts";
import {
	buildEvaluator,
	type EvaluatorRuntime,
	type EvaluatorHost,
} from "./v2/evaluator.ts";
import { buildConfig, loadConfigs } from "./v2/loader.ts";
import {
	buildObserverDispatcher,
	type ObserverDispatcher,
} from "./v2/observer-dispatcher.ts";
import { resolvePlugins } from "./v2/plugin-merger.ts";
import type { SteeringConfig } from "./v2/schema.ts";

/**
 * Pi extension factory. Wires the v2 steering engine onto pi's
 * lifecycle events:
 *
 *   - `agent_start`  — bump the internal `agentLoopIndex` counter so
 *                       tool_call / tool_result handlers can forward it
 *                       into the evaluator + dispatcher. One agent loop
 *                       = one user prompt + all the tool calls it spawns.
 *   - `session_start` — load the walk-up config (inner-first), merge
 *                       with DEFAULT_RULES + DEFAULT_PLUGINS unless
 *                       `disableDefaults: true` is set anywhere in the
 *                       walk-up chain, then build the evaluator +
 *                       dispatcher. A broken config layer is logged
 *                       and skipped by the loader; a thrown error at
 *                       build time disables the extension for this
 *                       session (fail-open rather than blocking every
 *                       tool call).
 *   - `tool_call`     — gate via the evaluator. Returns a
 *                       ToolCallEventResult to block or `undefined` to
 *                       allow.
 *   - `tool_result`   — dispatch to all matching observers.
 *
 * Exported as the default export per pi's extension convention.
 */
export default function register(pi: ExtensionAPI): void {
	let agentLoopIndex = 0;
	let evaluator: EvaluatorRuntime | null = null;
	let dispatcher: ObserverDispatcher | null = null;

	// Narrow host surface the evaluator + dispatcher need. `bind(pi)`
	// preserves the `this` context on the API methods (some pi
	// implementations rely on it; binding is cheap insurance and
	// identical to pi's own call sites).
	const host: EvaluatorHost = {
		exec: pi.exec.bind(pi),
		appendEntry: pi.appendEntry.bind(pi),
	};

	pi.on("agent_start", () => {
		agentLoopIndex += 1;
	});

	pi.on("session_start", async (_event, ctx: ExtensionContext) => {
		try {
			const { evaluator: ev, dispatcher: dp } = await buildSessionRuntime(
				ctx.cwd,
				host,
			);
			evaluator = ev;
			dispatcher = dp;
		} catch (err) {
			console.error(
				`[pi-steering-hooks] Failed to load steering config: ` +
					`${err instanceof Error ? err.message : String(err)}. ` +
					`Extension will not block any tool calls for this session.`,
			);
			evaluator = null;
			dispatcher = null;
		}
	});

	pi.on("tool_call", async (event, ctx) => {
		if (!evaluator) return;
		return evaluator.evaluate(event, ctx, agentLoopIndex);
	});

	pi.on("tool_result", async (event, ctx) => {
		if (!dispatcher) return;
		await dispatcher.dispatch(event, ctx, agentLoopIndex);
	});
}

/**
 * Build the per-session evaluator + observer dispatcher from the walk-
 * up config rooted at `cwd`. Two-pass merge so `disableDefaults: true`
 * in any layer is honored before defaults are injected:
 *
 *   1. `loadConfigs(cwd)` — async IO, read every layer from cwd →
 *      $HOME.
 *   2. `buildConfig(layers)` with NO defaults — lets us peek at the
 *      merged `disableDefaults` flag without DEFAULT_RULES /
 *      DEFAULT_PLUGINS polluting the result.
 *   3. Re-run `buildConfig(layers, defaults?)` with defaults
 *      conditional on `disableDefaults`, producing the effective
 *      config.
 *   4. Apply `config.disable` to the merged `rules` — the plugin
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

	// Apply `disable` to the merged rule set. Plugin-shipped rules are
	// filtered inside `resolvePlugins`; user / default rules go through
	// `config.rules` on the evaluator side, so we filter them here to
	// keep the semantic consistent across both sources.
	const disabled = new Set(merged.disable ?? []);
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

// ---------------------------------------------------------------------------
// Public surface — the v2 engine.
//
// Consumers embedding the engine (building their own extensions, a CLI
// that lints commands, a test harness, …) import these from the
// package root.
// ---------------------------------------------------------------------------

export { DEFAULT_PLUGINS, DEFAULT_RULES } from "./v2/defaults.ts";

export {
	buildConfig,
	defineConfig,
	fromJSON,
	FromJSONError,
	loadConfigs,
	loadSteeringConfig,
} from "./v2/index.ts";

export type {
	ExecOpts,
	ExecResult,
	Observer,
	ObserverContext,
	ObserverWatch,
	Pattern,
	Plugin,
	PredicateContext,
	PredicateFn,
	PredicateHandler,
	PredicateToolInput,
	Rule,
	SteeringConfig,
	ToolResultEvent,
	WhenClause,
} from "./v2/index.ts";

// Walker types re-exported for plugin authors. Forward-compatible with
// future unbash-walker extraction — imports from this package won't
// break.
export type {
	CommandRef,
	Command,
	Modifier,
	Node,
	Script,
	SubshellSemantics,
	Tracker,
	WalkResult,
} from "unbash-walker";

// Walker functions re-exported for plugin authors writing custom
// predicates and trackers. Forward-compatible with future
// unbash-walker extraction.
export {
	cwdTracker,
	expandWrapperCommands,
	extractAllCommandsFromAST,
	formatCommand,
	getBasename,
	getCommandArgs,
	getCommandName,
	isStaticallyResolvable,
	parse,
	walk,
} from "unbash-walker";

// Testing primitives — re-exported at the root for discoverability.
// The canonical import path is `@cad0p/pi-steering-hooks/testing`;
// this root re-export means a test file that already imports
// `defineConfig` from the root doesn't need a second import line for
// `loadHarness`. See `./testing/index.ts` for the API docs.
export {
	expectAllows,
	expectBlocks,
	expectRuleFires,
	formatMatrix,
	getAppendedEntries,
	loadHarness,
	mockContext,
	mockObserverContext,
	runMatrix,
	testObserver,
	testPredicate,
} from "./testing/index.ts";

export type {
	BashShorthand,
	EditShorthand,
	ExpectBlocksOptions,
	Harness,
	LoadHarnessOptions,
	MatrixCase,
	MatrixCaseResult,
	MatrixResult,
	MockContextOptions,
	MockObserverContextOptions,
	MockEntry,
	ToolCallShorthand,
	ToolResultShorthand,
	WriteShorthand,
} from "./testing/index.ts";

// SPDX-License-Identifier: MIT
// Part of pi-steering.
//
// pi-steering — deterministic steering hooks for pi agents.
// Inspired by @samfp/pi-steering-hooks (schema, override-comment,
// defaults). AST backend + command-level effective-cwd via
// unbash-walker. This file is the thin wiring layer between pi's
// extension API and the engine (loader + plugin-merger + evaluator
// + observer-dispatcher).

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { buildSessionRuntime } from "./internal/session-runtime.ts";
import type { EvaluatorRuntime, EvaluatorHost } from "./evaluator.ts";
import type { ObserverDispatcher } from "./observer-dispatcher.ts";

/**
 * Pi extension factory. Wires the steering engine onto pi's
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
				`[pi-steering] Failed to load steering config: ` +
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

// ---------------------------------------------------------------------------
// Public surface — the engine.
//
// Consumers embedding the engine (building their own extensions, a CLI
// that lints commands, a test harness, …) import these from the
// package root.
// ---------------------------------------------------------------------------

// Defaults — bundled rule and plugin starter set.
export { DEFAULT_PLUGINS, DEFAULT_RULES } from "./defaults.ts";

// Config helper (preferred entry point).
export { defineConfig } from "./define-config.ts";
export type { DefineConfigInput } from "./define-config.ts";

// Predicate helper.
export { definePredicate } from "./define-predicate.ts";

// Loader — walk-up config discovery + merge.
export { buildConfig, loadConfigs, loadSteeringConfig } from "./loader.ts";

// JSON compat — convert v1 JSON configs to v2 TS configs.
export { FromJSONError, fromJSON } from "./compat.ts";

// Auto-tag key for session-entry writes. Exposed so plugin authors
// inspecting raw session entries via `findEntries` can reference the
// constant instead of hardcoding the string.
export { AGENT_LOOP_INDEX_KEY } from "./evaluator-internals/context.ts";

// Schema types — the public authoring surface.
export type {
	ExecOpts,
	ExecResult,
	BaseRule,
	BashRule,
	EditRule,
	Observer,
	ObserverContext,
	ObserverWatch,
	Pattern,
	Plugin,
	PredicateContext,
	PredicateFn,
	PredicateHandler,
	PredicateToolInput,
	ReasonFn,
	Rule,
	SteeringConfig,
	ToolResultEvent,
	WhenClause,
	WhenWalkerState,
	WriteRule,
} from "./schema.ts";

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
	Word,
	WordPart,
} from "unbash-walker";

// Walker functions re-exported for plugin authors writing custom
// predicates and trackers. Forward-compatible with future
// unbash-walker extraction.
export {
	cwdTracker,
	envTracker,
	expandWrapperCommands,
	extractAllCommandsFromAST,
	formatCommand,
	getBasename,
	getCommandArgs,
	getCommandName,
	isStaticallyResolvable,
	parse,
	resolveWord,
	walk,
} from "unbash-walker";

export type { EnvState } from "unbash-walker";

// Testing primitives — re-exported at the root for discoverability.
// The canonical import path is `pi-steering/testing`;
// this root re-export means a test file that already imports
// `defineConfig` from the root doesn't need a second import line for
// `loadHarness`. See `./testing/index.ts` for the API docs.
export {
	createRecordingHost,
	expectAllows,
	expectBlocks,
	expectRuleFires,
	formatMatrix,
	getAppendedEntries,
	loadHarness,
	mockContext,
	mockExtensionContext,
	mockObserverContext,
	priorEntry,
	runMatrix,
	testObserver,
	testPredicate,
} from "./testing/index.ts";

export type {
	BashShorthand,
	CreateRecordingHostOptions,
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
	PriorEntryOptions,
	RecordedExecCall,
	RecordedSessionEntry,
	RecordingHost,
	ToolCallShorthand,
	ToolResultShorthand,
	WriteShorthand,
} from "./testing/index.ts";

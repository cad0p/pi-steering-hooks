// SPDX-License-Identifier: MIT
// Part of @cad0p/pi-steering-hooks.

/**
 * Testing primitives for rule and plugin authors.
 *
 * Subpath export: `@cad0p/pi-steering-hooks/testing`. Also re-exported
 * at the package root for discoverability.
 *
 * Phase 5a ships four low-level primitives that wrap the engine's
 * internals without forcing authors to stand up a pi runtime stub:
 *
 *   - {@link loadHarness}         — build an evaluator + dispatcher
 *                                    pair from a static
 *                                    {@link SteeringConfig}. No walk-up
 *                                    loading — tests pass explicit
 *                                    config.
 *   - {@link mockContext}         — build a {@link PredicateContext}
 *                                    for unit-testing predicate
 *                                    handlers in isolation.
 *   - {@link mockObserverContext} — same for {@link ObserverContext}.
 *   - {@link getAppendedEntries}  — read back `appendEntry` writes
 *                                    captured by either mock context.
 *
 * The convenience wrappers (`testPredicate`, `expectBlocks`,
 * `runMatrix`, …) that build on these live in a Phase 5b follow-up.
 *
 * Design notes:
 *
 *   - `exec` is deliberately stub-required. The defaults reject with a
 *     clear error so a test forgetting to stub fails loudly instead of
 *     silently evaluating predicates against an always-empty exec
 *     result.
 *   - `appendEntry` captures are tracked in a module-level WeakMap
 *     keyed by the context object, so {@link getAppendedEntries}
 *     accesses cleanly without leaking state across tests and without
 *     requiring users to pass capture buffers around.
 *   - `findEntries` draws from an entries array passed in at context
 *     build time; it does NOT pick up entries written via the
 *     context's own `appendEntry`. That mirrors the production
 *     evaluator's per-call snapshot semantics — appends are visible
 *     on the NEXT evaluation, not the current one.
 */

import type {
	ExecOpts,
	ExecResult,
	ObserverContext,
	PredicateContext,
	PredicateToolInput,
	SteeringConfig,
} from "../v2/schema.ts";
import { DEFAULT_PLUGINS, DEFAULT_RULES } from "../v2/defaults.ts";
import {
	buildEvaluator,
	type EvaluatorHost,
	type EvaluatorRuntime,
} from "../v2/evaluator.ts";
import {
	buildObserverDispatcher,
	type ObserverDispatcher,
} from "../v2/observer-dispatcher.ts";
import {
	resolvePlugins,
	type ResolvedPluginState,
} from "../v2/plugin-merger.ts";

// ---------------------------------------------------------------------------
// Capture tracking
// ---------------------------------------------------------------------------

/**
 * Entry shape recorded by a mock context's `appendEntry`. Mirrors the
 * call signature `appendEntry<T>(customType, data?)`; `data` is
 * optional because pi's API accepts a bare customType.
 */
interface CapturedEntry {
	readonly customType: string;
	readonly data?: unknown;
}

/**
 * Global, per-context append buffers. Weak so dropped contexts free
 * the buffer. Never holds a reference to the test's context object
 * itself beyond the weak slot.
 */
const appendBuffers = new WeakMap<object, CapturedEntry[]>();

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/**
 * Build-once, invoke-many handle a test uses to drive the engine
 * against a scenario. `evaluate` and `dispatch` have identical
 * signatures to {@link EvaluatorRuntime.evaluate} and
 * {@link ObserverDispatcher.dispatch} so production call sites can be
 * ported verbatim.
 */
export interface Harness {
	/** See {@link EvaluatorRuntime.evaluate}. */
	evaluate: EvaluatorRuntime["evaluate"];
	/** See {@link ObserverDispatcher.dispatch}. */
	dispatch: ObserverDispatcher["dispatch"];
	/**
	 * The effective config the harness was built from (after default
	 * injection and `disable` filtering).
	 */
	readonly config: SteeringConfig;
	/** The plugin merger's resolved state, for introspection / assertions. */
	readonly resolved: ResolvedPluginState;
}

/**
 * Options for {@link loadHarness}.
 */
export interface LoadHarnessOptions {
	/** The config under test. */
	readonly config: SteeringConfig;

	/**
	 * Prepend {@link DEFAULT_PLUGINS} to `config.plugins` and
	 * {@link DEFAULT_RULES} to `config.rules` at the innermost
	 * position. Mirrors the production flag via
	 * `!config.disableDefaults`, but kept explicit here so tests can
	 * exercise default rules without editing the config under test.
	 *
	 * Default: `false`.
	 */
	readonly includeDefaults?: boolean;

	/**
	 * Host to drive `exec` / `appendEntry` off. Defaults to an
	 * in-memory stub whose `exec` rejects with a clear error (tests
	 * needing exec must stub it explicitly) and whose `appendEntry`
	 * is a silent sink.
	 */
	readonly host?: EvaluatorHost;
}

/**
 * Build an evaluator + observer dispatcher pair from a static
 * {@link SteeringConfig}. Tests drive rules through the same pipeline
 * production uses, without needing a pi runtime stub or walk-up
 * loading.
 */
export function loadHarness(options: LoadHarnessOptions): Harness {
	const inputConfig = options.config;
	const includeDefaults = options.includeDefaults ?? false;

	// Layer defaults at the INNERMOST position — user-declared rules
	// and plugins still win on name collision, matching production's
	// walk-up-first-wins semantics for the innermost layer vs defaults.
	const mergedConfig: SteeringConfig = { ...inputConfig };
	if (includeDefaults) {
		mergedConfig.plugins = [
			...(inputConfig.plugins ?? []),
			...DEFAULT_PLUGINS,
		];
		mergedConfig.rules = [
			...(inputConfig.rules ?? []),
			...DEFAULT_RULES,
		];
	}

	// Apply `config.disable` to user + default rules. Plugin-shipped
	// rules are filtered inside `resolvePlugins`. Mirrors
	// `buildSessionRuntime` in src/index.ts.
	const disabled = new Set(mergedConfig.disable ?? []);
	const filteredConfig: SteeringConfig = { ...mergedConfig };
	if (mergedConfig.rules !== undefined) {
		const kept = mergedConfig.rules.filter((r) => !disabled.has(r.name));
		if (kept.length > 0) filteredConfig.rules = kept;
		else delete filteredConfig.rules;
	}

	const resolved = resolvePlugins(
		filteredConfig.plugins ?? [],
		filteredConfig,
		// `cwd` is injected by the evaluator (built-in `cwdTracker`);
		// extensions targeting it are valid and must not be treated as
		// orphans. Keep in sync with `buildSessionRuntime`.
		["cwd"],
	);

	const host = options.host ?? defaultHarnessHost();
	const evaluator = buildEvaluator(filteredConfig, resolved, host);
	const dispatcher = buildObserverDispatcher(
		resolved,
		filteredConfig.observers ?? [],
		host,
	);

	return {
		evaluate: evaluator.evaluate,
		dispatch: dispatcher.dispatch,
		config: filteredConfig,
		resolved,
	};
}

/**
 * Default in-memory host for {@link loadHarness}. `exec` rejects
 * explicitly — authors needing a stub pass their own host. `appendEntry`
 * is a silent sink (writes into a throwaway array not exposed on the
 * return).
 */
function defaultHarnessHost(): EvaluatorHost {
	return {
		exec: () =>
			Promise.reject(
				new Error(
					"loadHarness: exec not stubbed — pass options.host with an exec implementation",
				),
			),
		appendEntry: () => {},
	};
}

// ---------------------------------------------------------------------------
// mockContext
// ---------------------------------------------------------------------------

/**
 * Shape of an entry fed into {@link mockContext} / {@link
 * mockObserverContext} to back `findEntries`. Mirrors the subset of
 * pi's `CustomEntry` the evaluator + dispatcher actually read.
 */
export interface MockEntry {
	readonly type: "custom";
	readonly customType: string;
	readonly data: unknown;
	readonly timestamp: string;
}

/**
 * Options for {@link mockContext}.
 */
export interface MockContextOptions {
	/** Defaults to `"/tmp/test"`. */
	readonly cwd?: string;

	/** pi turn counter. Defaults to `0`. */
	readonly turnIndex?: number;

	/**
	 * Which tool this predicate is evaluating under. Defaults to
	 * `"bash"`. Drives the default shape of {@link input} when the
	 * caller doesn't supply one.
	 */
	readonly tool?: "bash" | "write" | "edit";

	/**
	 * Tool input. Omitted: derived from {@link tool} as the empty
	 * shape for that tool (bash: `{ command: "" }`, write:
	 * `{ path: "", content: "" }`, edit: `{ path: "", edits: [] }`).
	 */
	readonly input?: PredicateToolInput;

	/**
	 * Walker-state snapshot the predicate sees via
	 * {@link PredicateContext.walkerState}. Defaults to
	 * `{ cwd: options.cwd }` so built-in `when.cwd` reads the right
	 * effective cwd without any walker having to run.
	 */
	readonly walkerState?: Record<string, unknown>;

	/**
	 * Stub for `ctx.exec`. Defaults to rejecting with a clear error
	 * message — tests that call out to exec must stub explicitly
	 * (silent `undefined` would make predicate logic hard to reason
	 * about).
	 */
	readonly exec?: (
		cmd: string,
		args: readonly string[],
		opts?: ExecOpts,
	) => ExecResult | Promise<ExecResult>;

	/**
	 * Prior session entries `findEntries` reads from. Filtered by
	 * customType; timestamps parsed from the ISO string to epoch-ms,
	 * matching the production shape.
	 */
	readonly entries?: ReadonlyArray<MockEntry>;
}

/**
 * Build a {@link PredicateContext} for unit-testing predicates in
 * isolation. See {@link MockContextOptions} for defaults. The returned
 * context's `appendEntry` captures into a buffer accessible via
 * {@link getAppendedEntries}.
 */
export function mockContext(
	options: MockContextOptions = {},
): PredicateContext {
	const cwd = options.cwd ?? "/tmp/test";
	const tool = options.tool ?? "bash";
	const input = options.input ?? defaultInputFor(tool);
	const walkerState = options.walkerState ?? { cwd };
	const buffer: CapturedEntry[] = [];

	const ctx: PredicateContext = {
		cwd,
		tool,
		input,
		turnIndex: options.turnIndex ?? 0,
		exec: buildExec(options.exec, "mockContext"),
		appendEntry: <T>(customType: string, data?: T) => {
			buffer.push({
				customType,
				...(data !== undefined ? { data } : {}),
			});
		},
		findEntries: buildFindEntries(options.entries ?? []),
		walkerState,
	};

	appendBuffers.set(ctx, buffer);
	return ctx;
}

/**
 * Shape-of-`input` default per tool. Kept narrow — just the shape
 * required by `PredicateToolInput` so unit tests don't have to invent
 * placeholder values.
 */
function defaultInputFor(
	tool: "bash" | "write" | "edit",
): PredicateToolInput {
	switch (tool) {
		case "bash":
			return { tool: "bash", command: "" };
		case "write":
			return { tool: "write", path: "", content: "" };
		case "edit":
			return { tool: "edit", path: "", edits: [] };
	}
}

// ---------------------------------------------------------------------------
// mockObserverContext
// ---------------------------------------------------------------------------

/**
 * Options for {@link mockObserverContext}. Observers don't see
 * `tool`, `input`, or `walkerState` — those are predicate-side
 * concepts — so those fields are omitted here.
 */
export type MockObserverContextOptions = Omit<
	MockContextOptions,
	"tool" | "input" | "walkerState"
>;

/**
 * Build an {@link ObserverContext} for unit-testing observer
 * `onResult` handlers. Same capture + `findEntries` pattern as
 * {@link mockContext}.
 *
 * Note: production `ObserverContext` does NOT expose `exec` — but the
 * mock does (as an `exec`-like stub on a different property name is
 * more confusing than forbidding it outright). Observer authors that
 * reach for `exec` are probably using the wrong hook; rules / plugins
 * carrying that logic belong in a predicate. The mock still accepts
 * the stub so tests composing an observer + predicate through a shared
 * options object don't have to strip the field.
 *
 * We DO NOT attach `exec` to the returned ObserverContext — the
 * schema doesn't expose it. The stub is accepted but silently unused
 * at this phase; the follow-up `testObserver` wrapper (Phase 5b) will
 * surface a warning when the stub is set but can never fire.
 */
export function mockObserverContext(
	options: MockObserverContextOptions = {},
): ObserverContext {
	const cwd = options.cwd ?? "/tmp/test";
	const buffer: CapturedEntry[] = [];

	const ctx: ObserverContext = {
		cwd,
		turnIndex: options.turnIndex ?? 0,
		appendEntry: <T>(customType: string, data?: T) => {
			buffer.push({
				customType,
				...(data !== undefined ? { data } : {}),
			});
		},
		findEntries: buildFindEntries(options.entries ?? []),
	};

	appendBuffers.set(ctx, buffer);
	return ctx;
}

// ---------------------------------------------------------------------------
// getAppendedEntries
// ---------------------------------------------------------------------------

/**
 * Read the `appendEntry` capture buffer for a mock context.
 *
 * Returns an empty array when:
 *   - nothing has been appended yet, OR
 *   - the context wasn't built by {@link mockContext} /
 *     {@link mockObserverContext} (safe lookup — no throw).
 *
 * The returned array is a snapshot (copy) so callers can iterate
 * without worrying about concurrent appends racing the assertion.
 */
export function getAppendedEntries(
	ctx: PredicateContext | ObserverContext,
): ReadonlyArray<{ customType: string; data?: unknown }> {
	const buf = appendBuffers.get(ctx);
	if (buf === undefined) return [];
	return [...buf];
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Build the `exec` closure for a mock context. Wraps a user-supplied
 * stub or returns a "not stubbed" rejecter. Normalizes the return
 * type to `Promise<ExecResult>` so sync stubs work too.
 */
function buildExec(
	stub: MockContextOptions["exec"],
	who: "mockContext" | "mockObserverContext",
): PredicateContext["exec"] {
	if (stub === undefined) {
		return () =>
			Promise.reject(
				new Error(`${who}: exec not stubbed — pass options.exec`),
			);
	}
	return async (cmd, args, opts) => stub(cmd, args, opts);
}

/**
 * Build the `findEntries` closure backing mock contexts. Filters the
 * entries array by customType and projects timestamps from ISO
 * strings to epoch-ms — matches {@link createFindEntries} on the
 * production path.
 *
 * No caching here: test-context entry lists are tiny and the cache
 * would make it harder to reason about repeated reads during a test
 * mutating the underlying array.
 */
function buildFindEntries(
	entries: ReadonlyArray<MockEntry>,
): PredicateContext["findEntries"] {
	return <T>(customType: string) => {
		const out: Array<{ data: T; timestamp: number }> = [];
		for (const entry of entries) {
			if (entry.type !== "custom") continue;
			if (entry.customType !== customType) continue;
			const ts = Date.parse(entry.timestamp);
			out.push({
				data: entry.data as T,
				timestamp: Number.isNaN(ts) ? 0 : ts,
			});
		}
		return out;
	};
}

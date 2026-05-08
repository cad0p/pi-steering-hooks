// SPDX-License-Identifier: MIT
// Part of pi-steering.

/**
 * Testing primitives for rule and plugin authors.
 *
 * Subpath export: `pi-steering/testing`. Also re-exported
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
	Observer,
	ObserverContext,
	ObserverWatch,
	PredicateContext,
	PredicateHandler,
	PredicateToolInput,
	SteeringConfig,
	ToolResultEvent as SchemaToolResultEvent,
} from "../v2/schema.ts";
import type {
	ExtensionContext,
	ToolCallEvent,
	ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";
import { DEFAULT_PLUGINS, DEFAULT_RULES } from "../v2/defaults.ts";
import { createAppendEntry } from "../v2/evaluator-internals/context.ts";
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

/**
 * Minimal {@link EvaluatorHost} whose `appendEntry` pushes into the
 * given capture buffer. Used by {@link mockContext} /
 * {@link mockObserverContext} to share the production
 * `createAppendEntry` wrapper: the wrapper expects an
 * `EvaluatorHost`, and wiring a buffering host here lets the mocks
 * auto-tag writes with `_agentLoopIndex` in the exact same shape the
 * real engine and dispatcher produce.
 *
 * `exec` is stubbed to reject — it's never touched on this path
 * (`createAppendEntry` only calls `host.appendEntry`) but has to be
 * present to satisfy the {@link EvaluatorHost} shape.
 */
function bufferingAppendHost(buffer: CapturedEntry[]): EvaluatorHost {
	return {
		exec: () =>
			Promise.reject(
				new Error(
					"[pi-steering-hooks/testing] internal: bufferingAppendHost.exec " +
						"should never be called",
				),
			),
		appendEntry: (customType: string, data?: unknown) => {
			buffer.push({
				customType,
				...(data !== undefined ? { data } : {}),
			});
		},
	};
}

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

	/** Engine agent-loop counter. Defaults to `0`. */
	readonly agentLoopIndex?: number;

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
	const agentLoopIndex = options.agentLoopIndex ?? 0;
	const buffer: CapturedEntry[] = [];

	// Route through the production `createAppendEntry` wrapper so mock
	// and real engine stay in lockstep: plain-object payloads get
	// `_agentLoopIndex` merged in, everything else wraps as
	// `{ value, _agentLoopIndex }`. Without this, a rule author testing
	// their self-mark pattern via `mockContext` would see un-tagged
	// entries that would never have been written that way in
	// production, and a follow-up `when.happened: { in: "agent_loop" }`
	// simulation would disagree with the real engine.
	const bufferingHost = bufferingAppendHost(buffer);

	const ctx: PredicateContext = {
		cwd,
		tool,
		input,
		agentLoopIndex,
		exec: buildExec(options.exec, "mockContext"),
		appendEntry: createAppendEntry(bufferingHost, agentLoopIndex),
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
	const agentLoopIndex = options.agentLoopIndex ?? 0;
	const buffer: CapturedEntry[] = [];

	// Same wrapper as mockContext: keeps the mock observer context
	// writing entries in the auto-tagged shape the real dispatcher
	// produces.
	const bufferingHost = bufferingAppendHost(buffer);

	const ctx: ObserverContext = {
		cwd,
		agentLoopIndex,
		appendEntry: createAppendEntry(bufferingHost, agentLoopIndex),
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

// ===========================================================================
// Phase 5b — Convenience wrappers
// ===========================================================================

// ---------------------------------------------------------------------------
// Shorthand input types
// ---------------------------------------------------------------------------

/**
 * Convenience shape for a bash tool-call event. Accepted by
 * {@link expectBlocks}, {@link expectAllows}, {@link expectRuleFires},
 * and {@link runMatrix} in place of a full {@link ToolCallEvent}.
 */
export interface BashShorthand {
	readonly command: string;
	readonly cwd?: string;
}

/** Convenience shape for a write tool-call event. */
export interface WriteShorthand {
	readonly write: { readonly path: string; readonly content: string };
	readonly cwd?: string;
}

/** Convenience shape for an edit tool-call event. */
export interface EditShorthand {
	readonly edit: {
		readonly path: string;
		readonly edits: ReadonlyArray<{
			readonly oldText: string;
			readonly newText: string;
		}>;
	};
	readonly cwd?: string;
}

/** Union of the bash/write/edit shorthands. */
export type ToolCallShorthand =
	| BashShorthand
	| WriteShorthand
	| EditShorthand;

/**
 * Convenience shape for a tool-result event, accepted by
 * {@link testObserver}. Mirrors the minimal {@link SchemaToolResultEvent}
 * fields observers actually read.
 */
export interface ToolResultShorthand {
	readonly toolName: string;
	readonly input?: unknown;
	readonly output?: unknown;
	readonly exitCode?: number;
}

// ---------------------------------------------------------------------------
// Event + context resolution helpers
// ---------------------------------------------------------------------------

/**
 * Detect a {@link ToolCallShorthand} by its tag field. Actual
 * {@link ToolCallEvent} instances carry a `type: "tool_call"` marker
 * that shorthands never have.
 */
function isShorthand(
	input: ToolCallEvent | ToolCallShorthand,
): input is ToolCallShorthand {
	return !("type" in input && input.type === "tool_call");
}

/**
 * Resolve a shorthand-or-event input into a concrete
 * {@link ToolCallEvent} + a minimal {@link ExtensionContext} stub.
 * The stub carries only `cwd` and a `sessionManager.getEntries()`
 * returning `[]` — enough for the evaluator to build its per-call
 * closures without failing on undefined reads.
 */
function resolveToolCallEvent(
	input: ToolCallEvent | ToolCallShorthand,
	fallbackCwd: string,
): { event: ToolCallEvent; ctx: ExtensionContext } {
	const event = isShorthand(input) ? shorthandToEvent(input) : input;
	const cwd = isShorthand(input) ? (input.cwd ?? fallbackCwd) : fallbackCwd;
	const ctx = {
		cwd,
		sessionManager: { getEntries: () => [] },
	} as unknown as ExtensionContext;
	return { event, ctx };
}

/** Build a synthetic {@link ToolCallEvent} from a shorthand. */
function shorthandToEvent(s: ToolCallShorthand): ToolCallEvent {
	if ("command" in s) {
		return {
			type: "tool_call",
			toolName: "bash",
			input: { command: s.command },
		} as unknown as ToolCallEvent;
	}
	if ("write" in s) {
		return {
			type: "tool_call",
			toolName: "write",
			input: { path: s.write.path, content: s.write.content },
		} as unknown as ToolCallEvent;
	}
	return {
		type: "tool_call",
		toolName: "edit",
		input: { path: s.edit.path, edits: s.edit.edits },
	} as unknown as ToolCallEvent;
}

/** Short human-readable summary of an event for failure messages. */
function describeEvent(event: ToolCallEvent): string {
	const input = (event as unknown as { input: unknown }).input;
	if (
		event.toolName === "bash" &&
		typeof input === "object" &&
		input !== null &&
		"command" in input
	) {
		const cmd = (input as { command: unknown }).command;
		return `bash \`${String(cmd)}\``;
	}
	if (typeof input === "object" && input !== null && "path" in input) {
		const p = (input as { path: unknown }).path;
		return `${event.toolName} ${String(p)}`;
	}
	return event.toolName;
}

/**
 * Resolve a tool-result event or shorthand into a full
 * {@link SchemaToolResultEvent}. Used by {@link testObserver} to drive
 * observers without making the caller stand up a pi-shape result.
 */
function resolveToolResultEvent(
	input: SchemaToolResultEvent | ToolResultShorthand,
): SchemaToolResultEvent {
	// Both shapes carry `toolName` + `input` + `output` + `exitCode?`.
	// Accept either; project to the minimal schema shape.
	return {
		toolName: input.toolName,
		input: (input as { input?: unknown }).input ?? {},
		output: (input as { output?: unknown }).output ?? {},
		...(input.exitCode !== undefined ? { exitCode: input.exitCode } : {}),
	};
}

// ---------------------------------------------------------------------------
// Watch-filter (local reimplementation of observer-dispatcher's matchesWatch)
// ---------------------------------------------------------------------------

/**
 * True if the observer's `watch` filter accepts this event. Missing
 * watch → matches every event. Mirrors
 * `observer-dispatcher.ts`'s internal `matchesWatch` — intentionally
 * reimplemented here so the testing module has zero imports from
 * dispatcher internals. Keep in sync with the dispatcher if the
 * filter semantics change.
 */
function matchesWatchFilter(
	watch: ObserverWatch | undefined,
	event: SchemaToolResultEvent,
): boolean {
	if (!watch) return true;

	if (watch.toolName !== undefined && watch.toolName !== event.toolName) {
		return false;
	}

	if (watch.inputMatches !== undefined) {
		const eventInput =
			typeof event.input === "object" && event.input !== null
				? (event.input as Record<string, unknown>)
				: {};
		for (const [key, pattern] of Object.entries(watch.inputMatches)) {
			const value = eventInput[key];
			if (typeof value !== "string") return false; // fail-closed on absent / non-string
			const re = pattern instanceof RegExp ? pattern : new RegExp(pattern);
			if (!re.test(value)) return false;
		}
	}

	if (watch.exitCode !== undefined && watch.exitCode !== "any") {
		const code = event.exitCode;
		if (watch.exitCode === "success") {
			if (code !== 0) return false;
		} else if (watch.exitCode === "failure") {
			if (code === undefined || code === 0) return false;
		} else if (typeof watch.exitCode === "number") {
			if (code !== watch.exitCode) return false;
		}
	}

	return true;
}

// ---------------------------------------------------------------------------
// testPredicate
// ---------------------------------------------------------------------------

/**
 * Drive a single {@link PredicateHandler} against a {@link mockContext}.
 * Returns the boolean verdict.
 *
 * Usage:
 * ```ts
 * const fires = await testPredicate(branch, /^main$/, {
 *   walkerState: { branch: "main" },
 * });
 * ```
 */
export async function testPredicate<A = unknown>(
	predicate: PredicateHandler<A>,
	args: A,
	options: MockContextOptions = {},
): Promise<boolean> {
	const ctx = mockContext(options);
	return predicate(args, ctx);
}

// ---------------------------------------------------------------------------
// testObserver
// ---------------------------------------------------------------------------

/**
 * Fire an {@link Observer} at an event, returning the captured
 * `appendEntry` writes plus whether the observer's `watch` filter
 * accepted the event. Use the `entries` field to assert what the
 * observer recorded; use `watchMatched` to assert the filter gated
 * firing correctly.
 *
 * If the observer's `watch` did NOT match, `onResult` is NOT called
 * (mirrors production dispatch).
 *
 * If `options.exec` is supplied, emits a `console.warn` — observers
 * don't see `exec`, so the stub can never fire. Exists on the options
 * shape only because {@link MockObserverContextOptions} is derived
 * from {@link MockContextOptions} for ergonomic test composition.
 */
export async function testObserver(
	observer: Observer,
	event: SchemaToolResultEvent | ToolResultShorthand,
	options: MockObserverContextOptions = {},
): Promise<{
	entries: ReadonlyArray<{ customType: string; data?: unknown }>;
	watchMatched: boolean;
}> {
	if (options.exec !== undefined) {
		console.warn(
			"testObserver: exec option ignored — ObserverContext doesn't expose exec",
		);
	}

	const ctx = mockObserverContext(options);
	const resolvedEvent = resolveToolResultEvent(event);
	const watchMatched = matchesWatchFilter(observer.watch, resolvedEvent);

	if (watchMatched) {
		await Promise.resolve(observer.onResult(resolvedEvent, ctx));
	}

	return { entries: getAppendedEntries(ctx), watchMatched };
}

// ---------------------------------------------------------------------------
// expectBlocks / expectAllows / expectRuleFires
// ---------------------------------------------------------------------------

/** Options for {@link expectBlocks}. */
export interface ExpectBlocksOptions {
	/**
	 * Expected rule name — matched against the `[steering:<name>@<source>]`
	 * prefix (source-tagged format per ADR §11). The source suffix is
	 * ignored for matching; pass the bare rule name.
	 */
	readonly rule?: string;
	/** Expected reason — exact string match (string) or pattern match (RegExp). */
	readonly reason?: string | RegExp;
}

/**
 * Extract the rule name from a block reason. Reasons are source-tagged
 * as `[steering:<rule>@<source>] …`; we return the `<rule>` portion
 * so callers can assert by name without caring which plugin shipped
 * the rule.
 */
function extractRuleName(reason: string): string | null {
	const m = reason.match(/^\[steering:([^@\]]+)(?:@[^\]]+)?\]/);
	return m ? m[1]! : null;
}

/** Normalize the `ToolCallEventResult` to a concrete block payload or null. */
function interpretResult(
	result: ToolCallEventResult | void,
): { blocked: boolean; reason: string | null } {
	if (result === undefined || result === null) {
		return { blocked: false, reason: null };
	}
	const r = result as { block?: boolean; reason?: unknown };
	if (r.block !== true) return { blocked: false, reason: null };
	return {
		blocked: true,
		reason: typeof r.reason === "string" ? r.reason : String(r.reason ?? ""),
	};
}

/**
 * Assert that the harness blocks the given event. Returns the block
 * payload for further inspection. Throws on allow.
 *
 * Optional `expected.rule` / `expected.reason` narrow the assertion:
 *   - `rule: "no-force-push"` — the fired rule's name must match.
 *   - `reason: /force-push/` — the reason string must match (exact
 *     string or regex).
 */
export async function expectBlocks(
	harness: Harness,
	event: ToolCallEvent | ToolCallShorthand,
	expected: ExpectBlocksOptions = {},
): Promise<ToolCallEventResult> {
	const { event: resolvedEvent, ctx } = resolveToolCallEvent(
		event,
		"/tmp/test",
	);
	const result = await harness.evaluate(resolvedEvent, ctx, 0);
	const { blocked, reason } = interpretResult(result);

	if (!blocked) {
		throw new Error(
			`expectBlocks: expected block, got allow for ${describeEvent(resolvedEvent)} at ${ctx.cwd}`,
		);
	}

	if (expected.rule !== undefined) {
		const firedRule = extractRuleName(reason ?? "");
		if (firedRule !== expected.rule) {
			throw new Error(
				`expectBlocks: expected rule "${expected.rule}" to fire, ` +
					`got "${firedRule ?? "<none>"}" for ${describeEvent(resolvedEvent)}\n` +
					`  reason: ${reason}`,
			);
		}
	}

	if (expected.reason !== undefined && reason !== null) {
		const matches =
			expected.reason instanceof RegExp
				? expected.reason.test(reason)
				: expected.reason === reason;
		if (!matches) {
			throw new Error(
				`expectBlocks: reason did not match expected pattern\n` +
					`  expected: ${String(expected.reason)}\n` +
					`  got:      ${reason}`,
			);
		}
	}

	return result as ToolCallEventResult;
}

/**
 * Assert that the harness allows the given event (no rule fires).
 * Throws with a rich message on block.
 */
export async function expectAllows(
	harness: Harness,
	event: ToolCallEvent | ToolCallShorthand,
): Promise<void> {
	const { event: resolvedEvent, ctx } = resolveToolCallEvent(
		event,
		"/tmp/test",
	);
	const result = await harness.evaluate(resolvedEvent, ctx, 0);
	const { blocked, reason } = interpretResult(result);

	if (blocked) {
		const firedRule = extractRuleName(reason ?? "") ?? "<unknown>";
		throw new Error(
			`expectAllows: expected allow, got block for ${describeEvent(resolvedEvent)}\n` +
				`  rule:   ${firedRule}\n` +
				`  reason: ${reason}`,
		);
	}
}

/**
 * Assert that a specific rule fires on the given event. Thin alias
 * over {@link expectBlocks}; kept as a distinct helper for tests whose
 * intent is "which rule fired" rather than "the tool was blocked".
 */
export async function expectRuleFires(
	harness: Harness,
	event: ToolCallEvent | ToolCallShorthand,
	ruleName: string,
): Promise<void> {
	await expectBlocks(harness, event, { rule: ruleName });
}

// ---------------------------------------------------------------------------
// runMatrix / formatMatrix
// ---------------------------------------------------------------------------

/** One row of a {@link runMatrix} input. */
export interface MatrixCase {
	readonly name: string;
	readonly event: ToolCallEvent | ToolCallShorthand;
	readonly expect:
		| "block"
		| "allow"
		| { readonly block: true; readonly rule?: string };
	readonly cwd?: string;
}

/** Per-case outcome. */
export interface MatrixCaseResult {
	readonly case: MatrixCase;
	readonly passed: boolean;
	readonly actual: "block" | "allow";
	readonly reason?: string;
	readonly errorMessage?: string;
}

/** Aggregate outcome of {@link runMatrix}. */
export interface MatrixResult {
	readonly total: number;
	readonly passed: number;
	readonly failed: number;
	readonly cases: ReadonlyArray<MatrixCaseResult>;
}

/**
 * Batch-evaluate a list of cases against a harness. Never throws —
 * failures surface in `result.cases`. Pair with {@link formatMatrix}
 * to render a human-readable report.
 */
export async function runMatrix(
	harness: Harness,
	cases: readonly MatrixCase[],
): Promise<MatrixResult> {
	const caseResults: MatrixCaseResult[] = [];

	for (const c of cases) {
		const fallback = c.cwd ?? "/tmp/test";
		const { event, ctx } = resolveToolCallEvent(c.event, fallback);
		const evalResult = await harness.evaluate(event, ctx, 0);
		const { blocked, reason } = interpretResult(evalResult);
		const actual: "block" | "allow" = blocked ? "block" : "allow";

		let passed = false;
		let errorMessage: string | undefined;

		if (c.expect === "allow") {
			passed = !blocked;
			if (!passed) {
				errorMessage = `expected allow; got block (${extractRuleName(reason ?? "") ?? "<unknown>"})`;
			}
		} else if (c.expect === "block") {
			passed = blocked;
			if (!passed) errorMessage = "expected block; got allow";
		} else {
			if (!blocked) {
				passed = false;
				errorMessage = "expected block; got allow";
			} else if (c.expect.rule !== undefined) {
				const firedRule = extractRuleName(reason ?? "");
				passed = firedRule === c.expect.rule;
				if (!passed) {
					errorMessage = `expected rule "${c.expect.rule}"; got "${firedRule ?? "<unknown>"}"`;
				}
			} else {
				passed = true;
			}
		}

		caseResults.push({
			case: c,
			passed,
			actual,
			...(reason !== null ? { reason } : {}),
			...(errorMessage !== undefined ? { errorMessage } : {}),
		});
	}

	const passed = caseResults.filter((r) => r.passed).length;
	return {
		total: caseResults.length,
		passed,
		failed: caseResults.length - passed,
		cases: caseResults,
	};
}

/**
 * Pretty-print a {@link MatrixResult}. ASCII-friendly for CI log
 * aggregators; structure mirrors the adversarial-matrix report style.
 */
export function formatMatrix(result: MatrixResult): string {
	const lines: string[] = [];
	lines.push(
		`MATRIX — ${result.total} cases. ${result.passed} pass, ${result.failed} fail.`,
	);
	lines.push("=".repeat(64));
	for (const r of result.cases) {
		const expect =
			typeof r.case.expect === "string"
				? r.case.expect
				: `block:${r.case.expect.rule ?? "*"}`;
		const actualLabel =
			r.actual === "block"
				? `BLOCK (${extractRuleName(r.reason ?? "") ?? "?"})`
				: "allow";
		const status = r.passed ? "" : "  FAIL";
		lines.push(
			`[${r.case.name}]  expect:${expect}  actual:${actualLabel}${status}`,
		);
		if (!r.passed && r.errorMessage) {
			lines.push(`  ↳ ${r.errorMessage}`);
		}
	}
	lines.push("=".repeat(64));
	lines.push(`PASS: ${result.passed}/${result.total}`);
	return lines.join("\n");
}

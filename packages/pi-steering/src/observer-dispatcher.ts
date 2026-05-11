// SPDX-License-Identifier: MIT
// Part of pi-steering.

/**
 * v2 observer dispatcher.
 *
 * Observers are the `tool_result` side of the steering engine: rules
 * decide "can this run" pre-execution; observers record "what happened"
 * post-execution. Typical use is to `appendEntry` into pi's session
 * JSONL so later predicates can gate on prior turn state (the
 * "description was read in a PRIOR turn" idiom from the ADR).
 *
 * This module merges user-declared observers (from
 * {@link SteeringConfig.observers}) with plugin-shipped ones (from
 * {@link ResolvedPluginState.observers}), then on every `tool_result`:
 *
 *   1. Applies the observer's `watch` filter (toolName + inputMatches
 *      + exitCode). No `watch` means "fire on every tool_result".
 *   2. Calls `observer.onResult(event, observerCtx)`. Awaits if it
 *      returns a promise.
 *   3. Catches thrown errors per-observer — one buggy observer does
 *      NOT prevent the rest from running.
 *
 * Observer context (`ObserverContext`) is built fresh per event, using
 * `appendEntry` and `findEntries` closures shared with the evaluator.
 * `exec` is deliberately NOT exposed — observers are expected to be
 * lightweight state-recording hooks. Complex tool_result analysis that
 * needs to shell out belongs in a separate pi extension hook or in a
 * rule's `when.condition` pre-execution, not in an observer.
 *
 * Wiring (Phase 3c): the extension runtime subscribes to `tool_result`
 * and forwards the event + current `agentLoopIndex` into `dispatch`.
 */

import type {
	ExtensionContext,
	ToolResultEvent as PiToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import {
	createAppendEntry,
	createFindEntries,
	createSessionEntryCache,
	type EvaluatorHost,
} from "./evaluator-internals/context.ts";
import { mergeObserversUserFirst } from "./internal/merge-observers.ts";
import {
	extractRefTextsForBash,
	matchesWatch,
} from "./internal/watch-matcher.ts";
import { validateName } from "./plugin-merger.ts";
import type { ResolvedPluginState } from "./plugin-merger.ts";
import type {
	Observer,
	ObserverContext,
	ToolResultEvent as SchemaToolResultEvent,
} from "./schema.ts";

// Re-export the shared filter contract so existing consumers that
// imported `matchesWatch` from this module (most notably the testing
// harness's `testObserver`) don't need to switch imports. The source
// of truth lives in `./internal/watch-matcher.ts`; this re-export
// keeps the public surface stable.
export { matchesWatch } from "./internal/watch-matcher.ts";

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/**
 * Runtime-facing dispatcher handle. Phase 3c holds an instance per
 * session and calls {@link dispatch} from the pi `tool_result` listener.
 */
export interface ObserverDispatcher {
	/**
	 * Dispatch a single `tool_result` to every matching observer.
	 *
	 * Resolves when all observer handlers have settled. Handlers that
	 * throw are caught + logged via `console.warn` and do not prevent
	 * subsequent observers from running.
	 */
	dispatch(
		event: PiToolResultEvent,
		ctx: ExtensionContext,
		agentLoopIndex: number,
	): Promise<void>;
}

/**
 * Construct an {@link ObserverDispatcher}.
 *
 * Arguments:
 *   - `resolved`       — merged plugin state from {@link resolvePlugins}.
 *                         Source of plugin-shipped observers and the
 *                         registry used by the evaluator at the same
 *                         level.
 *   - `userObservers`  — the user's `config.observers` list (already
 *                         deduped at the loader level in Phase 2). User
 *                         observers fire BEFORE plugin observers on the
 *                         same event; within each group, registration
 *                         order decides.
 *   - `host`           — narrow surface exposing pi's `exec` +
 *                         `appendEntry`. Passed straight through to the
 *                         per-event observer context.
 */
export function buildObserverDispatcher(
	resolved: ResolvedPluginState,
	userObservers: readonly Observer[],
	host: EvaluatorHost,
): ObserverDispatcher {
	// S3: validate user-supplied observer names. Plugin observer names
	// are validated inside `resolvePlugins` when the plugin is loaded;
	// user-level observers flow in here directly and need their own
	// gate.
	for (const o of userObservers) {
		validateName("observer", o.name, "user config");
	}

	// Merge user and plugin observers; duplicates of observer.name are
	// deduped here by first-registered (user takes precedence over a
	// plugin observer of the same name — matches the "user overrides
	// plugin by declaring their own" pattern the rule list uses). Shared
	// with the evaluator's speculative-synthesis reverse-index via
	// `mergeObserversUserFirst` so both callers see the same final list.
	const merged = mergeObserversUserFirst(userObservers, resolved.observers);

	return {
		dispatch: (event, ctx, agentLoopIndex) =>
			dispatchEvent(event, ctx, agentLoopIndex, merged, host),
	};
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

async function dispatchEvent(
	event: PiToolResultEvent,
	ctx: ExtensionContext,
	agentLoopIndex: number,
	observers: readonly Observer[],
	host: EvaluatorHost,
): Promise<void> {
	// Top-level fail-open wrap (S1 follow-up, promised in d728ef0).
	// Per-observer throws are already isolated in the inner loop; this
	// outer wrap exists so a throw in the dispatch SCAFFOLDING (e.g. a
	// session-JSONL read blowing up inside `createFindEntries`, or an
	// unexpected shape on the incoming event) is logged rather than
	// propagating back into pi's `tool_result` hook. Observers are
	// best-effort state recorders — a broken engine should not take
	// down the tool_result pipeline.
	try {
		await dispatchEventInner(event, ctx, agentLoopIndex, observers, host);
	} catch (err) {
		console.warn(
			`[pi-steering] observer dispatcher threw: ${formatError(err)}`,
		);
	}
}

async function dispatchEventInner(
	event: PiToolResultEvent,
	ctx: ExtensionContext,
	agentLoopIndex: number,
	observers: readonly Observer[],
	host: EvaluatorHost,
): Promise<void> {
	// Shared per-event session-entry cache: findEntries + appendEntry
	// share it so an earlier observer's appendEntry invalidates the
	// cached read for that customType, and a later observer's
	// findEntries(customType) sees the fresh write (S2/E1). Without the
	// shared cache, observer A appending "description-read" + observer
	// B reading "description-read" on the same event would see a stale
	// pre-write snapshot.
	const entryCache = createSessionEntryCache();
	const findEntries = createFindEntries(ctx, entryCache);
	// Shared appendEntry: auto-tags writes with `_agentLoopIndex` so
	// `when.happened: { in: "agent_loop" }` can filter by agent-loop
	// scope. Safe to hoist out of the loop: the wrapper is stateless.
	const appendEntry = createAppendEntry(host, agentLoopIndex, entryCache);

	// Hoist the per-event projections out of the loop so N observers
	// each get the identical event shape + exit code without paying N
	// copies of the same work.
	const exitCode = extractExitCode(event);
	const schemaEvent = toSchemaEvent(event, exitCode);

	// Wrapper-aware command-ref cache (ADR §12). Populated lazily on the
	// first observer whose watch filter references `inputMatches.command`
	// against a bash event; reused across subsequent observers on the
	// same event so `sh -c '…'` / `sudo …` are parsed at most once per
	// dispatch regardless of how many observers share the filter shape.
	// `null` encodes "extraction attempted but failed (parse error or
	// non-bash event)" so we don't retry per observer.
	let refTextsCache: readonly string[] | null | undefined = undefined;
	const getRefTexts = (): readonly string[] | null => {
		if (refTextsCache !== undefined) return refTextsCache;
		refTextsCache = extractRefTextsForBash(schemaEvent);
		return refTextsCache;
	};

	for (const observer of observers) {
		if (!matchesWatch(observer.watch, schemaEvent, getRefTexts)) continue;

		// Each observer gets its own ctx so appendEntry writes attribute
		// cleanly. `exec` is intentionally absent — observers are recording
		// hooks, not shell-out points.
		const observerCtx: ObserverContext = {
			cwd: ctx.cwd,
			agentLoopIndex,
			appendEntry,
			findEntries,
		};

		try {
			const result = observer.onResult(schemaEvent, observerCtx);
			if (result instanceof Promise) {
				await result;
			}
		} catch (err) {
			// One observer's bug must not poison the rest. Log with the
			// observer name so the operator can locate + disable it.
			console.warn(
				`[pi-steering] observer "${observer.name}" threw: ${formatError(err)}`,
			);
		}
	}
}

// ---------------------------------------------------------------------------
// Schema event projection
// ---------------------------------------------------------------------------

/**
 * Extract an exit code from a pi tool_result event. Only bash events
 * carry one (via `details.exitCode`). Other tool results lack a
 * meaningful numeric code; we return `undefined` and let the watch
 * filter's `exitCode` check decide.
 */
function extractExitCode(event: PiToolResultEvent): number | undefined {
	if (event.toolName !== "bash") return undefined;
	const details = event.details as { exitCode?: number } | undefined;
	if (!details || typeof details.exitCode !== "number") return undefined;
	return details.exitCode;
}

/**
 * Project pi's concrete `ToolResultEvent` onto the schema's minimal
 * {@link SchemaToolResultEvent}. Observers are typed against the schema
 * shape — they don't depend on pi's internal tool details unions. The
 * fields we fill:
 *
 *   - `toolName` + `input`   — direct.
 *   - `output`               — pi's `content` (TextContent/ImageContent
 *                               array) passed through unchanged. Observer
 *                               handlers cast to the shape they expect.
 *   - `exitCode`             — passed in precomputed by the caller
 *                               (so the extraction runs once per event,
 *                               not once per matching observer); bash
 *                               events only, others leave it `undefined`.
 */
function toSchemaEvent(
	event: PiToolResultEvent,
	exitCode: number | undefined,
): SchemaToolResultEvent {
	const out: SchemaToolResultEvent = {
		toolName: event.toolName,
		input: event.input,
		output: event.content,
	};
	if (exitCode !== undefined) out.exitCode = exitCode;
	return out;
}

// ---------------------------------------------------------------------------
// Error formatting
// ---------------------------------------------------------------------------

function formatError(err: unknown): string {
	if (err instanceof Error) return `${err.message}\n${err.stack ?? ""}`;
	try {
		return JSON.stringify(err);
	} catch {
		return String(err);
	}
}

// Re-export host type for symmetry with evaluator.ts.
export type { EvaluatorHost } from "./evaluator-internals/context.ts";

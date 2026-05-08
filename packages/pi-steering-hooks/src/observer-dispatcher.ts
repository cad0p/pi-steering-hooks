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
	expandWrapperCommands,
	extractAllCommandsFromAST,
	getBasename,
	getCommandArgs,
	parse as parseBash,
} from "unbash-walker";
import {
	createAppendEntry,
	createFindEntries,
	createSessionEntryCache,
	type EvaluatorHost,
} from "./evaluator-internals/context.ts";
import { matchesPattern } from "./evaluator-internals/predicates.ts";
import type { ResolvedPluginState } from "./plugin-merger.ts";
import type {
	Observer,
	ObserverContext,
	ObserverWatch,
	Pattern,
	ToolResultEvent as SchemaToolResultEvent,
} from "./schema.ts";

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
	// Merge user and plugin observers; duplicates of observer.name are
	// deduped here by first-registered (user takes precedence over a
	// plugin observer of the same name — matches the "user overrides
	// plugin by declaring their own" pattern the rule list uses).
	const merged: Observer[] = [];
	const seen = new Set<string>();
	for (const o of userObservers) {
		if (seen.has(o.name)) continue;
		seen.add(o.name);
		merged.push(o);
	}
	for (const o of resolved.observers) {
		if (seen.has(o.name)) continue;
		seen.add(o.name);
		merged.push(o);
	}

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
			`[pi-steering-hooks] observer dispatcher threw: ${formatError(err)}`,
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
				`[pi-steering-hooks] observer "${observer.name}" threw: ${formatError(err)}`,
			);
		}
	}
}

// ---------------------------------------------------------------------------
// watch filter evaluation
// ---------------------------------------------------------------------------

/**
 * True if the observer's `watch` filter accepts this event. No watch
 * → matches everything. Semantics per ADR "Observer schema":
 *
 *   - `toolName` — exact match against `event.toolName`.
 *   - `inputMatches` — every declared key's Pattern must match against
 *     `event.input[key]` if that key exists AND the value is a string.
 *     Keys absent from the event's input (or non-string values) make
 *     the whole filter fail — documented fail-closed choice: subset
 *     checks don't silently pass when the expected field isn't present.
 *   - `exitCode` — `"success"` → 0, `"failure"` → non-zero,
 *     `"any"`/omitted → pass, numeric → exact match. `exitCode` is
 *     sourced from the event's `exitCode` field (bash only via pi's
 *     `details.exitCode` after projection to the schema shape); other
 *     tool results leave it `undefined` and satisfy everything except
 *     a numeric `exitCode:` (treated as "no match" — bash-specific
 *     filter).
 *
 * Wrapper-aware command matching (ADR §12): when `inputMatches.command`
 * is set AND the event is a bash event, the pattern matches if EITHER
 * the raw outer `event.input.command` OR any extracted command ref
 * text matches. So `sh -c 'brazil ws sync'` with pattern
 * `/^brazil\s+ws\s+sync$/` fires the observer — the outer raw command
 * starts with `sh`, but the walker-extracted ref `brazil ws sync` does
 * hit the anchored pattern.
 *
 * Exported so the testing module's `testObserver` can reuse the exact
 * same filter semantics as production — prevents silent drift between
 * the test harness and the real dispatcher on wrapper-aware matching
 * and fail-closed edge cases.
 *
 * Performance: when multiple observers share the same event (the
 * production dispatch path), pass a memoizing `refTextsProvider` to
 * parse the bash command once across observers. Standalone callers
 * (e.g. `testObserver` evaluating one observer in isolation) can omit
 * it — the default provider parses on demand.
 */
export function matchesWatch(
	watch: ObserverWatch | undefined,
	event: SchemaToolResultEvent,
	refTextsProvider?: () => readonly string[] | null,
): boolean {
	if (!watch) return true;

	if (watch.toolName !== undefined && watch.toolName !== event.toolName) {
		return false;
	}

	if (watch.inputMatches) {
		const rawInput = event.input;
		const input: Record<string, unknown> =
			typeof rawInput === "object" && rawInput !== null
				? (rawInput as Record<string, unknown>)
				: {};
		const getRefTexts =
			refTextsProvider ?? (() => extractRefTextsForBash(event));
		for (const [key, pat] of Object.entries(watch.inputMatches)) {
			const value = input[key];
			if (typeof value !== "string") return false;
			if (!matchesInputField(key, pat, value, event, getRefTexts)) {
				return false;
			}
		}
	}

	if (watch.exitCode !== undefined && watch.exitCode !== "any") {
		if (!matchesExitCode(event.exitCode, watch.exitCode)) return false;
	}
	return true;
}

/**
 * Match a single `inputMatches` key/value against the event. `command`
 * on a bash event is wrapper-aware per ADR §12 — the raw outer command
 * OR any extracted ref text matches. All other keys (and `command` on
 * non-bash events) keep the straight raw-string match the v0.0 engine
 * shipped with.
 *
 * Share the evaluator's regex cache (module-scoped in `predicates.ts`)
 * so observer `inputMatches` reuse the same compiled `RegExp` as
 * equivalent rule patterns.
 */
function matchesInputField(
	key: string,
	pat: Pattern,
	value: string,
	event: SchemaToolResultEvent,
	getRefTexts: () => readonly string[] | null,
): boolean {
	if (matchesPattern(pat, value)) return true;

	// Wrapper-aware fallback: only for `command` on bash events. Other
	// fields (path, content, …) don't have wrapper analogues — a
	// file-path pattern has nothing to do with bash AST refs, so
	// leaving them on the raw-string path is both correct and a perf
	// guard against needless parsing on non-bash events.
	if (key !== "command" || event.toolName !== "bash") return false;

	const refTexts = getRefTexts();
	if (refTexts === null) return false;
	for (const text of refTexts) {
		if (matchesPattern(pat, text)) return true;
	}
	return false;
}

/**
 * Extract per-ref flattened text (basename + args joined with spaces)
 * from a bash tool_result's outer command, mirroring the evaluator's
 * `prepareBashState` text projection so observer watch patterns match
 * the same strings rule patterns see for the same command.
 *
 * Returns `null` when the event isn't a bash tool_result, the raw
 * command is missing/non-string, or the walker throws while parsing
 * (hard-to-parse command — fall back to raw-only matching without
 * blowing up dispatch). Unlike the evaluator we don't walk trackers:
 * observers don't receive `walkerState`, so the parse+extract+expand
 * stages suffice.
 */
function extractRefTextsForBash(
	event: SchemaToolResultEvent,
): readonly string[] | null {
	if (event.toolName !== "bash") return null;
	const input =
		typeof event.input === "object" && event.input !== null
			? (event.input as { command?: unknown })
			: undefined;
	const command = input?.command;
	if (typeof command !== "string" || command.length === 0) return null;
	try {
		const script = parseBash(command);
		const extracted = extractAllCommandsFromAST(script, command);
		const { commands: refs } = expandWrapperCommands(extracted);
		return refs.map((ref) =>
			`${getBasename(ref)} ${getCommandArgs(ref).join(" ")}`.trim(),
		);
	} catch {
		// Don't let a parse error take down dispatch — a malformed
		// command still deserves a raw-match chance. Returning null
		// (as opposed to []) skips ref matching entirely for this event.
		return null;
	}
}

/**
 * Extract an exit code from a pi tool_result event. Only bash events
 * carry one (via `details.exitCode`). Other tool results lack a
 * meaningful numeric code; we return `undefined` and let
 * {@link matchesExitCode} decide.
 */
function extractExitCode(event: PiToolResultEvent): number | undefined {
	if (event.toolName !== "bash") return undefined;
	const details = event.details as { exitCode?: number } | undefined;
	if (!details || typeof details.exitCode !== "number") return undefined;
	return details.exitCode;
}

function matchesExitCode(
	code: number | undefined,
	filter: number | "success" | "failure",
): boolean {
	if (typeof filter === "number") {
		// Numeric filter requires a concrete code; no-code events (non-bash)
		// never match a numeric filter.
		return code === filter;
	}
	if (filter === "success") return code === 0;
	if (filter === "failure") return code !== undefined && code !== 0;
	return true;
}

// ---------------------------------------------------------------------------
// Schema event projection
// ---------------------------------------------------------------------------

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

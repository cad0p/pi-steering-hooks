// SPDX-License-Identifier: MIT
// Part of @cad0p/pi-steering-hooks.

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
 * and forwards the event + current `turnIndex` into `dispatch`.
 */

import type {
	ExtensionContext,
	ToolResultEvent as PiToolResultEvent,
} from "@mariozechner/pi-coding-agent";
import {
	createFindEntries,
	type EvaluatorHost,
} from "./evaluator-internals/context.ts";
import { matchesPattern } from "./evaluator-internals/predicates.ts";
import type { ResolvedPluginState } from "./plugin-merger.ts";
import type {
	Observer,
	ObserverContext,
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
		turnIndex: number,
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
		dispatch: (event, ctx, turnIndex) =>
			dispatchEvent(event, ctx, turnIndex, merged, host),
	};
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

async function dispatchEvent(
	event: PiToolResultEvent,
	ctx: ExtensionContext,
	turnIndex: number,
	observers: readonly Observer[],
	host: EvaluatorHost,
): Promise<void> {
	// Shared per-event findEntries. Built once so an observer that
	// reads a prior entry sees the same snapshot other observers on the
	// same event see (mirroring evaluator semantics — evaluator rebuilds
	// on every tool_call, dispatcher rebuilds on every tool_result).
	const findEntries = createFindEntries(ctx);

	// Hoist the per-event projections out of the loop so N observers
	// each get the identical event shape + exit code without paying N
	// copies of the same work.
	const exitCode = extractExitCode(event);
	const schemaEvent = toSchemaEvent(event, exitCode);

	for (const observer of observers) {
		if (!matchesWatch(observer, event, exitCode)) continue;

		// Each observer gets its own ctx so appendEntry writes attribute
		// cleanly. `exec` is intentionally absent — observers are recording
		// hooks, not shell-out points.
		const observerCtx: ObserverContext = {
			cwd: ctx.cwd,
			turnIndex,
			appendEntry: (type, data) => host.appendEntry(type, data),
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
 *     sourced from bash's `details.exitCode`; other tool results don't
 *     carry exit codes and satisfy everything except a numeric
 *     `exitCode:` (treated as "no match" — bash-specific filter).
 */
function matchesWatch(
	observer: Observer,
	event: PiToolResultEvent,
	exitCode: number | undefined,
): boolean {
	const watch = observer.watch;
	if (!watch) return true;

	if (watch.toolName !== undefined && watch.toolName !== event.toolName) {
		return false;
	}

	if (watch.inputMatches) {
		const input = event.input as Record<string, unknown>;
		for (const [key, pat] of Object.entries(watch.inputMatches)) {
			const value = input[key];
			if (typeof value !== "string") return false;
			// Share the evaluator's regex cache (module-scoped in
			// predicates.ts) so observer inputMatches reuse the same
			// compiled RegExp as equivalent rule patterns.
			if (!matchesPattern(pat, value)) return false;
		}
	}

	if (watch.exitCode !== undefined && watch.exitCode !== "any") {
		if (!matchesExitCode(exitCode, watch.exitCode)) return false;
	}
	return true;
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

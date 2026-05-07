// SPDX-License-Identifier: MIT
// Part of @cad0p/pi-steering-hooks.

/**
 * Predicate context construction for the v2 evaluator.
 *
 * Three concerns live here because they collaborate tightly:
 *
 *   1. `createExecCache` — memoizes `exec(cmd, args, opts)` by
 *      `(cmd, args, cwd)` so every rule evaluated for ONE tool_call
 *      sees the same result for the same query, without re-running the
 *      underlying child process. A fresh cache is created per
 *      tool_call; cross-call results are never shared.
 *   2. `findEntriesAdapter` — wraps pi's `sessionManager.getEntries()`
 *      into the {@link PredicateContext.findEntries} shape, filtering
 *      to `type: "custom"` entries by `customType` and flattening to
 *      `{ data, timestamp }` (timestamps normalized from ISO strings to
 *      epoch ms, matching what observers producing entries can rely on).
 *   3. `buildPredicateContext` — ties the pieces together: given
 *      per-ref walker state plus the shared exec / findEntries /
 *      appendEntry closures, returns a fully-populated
 *      {@link PredicateContext} suitable for a single predicate
 *      invocation.
 *
 * Kept internal (under `evaluator-internals/`) so consumers can swap
 * the evaluator without inheriting its helper surface. The only
 * re-export is through `../evaluator.ts`.
 */

import type {
	ExtensionContext,
	ExtensionAPI,
	ExecOptions as PiExecOptions,
	ExecResult as PiExecResult,
} from "@mariozechner/pi-coding-agent";
import type { ExecOpts, ExecResult, PredicateContext } from "../schema.ts";

/**
 * Narrow host surface the evaluator needs from the pi runtime. Lets
 * tests pass a stub without building a full fake `ExtensionAPI`, and
 * keeps the evaluator decoupled from the unrelated parts of pi's API
 * (tool registration, slash commands, OAuth, …).
 */
export interface EvaluatorHost {
	/** See {@link ExtensionAPI.exec}. */
	exec: ExtensionAPI["exec"];
	/** See {@link ExtensionAPI.appendEntry}. */
	appendEntry: ExtensionAPI["appendEntry"];
}

/**
 * Key used by the per-tool-call exec cache. Null-byte separator is safe
 * because neither a command path nor POSIX argv can legitimately contain
 * a NUL byte; collisions are impossible in practice.
 */
function execCacheKey(cmd: string, args: readonly string[], cwd: string): string {
	return `${cmd}\x00${args.join("\x00")}\x00${cwd}`;
}

/**
 * Bridge pi's `ExecResult` (uses `code`) to the schema's `ExecResult`
 * (uses `exitCode`). Dropping `killed` is intentional — predicate
 * authors don't need to distinguish "timed out" from "exited
 * non-zero"; both surface as a non-zero exit for guardrail purposes.
 */
function toSchemaExecResult(r: PiExecResult): ExecResult {
	return { stdout: r.stdout, stderr: r.stderr, exitCode: r.code };
}

/**
 * Create a tool_call-scoped exec function that memoizes by
 * `(cmd, args, cwd)`. Caches only the PROMISE so concurrent
 * predicate evaluations that hit the same key await the same
 * in-flight child process — not N redundant ones.
 *
 * `opts.cwd` defaults to `sessionCwd` (mirroring how predicates see
 * their "current cwd" via {@link PredicateContext.cwd}). `timeoutMs`
 * is forwarded as `timeout`.
 */
export function createExecCache(
	host: EvaluatorHost,
	sessionCwd: string,
): PredicateContext["exec"] {
	const cache = new Map<string, Promise<ExecResult>>();
	return (cmd, args, opts) => {
		const cwd = opts?.cwd ?? sessionCwd;
		const key = execCacheKey(cmd, args, cwd);
		const hit = cache.get(key);
		if (hit !== undefined) return hit;
		const piOpts: PiExecOptions = { cwd };
		if (opts?.timeoutMs !== undefined) piOpts.timeout = opts.timeoutMs;
		const p = host
			.exec(cmd, args, piOpts)
			.then(toSchemaExecResult);
		cache.set(key, p);
		return p;
	};
}

/**
 * Adapt pi's `sessionManager.getEntries()` into the typed-and-filtered
 * view predicates (and observers) expect.
 *
 * Strategy:
 *   - pick only `type: "custom"` entries (the shape `pi.appendEntry`
 *     produces — see `CustomEntry` in pi's session-manager),
 *   - filter by `customType`,
 *   - project to `{ data, timestamp }` where `timestamp` is epoch-ms
 *     (parsed from the entry's ISO string). Epoch-ms is what turn-state
 *     checks want for chronological comparisons without having to
 *     re-parse.
 *
 * The `ctx` argument is the pi `ExtensionContext` — we re-read
 * `getEntries()` on every call so predicates see the freshest state
 * (observers may have appended entries earlier in the same tool_call
 * via an earlier tool_result handler).
 */
export function createFindEntries(
	ctx: ExtensionContext,
): PredicateContext["findEntries"] {
	return <T>(customType: string) => {
		const out: Array<{ data: T; timestamp: number }> = [];
		for (const entry of ctx.sessionManager.getEntries()) {
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

/**
 * Assemble a {@link PredicateContext} for one predicate invocation.
 *
 * `input` is tool-specific (command / path / content / edits) — the
 * evaluator populates whichever fields apply to the rule being checked.
 * `cwd` is the *per-command* effective cwd for bash rules (from the
 * walker's `cwdTracker`), or the session cwd for write / edit rules.
 */
export function buildPredicateContext(params: {
	readonly cwd: string;
	readonly tool: "bash" | "write" | "edit";
	readonly input: PredicateContext["input"];
	readonly turnIndex: number;
	readonly exec: PredicateContext["exec"];
	readonly appendEntry: PredicateContext["appendEntry"];
	readonly findEntries: PredicateContext["findEntries"];
}): PredicateContext {
	return {
		cwd: params.cwd,
		tool: params.tool,
		input: params.input,
		turnIndex: params.turnIndex,
		exec: params.exec,
		appendEntry: params.appendEntry,
		findEntries: params.findEntries,
	};
}

// Silence a re-import of ExecOpts that older linters flag (we only use
// the type via PredicateContext["exec"] signature above).
export type { ExecOpts };

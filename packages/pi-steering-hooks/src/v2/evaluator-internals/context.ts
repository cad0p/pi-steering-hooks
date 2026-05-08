// SPDX-License-Identifier: MIT
// Part of @cad0p/pi-steering-hooks.

/**
 * Predicate context construction for the v2 evaluator.
 *
 * Two concerns live here because they collaborate tightly:
 *
 *   1. `createExecCache` — memoizes `exec(cmd, args, opts)` by
 *      `(cmd, args, cwd)` so every rule evaluated for ONE tool_call
 *      sees the same result for the same query, without re-running the
 *      underlying child process. A fresh cache is created per
 *      tool_call; cross-call results are never shared.
 *   2. `createFindEntries` — wraps pi's `sessionManager.getEntries()`
 *      into the {@link PredicateContext.findEntries} shape, filtering
 *      to `type: "custom"` entries by `customType` and flattening to
 *      `{ data, timestamp }` (timestamps normalized from ISO strings to
 *      epoch ms, matching what observers producing entries can rely on).
 *
 * The evaluator itself assembles the final {@link PredicateContext}
 * from these closures plus per-candidate fields (cwd / tool / input /
 * agentLoopIndex) as an object literal — no helper needed once the shape
 * is shared across bash and write/edit code paths.
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
 * Key under which the engine auto-injects the current `agentLoopIndex`
 * into every entry written via `PredicateContext.appendEntry` or
 * `ObserverContext.appendEntry`. Rules using
 * `when.happened: { in: "agent_loop" }` filter session entries by
 * comparing this key against `ctx.agentLoopIndex`.
 *
 * Exposed as a module-level constant so predicates / observers that
 * need to manually inspect the tag can reference it by name rather
 * than hardcoding the string.
 */
export const AGENT_LOOP_INDEX_KEY = "_agentLoopIndex" as const;

/**
 * Narrow "is plain object" guard used to distinguish payloads that
 * are safe to merge into (spread) from payloads that must be wrapped
 * as `{ value, _agentLoopIndex }`.
 *
 * Anything that is NOT a plain object (arrays, Date, Map, Set, Error,
 * class instances, functions, null, undefined, primitives) falls into
 * the wrap branch. Direct `{...}` or `Object.create(null)` shapes fall
 * into the merge branch.
 *
 * Two-stage detection:
 *   1. `Object.prototype.toString.call(x)` returns `"[object Object]"`
 *      only for plain objects and for class instances of user-defined
 *      classes. It correctly excludes arrays, Date, Map, Set, Error,
 *      etc.
 *   2. A prototype check then rejects user-class instances: plain
 *      objects have `Object.prototype` (or `null` for
 *      `Object.create(null)`) as their prototype; `new Box(...)` has
 *      `Box.prototype`, which is neither.
 *
 * The explicit `Array.isArray` check is belt-and-suspenders — some
 * runtimes have historically misreported arrays via `toString`, and
 * the array case is the one most likely to hit this wrapper (an
 * observer appending a list of watched paths). Cheap to check twice.
 */
function isPlainObject(x: unknown): x is Record<string, unknown> {
	if (x === null || typeof x !== "object") return false;
	if (Array.isArray(x)) return false;
	if (Object.prototype.toString.call(x) !== "[object Object]") return false;
	const proto = Object.getPrototypeOf(x);
	if (proto !== null && proto !== Object.prototype) return false;
	return true;
}

/**
 * Wrap a raw `host.appendEntry` so every write auto-injects the
 * current `agentLoopIndex` into the payload. Plain-object payloads
 * get the field merged in; everything else — primitives, arrays,
 * `Date`, `Map`, `Set`, `Error`, class instances, functions, null,
 * undefined — is wrapped as `{ value, _agentLoopIndex }` so
 * downstream consumers always see a consistent object shape.
 *
 * The "everything else" branch exists because the naive spread
 * (`{ ...data, ... }`) silently corrupts non-plain objects: arrays
 * become pseudo-objects with string-indexed keys, Date / Map / Set /
 * Error instances lose their internal state entirely, etc. Wrapping
 * under `value` preserves the original reference unchanged.
 *
 * The returned closure matches both {@link PredicateContext.appendEntry}
 * and {@link ObserverContext.appendEntry} so the evaluator and the
 * observer dispatcher share one wrapper.
 */
export function createAppendEntry(
	host: EvaluatorHost,
	agentLoopIndex: number,
): PredicateContext["appendEntry"] {
	return <T>(customType: string, data?: T) => {
		const tagged = isPlainObject(data)
			? { ...data, [AGENT_LOOP_INDEX_KEY]: agentLoopIndex }
			: { value: data, [AGENT_LOOP_INDEX_KEY]: agentLoopIndex };
		host.appendEntry(customType, tagged);
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
 * Results are memoized PER invocation of `createFindEntries` by
 * customType. The evaluator rebuilds the closure on every tool_call;
 * the observer dispatcher rebuilds on every tool_result. So each phase
 * sees a consistent snapshot, but subsequent calls to the SAME closure
 * with the same customType return the previously-materialized array.
 *
 * Staleness caveat: appending an entry via `ctx.appendEntry` during the
 * same phase does NOT invalidate the cache for this closure. Within one
 * `evaluate()` call the evaluator never writes entries while predicates
 * read them (override-audit writes happen AFTER the when-chain resolves
 * — see `evaluateCandidate`), so this is sound. Observer handlers that
 * both read and write in the same phase should read first or call
 * `findEntries` before their own `appendEntry`.
 *
 * The `ctx` argument is the pi `ExtensionContext` — we re-read
 * `getEntries()` only on the first miss per customType. Cache keys are
 * per-closure so cross-tool_call or cross-tool_result reads always see
 * the freshest state (a new closure = a new cache).
 */
export function createFindEntries(
	ctx: ExtensionContext,
): PredicateContext["findEntries"] {
	const cache = new Map<
		string,
		Array<{ data: unknown; timestamp: number }>
	>();
	return <T>(customType: string) => {
		const hit = cache.get(customType);
		if (hit !== undefined) {
			return hit as Array<{ data: T; timestamp: number }>;
		}
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
		cache.set(
			customType,
			out as Array<{ data: unknown; timestamp: number }>,
		);
		return out;
	};
}

// Silence a re-import of ExecOpts that older linters flag (we only use
// the type via PredicateContext["exec"] signature above).
export type { ExecOpts };

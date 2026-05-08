// SPDX-License-Identifier: MIT
// Part of @cad0p/pi-steering-hooks.

/**
 * Shared test-double helpers for v2 suites.
 *
 * `evaluator.test.ts` and `observer-dispatcher.test.ts` both need:
 *
 *   - a minimal {@link ExtensionContext} stub whose `sessionManager`
 *     only exposes `getEntries()` (everything else throws on access),
 *   - a "tracked host" {@link EvaluatorHost} that records every
 *     `exec` / `appendEntry` call plus pushes `appendEntry` payloads
 *     into an entries array shaped like the pi session JSONL, so the
 *     same array can back a `makeCtx` stub and let tests assert
 *     cross-handler `findEntries` visibility.
 *
 * The two former copies diverged only in whether `makeHost` accepted an
 * `exec` override (evaluator tests need it to count child-process
 * invocations for the memoization assertions; observer tests don't).
 * That's now a single option on the unified helper.
 *
 * Kept OUT of the public surface: `__test-helpers__` is a leading-double-
 * underscore convention indicating "test only"; nothing under `src/v2/`
 * imports it at runtime.
 */

import type {
	ExecResult as PiExecResult,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { EvaluatorHost } from "./evaluator-internals/context.ts";

// ---------------------------------------------------------------------------
// Session-entry shape
// ---------------------------------------------------------------------------

/**
 * Exact shape pi's `sessionManager.getEntries()` returns for entries
 * produced by `appendEntry`. The evaluator filters to `type: "custom"`,
 * matches by `customType`, and reads `{ data, timestamp }` — other
 * fields (`id`, `parentId`) exist on real entries so we mirror them
 * here to avoid silent type drift.
 */
export interface CustomEntry {
	readonly type: "custom";
	readonly customType: string;
	readonly data: unknown;
	readonly timestamp: string;
	readonly id: string;
	readonly parentId: string | null;
}

// ---------------------------------------------------------------------------
// ExtensionContext stub
// ---------------------------------------------------------------------------

/**
 * Minimal stub for pi's `ExtensionContext`. Only the fields the
 * evaluator + observer-dispatcher read are populated; everything else
 * throws if touched so accidental reliance on unsupported surface
 * breaks loudly.
 *
 * The `entries` array mimics `sessionManager.getEntries()` output —
 * tests that want cross-handler `findEntries` visibility pass
 * `host.entries` (from {@link makeTrackedHost}) here so the host's
 * `appendEntry` writes show up on subsequent reads.
 */
export function makeCtx(
	cwd: string,
	entries: ReadonlyArray<CustomEntry> = [],
): ExtensionContext {
	return {
		cwd,
		sessionManager: {
			getEntries: () => entries,
			// Other SessionManager methods are stubbed to throw via the
			// unknown-cast below; any accidental dependency surfaces as a
			// clear TypeError rather than silently passing.
		} as unknown as ExtensionContext["sessionManager"],
	} as ExtensionContext;
}

// ---------------------------------------------------------------------------
// Tracked EvaluatorHost
// ---------------------------------------------------------------------------

/**
 * Tracked {@link EvaluatorHost} recording every exec / appendEntry
 * call so tests can assert memoization + audit logging.
 *
 * `entries` is the backing array `makeCtx` wraps when tests want the
 * host's `appendEntry` writes visible to a later `findEntries` read.
 * Timestamps are monotonically-incrementing second-level ISO strings
 * so ordering asserts stay stable inside the same millisecond.
 */
export interface TrackedHost extends EvaluatorHost {
	readonly execCalls: Array<{ cmd: string; args: string[]; cwd: string }>;
	readonly appended: Array<{ type: string; data: unknown }>;
	readonly entries: CustomEntry[];
}

/**
 * Build a {@link TrackedHost}. Optional `exec` override lets evaluator
 * tests count real invocations against the cache (the default exec
 * returns `{ stdout: "", stderr: "", code: 0, killed: false }`).
 */
export function makeTrackedHost(options?: {
	exec?: (
		cmd: string,
		args: string[],
		cwd: string,
	) => Promise<PiExecResult>;
}): TrackedHost {
	const execCalls: TrackedHost["execCalls"] = [];
	const appended: TrackedHost["appended"] = [];
	const entries: CustomEntry[] = [];
	let idCounter = 0;
	return {
		execCalls,
		appended,
		entries,
		exec: async (cmd, args, opts) => {
			const cwd = opts?.cwd ?? "/";
			execCalls.push({ cmd, args: [...args], cwd });
			if (options?.exec) {
				return options.exec(cmd, args, cwd);
			}
			return { stdout: "", stderr: "", code: 0, killed: false };
		},
		appendEntry: (type, data) => {
			appended.push({ type, data });
			entries.push({
				type: "custom",
				customType: type,
				data,
				timestamp: new Date(
					Date.UTC(2026, 0, 1, 0, 0, idCounter++),
				).toISOString(),
				id: `entry-${idCounter}`,
				parentId: null,
			});
		},
	};
}

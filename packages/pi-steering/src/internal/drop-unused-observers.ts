// SPDX-License-Identifier: MIT
// Part of pi-steering.

/**
 * Observer-drop optimization.
 *
 * At config-build time, observers whose declared `writes: [...]` are
 * entirely unconsumed by any rule's `happened.event` / `happened.since`
 * can be dropped: they'd only fire on `tool_result` and write entries
 * no rule ever reads. Dropping them skips both the write (cheaper
 * session JSONL) and the speculative-synthesis contribution (no chain
 * entries for events nobody consults).
 *
 * Observers with `writes === undefined` or `writes: []` are kept
 * unconditionally — without a declaration we can't prove they're
 * unused, and `[]` is conservative parity with undeclared. Plugin
 * authors are encouraged to declare `writes` both for this
 * optimization and for `defineConfig`'s compile-time type inference.
 *
 * Pure function — no logging. Callers (session-runtime, testing)
 * log on drop so tests can inspect `dropped` directly without
 * intercepting stdout.
 */

import type { Observer, Rule } from "../schema.ts";

/** An observer dropped by {@link dropUnusedObservers}. */
export interface DroppedObserver {
	readonly name: string;
	readonly writes: readonly string[];
	readonly reason: "unused-writes";
}

/**
 * Partition `observers` into kept and dropped based on whether each
 * observer's declared writes are consumed by any rule.
 *
 * @param observers - Observers to filter (any origin — plugin-merged
 *   or user-authored).
 * @param rules - Full rule set whose `happened.event` / `happened.since`
 *   references determine consumption. Disabled rules should already
 *   be filtered out by the caller — this helper honors whatever's
 *   passed in.
 */
export function dropUnusedObservers(
	observers: readonly Observer[],
	rules: readonly Rule[],
): { kept: readonly Observer[]; dropped: readonly DroppedObserver[] } {
	const consumed = collectConsumedEvents(rules);
	const kept: Observer[] = [];
	const dropped: DroppedObserver[] = [];
	for (const o of observers) {
		if (o.writes === undefined || o.writes.length === 0) {
			kept.push(o);
			continue;
		}
		if (o.writes.some((w) => consumed.has(w))) {
			kept.push(o);
			continue;
		}
		dropped.push({
			name: o.name,
			writes: o.writes,
			reason: "unused-writes",
		});
	}
	return { kept, dropped };
}

/** Collect every event referenced by any rule's `happened.event` /
 *  `happened.since`. Rules without `when.happened` contribute nothing. */
function collectConsumedEvents(rules: readonly Rule[]): Set<string> {
	const consumed = new Set<string>();
	for (const rule of rules) {
		const h = rule.when?.happened;
		if (h === undefined) continue;
		if (typeof h.event === "string") consumed.add(h.event);
		if (typeof h.since === "string") consumed.add(h.since);
	}
	return consumed;
}

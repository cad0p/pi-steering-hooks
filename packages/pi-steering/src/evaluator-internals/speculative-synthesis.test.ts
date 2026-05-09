// SPDX-License-Identifier: MIT
// Part of pi-steering.

/**
 * Unit tests for {@link synthesizeSpeculativeEntries}.
 *
 * Table-driven across (watch, joiner) shapes per PR #5 spec. These
 * tests pin the behaviour the evaluator relies on when threading the
 * synthesis output into `walkerState.events`; the integration-level
 * chain-aware tests in `evaluator.test.ts` still drive end-to-end
 * behaviour through the built-in `happened` predicate.
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import {
	expandWrapperCommands,
	extractAllCommandsFromAST,
	parse as parseBash,
	type CommandRef,
} from "unbash-walker";
import {
	synthesizeSpeculativeEntries,
	type SyntheticEntry,
} from "./speculative-synthesis.ts";
import type { Observer } from "../schema.ts";

function refsFor(command: string): readonly CommandRef[] {
	const script = parseBash(command);
	const extracted = extractAllCommandsFromAST(script, command);
	return expandWrapperCommands(extracted).commands;
}

/** No real entries — baseline is always 0. */
const NO_REAL_ENTRIES = () => [];

const SYNC_DONE = "sync-done" as const;
const UPSTREAM_FAILED = "upstream-failed" as const;

function syncObserver(
	overrides: Partial<Observer> = {},
): Observer {
	return {
		name: "sync-tracker",
		writes: [SYNC_DONE],
		watch: {
			toolName: "bash",
			inputMatches: { command: /^sync\b/ },
			exitCode: "success",
		},
		onResult: () => {},
		...overrides,
	};
}

describe("synthesizeSpeculativeEntries: joiner reachability", () => {
	it("empty refs → empty result", () => {
		const out = synthesizeSpeculativeEntries([], [syncObserver()], NO_REAL_ENTRIES);
		assert.equal(out.size, 0);
	});

	it("`sync && cr` — cr sees sync's synthetic entry", () => {
		const refs = refsFor("sync && cr --review");
		const out = synthesizeSpeculativeEntries(
			refs,
			[syncObserver()],
			NO_REAL_ENTRIES,
		);
		const syncView = out.get(refs[0]!);
		const crView = out.get(refs[1]!);
		assert.deepEqual(syncView, {}, "first ref sees empty chain");
		assert.ok(crView?.[SYNC_DONE], "cr sees sync's synthetic entry");
		assert.equal(crView[SYNC_DONE].length, 1);
		assert.deepEqual(crView[SYNC_DONE][0], {
			data: {},
			timestamp: 1, // baseline 0 + 1 + ref index 0
			speculative: true,
		});
	});

	it("`cr && sync` — cr has no prior && producer", () => {
		const refs = refsFor("cr --review && sync");
		const out = synthesizeSpeculativeEntries(
			refs,
			[syncObserver()],
			NO_REAL_ENTRIES,
		);
		assert.deepEqual(out.get(refs[0]!), {}, "cr sees empty");
		// sync sees cr's produced events — but cr doesn't match the
		// observer, so sync still sees empty too.
		assert.deepEqual(out.get(refs[1]!), {});
	});

	it("`sync ; cr` — `;` does NOT propagate synthesis across", () => {
		const refs = refsFor("sync ; cr --review");
		const out = synthesizeSpeculativeEntries(
			refs,
			[syncObserver()],
			NO_REAL_ENTRIES,
		);
		assert.deepEqual(out.get(refs[1]!), {}, "cr after `;` sees no chain");
	});

	it("`sync || cr` — `||` breaks the chain", () => {
		const refs = refsFor("sync || cr --review");
		const out = synthesizeSpeculativeEntries(
			refs,
			[syncObserver()],
			NO_REAL_ENTRIES,
		);
		assert.deepEqual(out.get(refs[1]!), {});
	});

	it("`lint || sync && cr` — `||` early kills reachability", () => {
		// lint.joiner=||, sync.joiner=&&, cr.joiner=undef. Because
		// `lint` is followed by `||`, reachability clears. `sync`'s
		// `&&` happens on an unreachable segment → sync is not an
		// eligible producer for cr.
		const refs = refsFor("lint || sync && cr --review");
		const out = synthesizeSpeculativeEntries(
			refs,
			[syncObserver()],
			NO_REAL_ENTRIES,
		);
		assert.deepEqual(out.get(refs[2]!), {});
	});

	it("`cd /x ; sync && cr` — `;` restores reachability", () => {
		const refs = refsFor("cd /x ; sync && cr --review");
		const out = synthesizeSpeculativeEntries(
			refs,
			[syncObserver()],
			NO_REAL_ENTRIES,
		);
		const crView = out.get(refs[refs.length - 1]!);
		assert.ok(
			crView?.[SYNC_DONE],
			"after `;`, sync && cr grants a synthetic entry for cr",
		);
	});

	it("`echo foo && sync && cr` — transitive chain", () => {
		const refs = refsFor("echo foo && sync && cr --review");
		const out = synthesizeSpeculativeEntries(
			refs,
			[syncObserver()],
			NO_REAL_ENTRIES,
		);
		const crView = out.get(refs[2]!);
		assert.ok(crView?.[SYNC_DONE], "cr inherits the && chain");
	});
});

describe("synthesizeSpeculativeEntries: observer watch gating", () => {
	it("observer without inputMatches.command → no synthesis", () => {
		const looseObs: Observer = {
			name: "loose",
			writes: [SYNC_DONE],
			watch: { toolName: "bash" },
			onResult: () => {},
		};
		const refs = refsFor("sync && cr --review");
		const out = synthesizeSpeculativeEntries(
			refs,
			[looseObs],
			NO_REAL_ENTRIES,
		);
		assert.deepEqual(out.get(refs[1]!), {});
	});

	it("observer with non-bash toolName → no synthesis", () => {
		const readObs: Observer = {
			name: "read-obs",
			writes: [SYNC_DONE],
			watch: {
				toolName: "read",
				inputMatches: { command: /^sync\b/ },
			},
			onResult: () => {},
		};
		const refs = refsFor("sync && cr --review");
		const out = synthesizeSpeculativeEntries(
			refs,
			[readObs],
			NO_REAL_ENTRIES,
		);
		assert.deepEqual(out.get(refs[1]!), {});
	});

	it("observer gated on exitCode: 'failure' → no synthesis (success event)", () => {
		// The synthesized event is `exitCode: 0`; a watch demanding
		// failure rejects it via `matchesWatch`. This is the
		// delegation-to-matchesWatch contract — no subset re-impl here.
		const failObs = syncObserver({
			name: "fail-gated",
			watch: {
				toolName: "bash",
				inputMatches: { command: /^sync\b/ },
				exitCode: "failure",
			},
		});
		const refs = refsFor("sync && cr --review");
		const out = synthesizeSpeculativeEntries(
			refs,
			[failObs],
			NO_REAL_ENTRIES,
		);
		assert.deepEqual(out.get(refs[1]!), {});
	});

	it("observer with inputMatches pattern not hitting the ref → no synthesis", () => {
		const tightObs = syncObserver({
			watch: {
				toolName: "bash",
				inputMatches: { command: /^sync --lock\b/ },
				exitCode: "success",
			},
		});
		const refs = refsFor("sync && cr --review");
		const out = synthesizeSpeculativeEntries(
			refs,
			[tightObs],
			NO_REAL_ENTRIES,
		);
		assert.deepEqual(out.get(refs[1]!), {});
	});

	it("observer without writes[] → no synthesis", () => {
		const noWritesObs: Observer = {
			name: "no-writes",
			watch: {
				toolName: "bash",
				inputMatches: { command: /^sync\b/ },
			},
			onResult: () => {},
		};
		const refs = refsFor("sync && cr --review");
		const out = synthesizeSpeculativeEntries(
			refs,
			[noWritesObs],
			NO_REAL_ENTRIES,
		);
		assert.deepEqual(out.get(refs[1]!), {});
	});

	it("multiple observers on same type — first match wins, no duplicate entries", () => {
		const obsA = syncObserver({
			name: "obs-a",
			watch: {
				toolName: "bash",
				inputMatches: { command: /^never-match\b/ },
			},
		});
		const obsB = syncObserver({
			name: "obs-b",
			watch: {
				toolName: "bash",
				inputMatches: { command: /^sync\b/ },
			},
		});
		const refs = refsFor("sync && cr --review");
		const out = synthesizeSpeculativeEntries(
			refs,
			[obsA, obsB],
			NO_REAL_ENTRIES,
		);
		const crView = out.get(refs[1]!);
		assert.equal(
			crView?.[SYNC_DONE]?.length,
			1,
			"one synthetic entry per (ref, customType) — dedup across observers",
		);
	});
});

describe("synthesizeSpeculativeEntries: timestamp convention", () => {
	it("baseline = max(real) + 1 + astIndex", () => {
		const realEntries = (type: string) => {
			if (type !== SYNC_DONE) return [];
			return [{ timestamp: 1000 }, { timestamp: 500 }];
		};
		const refs = refsFor("sync && cr --review");
		const out = synthesizeSpeculativeEntries(
			refs,
			[syncObserver()],
			realEntries,
		);
		const entry = out.get(refs[1]!)?.[SYNC_DONE]?.[0];
		assert.equal(entry?.timestamp, 1001, "1000 (max real) + 1 + 0 (ref index of sync) = 1001");
	});

	it("no real entries → baseline 0; timestamps encode AST index", () => {
		// `echo foo && sync && cr`: echo.idx=0, sync.idx=1.
		// Only sync matches the observer. Its timestamp: 0 + 1 + 1 = 2.
		const refs = refsFor("echo foo && sync && cr --review");
		const out = synthesizeSpeculativeEntries(
			refs,
			[syncObserver()],
			NO_REAL_ENTRIES,
		);
		const entry = out.get(refs[2]!)?.[SYNC_DONE]?.[0];
		assert.equal(entry?.timestamp, 2);
	});

	it("two speculative writes in same chain — later ref has later timestamp", () => {
		// `A && B && cr` where A writes X and B writes Y. AST order:
		// A.idx=0, B.idx=1. Timestamps: X=1, Y=2. A `when.happened: {
		// event: X, since: Y }` evaluation downstream correctly reads
		// X as stale — the two-speculative-writes-with-since-invalidator
		// correctness case.
		const EVENT_X = "event-x";
		const EVENT_Y = "event-y";
		const obsA: Observer = {
			name: "a-tracker",
			writes: [EVENT_X],
			watch: {
				toolName: "bash",
				inputMatches: { command: /^a\b/ },
			},
			onResult: () => {},
		};
		const obsB: Observer = {
			name: "b-tracker",
			writes: [EVENT_Y],
			watch: {
				toolName: "bash",
				inputMatches: { command: /^b\b/ },
			},
			onResult: () => {},
		};
		const refs = refsFor("a && b && cr --review");
		const out = synthesizeSpeculativeEntries(
			refs,
			[obsA, obsB],
			NO_REAL_ENTRIES,
		);
		const crView = out.get(refs[2]!);
		assert.equal(crView?.[EVENT_X]?.[0]?.timestamp, 1, "X ts = 0 + 1 + 0");
		assert.equal(crView?.[EVENT_Y]?.[0]?.timestamp, 2, "Y ts = 0 + 1 + 1");
		// Invariant: X older than Y in the speculative timeline.
		assert.ok(
			(crView![EVENT_X]![0]!.timestamp) <
				(crView![EVENT_Y]![0]!.timestamp),
			"AST order preserved among speculatives",
		);
	});

	it("speculative is strictly newer than real for the same type", () => {
		// Real entry at ts=5000 for SYNC_DONE. Synthetic via ref
		// at index 0: baseline=5000 → ts=5001. The happened predicate's
		// timestamp merge sees the synthetic as newer.
		const realEntries = (type: string) =>
			type === SYNC_DONE ? [{ timestamp: 5000 }] : [];
		const refs = refsFor("sync && cr --review");
		const out = synthesizeSpeculativeEntries(
			refs,
			[syncObserver()],
			realEntries,
		);
		const entry = out.get(refs[1]!)?.[SYNC_DONE]?.[0];
		assert.ok(entry!.timestamp > 5000);
	});
});

describe("synthesizeSpeculativeEntries: flag + identity", () => {
	it("all synthetic entries carry `speculative: true`", () => {
		const refs = refsFor("sync && cr --review");
		const out = synthesizeSpeculativeEntries(
			refs,
			[syncObserver()],
			NO_REAL_ENTRIES,
		);
		const entry = out.get(refs[1]!)?.[SYNC_DONE]?.[0];
		assert.equal(entry?.speculative, true);
	});

	it("output is keyed by ref identity, not index", () => {
		const refs = refsFor("sync && cr --review");
		const out = synthesizeSpeculativeEntries(
			refs,
			[syncObserver()],
			NO_REAL_ENTRIES,
		);
		for (const ref of refs) {
			assert.ok(out.has(ref), `result has ref ${ref.node.name?.text ?? ""}`);
		}
	});

	it("single ref with no joiner → empty view", () => {
		const refs = refsFor("cr --review");
		const out = synthesizeSpeculativeEntries(
			refs,
			[syncObserver()],
			NO_REAL_ENTRIES,
		);
		assert.deepEqual(out.get(refs[0]!), {});
	});
});

describe("synthesizeSpeculativeEntries: subshell coverage", () => {
	it("`(sync) && cr` — subshell refs participate in the chain", () => {
		const refs = refsFor("(sync) && cr --review");
		const out = synthesizeSpeculativeEntries(
			refs,
			[syncObserver()],
			NO_REAL_ENTRIES,
		);
		// cr is the last ref; sync's synthetic entry must be visible.
		const crView = out.get(refs[refs.length - 1]!);
		assert.ok(crView?.[SYNC_DONE], "subshell sync feeds cr's chain");
	});

	it("`(echo hi && sync) && cr` — multi-ref subshell", () => {
		// GAP-01 regression fence. Both refs inside `(...)` participate
		// in cr's prior chain; sync matches the observer.
		const refs = refsFor("(echo hi && sync) && cr --review");
		const out = synthesizeSpeculativeEntries(
			refs,
			[syncObserver()],
			NO_REAL_ENTRIES,
		);
		const crView = out.get(refs[refs.length - 1]!);
		assert.ok(crView?.[SYNC_DONE], "multi-ref subshell: sync feeds cr");
	});

	it("`foo && (bar ; sync) && cr` — `;` inside subshell clears chain", () => {
		// GAP-02 conservative-under fence. After the `;`, only sync is
		// in cr's prior chain; foo is dropped. Observer matches ONLY
		// foo → no synthesis for cr.
		const fooObs = syncObserver({
			name: "foo-only",
			watch: {
				toolName: "bash",
				inputMatches: { command: /^foo\b/ },
				exitCode: "success",
			},
		});
		const refs = refsFor("foo && (bar ; sync) && cr --review");
		const out = synthesizeSpeculativeEntries(
			refs,
			[fooObs],
			NO_REAL_ENTRIES,
		);
		const crView = out.get(refs[refs.length - 1]!);
		assert.deepEqual(
			crView,
			{},
			"conservative-under: foo dropped from cr's chain by `;`",
		);
	});
});

describe("synthesizeSpeculativeEntries: per-ref isolation", () => {
	it("earlier refs do not see later producers", () => {
		// Load-bearing safety property. `sync && cr`: sync (idx 0)
		// must NOT see its own synthetic entry. Only cr (idx 1) does.
		const refs = refsFor("sync && cr --review");
		const out = synthesizeSpeculativeEntries(
			refs,
			[syncObserver()],
			NO_REAL_ENTRIES,
		);
		assert.deepEqual(
			out.get(refs[0]!),
			{},
			"sync cannot see entries it (would) produce",
		);
	});

	it("map entries are distinct per ref (no cross-ref mutation)", () => {
		const refs = refsFor("echo foo && sync && cr --review");
		const out = synthesizeSpeculativeEntries(
			refs,
			[syncObserver()],
			NO_REAL_ENTRIES,
		);
		const echoView = out.get(refs[0]!);
		const syncView = out.get(refs[1]!);
		const crView = out.get(refs[2]!);
		// echo, sync should both see empty (sync hasn't produced yet
		// for itself). cr should see sync's entry.
		assert.deepEqual(echoView, {});
		assert.deepEqual(syncView, {});
		assert.ok(crView?.[SYNC_DONE]);
	});
});

describe("synthesizeSpeculativeEntries: baseline semantics", () => {
	it("writes by distinct observers for different customTypes coexist", () => {
		const OTHER = "other-event";
		const otherObs: Observer = {
			name: "other",
			writes: [OTHER],
			watch: {
				toolName: "bash",
				inputMatches: { command: /^sync\b/ },
			},
			onResult: () => {},
		};
		const refs = refsFor("sync && cr --review");
		const out = synthesizeSpeculativeEntries(
			refs,
			[syncObserver(), otherObs],
			NO_REAL_ENTRIES,
		);
		const crView = out.get(refs[1]!);
		assert.ok(crView?.[SYNC_DONE]);
		assert.ok(crView?.[OTHER]);
	});

	it("custom type with no observers remains unrepresented", () => {
		const refs = refsFor("sync && cr --review");
		const out = synthesizeSpeculativeEntries(
			refs,
			[syncObserver()],
			NO_REAL_ENTRIES,
		);
		const crView = out.get(refs[1]!) as Record<
			string,
			readonly SyntheticEntry[]
		>;
		assert.equal(crView[UPSTREAM_FAILED], undefined);
	});
});

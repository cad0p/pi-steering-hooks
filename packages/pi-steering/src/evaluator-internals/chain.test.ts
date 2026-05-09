// SPDX-License-Identifier: MIT
// Part of pi-steering.

/**
 * Reachability-matrix unit tests for {@link computePriorAndChains}.
 *
 * The function encodes the safety model for bash `&&`-speculative
 * allow: for each extracted command ref in a script, compute the
 * prior refs reachable via a continuous left-to-right `&&` chain
 * starting from an unconditionally-reached segment. Chain-aware
 * `when.happened` uses this set to decide whether to skip a block.
 *
 * End-to-end chain-aware tests in `evaluator.test.ts` already cover
 * the user-visible behaviour (skip / block on representative shapes),
 * but they stack the full evaluator + observer-dispatcher + session-
 * entry plumbing on top of this one pure function. A bug in the
 * reachability logic could slip past end-to-end tests if the specific
 * shape isn't exercised; if the function is re-touched later, it's
 * easy to reintroduce a subtle bug that passes the end-to-end cases.
 *
 * These unit tests pin the reachability matrix DIRECTLY against
 * `computePriorAndChains`:
 *   - input: a command string parsed + extracted via the same walker
 *     pipeline the evaluator uses (parse → extract → expand-wrappers)
 *     so the ref shape matches production exactly,
 *   - output: the per-ref prior-text arrays (one array per ref).
 *
 * Full matrix per pr4-dedup-spec, plus edge / negative / mixed cases.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	expandWrapperCommands,
	extractAllCommandsFromAST,
	parse as parseBash,
	type CommandRef,
} from "unbash-walker";
import { computePriorAndChains, refToText } from "./chain.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Mirror the evaluator's ref-extraction pipeline so tests exercise
 * the exact same `CommandRef` shape (source, joiner metadata, etc.)
 * `computePriorAndChains` sees at runtime. Hand-rolled fake refs
 * would bypass the real walker's joiner-assignment logic and turn
 * this into a test of the test fixture rather than the function.
 */
function refsFor(command: string): readonly CommandRef[] {
	const script = parseBash(command);
	const extracted = extractAllCommandsFromAST(script, command);
	const { commands } = expandWrapperCommands(extracted);
	return commands;
}

/** Extract just the prior-text arrays as plain string[][] for assert.deepEqual. */
function priorTexts(command: string): string[][] {
	const refs = refsFor(command);
	const chains = computePriorAndChains(refs);
	return chains.map((perRef) => perRef.map((r) => r.text));
}

// ---------------------------------------------------------------------------
// Core reachability matrix (pr4-dedup-spec)
// ---------------------------------------------------------------------------

describe("computePriorAndChains: reachability matrix", () => {
	it("empty command → empty result", () => {
		assert.deepEqual(priorTexts(""), []);
	});

	it("single ref → prior = []", () => {
		// One ref, no predecessors to speak of.
		assert.deepEqual(priorTexts("echo hi"), [[]]);
	});

	it("A && B → B's prior = [A]", () => {
		// The canonical chain-aware case.
		assert.deepEqual(priorTexts("A && B"), [[], ["A"]]);
	});

	it("A && B && C → transitive chain", () => {
		assert.deepEqual(priorTexts("A && B && C"), [[], ["A"], ["A", "B"]]);
	});

	it("A ; B && C → `;` resets but B stays predecessor of C", () => {
		// After `;` the next ref runs unconditionally, so B's own prior
		// is []. B && C makes B a prior of C from a restored reachable
		// segment.
		assert.deepEqual(priorTexts("A ; B && C"), [[], [], ["B"]]);
	});

	it("A || B && C → B not reachable; C's prior = []", () => {
		// Bash parses `A || B && C` as `(A || B) && C`. When A succeeds,
		// B is skipped but C still runs — B never executed, so B must
		// NOT appear in C's prior chain. Conservative under-allow: we
		// don't grant speculative-allow based on B.
		assert.deepEqual(priorTexts("A || B && C"), [[], [], []]);
	});

	it("A | B && C → pipe breaks reachability; C's prior = []", () => {
		// Pipes don't give us success-ordering semantics we can rely on
		// (B's exit code gates C, not A's). Treat `|` the same as `||`
		// for the purposes of this walker: B is NOT in an
		// unconditionally-reached segment, so C cannot safely chain off
		// it.
		assert.deepEqual(priorTexts("A | B && C"), [[], [], []]);
	});

	it("A && B ; C && D → `;` resets; D's prior = [C] only", () => {
		// Semicolon boundary severs the `&&` chain. After `;`, C starts
		// a fresh reachable segment; only C (not A or B) precedes D.
		assert.deepEqual(priorTexts("A && B ; C && D"), [
			[],
			["A"],
			[],
			["C"],
		]);
	});

	it("A && B ; C → `;` resets; C's prior = []", () => {
		// A new statement after an `&&`-chain. C is unconditionally
		// reached but has no `&&` predecessors in its own segment.
		assert.deepEqual(priorTexts("A && B ; C"), [[], ["A"], []]);
	});

	it("(A && B) && C → subshell &&-exit propagates", () => {
		// The walker flattens subshells into a flat ref list and the
		// joiner metadata on each ref describes the operator to the
		// NEXT extracted ref in source order. For `(A && B) && C` that
		// makes both A (inside the subshell, joined by `&&` to B) and
		// B (subshell's last ref, joined by `&&` to the outer C)
		// prior-`&&` predecessors of C.
		assert.deepEqual(priorTexts("(A && B) && C"), [
			[],
			["A"],
			["A", "B"],
		]);
	});

	it("A && (B; C) && D → conservative under-allow; D's prior = [C] only", () => {
		// Documented per JSDoc: when a subshell contains an inner `;`,
		// the `&&`-chain into/out of the subshell is conservatively
		// broken. D's prior is [C] (the post-`;` reachable segment's
		// last ref that &&-chains to the outer D), not [A, C]. Under-
		// allow is safe; we never grant a speculative allow we
		// shouldn't.
		assert.deepEqual(priorTexts("A && (B ; C) && D"), [
			[],
			["A"],
			[],
			["C"],
		]);
	});
});

// ---------------------------------------------------------------------------
// Negative cases — prior chain must be empty
// ---------------------------------------------------------------------------

describe("computePriorAndChains: negative cases", () => {
	it("A || B → B's prior = [] (A not a success-predecessor of B)", () => {
		// `||` runs B only on A's FAILURE. B is not in a reachable-
		// from-an-unconditional-success segment; no prior-&& chain
		// applies.
		assert.deepEqual(priorTexts("A || B"), [[], []]);
	});

	it("A && B || C → C's prior = [] (C runs on B's failure)", () => {
		// Bash parses `A && B || C` as `(A && B) || C`. When A && B
		// succeeds, C is skipped. When A or B fails, C runs — but by
		// then the `&&`-chain is broken. C has no reliable `&&`
		// predecessor.
		assert.deepEqual(priorTexts("A && B || C"), [[], ["A"], []]);
	});

	it("A | B → B's prior = [] (pipe breaks reachability)", () => {
		// Pipe between A and B means B reads A's stdout; the &&-
		// predecessor relationship doesn't hold.
		assert.deepEqual(priorTexts("A | B"), [[], []]);
	});

	it("A || B || C → all priors = []", () => {
		// No `&&` anywhere; nothing qualifies as a prior-`&&`
		// predecessor of anything.
		assert.deepEqual(priorTexts("A || B || C"), [[], [], []]);
	});
});

// ---------------------------------------------------------------------------
// Mixed operators — careful thought-through cases
// ---------------------------------------------------------------------------

describe("computePriorAndChains: mixed-operator cases", () => {
	it("A && B ; C || D && E → boundaries cascade correctly", () => {
		// Walk through:
		//   - A: prior []. A's joiner is `&&` and reachable, so B inherits [A].
		//   - B: prior [A]. B's joiner is `;`, statement boundary → next
		//        ref C is unconditionally reached, chain resets to [].
		//   - C: prior []. C's joiner is `||` → D is NOT reachable (runs
		//        only on C's failure), chain stays [], reachable=false.
		//   - D: prior []. D's joiner is `&&` but D is unreachable, so
		//        the `&&`-advance guard fails → clears chain, next ref E
		//        is not in a reachable segment.
		//   - E: prior [].
		assert.deepEqual(priorTexts("A && B ; C || D && E"), [
			[],
			["A"],
			[],
			[],
			[],
		]);
	});

	it("A ; B ; C ; D → each statement fresh; all priors = []", () => {
		// Pure statement-separated commands. No `&&` anywhere, so no
		// speculative-allow candidates.
		assert.deepEqual(priorTexts("A ; B ; C ; D"), [[], [], [], []]);
	});

	it("A && B && C ; D → `;` resets; D's prior = []", () => {
		// The `&&` chain up to C doesn't leak past `;` into D.
		assert.deepEqual(priorTexts("A && B && C ; D"), [
			[],
			["A"],
			["A", "B"],
			[],
		]);
	});

	it("A ; B && C && D → mid-script chain after `;`", () => {
		assert.deepEqual(priorTexts("A ; B && C && D"), [
			[],
			[],
			["B"],
			["B", "C"],
		]);
	});

	it("A || B ; C && D → `;` restores reachability for C && D", () => {
		// A || B: neither A nor B is in a stably-reachable segment via
		// `&&` for anything that follows. `;` resets. C runs
		// unconditionally. C && D → D's prior = [C].
		assert.deepEqual(priorTexts("A || B ; C && D"), [
			[],
			[],
			[],
			["C"],
		]);
	});

	it("A && B | C → `|` breaks the chain for what follows C", () => {
		// A && B: B inherits [A]. B's joiner is `|`, not `&&` — so C is
		// the stdin-of-pipe side, NOT an `&&`-successor. Pipelines
		// don't propagate success-ordering we can rely on; chain for
		// anything after C resets.
		assert.deepEqual(priorTexts("A && B | C"), [[], ["A"], []]);
	});
});

// ---------------------------------------------------------------------------
// Safety invariant: strictly-prior (never forward-looking)
// ---------------------------------------------------------------------------

describe("computePriorAndChains: strictly-prior invariant", () => {
	// Load-bearing safety property: `priorAndChainedRefs[i]` must
	// contain ONLY refs at indices < i. Violating it would let an
	// agent bypass a block by placing the "satisfying" ref AFTER the
	// blocked ref, since events from future refs would speculatively
	// pre-satisfy a `when.happened` check on the current ref.
	it("no ref in its own prior set", () => {
		const refs = refsFor("A && B && C && D");
		const chains = computePriorAndChains(refs);
		for (let i = 0; i < refs.length; i++) {
			const selfText = refToText(refs[i]!);
			for (const prior of chains[i] ?? []) {
				assert.notEqual(
					prior.text,
					selfText,
					`ref ${i} (${selfText}) found itself in its prior set`,
				);
			}
		}
	});

	it("prior sets never include refs at indices >= self", () => {
		// Concrete: for each (i, j) with j >= i, refs[j]'s text must
		// not appear in chains[i]. The walk populates left-to-right and
		// never forward-references by construction; this test pins the
		// invariant against future refactors.
		const script = "A && B && C && D";
		const refs = refsFor(script);
		const chains = computePriorAndChains(refs);
		// Build the text-per-ref array the same way refToText does:
		// `basename args...`. For these single-token commands the
		// basename IS the text.
		const texts = ["A", "B", "C", "D"];
		for (let i = 0; i < refs.length; i++) {
			const priorTextsSet = new Set(
				(chains[i] ?? []).map((r) => r.text),
			);
			for (let j = i; j < refs.length; j++) {
				assert.ok(
					!priorTextsSet.has(texts[j]!),
					`ref ${i} (${texts[i]}) contains future ref ${j} (${texts[j]}) in its prior set — forward-reference violates strictly-prior invariant`,
				);
			}
		}
	});
});

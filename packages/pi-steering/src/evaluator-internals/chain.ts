// SPDX-License-Identifier: MIT
// Part of pi-steering.

/**
 * Chain-reachability computation for bash `&&` speculative-allow.
 *
 * Lives alongside the other `evaluator-internals/` modules because it
 * is evaluator-specific but worth isolating from the 700-line
 * `evaluator.ts`: the function is a pure, input-driven
 * reachability-matrix calculator (refs → prior ref sets per index)
 * that's easier to unit-test in isolation than to exercise end-to-end
 * through `buildEvaluator`. The end-to-end chain-aware tests in
 * `evaluator.test.ts` are still the source of truth for user-facing
 * behaviour; this file's unit tests pin the reachability logic so
 * future refactors are independently verifiable.
 *
 * @internal — not part of the public pi-steering surface. Re-exported
 * here so test files can import it directly without crossing the
 * package boundary through `evaluator.ts`'s public re-exports.
 */

import {
	getBasename,
	getCommandArgs,
	type CommandRef,
} from "unbash-walker";

/**
 * Shape the chain-aware path carries through `PredicateContext`. The
 * evaluator captures enough information from each prior ref for the
 * built-in `happened` predicate to run `watch.inputMatches.command`
 * patterns against — observers never see the full {@link CommandRef}.
 *
 * @internal
 */
export interface PriorAndChainedRef {
	readonly text: string;
}

/**
 * Compute the text of a ref the same way `BashRefState.text` does.
 * Hoisted so both the prior-`&&` chain computation in
 * {@link computePriorAndChains} and the per-ref state prep in the
 * evaluator share one implementation.
 *
 * @internal
 */
export function refToText(ref: CommandRef): string {
	return `${getBasename(ref)} ${getCommandArgs(ref).join(" ")}`.trim();
}

/**
 * For each ref in `refs`, compute the list of prior refs reachable via
 * a continuous left-to-right `&&` chain starting from an
 * unconditionally-reached point.
 *
 * Walk left-to-right tracking two pieces of state:
 *   - `current`: the prior-`&&` chain for the NEXT ref.
 *   - `reachable`: whether the NEXT ref will be unconditionally reached
 *     regardless of any prior conditional branches (or, for `&&`-
 *     joined successors, whether the current ref is itself part of an
 *     unconditionally-reachable segment).
 *
 * Safety model for chain-aware `when.happened` speculative allow: we
 * must only let a prior ref count as a predecessor of a successor if
 * (a) the successor is joined to it via `&&` (short-circuit guarantees
 * the prior ref ran AND succeeded before successor runs) AND (b) the
 * prior ref itself was part of an unconditionally-reached segment
 * (so it wasn't skipped by a `||`/`|` short-circuit further left). The
 * `reachable` flag tracks (b); the `ref.joiner === "&&"` check tracks
 * (a).
 *
 * Concrete breaks:
 *   - `A || B && C`: when A succeeds, B is SKIPPED, then C runs
 *     (because `A || B` is true). B must NOT appear in C's prior
 *     chain — speculative allow via B is unsafe.
 *   - `A | B && C`: pipelines don't give us success-ordering semantics
 *     we can rely on; treat `|` the same as `||` for this purpose.
 *   - `A ; B && C`: `;` is a statement boundary — B runs
 *     unconditionally, so B's success predecessor-ness for C is
 *     restored.
 *
 * Subshells (`(A && B) && C`) are flattened by the walker into a flat
 * ref list — the joiner metadata on each ref describes the operator
 * to the NEXT extracted ref in source order. In practice this gives
 * the right answer for the common shapes (see tests), and is
 * **conservative** for the rare shapes where a subshell's last ref
 * joiner is `&&` (e.g. `A && (B ; C) && D` gives `D ← [C]`, not
 * `[A, C]`). Conservative under-allow is safe; we never grant a
 * speculative allow we shouldn't.
 *
 * Invariant: the returned array's i-th entry contains ONLY refs at
 * indices strictly less than i. The walk is left-to-right and never
 * forward-references — this is a load-bearing safety property for
 * chain-aware speculative-allow (events from refs AFTER the current
 * ref must NOT satisfy `when.happened`, otherwise an agent could
 * bypass a block by putting the "satisfying" ref after the blocked
 * ref).
 *
 * @internal
 */
export function computePriorAndChains(
	refs: readonly CommandRef[],
): Array<readonly PriorAndChainedRef[]> {
	const result: Array<readonly PriorAndChainedRef[]> = new Array(
		refs.length,
	);
	let current: Array<PriorAndChainedRef> = [];
	// The first ref runs unconditionally from the start of the command.
	let reachable = true;
	for (let i = 0; i < refs.length; i++) {
		result[i] = current;
		const ref = refs[i];
		if (ref === undefined) continue;
		if (ref.joiner === "&&" && reachable) {
			// `ref` is unconditionally-reached AND joined to the next ref
			// via `&&`. The next ref runs only if `ref` succeeded — so when
			// it runs, `ref` is guaranteed to have completed successfully.
			// Push `ref` onto the chain for the next ref; `reachable` stays
			// true for the same reason.
			current = [...current, { text: refToText(ref) }];
		} else if (ref.joiner === ";") {
			// Statement boundary. Next ref runs unconditionally regardless
			// of prior branches. Reset the chain (prior `&&` predecessors
			// no longer precede the next ref via `&&`) and mark reachable.
			current = [];
			reachable = true;
		} else {
			// `||`, `|`, undefined, or `&&` on an unreachable ref. The next
			// ref is not unconditionally reached (it runs only on a
			// specific branch), so no ref from this segment can safely
			// serve as a prior-`&&` predecessor. Clear the chain and mark
			// the next ref unreachable until a `;` restores it.
			current = [];
			reachable = false;
		}
	}
	return result;
}

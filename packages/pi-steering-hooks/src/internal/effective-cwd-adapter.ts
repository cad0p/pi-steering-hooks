// SPDX-License-Identifier: MIT
// Part of @cad0p/pi-steering-hooks.
//
// Local adapter, to be removed in Phase 2.
//
// The Phase 1 ADR for PR #2 (linked from the PR description) generalized
// unbash-walker's `effectiveCwd` into a `walk(script, state, trackers,
// refs?)` function with a tracker registry. The old single-purpose
// `effectiveCwd` export is gone — no back-compat shim in `unbash-walker`
// itself, per the ADR's "no compat wrappers" directive.
//
// Phase 2 (the v1 config-format rewrite) replaces this evaluator wholesale
// with the Tracker-aware evaluator / predicate system. Until then this
// adapter keeps the existing evaluator code building by translating the
// new `walk` API back to the old `effectiveCwd` shape.

import {
	cwdTracker,
	walk,
	type CommandRef,
	type Script,
} from "unbash-walker";

/**
 * Compute per-command effective cwds — Phase 2-bound shim over
 * `walk(script, { cwd }, { cwd: cwdTracker }, refs)`.
 *
 * Identical in behavior to the old `unbash-walker`-exported `effectiveCwd`:
 * the returned Map is keyed by CommandRef (using the caller's refs if
 * given, else fresh ones from an internal extract) and each value is the
 * command's cwd string.
 *
 * Exists only so the pi-steering-hooks evaluator can continue to import
 * an `effectiveCwd`-shaped helper during Phase 1. Phase 2 will rewrite the
 * evaluator around a tracker-snapshot-aware `BashContext`, at which point
 * this file is deleted.
 */
export function effectiveCwd(
	script: Script,
	initialCwd: string,
	refs?: readonly CommandRef[],
): Map<CommandRef, string> {
	const walkResult = walk(
		script,
		{ cwd: initialCwd },
		{ cwd: cwdTracker },
		refs,
	);
	const out = new Map<CommandRef, string>();
	for (const [ref, snap] of walkResult) {
		out.set(ref, snap.cwd);
	}
	return out;
}

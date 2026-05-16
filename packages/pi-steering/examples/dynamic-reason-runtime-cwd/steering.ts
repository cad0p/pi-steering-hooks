// SPDX-License-Identifier: MIT
// Part of pi-steering / examples.

/**
 * Example: dynamic-reason + walker-unknown-cwd pattern.
 *
 * Demonstrates how external plugin authors compose runtime-cwd
 * predicates (gitPlugin's `isClean` / `hasStagedChanges` / `remote` /
 * `upstream` / `commitsAhead` — all `requireKnownCwd`-wrapped) with
 * informative agent-facing reasons that distinguish two branches:
 *
 *   - Static cwd + predicate fires: domain-specific reason text
 *     (the working tree is genuinely dirty).
 *   - Walker-unknown cwd: `walkerUnknownCwdReason()` explains the
 *     walker couldn't statically resolve cwd, surfaces the actual
 *     `ctx.cwd`, and prompts a retry with a literal path. The
 *     example appends a small piece of domain-specific retry
 *     guidance after the helper's output.
 *
 * Drop this file in at `.pi/steering.ts` (or
 * `.pi/steering/index.ts`) to activate. The example uses gitPlugin's
 * `isClean` predicate to gate `npm run deploy` on a clean working
 * tree.
 */

import {
	defineConfig,
	walkerUnknownCwdReason,
	type Rule,
} from "pi-steering";
import gitPlugin from "pi-steering/plugins/git";

/**
 * Rule: block `npm run deploy` when the working tree isn't clean.
 *
 * The `reason` field is a {@link ReasonFn} that branches on
 * `ctx.walkerState?.cwd === "unknown"` to detect the
 * walker-unknown-cwd fail-closed branch (gitPlugin's `isClean` is
 * `requireKnownCwd`-wrapped). On that branch, `walkerUnknownCwdReason`
 * produces the canonical agent-facing explanation; the example
 * appends domain-specific retry guidance after it.
 */
const deployRequiresCleanTree = {
	name: "deploy-requires-clean-tree",
	tool: "bash",
	field: "command",
	pattern: /^npm\s+run\s+deploy\b/,
	// Fail-closed semantics under walker-unknown cwd: use `isClean: false`
	// (the canonical "fires when dirty" form per gitPlugin's predicates.ts
	// JSDoc) NOT `not: { isClean: true }`. The requireKnownCwd wrap returns
	// true unconditionally under walker-unknown cwd; the `not:` form
	// inverts that to false and silently fails OPEN. See README
	// "Why isClean: false, not not: { isClean: true }" subsection.
	when: { isClean: false },
	reason: (ctx) => {
		if (ctx.walkerState?.cwd === "unknown") {
			// requireKnownCwd-wrap fired: walker couldn't resolve cwd
			// statically. Use the helper for a consistent agent-facing
			// explanation; append domain-specific retry guidance.
			return (
				walkerUnknownCwdReason(ctx, "working tree status") +
				" Run from inside the package directory with a literal path."
			);
		}
		// Predicate fired with a known cwd: working tree is genuinely dirty.
		return "Working tree has uncommitted changes. Commit or stash before deploying.";
	},
} as const satisfies Rule;

export default defineConfig({
	plugins: [gitPlugin],
	rules: [deployRequiresCleanTree],
});

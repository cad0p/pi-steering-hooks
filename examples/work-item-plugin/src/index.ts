// SPDX-License-Identifier: MIT
// Part of the pi-steering work-item-plugin example.

/**
 * Work-item example plugin — canonical reference for pi-steering
 * plugin authors (ADR §15).
 *
 * What this plugin demonstrates, file-by-file:
 *
 *   - `predicates/work-item-format.ts`
 *       - `definePredicate<T>` for typed predicate-arg variance.
 *       - Structured arg access via `input.args` (quote-aware).
 *   - `observers/npm-test-tracker.ts`
 *       - ADR §14 encapsulation convention: file exports the
 *         `<EVENT>_TYPE` constant AND a `mark<Event>(ctx)` helper;
 *         observer uses the helper.
 *       - `writes` declaration threading through for
 *         `defineConfig`'s compile-time type checking.
 *   - `rules/commit-requires-work-item.ts`
 *       - Plugin-registered predicate consumption via `when.<key>`.
 *       - `not:` inversion in a `WhenClause`.
 *   - `rules/push-requires-tests.ts`
 *       - `when.happened: { in: "agent_loop" }` gating.
 *       - Observer → rule coupling via the shared TYPE constant.
 *   - `rules/commit-description-check.ts`
 *       - Self-marking rules with `onFire`.
 *       - Constant + helper co-located with the rule when no
 *         observer corresponds (ADR §14).
 *
 * Copy-adapt this layout. A real plugin likely ships more rules and
 * possibly a tracker too — see `packages/pi-steering-hooks/src/plugins/git/`
 * for the tracker + tracker-extension pattern.
 *
 * ## Consuming this plugin
 *
 * ```ts
 * import { defineConfig } from "pi-steering";
 * import workItemPlugin from "@examples/work-item-plugin";
 *
 * export default defineConfig({
 *   plugins: [workItemPlugin],
 * });
 * ```
 */

import type { Plugin } from "pi-steering";
import { workItemFormat } from "./predicates/work-item-format.ts";
import {
	npmTestTracker,
	TEST_PASSED_TYPE,
} from "./observers/npm-test-tracker.ts";
import { commitRequiresWorkItem } from "./rules/commit-requires-work-item.ts";
import { pushRequiresTests } from "./rules/push-requires-tests.ts";
import {
	commitDescriptionCheck,
	DESCRIPTION_REVIEWED_TYPE,
} from "./rules/commit-description-check.ts";

// Re-export the type constants so consumers (e.g. another plugin or
// a user's custom rule) can gate on the same events without
// rediscovering the literal strings.
export { TEST_PASSED_TYPE, DESCRIPTION_REVIEWED_TYPE };

/**
 * The plugin. `as const satisfies Plugin` preserves the literal
 * `name: "work-item"` and the `writes` tuples from rules/observers
 * so `defineConfig` can cross-reference `when.happened.type` usages
 * against this plugin's declared writes. See the ADR §7 footgun
 * about bare `: Plugin` annotations.
 */
const workItemPlugin = {
	name: "work-item",
	predicates: { workItemFormat },
	rules: [
		commitRequiresWorkItem,
		pushRequiresTests,
		commitDescriptionCheck,
	],
	observers: [npmTestTracker],
} as const satisfies Plugin;

export default workItemPlugin;

// Named re-exports — pick-your-piece imports for authors who want
// just one rule or the predicate.
export { workItemFormat } from "./predicates/work-item-format.ts";
export { npmTestTracker, markTestPassed } from "./observers/npm-test-tracker.ts";
export { commitRequiresWorkItem } from "./rules/commit-requires-work-item.ts";
export { pushRequiresTests } from "./rules/push-requires-tests.ts";
export {
	commitDescriptionCheck,
	markDescriptionReviewed,
} from "./rules/commit-description-check.ts";

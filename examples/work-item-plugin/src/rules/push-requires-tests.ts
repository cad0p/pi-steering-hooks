// SPDX-License-Identifier: MIT
// Part of the pi-steering work-item-plugin example.

/**
 * `push-requires-tests` — example rule.
 *
 * Demonstrates the observer → rule coupling (ADR §5):
 *
 *   - The `npm-test-tracker` observer writes a `TEST_PASSED_EVENT`
 *     entry on every successful `npm test`.
 *   - This rule gates `git push` on `when.happened`, which fires
 *     when the event has NOT happened in the scope.
 *   - `in: "agent_loop"` filters by `_agentLoopIndex` — so the
 *     gate resets every time the user sends a new prompt. Running
 *     tests in turn N doesn't let you push in turn N+10; you have
 *     to re-run tests in THIS agent loop.
 *
 * `when.happened.event` is the imported `TEST_PASSED_EVENT` constant,
 * not the raw string. That's the ADR §14 encapsulation convention:
 * rules reference observer writes through the observer's exported
 * constant so renames stay type-safe.
 *
 * Override: disallowed. Pushing without proof of green tests is an
 * inherent-risk action here.
 */

import type { Rule } from "pi-steering";
import { TEST_PASSED_EVENT } from "../observers/npm-test-tracker.ts";

export const pushRequiresTests = {
	name: "push-requires-tests",
	tool: "bash",
	field: "command",
	pattern: /^git\s+push\b/,
	when: {
		// Fires when TEST_PASSED_EVENT has NOT been written in the
		// current agent loop (see ADR §5).
		happened: { event: TEST_PASSED_EVENT, in: "agent_loop" },
	},
	reason:
		"Run `npm test` successfully in this agent loop before pushing.",
	noOverride: true,
	// Declaring the observer's write-type in our `writes` is NOT
	// required — the observer already declares it. This rule doesn't
	// write anything, so no `writes` here.
} as const satisfies Rule;

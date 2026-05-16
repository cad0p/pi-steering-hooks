// SPDX-License-Identifier: MIT
// Part of pi-steering-flags.

/**
 * pi-steering-flags \u2014 declarative flag-presence and flag-allowlist
 * predicates for pi-steering rules.
 *
 * First official external plugin for the pi-steering ecosystem.
 * Establishes the precedent pattern for every community plugin that
 * follows:
 *
 *   - Package name: `pi-steering-<domain>` (unscoped, mirroring
 *     `pi-steering` core).
 *   - Keywords: `["pi-package", "pi-steering-package", ...]` for
 *     ecosystem discoverability via pi.dev and `npm search`.
 *   - PeerDep on `pi-steering` (pinned range once published).
 *   - Two predicates exported as a `Plugin`, three helpers exported
 *     for `when.condition` escape-hatch use.
 *
 * See this package's README for usage examples, and the pi-steering
 * README "Writing plugins" section for the design rationale.
 */

import type { Plugin } from "pi-steering";
import { allowlistedFlagsOnly } from "./predicates/allowlisted-flags-only.ts";
import { requiresFlag } from "./predicates/requires-flag.ts";

/**
 * The plugin. `as const satisfies Plugin` preserves literal types so
 * `defineConfig({ plugins: [flagsPlugin] })` can cross-reference the
 * predicate names at compile time.
 */
const flagsPlugin = {
	name: "flags",
	predicates: {
		requiresFlag,
		allowlistedFlagsOnly,
	},
} as const satisfies Plugin;

export default flagsPlugin;

// Named re-exports \u2014 pick-your-piece imports for authors who want
// just one predicate or a helper.
export { requiresFlag } from "./predicates/requires-flag.ts";
export { allowlistedFlagsOnly } from "./predicates/allowlisted-flags-only.ts";
export { hasFlag, getFlagValue, hasEnvAssignment, INFO_ONLY } from "./helpers.ts";
export type {
	RequiresFlagArgs,
	AllowlistedFlagsOnlyArgs,
} from "./types.ts";

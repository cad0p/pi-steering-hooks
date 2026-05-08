// SPDX-License-Identifier: MIT
// Part of @cad0p/pi-steering-hooks.

/**
 * v2 barrel — public surface of the new TS-first config system.
 *
 * Re-exported at the package root via `../index.ts`. Consumers shouldn't
 * need to reach into this directory directly; the flat package imports
 * are the stable surface.
 *
 * Nothing here is wired into the extension runtime in Phase 2 — the
 * v1 evaluator still drives pi. Phase 3 flips the extension to consume
 * the merged {@link SteeringConfig} produced by {@link loadSteeringConfig}.
 */

// Types
export type {
	ExecOpts,
	ExecResult,
	Observer,
	ObserverContext,
	ObserverWatch,
	Pattern,
	Plugin,
	PredicateContext,
	PredicateFn,
	PredicateHandler,
	PredicateToolInput,
	Rule,
	SteeringConfig,
	ToolResultEvent,
	WhenClause,
} from "./schema.ts";

// Config helper
export type { DefineConfigInput } from "./define-config.ts";
export { defineConfig } from "./define-config.ts";

// Predicate helper
export { definePredicate } from "./define-predicate.ts";

// Loader
export {
	ancestorChain,
	buildConfig,
	configCandidates,
	findConfigFile,
	loadConfigs,
	loadSteeringConfig,
} from "./loader.ts";

// JSON compat
export { FromJSONError, fromJSON } from "./compat.ts";

// Auto-tag key for session-entry writes. Exposed so plugin authors
// inspecting raw session entries via `findEntries` can reference the
// constant instead of hardcoding the string.
export { AGENT_LOOP_INDEX_KEY } from "./evaluator-internals/context.ts";

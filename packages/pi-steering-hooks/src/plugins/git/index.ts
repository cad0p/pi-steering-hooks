// SPDX-License-Identifier: MIT
// Part of @cad0p/pi-steering-hooks.

/**
 * Git plugin for `@cad0p/pi-steering-hooks`.
 *
 * Subpath import: `@cad0p/pi-steering-hooks/plugins/git`.
 *
 * Registers (in the terms of `Plugin`):
 *
 *   - `predicates`         - `branch`, `upstream`, `commitsAhead`,
 *                             `hasStagedChanges`, `isClean`, `remote`.
 *                             See `./predicates.ts` for the arg
 *                             shapes each handler accepts.
 *   - `rules`              - `no-main-commit` (overridable). Users
 *                             disable via `disable: ["no-main-commit"]`
 *                             or opt out of the whole plugin with
 *                             `disablePlugins: ["git"]`.
 *   - `trackers.branch`    - sequential `git checkout` / `git switch`
 *                             branch tracker. See `./branch-tracker.ts`.
 *   - `trackerExtensions.cwd.git`
 *                            - per-command `--git-dir=` / `--work-tree=`
 *                              parser layered on the core cwd tracker.
 *                              See `./cwd-extensions.ts`.
 *
 * Not registered by default. Users opt in:
 *
 *   ```ts
 *   import { defineConfig } from "@cad0p/pi-steering-hooks";
 *   import gitPlugin from "@cad0p/pi-steering-hooks/plugins/git";
 *
 *   export default defineConfig({
 *     plugins: [gitPlugin],
 *     rules: [...],
 *   });
 *   ```
 *
 * Phase 5+ may promote the git plugin into `DEFAULT_PLUGINS` once the
 * API surface stabilises; for Phase 4 the explicit opt-in keeps the
 * engine domain-agnostic.
 *
 * ## Note for plugin authors
 *
 * This is the canonical reference plugin. Third-party plugins are
 * expected to mirror this layout - one file per concern (tracker /
 * extension / predicates / rules), a terse default export assembling
 * them. Copy-adapt liberally.
 */

import type { Plugin, Tracker } from "../../index.ts";
import { branchTracker } from "./branch-tracker.ts";
import { gitCwdExtensions } from "./cwd-extensions.ts";
import { predicates } from "./predicates.ts";
import { rules } from "./rules.ts";

/**
 * The git plugin. Default export so `import gitPlugin from
 * "@cad0p/pi-steering-hooks/plugins/git"` gives you the whole thing.
 *
 * `as const satisfies Plugin` (rather than `: Plugin`) preserves the
 * literal `name: "git"` in the inferred type. That literal is the
 * input to any future `AllPluginNames<P>`-style inference in
 * `defineConfig`, which needs `name: "git"`, not `name: string`, to
 * offer string-literal completion for e.g. `disablePlugins`.
 */
const gitPlugin = {
	name: "git",
	predicates,
	rules: [...rules],
	trackers: {
		// `Plugin.trackers` is typed `Record<string, Tracker<unknown>>`
		// because the schema can't commit to a specific T per tracker.
		// Cast is safe - the walker dispatches on `modifiers[basename]`
		// and never narrows T at the tracker-registry layer.
		branch: branchTracker as unknown as Tracker<unknown>,
	},
	trackerExtensions: {
		cwd: {
			git: gitCwdExtensions,
		},
	},
} as const satisfies Plugin;

/**
 * Type-level regression sentinel: if the plugin literal ever loses
 * the `name: "git"` narrowing (for example, someone reintroducing
 * `: Plugin` annotation), the inferred type of `GIT_PLUGIN_NAME`
 * widens to `string` and any downstream literal-name inference
 * breaks. Keep this export in place to fail compilation loudly when
 * that happens.
 */
export const GIT_PLUGIN_NAME: "git" = gitPlugin.name;

export default gitPlugin;

// Named re-exports for consumers that want to pick pieces (e.g. a
// test harness constructing a minimal config that uses only the
// `branch` predicate without the shipped rule).
export { branchTracker } from "./branch-tracker.ts";
export { gitCwdExtensions } from "./cwd-extensions.ts";
export {
	branch,
	upstream,
	commitsAhead,
	hasStagedChanges,
	isClean,
	remote,
	predicates,
	type CommitsAheadArgs,
} from "./predicates.ts";
export { rules } from "./rules.ts";

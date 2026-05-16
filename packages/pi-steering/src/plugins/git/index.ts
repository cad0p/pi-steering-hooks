// SPDX-License-Identifier: MIT
// Part of pi-steering.

/**
 * Git plugin for `pi-steering`.
 *
 * Subpath import: `pi-steering/plugins/git`.
 *
 * Registers (in the terms of `Plugin`):
 *
 *   - `predicates`         - `branch`, `upstream`, `commitsAhead`,
 *                             `hasStagedChanges`, `isClean`, `remote`.
 *                             See `./predicates.ts` for the arg
 *                             shapes each handler accepts.
 *   - `rules`              - `no-main-commit` (overridable). Users
 *                             disable via `disabledRules: ["no-main-commit"]`
 *                             or opt out of the whole plugin with
 *                             `disabledPlugins: ["git"]`.
 *   - `trackers.branch`    - sequential `git checkout` / `git switch`
 *                             branch tracker. See `./branch-tracker.ts`.
 *   - `trackerExtensions.cwd.git`
 *                            - per-command `--git-dir=` / `--work-tree=`
 *                              parser layered on the core cwd tracker.
 *                              See `./cwd-extensions.ts`.
 *
 * Also re-exported as composable building blocks for downstream
 * plugins (e.g. RDS-style multi-package `cr --all` scans that need
 * to query git state per subpackage directory):
 *
 *   - `getBranch(ctx, cwd?)`            — current branch or `null`
 *   - `getUpstream(ctx, cwd?)`          — upstream name or `null`
 *   - `getCommitsAhead(ctx, wrt?, cwd?)` — commit count or `null`
 *   - `getStagedChanges(ctx, cwd?)`     — boolean or `null`
 *   - `getWorkingTreeClean(ctx, cwd?)`  — boolean or `null`
 *   - `getRemoteUrl(ctx, cwd?)`         — origin URL or `null`
 *
 * See `./git-ops.ts` for the helper contract (all collapse failure
 * modes to `null`; caller decides what to do with it).
 *
 * Default-on as of v0.1.0. Registered automatically via
 * {@link DEFAULT_PLUGINS}; users do not need to import and register
 * explicitly. Opt out via `disabledPlugins: ["git"]` or
 * `disableDefaults: true`.
 *
 * Explicit registration is still supported and canonical in tests
 * that build a config via `loadHarness({ includeDefaults: false })`.
 *
 * ## Note for plugin authors
 *
 * This is the canonical reference plugin. Third-party plugins are
 * expected to mirror this layout - one file per concern (tracker /
 * extension / predicates / rules), a terse default export assembling
 * them. Copy-adapt liberally.
 */

import type { Plugin } from "../../schema.ts";
import type { Tracker } from "unbash-walker";
import { branchTracker } from "./branch-tracker.ts";
import { gitCwdExtensions } from "./cwd-extensions.ts";
import { predicates } from "./predicates.ts";
import { rules } from "./rules.ts";

/**
 * The git plugin. Default export so `import gitPlugin from
 * "pi-steering/plugins/git"` gives you the whole thing.
 *
 * `as const satisfies Plugin` (rather than `: Plugin`) preserves the
 * literal `name: "git"` in the inferred type. That literal is the
 * input to any future `AllPluginNames<P>`-style inference in
 * `defineConfig`, which needs `name: "git"`, not `name: string`, to
 * offer string-literal completion for e.g. `disabledPlugins`.
 */
const gitPlugin = {
	name: "git",
	predicates,
	rules,
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
	getBranch,
	getCommitsAhead,
	getRemoteUrl,
	getStagedChanges,
	getUpstream,
	getWorkingTreeClean,
} from "./git-ops.ts";
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
export { rules, noMainCommit } from "./rules.ts";

// SPDX-License-Identifier: MIT
// Part of @cad0p/pi-steering-hooks.

/**
 * v2 config schema — TS-first rules, plugins, observers, predicates.
 *
 * Additive to the v1 schema (see `../schema.ts`). The existing evaluator
 * continues to drive the pi extension runtime on the v1 types; v2 types
 * live in parallel and power the new `defineConfig` / TS loader path.
 * Phase 3 rewrites the evaluator on top of this module and retires v1.
 *
 * Design references (see the accepted ADR, linked from PR #2's
 * description):
 *   - "Design → Rule schema"         → {@link Rule}, {@link WhenClause},
 *                                       {@link Pattern}, {@link PredicateFn},
 *                                       {@link PredicateHandler}.
 *   - "Design → Observer schema"     → {@link Observer},
 *                                       {@link ObserverContext}.
 *   - "Design → Plugin schema"       → {@link Plugin}.
 *   - "Design → Predicate context"   → {@link PredicateContext}.
 *   - "Design → Override default"    → {@link SteeringConfig.defaultNoOverride}
 *                                       (default `true`, fail-closed).
 *
 * Nothing in this module executes rules, observers, or predicates. It
 * only defines shapes. Evaluation is Phase 3's concern.
 */

import type { Tracker } from "unbash-walker";

// ---------------------------------------------------------------------------
// Primitive predicate types
// ---------------------------------------------------------------------------

/**
 * Static or regex pattern accepted by all built-in string-valued
 * predicates (`when.cwd`, `when.branch`, `when.upstream`, …).
 *
 * A plain string is treated as a regex source (compiled once at load
 * time by the evaluator — users escape literals themselves). A RegExp
 * is used as-is.
 *
 * See ADR "Design → Rule schema" → Pattern.
 */
export type Pattern = string | RegExp;

/**
 * Escape-hatch predicate: arbitrary user-supplied logic evaluated with a
 * {@link PredicateContext}. Returned value gates whether the surrounding
 * rule fires. Async OK — evaluator awaits it.
 *
 * Used as the value of `when.condition`, and as the fallback shape for
 * plugin-registered custom keys on a {@link WhenClause}.
 *
 * See ADR "Design → Rule schema" → PredicateFn.
 */
export type PredicateFn = (
	ctx: PredicateContext,
) => boolean | Promise<boolean>;

/**
 * Plugin-registered predicate *handler*. Differs from {@link PredicateFn}
 * only in that the first argument is the structured argument the user
 * supplied under their custom `when.<key>` slot. Example:
 *
 * ```ts
 * // user config
 * when: { commitsAhead: { wrt: "origin/main", eq: 1 } }
 *
 * // plugin registration
 * predicates: {
 *   commitsAhead: (args: { wrt: string; eq: number }, ctx) => { ... }
 * }
 * ```
 *
 * `args` is whatever the rule author put under that key — the handler is
 * responsible for validating its shape. `ctx` is the same
 * {@link PredicateContext} the escape-hatch form receives.
 *
 * See ADR "Design → Rule schema" → PredicateHandler.
 */
export type PredicateHandler<A = unknown> = (
	args: A,
	ctx: PredicateContext,
) => boolean | Promise<boolean>;

// ---------------------------------------------------------------------------
// When clause
// ---------------------------------------------------------------------------

/**
 * Recursively-composable predicate block attached to a {@link Rule}.
 *
 * Built-in keys:
 *   - {@link cwd}        — the sole walker-tied predicate the engine ships.
 *                          All other dimensions (`branch`, `upstream`, …)
 *                          come from plugins.
 *   - {@link not}        — boolean NOT over a nested clause; all nested
 *                          predicates must FAIL for `not` to "succeed".
 *   - {@link condition}  — escape hatch for one-off logic that doesn't
 *                          warrant a plugin.
 *
 * Plugin keys: anything else. A plugin registering
 * `predicates: { branch: <handler> }` teaches the engine that `when.branch`
 * is valid; the handler receives whatever value the user put there. Types
 * for plugin-registered predicates aren't inferred at this schema level —
 * they're enforced at config-build time via plugin registration (Phase 3).
 *
 * See ADR "Design → Rule schema" → WhenClause.
 */
export interface WhenClause {
	/**
	 * Constrain the rule to commands whose *effective* cwd matches
	 * the given pattern. For bash, the walker's `cwdTracker` resolves
	 * the effective cwd per extracted command (so
	 * `cd ~/personal && git commit --amend` evaluates against
	 * `~/personal`). For write / edit, the session cwd is used directly.
	 *
	 * The object form lets authors opt into `onUnknown: "allow"` when a
	 * command's cwd can't be statically resolved (e.g. `cd $VAR && …`).
	 * Default is `"block"` — fail-closed.
	 *
	 * See ADR "Design → Override default and `onUnknown`".
	 */
	cwd?: Pattern | { pattern: Pattern; onUnknown?: "allow" | "block" };

	/**
	 * Rule fires when an entry of the given `type` has NOT happened in
	 * the given scope. Typical usage: "block `cr` unless sync has
	 * happened" —
	 * `happened: { type: "rds-ws-sync-done", in: "agent_loop" }`.
	 *
	 * Scopes:
	 *   - `"agent_loop"` — filter session entries by
	 *     `entry.data._agentLoopIndex === ctx.agentLoopIndex`. The engine
	 *     auto-injects that tag on every `appendEntry` write, so plugin
	 *     authors don't have to remember to tag manually.
	 *   - `"session"`    — no scope filter. Any entry of `type` present
	 *     in the session JSONL satisfies.
	 *
	 * Inversion: place inside `not` to flip —
	 * `not: { happened: { type, in } }` fires when the type HAS
	 * happened. See ADR §5.
	 */
	happened?: { type: string; in: "agent_loop" | "session" };

	/**
	 * Boolean NOT: the rule fires only when every nested predicate
	 * fails. Useful for "mostly block, but allow the safe variant":
	 * `when: { not: { upstream: /origin\/main/ } }` — block unless the
	 * upstream is origin/main.
	 */
	not?: WhenClause;

	/**
	 * Escape-hatch predicate for one-off logic. Prefer plugin-registered
	 * predicates when the logic is reusable; use `condition` for
	 * genuinely local checks that don't warrant a plugin.
	 */
	condition?: PredicateFn;

	/**
	 * Plugin-registered predicates. Keys are free-form; values must match
	 * what the registering plugin expects (a {@link Pattern}, an object
	 * with a `pattern` field, a {@link PredicateFn}, or a plugin-specific
	 * argument shape validated by the plugin's {@link PredicateHandler}).
	 *
	 * The index signature is deliberately loose (`unknown`) — compile-
	 * time argument checking per-predicate is a plugin-level concern,
	 * not a schema-level one.
	 */
	[customKey: string]:
		| Pattern
		| PredicateFn
		| WhenClause
		| { pattern: Pattern; onUnknown?: "allow" | "block" }
		| unknown;
}

// ---------------------------------------------------------------------------
// Rule
// ---------------------------------------------------------------------------

/**
 * A single steering rule.
 *
 * Shape refinements vs. v1:
 *   - `pattern` accepts `RegExp` in addition to `string`.
 *   - `requires` / `unless` accept `Pattern | PredicateFn`.
 *   - `when` is a recursive {@link WhenClause}.
 *   - `observer` references an {@link Observer} by name (string) or
 *     inline definition.
 *
 * Generic parameter `ObsName` constrains the string form of the
 * {@link observer} field. {@link defineConfig} threads through the union
 * of observer names gathered from plugins + inline observers, producing
 * compile-time errors on typos. When authoring rules outside
 * `defineConfig` (with plain `satisfies SteeringConfig`), the default
 * `string` flows through and cross-reference checking is skipped.
 *
 * See ADR "Design → Rule schema".
 */
export interface Rule<ObsName extends string = string> {
	/** Unique rule identifier. Used in override comments and audit logs. */
	name: string;

	/**
	 * Which pi tool to intercept.
	 *
	 * Reserved: more tool names (`read`, `todo`, etc.) may land as pi
	 * grows its tool surface. This schema only models tools the
	 * evaluator knows how to gate.
	 */
	tool: "bash" | "write" | "edit";

	/**
	 * Which field of the tool input the {@link pattern} tests against.
	 * Included for forward compatibility — the evaluator derives the
	 * test target from {@link tool}, but the explicit declaration
	 * documents author intent and gives room for richer rules later.
	 */
	field: "command" | "path" | "content";

	/**
	 * Main match predicate. See {@link Pattern}. The rule fires only
	 * if this matches the chosen {@link field} value (for bash, the
	 * AST-extracted command string per ref).
	 */
	pattern: Pattern;

	/**
	 * Optional extra AND predicate — when provided, the rule fires
	 * only if this also matches. Accepts a pattern or a function so
	 * plugins can layer structured checks on top of the main match.
	 */
	requires?: Pattern | PredicateFn;

	/**
	 * Exemption predicate — when provided and matches, the rule does
	 * NOT fire. Same shape choice as {@link requires}.
	 */
	unless?: Pattern | PredicateFn;

	/**
	 * Composable predicate block. See {@link WhenClause}.
	 */
	when?: WhenClause;

	/** Message shown to the agent when blocked. Should be actionable. */
	reason: string;

	/**
	 * If `true`, no override escape hatch. If `false`, override always
	 * allowed. Omitted: falls back to
	 * {@link SteeringConfig.defaultNoOverride} (defaults to `true` —
	 * fail-closed).
	 */
	noOverride?: boolean;

	/**
	 * Observer to attach to this rule. The observer fires on matching
	 * `tool_result` events and can record per-turn state the rule
	 * consults via {@link PredicateContext.findEntries}.
	 *
	 * Either an inline {@link Observer} or a string referencing an
	 * observer registered on a plugin or at the config's top level.
	 * String references are constrained to the union of observer names
	 * known at {@link defineConfig} call sites (typo → compile error).
	 */
	observer?: Observer | ObsName;

	/**
	 * Session-entry custom types this rule's {@link onFire} may write.
	 * Purely documentation + IDE enforcement; the engine does NOT
	 * verify that `onFire` only calls `appendEntry` with these types.
	 *
	 * Fed into {@link defineConfig}'s type inference: the union of all
	 * `writes` across loaded plugins + user rules + observers
	 * constrains `when.happened.type` so typos become compile errors.
	 * Expansion of those generic constraints lands in Phase A2.
	 */
	writes?: readonly string[];

	/**
	 * Side-effect hook invoked when the rule decides to fire (all
	 * predicates passed) and BEFORE the block verdict is returned.
	 *
	 * Use for self-marking patterns where the rule's fire IS the event
	 * (e.g. `cr-description-check` — first attempt per agent loop blocks
	 * as reminder, self-marks via `onFire` so subsequent attempts pass).
	 * Anything written via `ctx.appendEntry` gets auto-tagged with the
	 * current `_agentLoopIndex` so a follow-up `when.happened:
	 * { in: "agent_loop" }` check can detect it.
	 *
	 * Timing guarantees:
	 *   - Runs after `pattern` / `requires` / `unless` / `when` have all
	 *     evaluated favourably. If `when.cwd` or any other predicate
	 *     fails, the rule doesn't fire and `onFire` doesn't run.
	 *   - Runs for rules that will actually BLOCK. Rules suppressed by an
	 *     inline override comment do NOT trigger `onFire` — the agent
	 *     overrode the rule, so its side effects are bypassed too.
	 *
	 * Async OK: the evaluator awaits.
	 */
	onFire?: (ctx: PredicateContext) => void | Promise<void>;
}

// ---------------------------------------------------------------------------
// Observer
// ---------------------------------------------------------------------------

/**
 * Filter applied to `tool_result` events before {@link Observer.onResult}
 * runs. Omitted: the observer fires on every result the engine sees.
 *
 * See ADR "Design → Observer schema".
 */
export interface ObserverWatch {
	/**
	 * Only fire on results from this tool. Use to narrow observers that
	 * only care about a specific tool surface (e.g. `read` results).
	 */
	toolName?: "bash" | "read" | "write" | "edit" | (string & {});

	/**
	 * Per-field regex constraints on the tool INPUT. Observer fires only
	 * when every listed field matches. Keys are tool-input field names
	 * (e.g. `path` for `read`, `command` for `bash`).
	 */
	inputMatches?: Record<string, Pattern>;

	/**
	 * Constrain by tool exit-code / success-failure classification.
	 *   - `"success"` / `"failure"` — string classification
	 *   - `number`                  — exact exit code match (bash)
	 *   - `"any"`                   — explicit no-filter
	 */
	exitCode?: number | "success" | "failure" | "any";
}

/**
 * Context passed to an observer's {@link Observer.onResult} callback.
 *
 * See ADR "Design → Observer schema".
 */
export interface ObserverContext {
	/** Session cwd at the time the tool_result arrived. */
	cwd: string;

	/**
	 * Monotonically-increasing agent-loop counter maintained by the
	 * engine. Bumped on each `agent_start` pi event (one agent loop =
	 * one user prompt + its tool calls). Observers writing session
	 * entries get this tag auto-injected into the payload so rules
	 * using `when.happened` with `in: "agent_loop"` can filter by it.
	 */
	agentLoopIndex: number;

	/**
	 * Append a typed entry into pi's session JSONL. Observers
	 * typically use this to record "the agent did X in turn N" so
	 * later predicates can gate on it via
	 * {@link PredicateContext.findEntries}.
	 */
	appendEntry: <T>(customType: string, data?: T) => void;

	/**
	 * Read all prior typed entries of the given custom type from pi's
	 * session JSONL. Handy for observers that need to coalesce state
	 * across turns (e.g. "has the agent read the CR description yet?").
	 */
	findEntries: <T>(
		customType: string,
	) => Array<{ data: T; timestamp: number }>;
}

/**
 * A reactive hook: runs on `tool_result` events, typically to record
 * per-turn state for later predicates to consult.
 *
 * Observers are named + deduped (first-registered wins; later
 * declarations log a WARN). A rule may reference an observer by name
 * via {@link Rule.observer}, letting plugins ship reusable observers
 * and multiple rules share a single entry-producing observer.
 *
 * See ADR "Design → Observer schema" and "Precedence: first-wins
 * everywhere".
 */
export interface Observer {
	/**
	 * Unique name. Used for dedup across plugins + inline observers.
	 * Referenced from {@link Rule.observer} as a string.
	 */
	name: string;

	/**
	 * Session-entry custom types this observer's {@link onResult} may
	 * write. Purely documentation + IDE enforcement; the engine does
	 * NOT verify writes match.
	 *
	 * Feeds into {@link defineConfig}'s type inference alongside
	 * {@link Rule.writes} (see that field for the full rationale).
	 */
	writes?: readonly string[];

	/**
	 * Filter narrowing which tool_result events trigger this observer.
	 * Omitted: every tool_result fires onResult.
	 */
	watch?: ObserverWatch;

	/**
	 * Called on every matching tool_result event. Typically writes an
	 * entry via `ctx.appendEntry(customType, data)`; occasionally
	 * performs side effects (logging). Must be idempotent — the same
	 * event MAY fire the observer more than once across pi's
	 * lifecycle (e.g. session restart mid-turn).
	 */
	onResult: (
		event: ToolResultEvent,
		ctx: ObserverContext,
	) => void | Promise<void>;
}

/**
 * Shape of a tool_result event as observed by an {@link Observer}.
 *
 * Intentionally minimal: the fields the schema commits to are the
 * ones every tool_result carries. Tool-specific `input` / `output`
 * fields are `unknown` here — observer authors cast to the known
 * shape for the tool they're watching.
 */
export interface ToolResultEvent {
	/** Tool name the result pertains to (e.g. `"bash"`, `"read"`). */
	toolName: string;
	/** Tool input as originally passed to the tool. Shape varies by tool. */
	input: unknown;
	/** Tool output / result payload. Shape varies by tool. */
	output: unknown;
	/** Exit code (bash) or undefined for non-command tools. */
	exitCode?: number;
}

// ---------------------------------------------------------------------------
// Predicate context
// ---------------------------------------------------------------------------

/**
 * Tool input signature reduced to the fields a predicate may read.
 *
 * Predicates are tool-agnostic (the same predicate can gate bash, write,
 * or edit rules). `tool` tells the predicate which discriminator applies;
 * the evaluator populates whichever fields belong to that tool.
 */
export interface PredicateToolInput {
	tool: "bash" | "write" | "edit";
	/** bash: the full command string. */
	command?: string;
	/** write / edit: the target path. */
	path?: string;
	/** write: the file content being written. */
	content?: string;
	/** edit: the replacement edits. Shape preserved from pi's edit tool. */
	edits?: ReadonlyArray<{ oldText: string; newText: string }>;
}

/**
 * Options forwarded to {@link PredicateContext.exec} — narrow surface
 * over child_process, scoped to the handful of knobs predicates need.
 */
export interface ExecOpts {
	/** Working directory. Defaults to the session cwd. */
	cwd?: string;
	/** Max runtime in ms. Predicates should cap this. */
	timeoutMs?: number;
}

/**
 * Return value of {@link PredicateContext.exec}.
 */
export interface ExecResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

/**
 * Context passed to a predicate (either {@link PredicateFn} or a
 * plugin's {@link PredicateHandler}).
 *
 * Rationale per ADR "Design → Predicate context":
 *   - `cwd`, `tool`, `input` — what the agent is about to do.
 *   - `agentLoopIndex` — engine-maintained counter bumped on each
 *     pi `agent_start` event (one agent loop = one user prompt + its
 *     tool calls). Rules gate "since the user's last message" state
 *     by comparing entries' auto-tagged `_agentLoopIndex` against
 *     `ctx.agentLoopIndex`, which is what `when.happened` with
 *     `in: "agent_loop"` does internally.
 *   - `exec` — shell escape hatch. The evaluator memoizes results per
 *     `(cmd, args, cwd)` within a single tool_call; no cross-call cache.
 *     This schema commits to the TYPE only — memoization is the
 *     evaluator's concern (Phase 3).
 *   - `appendEntry` / `findEntries` — pi's session JSONL mirror of
 *     what observers write. Predicates consult prior entries to
 *     implement turn-state checks.
 */
export interface PredicateContext {
	/** Session cwd (or, for bash rules, the effective cwd of the command). */
	cwd: string;

	/** Which pi tool is being gated. */
	tool: "bash" | "write" | "edit";

	/** Tool input — evaluator populates whichever fields apply to `tool`. */
	input: PredicateToolInput;

	/**
	 * Engine-maintained agent-loop counter (bumped on each pi
	 * `agent_start` event). See {@link ObserverContext.agentLoopIndex}.
	 */
	agentLoopIndex: number;

	/**
	 * Run a command and return its result. Memoized by the evaluator
	 * per `(cmd, args, cwd)` within a single tool_call evaluation.
	 *
	 * Stability guarantee: across rules evaluated for the SAME
	 * tool_call, identical `(cmd, args, cwd)` tuples return the same
	 * ExecResult without re-executing. Across tool_calls, no cache —
	 * the world can change between turns.
	 */
	exec: (
		cmd: string,
		args: string[],
		opts?: ExecOpts,
	) => Promise<ExecResult>;

	/**
	 * Append a typed entry into pi's session JSONL. Parallels
	 * {@link ObserverContext.appendEntry} so predicates can record
	 * decisions (though typically writing is an observer's job).
	 */
	appendEntry: <T>(customType: string, data?: T) => void;

	/**
	 * Read all prior typed entries of the given custom type. Used for
	 * turn-state predicates.
	 */
	findEntries: <T>(
		customType: string,
	) => Array<{ data: T; timestamp: number }>;

	/**
	 * Walker state snapshot for the command being evaluated. Populated
	 * only for bash rules — the walker runs once per tool_call over the
	 * full command and produces a per-ref snapshot of every registered
	 * tracker (`cwd`, plugin-registered dimensions like `branch`, …).
	 * For `write` / `edit` rules there is no walker, so this is
	 * `undefined`.
	 *
	 * Plugin predicates consult `walkerState[<tracker-name>]` to read
	 * statically-resolved values (branch after `git checkout X`, cwd
	 * after `cd /path`, …) without re-running the tracker's work. When
	 * the tracker can't resolve statically the value is the tracker's
	 * `unknown` sentinel — handlers apply their `onUnknown` policy.
	 *
	 * Shape is open-ended (`Record<string, unknown>`): the schema does
	 * not commit to which trackers exist — that's a plugin registration
	 * concern.
	 */
	walkerState?: Readonly<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

/**
 * A plugin — distribution unit for rule packs and extension points.
 *
 * Plugins register zero or more of:
 *   - {@link predicates}        — new `when.<key>` slots
 *   - {@link rules}             — bundled rules users can enable/disable
 *   - {@link observers}         — reusable observer definitions
 *   - {@link trackers}          — new walker state dimensions
 *   - {@link trackerExtensions} — modifiers for existing trackers
 *
 * See ADR "Design → Plugin schema". Plugin loading precedence is
 * "first-wins" (project-local → user's `plugins` array → built-in
 * defaults); name collisions on predicates / rules / observers /
 * tracker-extensions log a WARN and keep the first-registered entry.
 * Tracker-*name* collisions are a hard error — two plugins claiming the
 * same state dimension is always a bug.
 */
export interface Plugin {
	/** Unique plugin identifier. Used for `disablePlugins` + warning messages. */
	name: string;

	/**
	 * Predicate handlers keyed by the `when.<key>` slot they register.
	 * See {@link PredicateHandler}.
	 */
	predicates?: Record<string, PredicateHandler>;

	/** Rules the plugin suggests. Users can opt out via `disable: [...]`. */
	rules?: Rule[];

	/** Observers the plugin ships. Referenced by name from rules. */
	observers?: Observer[];

	/**
	 * NEW trackers the plugin introduces. Keys are tracker names (e.g.
	 * `branch`). A name collision between plugins is a hard error.
	 */
	trackers?: Record<string, Tracker<unknown>>;

	/**
	 * Modifiers added to an EXISTING tracker. Outer key is the tracker
	 * name (e.g. `cwd`), inner key is the command basename the modifier
	 * triggers on (e.g. `git` — to register a `--git-dir=...` parser on
	 * top of the built-in cwd tracker).
	 *
	 * The inner value accepts either a single {@link Modifier} or a
	 * readonly array of them, mirroring {@link Tracker.modifiers} on the
	 * walker side. Plugins can register multiple modifiers under one
	 * `(tracker, basename)` pair — e.g. distinct parsers for different
	 * subcommands of the same CLI that all share a basename.
	 *
	 * Collisions on a `(tracker, basename)` pair log a WARN and keep
	 * the first-registered entry.
	 *
	 * Typed as `unknown` at this schema level — concrete plugins
	 * declare their own modifier types tied to the tracker value they
	 * extend.
	 */
	trackerExtensions?: Record<
		string,
		Record<
			string,
			| import("unbash-walker").Modifier<unknown>
			| readonly import("unbash-walker").Modifier<unknown>[]
		>
	>;
}

// ---------------------------------------------------------------------------
// SteeringConfig
// ---------------------------------------------------------------------------

/**
 * Top-level v2 config shape. What a user's `.pi/steering.ts` /
 * `.pi/steering/index.ts` file default-exports (possibly via
 * {@link defineConfig} or `satisfies SteeringConfig`).
 *
 * The loader walks up from the session cwd to `$HOME`, collects every
 * layer, and merges them into a single effective config with inner
 * (closer to cwd) layers taking precedence on name collisions.
 *
 * See ADR "Design → File layout and loader behavior" and
 * "Design → Override default and `onUnknown`".
 */
export interface SteeringConfig {
	/**
	 * Default value for {@link Rule.noOverride} when a rule doesn't
	 * specify its own. Defaults to `true` (fail-closed — overrides
	 * must be explicit opt-in per rule).
	 *
	 * Walk-up merge: inner layer wins when specified; missing layer
	 * leaves the running value alone.
	 *
	 * `buildConfig` preserves `undefined` in the merged output so
	 * downstream evaluators can distinguish "user didn't specify" from
	 * "user explicitly chose false". The fail-closed `?? true` coercion
	 * happens at evaluator time.
	 *
	 * See ADR "Design → Override default".
	 */
	defaultNoOverride?: boolean;

	/**
	 * Disable specific rules by name. Additive union across layers.
	 */
	disable?: string[];

	/**
	 * Disable entire plugins by name. Additive union across layers.
	 * A disabled plugin contributes NOTHING — no rules, no observers,
	 * no predicates, no trackers.
	 */
	disablePlugins?: string[];

	/**
	 * Skip the package's built-in default plugins + default rules.
	 * Handy for isolated test harnesses or strict minimal configs.
	 *
	 * Walk-up merge: inner layer wins when specified.
	 */
	disableDefaults?: boolean;

	/** Plugins to load. Order matters for first-wins name collisions. */
	plugins?: Plugin[];

	/** User-authored rules. */
	rules?: Rule[];

	/** Inline observers (rules reference by name). */
	observers?: Observer[];
}

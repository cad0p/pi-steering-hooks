// SPDX-License-Identifier: MIT
// Part of pi-steering.

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

import type { Tracker, Word } from "unbash-walker";

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
export interface WhenClause<Writes extends string = string> {
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
	 * Rule fires when the given `event` has NOT happened in the given
	 * scope. Typical usage: "block `cr` unless sync has happened" —
	 * `happened: { event: "rds-ws-sync-done", in: "agent_loop" }`.
	 *
	 * Scopes:
	 *   - `"agent_loop"` — filter session entries by
	 *     `entry.data._agentLoopIndex === ctx.agentLoopIndex`. The engine
	 *     auto-injects that tag on every `appendEntry` write, so plugin
	 *     authors don't have to remember to tag manually.
	 *   - `"session"`    — no scope filter. Any entry of `event` present
	 *     in the session JSONL satisfies.
	 *   - `"tool_call"`  — only consider speculative entries synthesized
	 *     for THIS tool_call's `&&`-chain. Real (persisted) entries are
	 *     ignored entirely. Use when the rule requires the event to be
	 *     CHAINED directly before the guarded command (e.g. `sync && cr`)
	 *     rather than merely "somewhere this agent loop". Pairs naturally
	 *     with observer `writes:` declarations on observers whose
	 *     watch-matched refs produce speculative entries; no-op when no
	 *     observer writes the event.
	 *
	 * Inversion: place inside `not` to flip the clause-level boolean —
	 * `not: { happened: { event, in } }` fires when the event HAS
	 * happened. See ADR §5.
	 *
	 * Optional `since` sentinel (temporal ordering): when present,
	 * `event` is considered "happened" only if its most-recent entry
	 * in scope is newer than the most-recent `since` entry in scope.
	 * If `since` has never been written, the clause behaves as if
	 * `since` were absent (simple presence check on `event`).
	 *
	 * Use for invalidation semantics: "rule fires when sync has not
	 * happened in this agent_loop, OR the last sync is older than the
	 * last upstream-fail." Pattern:
	 *   `happened: { event: SYNC_DONE_EVENT, in: "agent_loop",
	 *                since: UPSTREAM_FAILED_EVENT }`.
	 *
	 * Optional `notIn` (set subtraction over scopes): when present,
	 * entries in `notIn` scope are excluded from the `in`-scoped entry
	 * stream BEFORE the `ts_max` comparison runs. Typical use:
	 * `happened: { event, in: "agent_loop", notIn: "tool_call" }` —
	 * "happened in a prior tool_call in this agent loop". Excludes
	 * same-tool_call speculative entries so `someCmd && guardedCmd`
	 * can't bypass the rule via tool_call-scope speculative synthesis.
	 *
	 * Distinct from the clause-level {@link WhenClause.not}, which is
	 * boolean negation of a sub-clause. `notIn` is set subtraction;
	 * separate keyword so the two operators can't be confused.
	 *
	 * Invalid scope combinations throw at evaluation time with the
	 * rule name prefixed:
	 *   - Supersets (e.g. `in: "agent_loop", notIn: "session"`) — the
	 *     subtraction is always empty.
	 *   - Identicals (`notIn === in`) — the subtraction is always empty.
	 *
	 * The nested-object form (`not: { in, since }`) from earlier drafts
	 * was dropped pre-publish: no motivating use case needed a `since`
	 * override on the inner block, and the flat string reads cleaner.
	 * If a future use case emerges, `notIn` can be widened additively
	 * to `string | { in, since }` without breaking existing configs.
	 *
	 * Compile-time constraint: inside {@link defineConfig}, both the
	 * `event` and `since` fields are narrowed to the union of all
	 * `writes` declared across plugin rules, plugin observers, user
	 * rules, and user observers. Typos become compile errors. Outside
	 * `defineConfig` the `Writes` parameter defaults to `string` so the
	 * check is skipped.
	 */
	happened?: {
		event: Writes;
		in: "agent_loop" | "session" | "tool_call";
		since?: Writes;
		notIn?: "agent_loop" | "session" | "tool_call";
	};

	/**
	 * Boolean NOT: the rule fires only when every nested predicate
	 * fails. Useful for "mostly block, but allow the safe variant":
	 * `when: { not: { upstream: /origin\/main/ } }` — block unless the
	 * upstream is origin/main.
	 */
	not?: WhenClause<Writes>;

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
// Rule (discriminated union by `tool`)
// ---------------------------------------------------------------------------

/**
 * Fields common to every tool-specific rule variant.
 *
 * `BaseRule` is the shared slice — everything except the `tool`
 * discriminant and the tool-specific {@link BashRule.field} /
 * {@link WriteRule.field} / {@link EditRule.field} sub-unions. The
 * exported user-facing type is {@link Rule}, the discriminated union
 * over the three tool variants; authors should reach for `Rule`
 * unless they're writing generic rule-handling code that already
 * knows the tool at its call site.
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
export interface BaseRule<
	ObsName extends string = string,
	Writes extends string = string,
> {
	/** Unique rule identifier. Used in override comments and audit logs. */
	name: string;

	/**
	 * Main match predicate. See {@link Pattern}. The rule fires only
	 * if this matches the chosen `field` value (for bash, the
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
	 *
	 * `Writes` is the union of session-entry event literals the rule's
	 * `when.happened.event` is allowed to reference. Threaded through by
	 * {@link defineConfig} from all declared `writes` arrays in scope.
	 */
	when?: WhenClause<Writes>;

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
	 *
	 * **Compile-time effect (via {@link defineConfig}):** the union of
	 * all `writes` literals declared across plugin rules, plugin
	 * observers, user rules, and user observers constrains the `event`
	 * field of every {@link WhenClause.happened} inside the same config.
	 * Declaring a write here makes it referenceable from
	 * `when.happened.event` anywhere in that config; omitting it leaves
	 * the string out of the union and downstream references to it are
	 * rejected as typos.
	 *
	 * **Authoring pattern.** Enforcement depends on TypeScript preserving
	 * the literal types of your `writes` arrays. Use one of:
	 *   - `as const satisfies Rule` on a rule object literal, OR
	 *   - `const satisfies Rule` on an object literal, OR
	 *   - declaring the rule INSIDE the `defineConfig({ rules: [...] })`
	 *     call so inference flows directly through the `const P`, `const R`
	 *     generics.
	 *
	 * **Footgun: bare `: Rule` / `: Observer` / `: Plugin` annotations
	 * widen the literal `writes` array to `readonly string[]`. The engine
	 * can no longer project string-literal members, so `AllWrites`
	 * collapses to `never` — meaning EVERY `when.happened.event`
	 * reference in the config is rejected as a typo, not silently
	 * accepted.
	 *
	 * **Runtime effect:** none. `writes` is purely documentation +
	 * type-level plumbing — the engine does NOT verify that `onFire`
	 * only calls `ctx.appendEntry` with declared types.
	 *
	 * **Opt-out:** authors who build their config via
	 * `satisfies SteeringConfig` instead of `defineConfig` lose the
	 * compile-time check — the `SteeringConfig` shape defaults the
	 * {@link Rule} generics to `string`, so `when.happened.event` is
	 * unconstrained. `defineConfig` is the entry point that enforces.
	 *
	 * The wider warning — "name" / "plugin" literals widening to
	 * `string` — causes the opposite failure: typos in `disabledRules`
	 * / `disabledPlugins` start compiling silently. Always use
	 * `as const satisfies` for reusable constants.
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
	 *   - Fail-closed rules (noOverride omitted or true) ignore override
	 *     comments entirely, so `onFire` runs on every fire even when
	 *     the agent wrote an override comment the engine rejected.
	 *
	 * Error handling: `onFire` is a best-effort side effect. If it
	 * throws (sync) or its returned promise rejects, the engine logs
	 * the error with `console.warn` and proceeds to return the block
	 * verdict. The block is not affected by an `onFire` failure — the
	 * block decision already passed every predicate, and a broken
	 * self-mark must not invalidate it. Mirrors the observer
	 * dispatcher's per-observer isolation.
	 *
	 * Async OK: the evaluator awaits.
	 */
	onFire?: (ctx: PredicateContext) => void | Promise<void>;
}

/**
 * Bash rule: gates pi's `bash` tool.
 *
 * `field` is constrained to `"command"` — the evaluator always runs
 * bash rules against the extracted command string per ref (see
 * `evaluator.ts` bash branch). There is no useful "test a bash rule
 * against a path" mode: bash has no path. `field: "path"` /
 * `field: "content"` on a bash rule silently misbehaved in the
 * previous (non-discriminated) schema; the union here makes the
 * mistake a compile error.
 *
 * Inside a rule's predicates / `onFire`, the context exposes the
 * extracted command plus `args` (quote-aware `Word[]`) and
 * `basename` — those are populated per-ref by the evaluator, not by
 * the rule author.
 */
export interface BashRule<
	ObsName extends string = string,
	Writes extends string = string,
> extends BaseRule<ObsName, Writes> {
	tool: "bash";
	field: "command";
}

/**
 * Write rule: gates pi's `write` tool (whole-file writes).
 *
 * `field` picks the input slot the {@link pattern} tests against:
 *   - `"path"`    — the target path (regex-gate paths a file may be
 *                  written to).
 *   - `"content"` — the full file contents the agent is writing.
 */
export interface WriteRule<
	ObsName extends string = string,
	Writes extends string = string,
> extends BaseRule<ObsName, Writes> {
	tool: "write";
	field: "path" | "content";
}

/**
 * Edit rule: gates pi's `edit` tool (targeted oldText/newText patches).
 *
 * `field` picks the input slot the {@link pattern} tests against:
 *   - `"path"`    — the target path.
 *   - `"content"` — the concatenated `newText` of every edit in the
 *                  tool call (evaluator joins with `\n`). This mirrors
 *                  `write.content` so authors can use one rule class
 *                  for both file surfaces.
 */
export interface EditRule<
	ObsName extends string = string,
	Writes extends string = string,
> extends BaseRule<ObsName, Writes> {
	tool: "edit";
	field: "path" | "content";
}

/**
 * A single steering rule — discriminated union over the three
 * gatable tools. The `tool` discriminant determines which `field`
 * values are legal: bash rules test against `"command"`, write / edit
 * rules test against `"path"` or `"content"`. Invalid combinations
 * (`{ tool: "bash", field: "path" }`, `{ tool: "write", field:
 * "command" }`, …) are TS errors.
 *
 * Shape refinements vs. v1:
 *   - `pattern` accepts `RegExp` in addition to `string`.
 *   - `requires` / `unless` accept `Pattern | PredicateFn`.
 *   - `when` is a recursive {@link WhenClause}.
 *   - `observer` references an {@link Observer} by name (string) or
 *     inline definition.
 *   - `Rule` is a discriminated union by `tool`.
 *
 * See ADR "Design → Rule schema".
 */
export type Rule<
	ObsName extends string = string,
	Writes extends string = string,
> =
	| BashRule<ObsName, Writes>
	| WriteRule<ObsName, Writes>
	| EditRule<ObsName, Writes>;

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
	 * write.
	 *
	 * **Compile-time effect (via {@link defineConfig}):** the union of
	 * all `writes` literals declared across plugin rules, plugin
	 * observers, user rules, and user observers constrains the `event`
	 * field of every {@link WhenClause.happened} inside the same config.
	 * Declaring a write here makes it referenceable from
	 * `when.happened.event` anywhere in that config; omitting it leaves
	 * the string out of the union and downstream references to it are
	 * rejected as typos.
	 *
	 * **Authoring pattern.** See {@link Rule.writes} for the full
	 * footgun note — TL;DR: use `as const satisfies Observer` on
	 * reusable observer constants, or declare them inline inside
	 * `defineConfig({ observers: [...] })`. Bare `: Observer` annotations
	 * widen `writes` to `readonly string[]` and collapse `AllWrites` to
	 * `never`, rejecting every `when.happened.event` reference.
	 *
	 * **Runtime effect:** none. `writes` is purely documentation +
	 * type-level plumbing — the engine does NOT verify that `onResult`
	 * only calls `ctx.appendEntry` with declared types.
	 *
	 * **Opt-out:** authors who build their config via
	 * `satisfies SteeringConfig` instead of `defineConfig` lose the
	 * compile-time check. `defineConfig` is the entry point that
	 * enforces.
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
 *
 * Bash note (per ADR §9): `command`, `basename`, and `args` are
 * populated PER extracted command ref — a bash invocation of
 * `git push --force && ls` runs the predicate once per ref, with
 * `command: "git push --force"` (flattened for pattern matching),
 * `basename: "git"`, and `args: [<Word>, <Word>]` (suffix `Word[]`
 * with quote-aware `.value`). `rawCommand` and full AST node access
 * are deliberately NOT exposed — the wrapper context would be wrong
 * for inner refs, and AST walking belongs in plugin code that imports
 * unbash-walker directly.
 */
export interface PredicateToolInput {
	tool: "bash" | "write" | "edit";
	/** bash: flattened `basename + args` string, per extracted ref. */
	command?: string;
	/**
	 * bash: extracted ref basename (e.g. `"git"` for `/usr/bin/git`).
	 * Sugar over `command.split(/\s+/)[0]` that handles path stripping
	 * correctly. Undefined for non-bash tools.
	 */
	basename?: string;
	/**
	 * bash: suffix `Word[]` for the extracted ref — quote-aware
	 * structured access with `.value` giving the lexical value and
	 * `.text` the raw source. Prefer this over splitting `command`
	 * when the predicate needs to preserve quoting (e.g. reading a
	 * `-m "conventional: subject"` message without munging spaces).
	 *
	 * Sourced from `CommandRef.node.suffix` via unbash-walker; the
	 * walker already parses into Word[] so we expose it directly.
	 * Undefined for non-bash tools.
	 */
	args?: readonly Word[];
	/**
	 * bash: shell env-assignment prefix for the extracted ref —
	 * `AWS_PROFILE=dev aws s3 ls` exposes `[W("AWS_PROFILE=dev")]`
	 * here (with `args` still `[W("s3"), W("ls")]`). Multiple
	 * assignments come through in source order. Enables plugins to
	 * inspect shell env vars via structured access instead of
	 * regex-on-raw-command.
	 *
	 * Sourced from `CommandRef.node.prefix` via unbash-walker. Each
	 * prefix element is projected into a `Word` whose `.text` preserves
	 * the full `KEY=VALUE` source token (with quoting, if any);
	 * consumers split on `=` to separate key from value. Dynamic
	 * values like `A=$VAR` come through as-is — the token syntax is
	 * visible in `.text`, so callers can detect the expansion
	 * themselves.
	 *
	 * Always an empty array for `write` / `edit` tools (shell env
	 * assignments don't apply to file-surface tools); shaped as
	 * `[]` rather than `undefined` so plugin authors can treat the
	 * field uniformly.
	 */
	envAssignments?: readonly Word[];
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
	 *
	 * Reserved key `events`: `Record<customType, SyntheticEntry[]>`.
	 * Populated by the walker-level speculative-entry synthesis pass
	 * (see `evaluator-internals/speculative-synthesis.ts`). Carries
	 * per-ref speculative entries representing "events about to happen"
	 * via continuous `&&` chains from observers' `writes:` declarations.
	 * Each entry carries a `{ data, timestamp, speculative: true }`
	 * shape; timestamps are in a reserved range (above any real entry)
	 * monotonic in AST order. The built-in `when.happened` predicate
	 * merges these with real entries via timestamp comparison;
	 * plugin-authored predicates can opt out by filtering
	 * `e.speculative === true`. Trackers cannot claim the `events`
	 * key — plugin registration rejects it as reserved.
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
	/** Unique plugin identifier. Used for `disabledPlugins` + warning messages. */
	name: string;

	/**
	 * Predicate handlers keyed by the `when.<key>` slot they register.
	 * See {@link PredicateHandler}.
	 */
	predicates?: Record<string, PredicateHandler>;

	/** Rules the plugin suggests. Users can opt out via `disabledRules: [...]`. */
	rules?: readonly Rule[];

	/** Observers the plugin ships. Referenced by name from rules. */
	observers?: readonly Observer[];

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
	 * Rules to disable by name. Additive union across layers.
	 *
	 * Past-participle form (`disabledRules`) reads as a predicate on
	 * state — "these are the rules that are disabled." Distinct from
	 * the imperative flag {@link disableDefaults} (action: disable
	 * the default plugins + rules).
	 */
	disabledRules?: string[];

	/**
	 * Plugins to disable by name. Additive union across layers.
	 * A disabled plugin contributes NOTHING — no rules, no observers,
	 * no predicates, no trackers.
	 */
	disabledPlugins?: string[];

	/**
	 * Skip the package's built-in default plugins + default rules.
	 * Handy for isolated test harnesses or strict minimal configs.
	 *
	 * Kept in imperative form (action flag: "disable the defaults")
	 * to distinguish shape at a glance from the past-participle
	 * {@link disabledRules} / {@link disabledPlugins} lists.
	 *
	 * Walk-up merge: inner layer wins when specified.
	 */
	disableDefaults?: boolean;

	/** Plugins to load. Order matters for first-wins name collisions. */
	plugins?: readonly Plugin[];

	/** User-authored rules. */
	rules?: readonly Rule[];

	/** Inline observers (rules reference by name). */
	observers?: readonly Observer[];
}

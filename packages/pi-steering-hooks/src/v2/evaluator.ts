// SPDX-License-Identifier: MIT
// Part of @cad0p/pi-steering-hooks.

/**
 * v2 steering evaluator.
 *
 * Assembles the per-tool_call pipeline on top of:
 *
 *   - `unbash-walker`           — AST parse + command extraction +
 *                                 wrapper expansion + per-ref walker
 *                                 state (cwd today; branch/others once
 *                                 plugins register them).
 *   - {@link matchesPatternOrFn} / {@link evaluateWhen} — shared
 *                                 predicate resolution (see
 *                                 `./evaluator-internals/predicates.ts`).
 *   - {@link extractOverride}   — inline override-comment detection
 *                                 ported from v1 (see
 *                                 `./evaluator-internals/override.ts`).
 *   - {@link createExecCache} / {@link createFindEntries} — per-call
 *                                 exec memoization + session-entry
 *                                 filtering (see
 *                                 `./evaluator-internals/context.ts`).
 *
 * Public surface is deliberately small: {@link buildEvaluator} returns
 * an {@link EvaluatorRuntime} whose sole method, {@link
 * EvaluatorRuntime.evaluate}, drives one `tool_call` event through
 * every applicable rule. Phase 3c wires it into the pi extension's
 * `tool_call` listener.
 *
 * Rule ordering (per ADR "Precedence: first-wins everywhere"):
 *
 *   1. `config.rules`       — user's top-level rules, first-match-wins.
 *   2. `resolved.rules`     — plugin-shipped rules (already deduped /
 *                              disabled-filtered by the plugin merger).
 *
 * First rule that fires AND isn't overridden wins and returns a block.
 *
 * Internal shape: each applicable rule is fed to {@link
 * evaluateCandidate}, the single predicate-chain used for every tool.
 * Bash rules loop over extracted command refs (one candidate per ref);
 * write / edit produce exactly one candidate. The per-tool axes of
 * variation live in the {@link Candidate} input — the body of
 * `evaluateCandidate` stays tool-agnostic.
 */

import {
	cwdTracker,
	expandWrapperCommands,
	extractAllCommandsFromAST,
	getBasename,
	getCommandArgs,
	parse as parseBash,
	walk,
	type CommandRef,
	type Modifier,
	type Tracker,
	type Word,
} from "unbash-walker";
import type {
	ExtensionContext,
	ToolCallEvent,
	ToolCallEventResult,
} from "@mariozechner/pi-coding-agent";
import { isToolCallEventType } from "@mariozechner/pi-coding-agent";
import {
	createAppendEntry,
	createExecCache,
	createFindEntries,
	type EvaluatorHost,
} from "./evaluator-internals/context.ts";
import { extractOverride } from "./evaluator-internals/override.ts";
import {
	evaluateWhen,
	matchesPatternOrFn,
	matchesPattern,
} from "./evaluator-internals/predicates.ts";
import type { ResolvedPluginState } from "./plugin-merger.ts";
import type {
	PredicateContext,
	PredicateToolInput,
	Rule,
	SteeringConfig,
} from "./schema.ts";

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/**
 * Runtime-facing evaluator handle. Phase 3c holds an instance per
 * session and calls {@link evaluate} from the pi `tool_call`
 * listener.
 */
export interface EvaluatorRuntime {
	/**
	 * Evaluate a single `tool_call` event against every rule in
	 * `config.rules` + `resolved.rules`. Returns:
	 *   - `{ block: true, reason }` — a rule matched + wasn't overridden.
	 *   - `undefined`               — no rule fires; tool call proceeds.
	 */
	evaluate(
		event: ToolCallEvent,
		ctx: ExtensionContext,
		agentLoopIndex: number,
	): Promise<ToolCallEventResult | void>;
}

/**
 * Construct an {@link EvaluatorRuntime}.
 *
 * Arguments:
 *   - `config`    — the user-facing {@link SteeringConfig}. Top-level
 *                    rules and `defaultNoOverride` live here.
 *   - `resolved`  — merged plugin state from
 *                    {@link resolvePlugins}. Source of plugin rules,
 *                    predicate handlers, and the composed tracker
 *                    registry for the walker.
 *   - `host`      — narrow surface exposing pi's `exec` + `appendEntry`
 *                    (typically `pi` itself in production; tests pass
 *                    a stub). Kept separate from `ExtensionContext`
 *                    because the ctx shape does not expose these.
 */
export function buildEvaluator(
	config: SteeringConfig,
	resolved: ResolvedPluginState,
	host: EvaluatorHost,
): EvaluatorRuntime {
	// Default the fail-closed override policy per ADR "Override default".
	const defaultNoOverride = config.defaultNoOverride ?? true;

	// Combine config.rules (user-authored, first) with resolved.rules
	// (plugin-shipped). Empty fallbacks mean a config without either slot
	// still produces a running evaluator — just never fires.
	const userRules = config.rules ?? [];
	const pluginRules = resolved.rules;
	const allRules: readonly Rule[] = [...userRules, ...pluginRules];

	// Compose the walker's tracker registry. Must always include `cwd`
	// so the built-in `when.cwd` predicate can resolve — even if no
	// plugin ships one. Plugins extending `cwd` with their own modifiers
	// are honored via `resolved.composedTrackers.cwd` (the plugin
	// merger already layered extensions on top of the plugin-declared
	// cwd tracker, if any).
	//
	// When no plugin registers a `cwd` tracker, we fall back to the
	// built-in `cwdTracker` AND layer any `trackerModifiers.cwd`
	// extensions onto it (the plugin merger preserves extensions
	// targeting `"cwd"` on the caller's behalf via the
	// `knownBuiltinTrackers` hint passed to `resolvePlugins`). This is
	// how the git plugin's `--git-dir=` / `--work-tree=` modifiers
	// reach the cwd tracker despite the plugin not owning the tracker
	// itself.
	const trackers: Record<string, Tracker<unknown>> = {
		...resolved.composedTrackers,
	};
	if (!("cwd" in trackers)) {
		const extraCwdModifiers = resolved.trackerModifiers["cwd"];
		trackers["cwd"] = composeBuiltinCwd(
			extraCwdModifiers,
		) as Tracker<unknown>;
	}

	return {
		evaluate: (event, ctx, agentLoopIndex) =>
			evaluateEvent(
				event,
				ctx,
				agentLoopIndex,
				allRules,
				trackers,
				resolved.predicates,
				host,
				defaultNoOverride,
			),
	};
}

// ---------------------------------------------------------------------------
// Per-event evaluation
// ---------------------------------------------------------------------------

/**
 * Layer a bucket of plugin-provided `{ basename -> Modifier[] }`
 * extensions on top of the built-in {@link cwdTracker}, returning a
 * fresh tracker so the built-in's `modifiers` map is never mutated.
 *
 * Used when no plugin registers a `cwd` tracker but plugins still
 * want to add basename modifiers to the built-in one (e.g. the git
 * plugin's `--git-dir=` handler). Mirrors the plugin-merger's
 * `composeTracker` shape — kept local here because the merger's
 * helper is private to that module and exposing it would force the
 * merger to know about the built-in cwd tracker. Keeping the merger
 * built-in-agnostic is worth the small duplication.
 */
function composeBuiltinCwd(
	extras: Record<string, Modifier<unknown>[]> | undefined,
): Tracker<string> {
	if (!extras || Object.keys(extras).length === 0) return cwdTracker;
	const merged: Record<string, Modifier<string> | Modifier<string>[]> = {};
	for (const [basename, mod] of Object.entries(cwdTracker.modifiers)) {
		merged[basename] = Array.isArray(mod)
			? [...(mod as Modifier<string>[])]
			: mod;
	}
	for (const [basename, mods] of Object.entries(extras)) {
		const existing = merged[basename];
		const extrasTyped = mods as unknown as Modifier<string>[];
		if (existing === undefined) {
			merged[basename] =
				extrasTyped.length === 1 ? extrasTyped[0]! : [...extrasTyped];
			continue;
		}
		const existingList = Array.isArray(existing)
			? (existing as Modifier<string>[])
			: [existing as Modifier<string>];
		merged[basename] = [...existingList, ...extrasTyped];
	}
	return { ...cwdTracker, modifiers: merged };
}

/**
 * Walker-state snapshot per extracted bash command ref plus the
 * stringified `basename + args` text for regex testing, the basename
 * sugar, and the suffix `Word[]` for quote-aware structured access.
 *
 * Built once per tool_call (in {@link prepareBashState}) so N rules
 * against M refs cost N×M regex tests — no N parses or N walks, and
 * `basename` / `args` are computed once per ref rather than per rule.
 */
interface BashRefState {
	readonly ref: CommandRef;
	readonly text: string;
	readonly basename: string;
	readonly args: readonly Word[];
	readonly walkerState: Record<string, unknown>;
}

/**
 * Prepare bash state for every rule to share: parse once, extract +
 * expand wrappers once, walk trackers once, stringify each ref once.
 */
function prepareBashState(
	command: string,
	sessionCwd: string,
	trackers: Record<string, Tracker<unknown>>,
): BashRefState[] {
	const script = parseBash(command);
	const extracted = extractAllCommandsFromAST(script, command);
	const { commands: refs } = expandWrapperCommands(extracted);
	const walkResult = walk(
		script,
		{ cwd: sessionCwd } as Record<string, unknown>,
		trackers,
		refs,
	);
	return refs.map((ref) => ({
		ref,
		text: `${getBasename(ref)} ${getCommandArgs(ref).join(" ")}`.trim(),
		basename: getBasename(ref),
		// `node.suffix` is the quote-aware Word[] for the ref. Exposed
		// to predicates via PredicateToolInput.args; the walker already
		// parsed it so we just pass it through.
		args: ref.node.suffix,
		walkerState: walkResult.get(ref) ?? { cwd: sessionCwd },
	}));
}

/**
 * Compute the effective `noOverride` for a rule — rule-level explicit
 * value wins, falling back to the config-level default (itself defaulted
 * to fail-closed `true` per ADR).
 */
function effectiveNoOverride(rule: Rule, defaultNoOverride: boolean): boolean {
	return rule.noOverride ?? defaultNoOverride;
}

/**
 * Format the block reason shown to the agent. Appends an override hint
 * ONLY when the rule is overridable — rules with
 * `noOverride: true` (or the fail-closed default) omit it to avoid
 * advertising a nonexistent escape hatch.
 *
 * Ported from v1's `formatBlockReason` + `overrideHint` so the message
 * shape is identical across versions.
 */
function formatReason(
	rule: Rule,
	tool: "bash" | "write" | "edit",
	noOverride: boolean,
): string {
	if (noOverride) {
		return `[steering:${rule.name}] ${rule.reason}`;
	}
	const leader = tool === "bash" ? "#" : "//";
	const hint =
		` To override, include a comment: ` +
		`\`${leader} steering-override: ${rule.name} — <reason>\`.`;
	return `[steering:${rule.name}] ${rule.reason}${hint}`;
}

// ---------------------------------------------------------------------------
// Unified per-candidate evaluation
// ---------------------------------------------------------------------------

/**
 * Per-tool_call state shared across every candidate and rule. One
 * struct in place of the 6-argument bundle the prior shape threaded
 * through both bash and write/edit call-sites.
 *
 * `exec` / `appendEntry` / `findEntries` are the closures the evaluator
 * builds once per tool_call (see `./evaluator-internals/context.ts`).
 * `host` is kept separate because the override-log path calls
 * `host.appendEntry` with extra fields (e.g. `command`, `path`) that
 * don't fit the `PredicateContext.appendEntry` signature.
 */
interface SharedEvalContext {
	readonly agentLoopIndex: number;
	readonly predicates: ResolvedPluginState["predicates"];
	readonly exec: PredicateContext["exec"];
	readonly appendEntry: PredicateContext["appendEntry"];
	readonly findEntries: PredicateContext["findEntries"];
	readonly host: EvaluatorHost;
	readonly defaultNoOverride: boolean;
}

/**
 * Single-candidate input for {@link evaluateCandidate}. The fields here
 * are the sole per-tool axes of variation — the body of
 * `evaluateCandidate` stays tool-agnostic.
 *
 *   - `target`        — string the rule's `pattern` / `requires` /
 *                        `unless` test against (bash: basename + args
 *                        for the current ref; write: content or path;
 *                        edit: joined newText or path).
 *   - `cwd`           — effective cwd seen by predicates via
 *                        `ctx.cwd`. Per-ref for bash (walker-resolved);
 *                        session cwd for write / edit.
 *   - `input`         — the `PredicateToolInput` predicates see via
 *                        `ctx.input`.
 *   - `overrideCarrier` — text scanned for `# steering-override: …`
 *                          comments. Bash: the raw tool_call command;
 *                          write: content; edit: joined newText.
 *   - `tool`          — plain-string tool, drives the override-comment
 *                        leader (`#` vs `//`) and the block reason.
 *   - `overrideEntryExtras` — extra fields merged into the
 *                              `steering-override` audit entry
 *                              (`command` for bash, `path` for
 *                              write / edit).
 */
interface Candidate {
	readonly target: string;
	readonly cwd: string;
	readonly input: PredicateToolInput;
	readonly overrideCarrier: string;
	readonly tool: "bash" | "write" | "edit";
	readonly overrideEntryExtras: Record<string, string>;
	/**
	 * Walker state snapshot for this candidate. Bash candidates carry
	 * the per-ref walk result; write / edit candidates leave it
	 * undefined (no walker ran).
	 */
	readonly walkerState?: Readonly<Record<string, unknown>>;
}

/**
 * Outcome of `evaluateCandidate`:
 *   - {@link ToolCallEventResult}  — rule fired + was NOT overridden.
 *                                     Caller returns this to stop
 *                                     evaluation for the whole event.
 *   - `"no-fire"`                   — rule didn't match this candidate.
 *                                     Caller continues to the next
 *                                     candidate (bash) or next rule
 *                                     (write / edit).
 *   - `"overridden"`                — rule fired but an override comment
 *                                     was accepted + audit-logged.
 *                                     Caller moves to the next rule;
 *                                     for bash that also means stopping
 *                                     the ref loop (override covers the
 *                                     whole tool_call per v1 semantics).
 */
type CandidateOutcome = ToolCallEventResult | "no-fire" | "overridden";

/**
 * Evaluate one candidate against one rule. This is the single pipeline
 * every tool funnels through — differences between bash, write, and
 * edit live entirely in the {@link Candidate} input.
 *
 * Evaluation order (short-circuits on first failure):
 *
 *   1. `pattern`   — required; if no match we exit before allocating
 *                     the predicate context.
 *   2. `requires`  — optional AND.
 *   3. `unless`    — optional exemption.
 *   4. `when`      — clause tree (`cwd`, `not`, `condition`, plugin
 *                     predicates).
 *
 * On rule fire, check for an override comment addressing the rule by
 * name (unless the rule opts out of overrides). An accepted override
 * logs a `steering-override` audit entry and returns `"overridden"`.
 */
async function evaluateCandidate(
	rule: Rule,
	cand: Candidate,
	shared: SharedEvalContext,
): Promise<CandidateOutcome> {
	// Pattern-miss is the common case; exit before allocating ctx.
	if (!matchesPattern(rule.pattern, cand.target)) return "no-fire";

	const ctx: PredicateContext = {
		cwd: cand.cwd,
		tool: cand.tool,
		input: cand.input,
		agentLoopIndex: shared.agentLoopIndex,
		exec: shared.exec,
		appendEntry: shared.appendEntry,
		findEntries: shared.findEntries,
		...(cand.walkerState !== undefined
			? { walkerState: cand.walkerState }
			: {}),
	};

	if (rule.requires !== undefined) {
		const ok = await matchesPatternOrFn(rule.requires, cand.target, ctx);
		if (!ok) return "no-fire";
	}
	if (rule.unless !== undefined) {
		const ok = await matchesPatternOrFn(rule.unless, cand.target, ctx);
		if (ok) return "no-fire";
	}
	const whenOk = await evaluateWhen(
		rule.when,
		{ cwd: cand.cwd },
		ctx,
		shared.predicates,
	);
	if (!whenOk) return "no-fire";

	// Rule fires. Check for override (if allowed) before committing to
	// blocking.
	const noOverride = effectiveNoOverride(rule, shared.defaultNoOverride);
	if (!noOverride) {
		const reason = extractOverride(cand.overrideCarrier, rule.name);
		if (reason !== null) {
			shared.host.appendEntry("steering-override", {
				rule: rule.name,
				reason,
				...cand.overrideEntryExtras,
				timestamp: new Date().toISOString(),
			});
			return "overridden";
		}
	}

	// Block is going to fire. Run the optional side-effect hook before
	// returning the verdict — rules using `onFire` to self-mark (e.g.
	// "write a session entry so my next attempt this agent loop passes")
	// need the write to land before the agent sees the block. Override
	// paths above already returned, so onFire is skipped when the rule
	// was overridden; fail-closed defaults with no override comment fall
	// through here normally.
	if (rule.onFire) {
		await rule.onFire(ctx);
	}

	return {
		block: true,
		reason: formatReason(rule, cand.tool, noOverride),
	};
}

async function evaluateEvent(
	event: ToolCallEvent,
	ctx: ExtensionContext,
	agentLoopIndex: number,
	rules: readonly Rule[],
	trackers: Record<string, Tracker<unknown>>,
	predicates: ResolvedPluginState["predicates"],
	host: EvaluatorHost,
	defaultNoOverride: boolean,
): Promise<ToolCallEventResult | void> {
	// Shared per-call closures: exec memoized by (cmd, args, cwd);
	// findEntries reads the current session JSONL on demand; appendEntry
	// auto-tags writes with `_agentLoopIndex` so rules using
	// `when.happened` can filter by agent-loop scope.
	const exec = createExecCache(host, ctx.cwd);
	const findEntries = createFindEntries(ctx);
	const appendEntry = createAppendEntry(host, agentLoopIndex);

	const shared: SharedEvalContext = {
		agentLoopIndex,
		predicates,
		exec,
		appendEntry,
		findEntries,
		host,
		defaultNoOverride,
	};

	// Bash state is lazy: non-bash rules don't pay for parse / walk.
	let bashState: BashRefState[] | null = null;
	const bashEvent = isToolCallEventType("bash", event) ? event : null;

	// Edit events share `allNewText` across every field="content" rule.
	// Computed lazily on the first edit rule so a config with only bash /
	// write rules doesn't pay the join cost. `null` sentinel is safe
	// because `edits` is always a non-null array on edit events.
	const editEvent = isToolCallEventType("edit", event) ? event : null;
	let editAllNewText: string | null = null;

	for (const rule of rules) {
		if (rule.tool !== event.toolName) continue;

		if (rule.tool === "bash") {
			if (!bashEvent) continue;
			if (bashState === null) {
				bashState = prepareBashState(
					bashEvent.input.command,
					ctx.cwd,
					trackers,
				);
			}
			const result = await evaluateBashRule(
				rule,
				bashEvent.input.command,
				bashState,
				shared,
			);
			if (result !== undefined) return result;
			continue;
		}

		if (rule.tool === "write" && isToolCallEventType("write", event)) {
			const target = rule.field === "path"
				? event.input.path
				: event.input.content;
			const result = await evaluateWriteEditRule(
				rule,
				{
					tool: "write",
					path: event.input.path,
					content: event.input.content,
				},
				target,
				// override-comment scanned against content (the natural
				// carrier for write override comments — v1 parity).
				event.input.content,
				event.input.path,
				ctx.cwd,
				shared,
			);
			if (result !== undefined) return result;
			continue;
		}

		if (rule.tool === "edit" && editEvent) {
			// Joined newText is needed as override carrier for EVERY edit
			// rule plus as `target` for field="content" rules. Compute once
			// per tool_call on the first edit rule, reuse for the rest.
			if (editAllNewText === null) {
				editAllNewText = editEvent.input.edits
					.map((e) => e.newText)
					.join("\n");
			}
			const target =
				rule.field === "path" ? editEvent.input.path : editAllNewText;
			const result = await evaluateWriteEditRule(
				rule,
				{
					tool: "edit",
					path: editEvent.input.path,
					edits: editEvent.input.edits,
				},
				target,
				editAllNewText,
				editEvent.input.path,
				ctx.cwd,
				shared,
			);
			if (result !== undefined) return result;
			continue;
		}
	}
	return undefined;
}

/**
 * Per-rule bash evaluation. Iterates every extracted command ref as
 * a {@link Candidate}. The first ref that fires the rule (pattern +
 * requires + unless + when) decides the verdict. Per v1 semantics, an
 * accepted override covers the whole tool_call — we stop scanning
 * further refs and hand control back to the caller.
 */
async function evaluateBashRule(
	rule: Rule,
	rawCommand: string,
	state: BashRefState[],
	shared: SharedEvalContext,
): Promise<ToolCallEventResult | void> {
	for (const refState of state) {
		const cand: Candidate = {
			target: refState.text,
			cwd:
				typeof refState.walkerState["cwd"] === "string"
					? (refState.walkerState["cwd"] as string)
					: "unknown",
			input: {
				tool: "bash",
				command: refState.text,
				basename: refState.basename,
				args: refState.args,
			},
			overrideCarrier: rawCommand,
			tool: "bash",
			overrideEntryExtras: { command: rawCommand },
			walkerState: refState.walkerState,
		};
		const r = await evaluateCandidate(rule, cand, shared);
		if (r === "no-fire") continue;
		if (r === "overridden") return undefined; // v1: override covers whole tool_call
		return r;
	}
	return undefined;
}

/**
 * Per-rule write / edit evaluation. Produces a single {@link Candidate}
 * and defers to {@link evaluateCandidate}.
 *
 * `target` is the pre-resolved string the rule's pattern tests against
 * — the caller computes it once per rule (reading `path` or the joined
 * `newText`), which lets edit tool_calls share the join across every
 * field="content" rule. `overrideCarrier` is the text scanned for
 * override comments (per v1 parity, content / joined newText even for
 * field="path" rules).
 */
async function evaluateWriteEditRule(
	rule: Rule,
	input: PredicateToolInput,
	target: string,
	overrideCarrier: string,
	path: string,
	sessionCwd: string,
	shared: SharedEvalContext,
): Promise<ToolCallEventResult | void> {
	const cand: Candidate = {
		target,
		cwd: sessionCwd,
		input,
		overrideCarrier,
		tool: rule.tool as "write" | "edit",
		overrideEntryExtras: { path },
	};
	const r = await evaluateCandidate(rule, cand, shared);
	if (r === "no-fire" || r === "overridden") return undefined;
	return r;
}

// Re-export supporting types for consumers embedding the evaluator.
export type { EvaluatorHost } from "./evaluator-internals/context.ts";

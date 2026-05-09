// SPDX-License-Identifier: MIT
// Part of pi-steering.

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
} from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import {
	computePriorAndChains,
	refToText,
} from "./evaluator-internals/chain.ts";
import {
	createAppendEntry,
	createExecCache,
	createFindEntries,
	createSessionEntryCache,
	type EvaluatorHost,
} from "./evaluator-internals/context.ts";
import { extractOverride } from "./evaluator-internals/override.ts";
import {
	evaluateWhen,
	matchesPatternOrFn,
	matchesPattern,
} from "./evaluator-internals/predicates.ts";
import { mergeObserversUserFirst } from "./internal/merge-observers.ts";
import type { ResolvedPluginState } from "./plugin-merger.ts";
import { validateName } from "./plugin-merger.ts";
import type {
	Observer,
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
	// S3: validate user-authored rule names up front so a name like
	// "phony] ALL CLEAR [real" can't slip into the block-reason tag
	// shown to the LLM. Plugin-shipped rule / plugin / observer names
	// are validated inside `resolvePlugins`; here we cover the
	// user-config side (config.rules).
	for (const rule of config.rules ?? []) {
		validateName("rule", rule.name, "user config");
	}

	// Default the fail-closed override policy per ADR "Override default".
	const defaultNoOverride = config.defaultNoOverride ?? true;

	// Combine config.rules (user-authored, first) with resolved.rules
	// (plugin-shipped). Empty fallbacks mean a config without either slot
	// still produces a running evaluator — just never fires.
	const userRules = config.rules ?? [];
	const pluginRules = resolved.rules;
	const allRules: readonly Rule[] = [...userRules, ...pluginRules];

	// Source tags per ADR §11: user-authored rules get `@user`, plugin-
	// shipped rules get the originating plugin's name. The merger
	// already tracks `rule-name → plugin-name` during resolution — we
	// reuse that instead of threading the map through the evaluator.
	const ruleSources = new Map<Rule, string>();
	for (const rule of userRules) {
		ruleSources.set(rule, "user");
	}
	for (const rule of pluginRules) {
		ruleSources.set(
			rule,
			resolved.rulePluginOwners[rule.name] ?? "user",
		);
	}

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

	// Chain-aware `when.happened`: for each event literal declared in
	// an observer's `writes`, we index the observer(s) that produce it.
	// The evaluator threads this map into PredicateContext so the
	// built-in `happened` predicate can speculatively allow `&&` chains
	// whose prior refs match a writing observer's watch. Both plugin-
	// shipped observers and user inline observers contribute.
	//
	// Apply the same user-first dedup the observer-dispatcher applies
	// (via the shared helper) so the reverse-index never keeps a plugin
	// observer that will be shadowed at dispatch time by a user
	// observer of the same name. Without this, chain-aware allow could
	// grant on the shadowed plugin observer's watch pattern while the
	// shadowed observer never fires, producing the exact infinite-loop
	// speculative allow was designed to avoid.
	const allObservers = mergeObserversUserFirst(
		config.observers ?? [],
		resolved.observers,
	);
	const observersByWrittenEvent = buildObserversByWrittenEvent(allObservers);

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
				ruleSources,
				observersByWrittenEvent,
			),
	};
}

/**
 * Build the reverse index `event literal → observers that write it`
 * from the evaluator's merged observer list. Observers with no
 * `writes[]` declaration contribute nothing (can't gate anything).
 * Returns `undefined` when the index is empty so downstream code can
 * short-circuit chain-aware logic without constructing a ctx field.
 */
function buildObserversByWrittenEvent(
	observers: readonly Observer[],
): ReadonlyMap<string, readonly Observer[]> | undefined {
	const map = new Map<string, Observer[]>();
	for (const obs of observers) {
		if (!obs.writes) continue;
		for (const event of obs.writes) {
			const bucket = map.get(event);
			if (bucket) {
				bucket.push(obs);
			} else {
				map.set(event, [obs]);
			}
		}
	}
	if (map.size === 0) return undefined;
	return map as ReadonlyMap<string, readonly Observer[]>;
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
	/**
	 * Prior refs reachable via a continuous `&&` chain from the left of
	 * this ref. Populated by {@link prepareBashState}; consumed by
	 * chain-aware `when.happened`. Each entry carries the ref's
	 * stringified text (enough to run `watch.inputMatches.command`
	 * patterns against) — observers never see the full `CommandRef`.
	 */
	readonly priorAndChainedRefs: readonly { text: string }[];
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
	const priorChains = computePriorAndChains(refs);
	return refs.map((ref, i) => ({
		ref,
		text: refToText(ref),
		basename: getBasename(ref),
		// `node.suffix` is the quote-aware Word[] for the ref. Exposed
		// to predicates via PredicateToolInput.args; the walker already
		// parsed it so we just pass it through.
		args: ref.node.suffix,
		walkerState: walkResult.get(ref) ?? { cwd: sessionCwd },
		priorAndChainedRefs: priorChains[i] ?? [],
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
 * Source-tagged (per ADR §11): `[steering:<rule-name>@<source>] …`
 * where `<source>` is the originating plugin name for plugin-shipped
 * rules, or `user` for rules declared directly in the user's
 * SteeringConfig.rules.
 *
 * Ported from v1's `formatBlockReason` + `overrideHint` so the
 * message body is otherwise identical across versions.
 */
function formatReason(
	rule: Rule,
	tool: "bash" | "write" | "edit",
	noOverride: boolean,
	source: string,
): string {
	const tag = `[steering:${rule.name}@${source}]`;
	if (noOverride) {
		return `${tag} ${rule.reason}`;
	}
	const leader = tool === "bash" ? "#" : "//";
	const hint =
		` To override, include a comment: ` +
		`\`${leader} steering-override: ${rule.name} — <reason>\`.`;
	return `${tag} ${rule.reason}${hint}`;
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
 * `appendEntry` auto-tags every write with the current
 * `_agentLoopIndex`, including the `steering-override` audit entries
 * written from the override-accepted path — so rules using
 * `when.happened: { event: "steering-override", in: "agent_loop" }`
 * can correctly filter override activity to the current agent loop.
 *
 * `host` is retained on the shared context for non-entry operations
 * (currently only `exec` indirectly) and for tests that stub pi’s
 * surface without having to re-shape every call-site.
 */
interface SharedEvalContext {
	readonly agentLoopIndex: number;
	readonly predicates: ResolvedPluginState["predicates"];
	readonly exec: PredicateContext["exec"];
	readonly appendEntry: PredicateContext["appendEntry"];
	readonly findEntries: PredicateContext["findEntries"];
	readonly host: EvaluatorHost;
	readonly defaultNoOverride: boolean;
	/**
	 * Rule → source-name lookup for source-tagged block reasons
	 * (`[steering:<rule>@<source>]`). Keyed by Rule object identity so
	 * the same rule name appearing in multiple plugins still resolves
	 * unambiguously.
	 */
	readonly ruleSources: ReadonlyMap<Rule, string>;
	/**
	 * Reverse index: event literal → observers that write it. Built
	 * once at evaluator-construction time and threaded into
	 * {@link PredicateContext.observersByWrittenEvent} so the built-in
	 * `happened` predicate can chain-aware speculatively allow `&&`
	 * chains whose prior refs match a writing observer's watch.
	 */
	readonly observersByWrittenEvent?: ReadonlyMap<string, readonly Observer[]>;
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
	/**
	 * Prior refs reachable via `&&` from the current ref. Populated
	 * only for bash candidates, exposed to predicates via
	 * {@link PredicateContext.priorAndChainedRefs}.
	 */
	readonly priorAndChainedRefs?: readonly { text: string }[];
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
 * Run a rule's predicate chain (pattern → requires → unless → when).
 * Returns the built {@link PredicateContext} when every predicate
 * passes (rule fires), or `null` when the chain short-circuits to
 * "no-fire" — **either** because a predicate legitimately rejected
 * the candidate, **or** because a predicate threw.
 *
 * Throws are the S1 hardening: a predicate function (built-in or
 * plugin-supplied) that throws synchronously or rejects asynchronously
 * gets its error logged with the rule name + source and the rule is
 * treated as NOT firing. Evaluation continues with the next rule.
 *
 * Why "does not fire" (vs "block" / "abort the whole evaluate"):
 *   - Mirrors the observer-dispatcher's per-observer isolation —
 *     one broken predicate must not poison the rest of the rule list.
 *   - A buggy predicate blocking everything would be worse UX than
 *     a buggy predicate silently failing — the block reason would
 *     leak the raw error message to the LLM (the pre-hardening
 *     behaviour). Top-level engine-throws still fail CLOSED; see
 *     {@link evaluateEvent}.
 */
async function runPredicateChain(
	rule: Rule,
	cand: Candidate,
	shared: SharedEvalContext,
): Promise<PredicateContext | null> {
	try {
		// Pattern-miss is the common case; exit before allocating ctx.
		if (!matchesPattern(rule.pattern, cand.target)) return null;

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
			...(cand.priorAndChainedRefs !== undefined
				? { priorAndChainedRefs: cand.priorAndChainedRefs }
				: {}),
			...(shared.observersByWrittenEvent !== undefined
				? { observersByWrittenEvent: shared.observersByWrittenEvent }
				: {}),
		};

		if (rule.requires !== undefined) {
			const ok = await matchesPatternOrFn(
				rule.requires,
				cand.target,
				ctx,
			);
			if (!ok) return null;
		}
		if (rule.unless !== undefined) {
			const ok = await matchesPatternOrFn(rule.unless, cand.target, ctx);
			if (ok) return null;
		}
		const whenOk = await evaluateWhen(
			rule.when,
			{ cwd: cand.cwd },
			ctx,
			shared.predicates,
			rule.name,
		);
		if (!whenOk) return null;

		return ctx;
	} catch (err) {
		const source = shared.ruleSources.get(rule) ?? "user";
		console.warn(
			`[pi-steering] predicate threw for rule "${rule.name}"@${source}: ${formatError(err)}`,
		);
		return null;
	}
}

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
 * All four steps are wrapped in a try/catch via
 * {@link runPredicateChain} — a throw is logged and treated as "rule
 * did not fire". That way a buggy predicate neither short-circuits the
 * whole rule list (a broken guardrail rule silently poisoning the
 * rest) nor leaks its raw `error.message` back to the agent via a
 * pi-level error tool_result.
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
	const ctx = await runPredicateChain(rule, cand, shared);
	if (ctx === null) return "no-fire";

	// Rule fires. Check for override (if allowed) before committing to
	// blocking.
	const noOverride = effectiveNoOverride(rule, shared.defaultNoOverride);
	if (!noOverride) {
		const reason = extractOverride(cand.overrideCarrier, rule.name);
		if (reason !== null) {
			// Go through the wrapped `shared.appendEntry` so the
			// `_agentLoopIndex` auto-tag lands on the audit entry. Rules
			// using `when.happened: { event: "steering-override", in:
			// "agent_loop" }` rely on the tag to filter overrides by the
			// current loop; a direct `host.appendEntry` here would bypass
			// the wrapper and leave the entry invisible to that predicate.
			shared.appendEntry("steering-override", {
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
	//
	// Fail-closed semantics on onFire errors: a sync throw or rejected
	// promise is logged and SWALLOWED — the block still returns. The
	// block decision already passed every predicate; a broken
	// best-effort side effect must not silently invalidate it. Mirrors
	// the observer-dispatcher's per-observer try/catch (observers are
	// isolated for the same reason).
	if (rule.onFire) {
		try {
			await rule.onFire(ctx);
		} catch (err) {
			console.warn(
				`[pi-steering] onFire for rule "${rule.name}" threw: ${formatError(err)}`,
			);
		}
	}

	return {
		block: true,
		reason: formatReason(
			rule,
			cand.tool,
			noOverride,
			shared.ruleSources.get(rule) ?? "user",
		),
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
	ruleSources: ReadonlyMap<Rule, string>,
	observersByWrittenEvent: ReadonlyMap<string, readonly Observer[]> | undefined,
): Promise<ToolCallEventResult | void> {
	// Top-level fail-closed wrap (S1). If the engine's own scaffolding
	// throws — parse errors, walker bugs, corrupted session JSONL, etc.
	// — we block the tool AS A SAFETY MEASURE and tag the reason so the
	// agent sees it came from the engine, not from a rule or plugin.
	// Per-predicate throws are handled one level down in
	// {@link runPredicateChain} (treated as "rule does not fire"); this
	// outer wrap only catches throws OUTSIDE the per-rule try/catch.
	try {
		return await evaluateEventInner(
			event,
			ctx,
			agentLoopIndex,
			rules,
			trackers,
			predicates,
			host,
			defaultNoOverride,
			ruleSources,
			observersByWrittenEvent,
		);
	} catch (err) {
		console.error(
			`[pi-steering] steering engine threw: ${formatError(err)}`,
		);
		return {
			block: true,
			reason:
				"[steering:engine@internal] steering engine error; " +
				"tool blocked as a safety measure",
		};
	}
}

async function evaluateEventInner(
	event: ToolCallEvent,
	ctx: ExtensionContext,
	agentLoopIndex: number,
	rules: readonly Rule[],
	trackers: Record<string, Tracker<unknown>>,
	predicates: ResolvedPluginState["predicates"],
	host: EvaluatorHost,
	defaultNoOverride: boolean,
	ruleSources: ReadonlyMap<Rule, string>,
	observersByWrittenEvent: ReadonlyMap<string, readonly Observer[]> | undefined,
): Promise<ToolCallEventResult | void> {
	// Shared per-call closures: exec memoized by (cmd, args, cwd);
	// findEntries reads the current session JSONL on demand; appendEntry
	// auto-tags writes with `_agentLoopIndex` so rules using
	// `when.happened` can filter by agent-loop scope.
	//
	// findEntries + appendEntry share a session-entry cache so a write
	// performed by an earlier rule's onFire (or by the override-audit
	// path) invalidates the cached read — later rules' when.happened
	// predicates see the fresh write instead of a stale snapshot
	// (S2/E1). The evaluator itself doesn't interleave writes with reads,
	// but onFire + override-audit do.
	const exec = createExecCache(host, ctx.cwd);
	const entryCache = createSessionEntryCache();
	const findEntries = createFindEntries(ctx, entryCache);
	const appendEntry = createAppendEntry(host, agentLoopIndex, entryCache);

	const shared: SharedEvalContext = {
		agentLoopIndex,
		predicates,
		exec,
		appendEntry,
		findEntries,
		host,
		defaultNoOverride,
		ruleSources,
		...(observersByWrittenEvent !== undefined
			? { observersByWrittenEvent }
			: {}),
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
			priorAndChainedRefs: refState.priorAndChainedRefs,
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

// ---------------------------------------------------------------------------
// Error formatting
// ---------------------------------------------------------------------------

/**
 * Format an unknown thrown value for a warning log. Shared across the
 * three places the evaluator catches throws:
 *
 *   - per-predicate try/catch in {@link runPredicateChain} (S1).
 *   - per-rule `onFire` try/catch in {@link evaluateCandidate}.
 *   - top-level engine try/catch in {@link evaluateEvent}.
 *
 * Mirrors the observer-dispatcher's `formatError` so the log shape
 * stays consistent across the two hook surfaces: `message\nstack` for
 * proper Errors, best-effort JSON otherwise, falling through to
 * `String(err)`.
 */
function formatError(err: unknown): string {
	if (err instanceof Error) return `${err.message}\n${err.stack ?? ""}`;
	try {
		return JSON.stringify(err);
	} catch {
		return String(err);
	}
}

// Re-export supporting types for consumers embedding the evaluator.
export type { EvaluatorHost } from "./evaluator-internals/context.ts";

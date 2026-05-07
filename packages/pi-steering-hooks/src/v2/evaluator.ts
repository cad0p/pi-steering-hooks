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
	type Tracker,
} from "unbash-walker";
import type {
	ExtensionContext,
	ToolCallEvent,
	ToolCallEventResult,
} from "@mariozechner/pi-coding-agent";
import { isToolCallEventType } from "@mariozechner/pi-coding-agent";
import {
	buildPredicateContext,
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
		turnIndex: number,
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
	const trackers: Record<string, Tracker<unknown>> = {
		...resolved.composedTrackers,
	};
	if (!("cwd" in trackers)) {
		trackers["cwd"] = cwdTracker as Tracker<unknown>;
	}

	return {
		evaluate: (event, ctx, turnIndex) =>
			evaluateEvent(
				event,
				ctx,
				turnIndex,
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
 * Walker-state snapshot per extracted bash command ref plus the
 * stringified `basename + args` text for regex testing.
 *
 * Built once per tool_call (in {@link prepareBashState}) so N rules
 * against M refs cost N×M regex tests — no N parses or N walks.
 */
interface BashRefState {
	readonly ref: CommandRef;
	readonly text: string;
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

async function evaluateEvent(
	event: ToolCallEvent,
	ctx: ExtensionContext,
	turnIndex: number,
	rules: readonly Rule[],
	trackers: Record<string, Tracker<unknown>>,
	predicates: ResolvedPluginState["predicates"],
	host: EvaluatorHost,
	defaultNoOverride: boolean,
): Promise<ToolCallEventResult | void> {
	// Shared per-call closures: exec memoized by (cmd, args, cwd);
	// findEntries reads the current session JSONL on demand; appendEntry
	// just passes through.
	const exec = createExecCache(host, ctx.cwd);
	const findEntries = createFindEntries(ctx);
	const appendEntry: PredicateContext["appendEntry"] = (type, data) =>
		host.appendEntry(type, data);

	// Bash state is lazy: non-bash rules don't pay for parse / walk.
	let bashState: BashRefState[] | null = null;
	const bashEvent = isToolCallEventType("bash", event) ? event : null;

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
				turnIndex,
				predicates,
				{ exec, appendEntry, findEntries },
				defaultNoOverride,
				host,
			);
			if (result !== undefined) return result;
			continue;
		}

		if (rule.tool === "write" && isToolCallEventType("write", event)) {
			const result = await evaluateWriteEditRule(
				rule,
				{
					tool: "write",
					path: event.input.path,
					content: event.input.content,
				},
				// override-comment scanned against content (the natural
				// carrier for write override comments — v1 parity).
				event.input.content,
				event.input.path,
				ctx.cwd,
				turnIndex,
				predicates,
				{ exec, appendEntry, findEntries },
				defaultNoOverride,
				host,
			);
			if (result !== undefined) return result;
			continue;
		}

		if (rule.tool === "edit" && isToolCallEventType("edit", event)) {
			const allNewText = event.input.edits.map((e) => e.newText).join("\n");
			const result = await evaluateWriteEditRule(
				rule,
				{
					tool: "edit",
					path: event.input.path,
					edits: event.input.edits,
				},
				allNewText,
				event.input.path,
				ctx.cwd,
				turnIndex,
				predicates,
				{ exec, appendEntry, findEntries },
				defaultNoOverride,
				host,
			);
			if (result !== undefined) return result;
			continue;
		}
	}
	return undefined;
}

/**
 * Per-rule bash evaluation. Iterates every extracted command ref; the
 * first ref that triggers the rule (pattern + requires + unless + when)
 * decides whether the rule fires. An override comment addressing this
 * rule converts "fired" into "allowed + logged".
 */
async function evaluateBashRule(
	rule: Rule,
	rawCommand: string,
	state: BashRefState[],
	turnIndex: number,
	predicates: ResolvedPluginState["predicates"],
	shared: {
		exec: PredicateContext["exec"];
		appendEntry: PredicateContext["appendEntry"];
		findEntries: PredicateContext["findEntries"];
	},
	defaultNoOverride: boolean,
	host: EvaluatorHost,
): Promise<ToolCallEventResult | void> {
	for (const refState of state) {
		const ctx = buildPredicateContext({
			cwd:
				typeof refState.walkerState["cwd"] === "string"
					? (refState.walkerState["cwd"] as string)
					: "unknown",
			tool: "bash",
			input: { tool: "bash", command: refState.text },
			turnIndex,
			exec: shared.exec,
			appendEntry: shared.appendEntry,
			findEntries: shared.findEntries,
		});

		// pattern is required; `requires` / `unless` optional; `when`
		// evaluated last (cheapest to reject on pattern miss first).
		if (!matchesPattern(rule.pattern, refState.text)) continue;
		if (rule.requires !== undefined) {
			const ok = await matchesPatternOrFn(rule.requires, refState.text, ctx);
			if (!ok) continue;
		}
		if (rule.unless !== undefined) {
			const ok = await matchesPatternOrFn(rule.unless, refState.text, ctx);
			if (ok) continue;
		}
		const cwdState =
			typeof refState.walkerState["cwd"] === "string"
				? (refState.walkerState["cwd"] as string)
				: "unknown";
		const whenOk = await evaluateWhen(
			rule.when,
			{ cwd: cwdState },
			ctx,
			predicates,
		);
		if (!whenOk) continue;

		// Rule fires on this ref. Look for an override comment addressing
		// this rule by name — unless the rule opts out of overrides.
		const noOverride = effectiveNoOverride(rule, defaultNoOverride);
		if (!noOverride) {
			const reason = extractOverride(rawCommand, rule.name);
			if (reason !== null) {
				host.appendEntry("steering-override", {
					rule: rule.name,
					reason,
					command: rawCommand,
					timestamp: new Date().toISOString(),
				});
				// Stop scanning further refs: override covers the whole
				// tool_call (v1 semantics).
				return undefined;
			}
		}
		return {
			block: true,
			reason: formatReason(rule, "bash", noOverride),
		};
	}
	return undefined;
}

/**
 * Per-rule write / edit evaluation. Target text is selected from the
 * rule's `field`:
 *   - `path`    → event.input.path
 *   - `content` → event.input.content (write) or joined newText (edit)
 *
 * `overrideCarrier` is the text scanned for override comments — per
 * v1 parity that's the content for both tools.
 */
async function evaluateWriteEditRule(
	rule: Rule,
	input: PredicateToolInput,
	overrideCarrier: string,
	path: string,
	cwd: string,
	turnIndex: number,
	predicates: ResolvedPluginState["predicates"],
	shared: {
		exec: PredicateContext["exec"];
		appendEntry: PredicateContext["appendEntry"];
		findEntries: PredicateContext["findEntries"];
	},
	defaultNoOverride: boolean,
	host: EvaluatorHost,
): Promise<ToolCallEventResult | void> {
	const target = getTargetText(rule, input);
	if (target === null) return undefined;

	const ctx = buildPredicateContext({
		cwd,
		tool: rule.tool as "write" | "edit",
		input,
		turnIndex,
		exec: shared.exec,
		appendEntry: shared.appendEntry,
		findEntries: shared.findEntries,
	});

	if (!matchesPattern(rule.pattern, target)) return undefined;
	if (rule.requires !== undefined) {
		const ok = await matchesPatternOrFn(rule.requires, target, ctx);
		if (!ok) return undefined;
	}
	if (rule.unless !== undefined) {
		const ok = await matchesPatternOrFn(rule.unless, target, ctx);
		if (ok) return undefined;
	}
	const whenOk = await evaluateWhen(rule.when, { cwd }, ctx, predicates);
	if (!whenOk) return undefined;

	const noOverride = effectiveNoOverride(rule, defaultNoOverride);
	if (!noOverride) {
		const reason = extractOverride(overrideCarrier, rule.name);
		if (reason !== null) {
			host.appendEntry("steering-override", {
				rule: rule.name,
				reason,
				path,
				timestamp: new Date().toISOString(),
			});
			return undefined;
		}
	}
	return {
		block: true,
		reason: formatReason(rule, rule.tool as "write" | "edit", noOverride),
	};
}

/**
 * Resolve the target string a rule's `pattern` should test against for
 * write / edit tools. Bash callers handle their own per-ref stringified
 * text upstream — this function returns `null` for bash (shouldn't be
 * reached; defensive).
 */
function getTargetText(rule: Rule, input: PredicateToolInput): string | null {
	if (rule.tool === "write") {
		if (rule.field === "path") return input.path ?? "";
		return input.content ?? "";
	}
	if (rule.tool === "edit") {
		if (rule.field === "path") return input.path ?? "";
		if (input.edits) return input.edits.map((e) => e.newText).join("\n");
		return "";
	}
	return null;
}

// Re-export supporting types for consumers embedding the evaluator.
export type { EvaluatorHost } from "./evaluator-internals/context.ts";

// SPDX-License-Identifier: MIT
// Part of @cad0p/pi-steering-hooks.
//
// @cad0p/pi-steering-hooks — deterministic steering hooks for pi agents.
// Inspired by @samfp/pi-steering-hooks (schema, override-comment, defaults).
// AST backend + command-level effective-cwd via unbash-walker.

import type {
	EditToolCallEvent,
	ExtensionAPI,
	ToolCallEventResult,
	WriteToolCallEvent,
} from "@mariozechner/pi-coding-agent";
import { isToolCallEventType } from "@mariozechner/pi-coding-agent";
import { DEFAULT_RULES } from "./defaults.ts";
import {
	type BashContext,
	evaluateBashRuleWithContext,
	evaluateRule,
	extractOverride,
	prepareBashContext,
	type ToolInput,
} from "./evaluator.ts";
import { buildRules, loadConfigs } from "./loader.ts";
import type { Rule } from "./schema.ts";

/**
 * Is this rule overridable given the rule's own `noOverride` and the
 * currently-merged `defaultNoOverride` fallback?
 *
 * Single source of truth so `overrideHint`, the bash branch, and the
 * write/edit helpers can't disagree on whether an override comment is
 * even worth looking for.
 *
 * Semantics:
 *   effective-noOverride = rule.noOverride ?? defaultNoOverride ?? false
 *   overridable          = !effective-noOverride
 */
function isOverridable(rule: Rule, defaultNoOverride: boolean): boolean {
	return !(rule.noOverride ?? defaultNoOverride);
}

/**
 * Build the "to override, add comment ..." hint appended to the block reason.
 * Kept as a single source of truth so the message stays consistent across
 * tool types and tests can assert exact phrasing.
 */
function overrideHint(
	rule: Rule,
	tool: "bash" | "write" | "edit",
	defaultNoOverride: boolean,
): string {
	if (!isOverridable(rule, defaultNoOverride)) return "";
	const leader = tool === "bash" ? "#" : "//";
	return ` To override, include a comment: \`${leader} steering-override: ${rule.name} — <reason>\`.`;
}

/** Format the block reason shown to the agent when a rule fires. */
function formatBlockReason(
	rule: Rule,
	tool: "bash" | "write" | "edit",
	defaultNoOverride: boolean,
): string {
	return `[steering:${rule.name}] ${rule.reason}${overrideHint(rule, tool, defaultNoOverride)}`;
}

/**
 * Evaluate a single rule against a bash tool call. Returns `true` if the rule
 * fires for any extracted command ref (including commands behind wrappers like
 * `sh -c`, `sudo`, `xargs`, etc.).
 *
 * Convenience one-shot: re-parses the AST on every call. For the hot path
 * (many rules per command) the extension dispatcher uses `prepareBashContext`
 * + `evaluateBashRuleWithContext` to amortize parse cost.
 *
 * Re-exported from `./evaluator.ts`. Exported here for the integration tests
 * and for downstream consumers that want to embed the evaluator without the
 * pi extension shim.
 */
export { evaluateBashRule } from "./evaluator.ts";

/**
 * Pi extension factory. Wires the steering engine onto `session_start` +
 * `tool_call` hooks. Exported as default per pi's extension convention.
 */
export default function register(pi: ExtensionAPI): void {
	let rules: Rule[] = [];
	// Fallback for `Rule.noOverride` when a rule doesn't specify it. Set from
	// the merged config layers on `session_start` alongside `rules`. Per-rule
	// `noOverride` still wins — see `isOverridable`.
	let defaultNoOverride = false;

	pi.on("session_start", (_event, ctx) => {
		const configs = loadConfigs(ctx.cwd);
		const built = buildRules(configs, DEFAULT_RULES);
		rules = built.rules;
		defaultNoOverride = built.defaultNoOverride;
	});

	pi.on("tool_call", (event, ctx): ToolCallEventResult | void => {
		// Lazy-build the bash AST context on first need and reuse it across
		// all bash rules for this tool call. Non-bash tool calls skip the
		// pipeline entirely (ctx stays null).
		let bashContext: BashContext | null = null;
		for (const rule of rules) {
			if (rule.tool === "bash" && isToolCallEventType("bash", event)) {
				const cmd = event.input.command;
				bashContext ??= prepareBashContext(cmd, ctx.cwd);
				if (!evaluateBashRuleWithContext(rule, bashContext)) continue;

				if (isOverridable(rule, defaultNoOverride)) {
					const reason = extractOverride(cmd, rule.name);
					if (reason !== null) {
						pi.appendEntry("steering-override", {
							rule: rule.name,
							reason,
							command: cmd,
							timestamp: new Date().toISOString(),
						});
						continue;
					}
				}

				return {
					block: true,
					reason: formatBlockReason(rule, "bash", defaultNoOverride),
				};
			}

			if (rule.tool === "write" && isToolCallEventType("write", event)) {
				const result = applyWrite(pi, rule, event, ctx.cwd, defaultNoOverride);
				if (result === "continue") continue;
				return result;
			}

			if (rule.tool === "edit" && isToolCallEventType("edit", event)) {
				const result = applyEdit(pi, rule, event, ctx.cwd, defaultNoOverride);
				if (result === "continue") continue;
				return result;
			}
		}
	});
}

/**
 * Handle the write tool path of the tool_call dispatcher. Factored out so the
 * main handler reads top-to-bottom without nested branching.
 *
 * Returns:
 *   - "continue" → rule did not fire OR override accepted; advance to next rule.
 *   - ToolCallEventResult → the tool call is blocked.
 */
function applyWrite(
	pi: ExtensionAPI,
	rule: Rule,
	event: WriteToolCallEvent,
	cwd: string,
	defaultNoOverride: boolean,
): "continue" | ToolCallEventResult {
	const input: ToolInput = {
		tool: "write",
		path: event.input.path,
		content: event.input.content,
	};
	if (!evaluateRule(rule, input, { cwd })) return "continue";

	if (isOverridable(rule, defaultNoOverride)) {
		const reason = extractOverride(event.input.content, rule.name);
		if (reason !== null) {
			pi.appendEntry("steering-override", {
				rule: rule.name,
				reason,
				path: event.input.path,
				timestamp: new Date().toISOString(),
			});
			return "continue";
		}
	}

	return {
		block: true,
		reason: formatBlockReason(rule, "write", defaultNoOverride),
	};
}

/**
 * Handle the edit tool path of the tool_call dispatcher. See `applyWrite` for
 * the return-value contract.
 */
function applyEdit(
	pi: ExtensionAPI,
	rule: Rule,
	event: EditToolCallEvent,
	cwd: string,
	defaultNoOverride: boolean,
): "continue" | ToolCallEventResult {
	const input: ToolInput = {
		tool: "edit",
		path: event.input.path,
		edits: event.input.edits,
	};
	if (!evaluateRule(rule, input, { cwd })) return "continue";

	if (isOverridable(rule, defaultNoOverride)) {
		const allNewText = event.input.edits.map((e) => e.newText).join("\n");
		const reason = extractOverride(allNewText, rule.name);
		if (reason !== null) {
			pi.appendEntry("steering-override", {
				rule: rule.name,
				reason,
				path: event.input.path,
				timestamp: new Date().toISOString(),
			});
			return "continue";
		}
	}

	return {
		block: true,
		reason: formatBlockReason(rule, "edit", defaultNoOverride),
	};
}

// ---------------------------------------------------------------------------
// Re-exports for consumers embedding the engine or writing their own
// extensions (e.g. to compose with additional hooks, or to build a CLI that
// evaluates rules outside the pi runtime).
// ---------------------------------------------------------------------------

export type { Rule, SteeringConfig } from "./schema.ts";
export type { BashContext, ToolInput, EvalContext } from "./evaluator.ts";
export { DEFAULT_RULES } from "./defaults.ts";
export {
	evaluateBashRuleWithContext,
	evaluateRule,
	evaluateRuleForCommand,
	extractOverride,
	prepareBashContext,
} from "./evaluator.ts";
export { parseConfig, loadConfigs, buildRules } from "./loader.ts";

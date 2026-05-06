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
import {
	effectiveCwd,
	expandWrapperCommands,
	extractAllCommandsFromAST,
	getBasename,
	getCommandArgs,
	parse as parseBash,
} from "unbash-walker";
import { DEFAULT_RULES } from "./defaults.ts";
import {
	evaluateRule,
	evaluateRuleForCommand,
	extractOverride,
	type ToolInput,
} from "./evaluator.ts";
import { buildRules, loadConfigs } from "./loader.ts";
import type { Rule } from "./schema.ts";

/**
 * Build the "to override, add comment ..." hint appended to the block reason.
 * Kept as a single source of truth so the message stays consistent across
 * tool types and tests can assert exact phrasing.
 */
function overrideHint(rule: Rule, tool: "bash" | "write" | "edit"): string {
	if (rule.noOverride) return "";
	const leader = tool === "bash" ? "#" : "//";
	return ` To override, include a comment: \`${leader} steering-override: ${rule.name} — <reason>\`.`;
}

/** Format the block reason shown to the agent when a rule fires. */
function formatBlockReason(rule: Rule, tool: "bash" | "write" | "edit"): string {
	return `[steering:${rule.name}] ${rule.reason}${overrideHint(rule, tool)}`;
}

/**
 * Evaluate a single rule against a bash tool call. Returns `true` if the rule
 * fires for any extracted command ref (including commands behind wrappers like
 * `sh -c`, `sudo`, `xargs`, etc.).
 *
 * Exported for the integration tests and for downstream consumers that want
 * to embed the evaluator without the pi extension shim.
 */
export function evaluateBashRule(
	rule: Rule,
	command: string,
	sessionCwd: string,
): boolean {
	const script = parseBash(command);
	const extracted = extractAllCommandsFromAST(script, command);
	const { commands: refs } = expandWrapperCommands(extracted);
	const cwdMap = effectiveCwd(script, sessionCwd, refs);

	for (const ref of refs) {
		const refCwd = cwdMap.get(ref) ?? sessionCwd;
		const commandText = `${getBasename(ref)} ${getCommandArgs(ref).join(" ")}`.trim();
		if (evaluateRuleForCommand(rule, commandText, refCwd)) return true;
	}
	return false;
}

/**
 * Pi extension factory. Wires the steering engine onto `session_start` +
 * `tool_call` hooks. Exported as default per pi's extension convention.
 */
export default function register(pi: ExtensionAPI): void {
	let rules: Rule[] = [];

	pi.on("session_start", (_event, ctx) => {
		const configs = loadConfigs(ctx.cwd);
		rules = buildRules(configs, DEFAULT_RULES);
	});

	pi.on("tool_call", (event, ctx): ToolCallEventResult | void => {
		for (const rule of rules) {
			if (rule.tool === "bash" && isToolCallEventType("bash", event)) {
				const cmd = event.input.command;
				if (!evaluateBashRule(rule, cmd, ctx.cwd)) continue;

				if (!rule.noOverride) {
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

				return { block: true, reason: formatBlockReason(rule, "bash") };
			}

			if (rule.tool === "write" && isToolCallEventType("write", event)) {
				const result = applyWrite(pi, rule, event, ctx.cwd);
				if (result === "continue") continue;
				if (result !== undefined) return result;
			}

			if (rule.tool === "edit" && isToolCallEventType("edit", event)) {
				const result = applyEdit(pi, rule, event, ctx.cwd);
				if (result === "continue") continue;
				if (result !== undefined) return result;
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
): "continue" | ToolCallEventResult {
	const input: ToolInput = {
		tool: "write",
		path: event.input.path,
		content: event.input.content,
	};
	if (!evaluateRule(rule, input, { cwd })) return "continue";

	if (!rule.noOverride) {
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

	return { block: true, reason: formatBlockReason(rule, "write") };
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
): "continue" | ToolCallEventResult {
	const input: ToolInput = {
		tool: "edit",
		path: event.input.path,
		edits: event.input.edits,
	};
	if (!evaluateRule(rule, input, { cwd })) return "continue";

	if (!rule.noOverride) {
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

	return { block: true, reason: formatBlockReason(rule, "edit") };
}

// ---------------------------------------------------------------------------
// Re-exports for consumers embedding the engine or writing their own
// extensions (e.g. to compose with additional hooks, or to build a CLI that
// evaluates rules outside the pi runtime).
// ---------------------------------------------------------------------------

export type { Rule, SteeringConfig } from "./schema.ts";
export type { ToolInput, EvalContext } from "./evaluator.ts";
export { DEFAULT_RULES } from "./defaults.ts";
export {
	evaluateRule,
	evaluateRuleForCommand,
	extractOverride,
} from "./evaluator.ts";
export { parseConfig, loadConfigs, buildRules } from "./loader.ts";

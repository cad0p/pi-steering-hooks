// SPDX-License-Identifier: MIT
// Part of @cad0p/pi-steering-hooks.

/**
 * Rule evaluation + inline override-comment detection.
 *
 * Two shapes are exposed because the bash path needs per-command-ref
 * evaluation (so each extracted command can be tested against its own
 * effective cwd), while write / edit evaluate once against the raw field.
 *
 *   - `evaluateRuleForCommand(rule, commandText, refCwd)` — for bash. The
 *     caller pre-parses the input with unbash-walker and invokes this per
 *     extracted CommandRef with that ref's stringified command and its
 *     effective cwd.
 *   - `evaluateRule(rule, input, ctx)` — for write / edit. Applies pattern
 *     directly to the chosen field value and cwdPattern to ctx.cwd.
 *
 * `extractOverride` parses inline override comments of the form:
 *   # steering-override: <rule-name> — <reason>
 * and returns the reason, or null when the override is absent or addressed
 * to a different rule. Comment leaders supported: `#`, `//`, `/*`, `<!--`,
 * `--`, `%%`, `;;`.
 */

import type { Rule } from "./schema.ts";

/** Pi tool input union, reduced to the fields the evaluator touches. */
export interface ToolInput {
	tool: "bash" | "write" | "edit";
	/** bash only */
	command?: string;
	/** write, edit */
	path?: string;
	/** write */
	content?: string;
	/** edit */
	edits?: ReadonlyArray<{ oldText: string; newText: string }>;
}

export interface EvalContext {
	/** Session cwd (from the pi ExtensionContext). */
	cwd: string;
}

/**
 * Evaluate a single rule against a pre-stringified bash command.
 *
 * The caller is responsible for:
 *   1. parsing the raw command with unbash,
 *   2. extracting command refs with `extractAllCommandsFromAST` +
 *      `expandWrapperCommands`,
 *   3. computing effective cwds with `effectiveCwd`, and
 *   4. passing each ref's `basename + " " + args.join(" ")` as
 *      `commandText` and the ref's effective cwd as `refCwd`.
 *
 * Returns true if the rule fires for this command ref.
 */
export function evaluateRuleForCommand(
	rule: Rule,
	commandText: string,
	refCwd: string,
): boolean {
	if (rule.tool !== "bash") return false;

	if (!new RegExp(rule.pattern).test(commandText)) return false;
	if (rule.requires && !new RegExp(rule.requires).test(commandText)) return false;
	if (rule.unless && new RegExp(rule.unless).test(commandText)) return false;
	if (rule.cwdPattern && !new RegExp(rule.cwdPattern).test(refCwd)) return false;

	return true;
}

/**
 * Evaluate a rule against a write or edit tool call.
 *
 * For `write`: pattern applies to `input.path` (field="path") or
 * `input.content` (field="content", default).
 * For `edit`: pattern applies to `input.path` (field="path") or the joined
 * `newText` values across edits (field="content", default).
 *
 * Bash invocations are not supported here — use `evaluateRuleForCommand`
 * so the caller can thread per-ref cwd in.
 */
export function evaluateRule(
	rule: Rule,
	input: ToolInput,
	ctx: EvalContext,
): boolean {
	if (rule.tool !== input.tool) return false;

	const target = getTargetText(rule, input);
	if (target === null) return false;

	if (!new RegExp(rule.pattern).test(target)) return false;
	if (rule.requires && !new RegExp(rule.requires).test(target)) return false;
	if (rule.unless && new RegExp(rule.unless).test(target)) return false;
	if (rule.cwdPattern && !new RegExp(rule.cwdPattern).test(ctx.cwd)) return false;

	return true;
}

/** Resolve the string the rule's pattern should test against, per tool + field. */
function getTargetText(rule: Rule, input: ToolInput): string | null {
	if (input.tool === "write") {
		if (rule.field === "path") return input.path ?? "";
		// Default for write: content
		return input.content ?? "";
	}
	if (input.tool === "edit") {
		if (rule.field === "path") return input.path ?? "";
		// Default for edit: the joined newText across edits
		if (input.edits) return input.edits.map((e) => e.newText).join("\n");
		return "";
	}
	// Bash: the caller should use evaluateRuleForCommand. Return null so the
	// dispatcher treats this as a non-match rather than accidentally matching
	// against the raw command text (which would re-introduce the regex-on-raw
	// silent-bypass classes the AST backend exists to avoid).
	return null;
}

/**
 * Extract an inline override comment targeted at a specific rule.
 *
 * Syntax:  `<leader> steering-override: <rule-name> <sep> <reason>`
 *   leader: #, //, /*, <!--, --, %%, ;;
 *   sep:    — (em dash), – (en dash), or - (hyphen)
 *
 * Returns the captured reason (trimmed), or null if:
 *   - no override comment is present, or
 *   - the override's rule name doesn't match `ruleName`.
 *
 * The match is deliberately case-sensitive on the rule name so operators see
 * exactly what they typed in audit logs.
 */
export function extractOverride(text: string, ruleName: string): string | null {
	// Match the first override comment in the text. If it names a different
	// rule, return null (the agent targeted a different override; this rule
	// is still in effect).
	const re =
		/(?:#|\/\/|\/\*|<!--|--|%%|;;)\s*steering-override:\s*([A-Za-z0-9_-]+)\s*[—–-]\s*(.+?)(?:\*\/|-->|$)/m;
	const m = re.exec(text);
	if (!m) return null;
	if (m[1] !== ruleName) return null;
	const reason = (m[2] ?? "").trim();
	return reason === "" ? null : reason;
}

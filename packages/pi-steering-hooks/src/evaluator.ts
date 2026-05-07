// SPDX-License-Identifier: MIT
// Part of @cad0p/pi-steering-hooks.

/**
 * Rule evaluation + inline override-comment detection.
 *
 * Three shapes are exposed because the bash path needs per-command-ref
 * evaluation (so each extracted command can be tested against its own
 * effective cwd), while write / edit evaluate once against the raw field.
 *
 *   - `evaluateRuleForCommand(rule, commandText, refCwd)` — lowest-level
 *     bash primitive. Caller has already parsed + extracted + expanded +
 *     cwd-resolved; this just runs the rule's predicates against one
 *     stringified ref and one effective cwd.
 *   - `prepareBashContext(command, sessionCwd)` + `evaluateBashRuleWithContext(rule, ctx)`
 *     — the hot-path pair. `prepareBashContext` runs the AST pipeline
 *     (parse → extract → expand → effectiveCwd → stringify) once, returning
 *     a reusable {@link BashContext}. `evaluateBashRuleWithContext` then
 *     tests each rule against the prepared refs without re-parsing. Callers
 *     evaluating many rules per tool call (e.g. the extension dispatcher)
 *     should use this pair to amortize the parse cost across rules.
 *   - `evaluateBashRule(rule, command, sessionCwd)` — one-shot convenience.
 *     Composes the two above for callers that only evaluate a single rule
 *     (tests, CLIs, ad-hoc checks). For hot loops with multiple rules per
 *     command, prefer the prepare/evaluate split.
 *   - `evaluateRule(rule, input, ctx)` — for write / edit. Applies pattern
 *     directly to the chosen field value and `when.cwd` to ctx.cwd.
 *
 * `extractOverride` parses inline override comments of the form:
 *   # steering-override: <rule-name> — <reason>
 * and returns the reason, or null when the override is absent or addressed
 * to a different rule. Comment leaders supported: `#`, `//`, `/*`, `<!--`,
 * `--`, `%%`, `;;`.
 */

import {
	expandWrapperCommands,
	extractAllCommandsFromAST,
	getBasename,
	getCommandArgs,
	parse as parseBash,
	type CommandRef,
} from "unbash-walker";
import { effectiveCwd } from "./internal/effective-cwd-adapter.ts";
import type { Rule } from "./schema.ts";

/**
 * Set of rule names that have already emitted an "unknown `when` key" warning
 * during this process. Using a module-level Set avoids spamming the console
 * on every tool call while still letting the first occurrence surface typos.
 */
const warnedWhenKeys = new Set<string>();

/**
 * Emit a one-time console.warn for any unrecognized keys under `rule.when`.
 *
 * The current evaluator only understands `when.cwd`; future peers (`branch`,
 * `env`, `time-of-day`, ...) are reserved but not yet implemented. Flagging
 * unknowns early catches typos (e.g. `when.cdw`) before they silently
 * short-circuit evaluation.
 */
function checkWhenKeys(rule: Rule): void {
	if (!rule.when) return;
	if (warnedWhenKeys.has(rule.name)) return;
	const known = new Set(["cwd"]);
	const unknown: string[] = [];
	for (const key of Object.keys(rule.when)) {
		if (!known.has(key)) unknown.push(key);
	}
	if (unknown.length === 0) return;
	warnedWhenKeys.add(rule.name);
	console.warn(
		`[steering:${rule.name}] ignoring unknown \`when\` key(s): ${unknown.join(", ")}. ` +
			`Known keys: cwd. Peers for branch/env/time-of-day are reserved for future use.`,
	);
}

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
 *     `commandText` and the ref's effective cwd as `refCwd`.
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
	checkWhenKeys(rule);
	const cwdPattern = rule.when?.cwd;
	if (cwdPattern && !new RegExp(cwdPattern).test(refCwd)) return false;

	return true;
}

/**
 * Pre-parsed view of one bash command — parse + extract + expand + cwd-resolve
 * done once, ready to evaluate against many rules.
 *
 * The AST pipeline (parse → `extractAllCommandsFromAST` → `expandWrapperCommands`
 * → `effectiveCwd`) is deterministic in `(command, sessionCwd)`. Previously the
 * extension ran it per rule inside the `tool_call` loop — N+4 times for the 4
 * default rules + N user rules — which scales linearly with rule count. With a
 * pre-computed context the per-rule cost drops to one regex test per ref.
 *
 * Frozen so accidental mutation in a rule handler can't leak across iterations.
 *
 * @experimental The shape of `refs` and `cwdMap` exposes `CommandRef` from
 * `unbash-walker`, transitively coupling consumers to unbash's AST node types.
 * This is acceptable for 0.x but will be revisited before v1.0 — see
 * `PUBLISHING.md` (section: v1 API stability considerations) for the options
 * on the table (keep as-is / opaque handle / flatten to plain data).
 */
export interface BashContext {
	/** Original raw command string passed in. */
	readonly rawCommand: string;
	/** Session cwd threaded through effectiveCwd (fallback for refs without one). */
	readonly sessionCwd: string;
	/** All extracted command refs after wrapper expansion. */
	readonly refs: readonly CommandRef[];
	/** ref → effective cwd, as produced by `effectiveCwd`. */
	readonly cwdMap: ReadonlyMap<CommandRef, string>;
	/**
	 * Pre-stringified `basename + " " + args.join(" ")` per ref, in the same
	 * order as `refs`. Materialized once so the per-rule loop is pure regex
	 * work — no repeated `getBasename`/`getCommandArgs` calls.
	 */
	readonly stringified: readonly {
		readonly ref: CommandRef;
		readonly text: string;
		readonly cwd: string;
	}[];
}

/**
 * Run the AST pipeline for a bash command and return a reusable
 * {@link BashContext}. Call this ONCE per tool call; pass the result to
 * `evaluateBashRuleWithContext` for each rule.
 *
 * The extension dispatcher uses this to amortize parse cost across the
 * rule list. External callers evaluating a single rule should prefer the
 * one-shot {@link evaluateBashRule} for readability.
 */
export function prepareBashContext(
	command: string,
	sessionCwd: string,
): BashContext {
	const script = parseBash(command);
	const extracted = extractAllCommandsFromAST(script, command);
	const { commands: refs } = expandWrapperCommands(extracted);
	const cwdMap = effectiveCwd(script, sessionCwd, refs);
	const stringified = refs.map((ref) => {
		const text = `${getBasename(ref)} ${getCommandArgs(ref).join(" ")}`.trim();
		const cwd = cwdMap.get(ref) ?? sessionCwd;
		return { ref, text, cwd };
	});
	return {
		rawCommand: command,
		sessionCwd,
		refs,
		cwdMap,
		stringified,
	};
}

/**
 * Evaluate one bash rule against a prepared {@link BashContext}. Returns
 * true if the rule fires for any extracted command ref.
 *
 * This is the hot-loop entry point: no parsing, no extraction, no cwd walk.
 * Given N rules and M refs, cost is N × M regex tests.
 */
export function evaluateBashRuleWithContext(
	rule: Rule,
	ctx: BashContext,
): boolean {
	if (rule.tool !== "bash") return false;
	for (const { text, cwd } of ctx.stringified) {
		if (evaluateRuleForCommand(rule, text, cwd)) return true;
	}
	return false;
}

/**
 * One-shot bash rule evaluation. Parses, extracts, expands, cwd-resolves,
 * and evaluates `rule` in a single call.
 *
 * Use this for ad-hoc checks, tests, or CLIs that run one rule at a time.
 * For hot loops (multiple rules per command — e.g. the extension dispatcher),
 * call {@link prepareBashContext} once and then {@link evaluateBashRuleWithContext}
 * per rule so the parse cost is paid just once.
 */
export function evaluateBashRule(
	rule: Rule,
	command: string,
	sessionCwd: string,
): boolean {
	return evaluateBashRuleWithContext(
		rule,
		prepareBashContext(command, sessionCwd),
	);
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
	checkWhenKeys(rule);
	const cwdPattern = rule.when?.cwd;
	if (cwdPattern && !new RegExp(cwdPattern).test(ctx.cwd)) return false;

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
	// Scan every override comment in the text with a global-flag regex and
	// return the first one that targets `ruleName`.
	//
	// Stacked overrides on one line, e.g.
	//   `cmd # steering-override: rule-a — r1 # steering-override: rule-b — r2`
	// are parsed without cross-contamination: after each match we cap the
	// captured reason at the next override marker, and reset `lastIndex` to
	// that marker's position so the subsequent iteration sees it.
	const re =
		/(?:#|\/\/|\/\*|<!--|--|%%|;;)\s*steering-override:\s*([A-Za-z0-9_-]+)\s*[—–-]\s*(.*?)(?:\*\/|-->|$)/gm;
	const markerRe =
		/(?:#|\/\/|\/\*|<!--|--|%%|;;)\s*steering-override:/;
	let m: RegExpExecArray | null;
	while ((m = re.exec(text)) !== null) {
		let reason = m[2] ?? "";
		// If the lazy capture swallowed a subsequent override marker (common
		// when stacked on one line, because the greedy `$` terminator sits
		// past the marker), cap the reason at that marker and rewind the
		// scanner to the marker so the next iteration parses it cleanly.
		const reasonStart = (m.index ?? 0) + m[0].length - reason.length;
		const nextIdx = reason.search(markerRe);
		if (nextIdx !== -1) {
			reason = reason.slice(0, nextIdx);
			re.lastIndex = reasonStart + nextIdx;
		}
		if (m[1] !== ruleName) continue;
		reason = reason.trim();
		if (reason === "") continue;
		return reason;
	}
	return null;
}

// SPDX-License-Identifier: MIT
// Part of @cad0p/pi-steering-hooks.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	expandWrapperCommands,
	extractAllCommandsFromAST,
	getBasename,
	getCommandArgs,
	parse as parseBash,
} from "unbash-walker";
import {
	evaluateBashRule,
	evaluateBashRuleWithContext,
	evaluateRule,
	evaluateRuleForCommand,
	extractOverride,
	prepareBashContext,
	type ToolInput,
} from "./evaluator.ts";
import { effectiveCwd } from "./internal/effective-cwd-adapter.ts";
import type { Rule } from "./schema.ts";

/**
 * Helper that mirrors what the extension does per rule for bash: parse,
 * extract, expand wrappers, compute per-ref effective cwd, then test
 * evaluateRuleForCommand for each ref. Returns true on any hit.
 */
function fires(rule: Rule, command: string, sessionCwd = "/repo"): boolean {
	const script = parseBash(command);
	const { commands: refs } = expandWrapperCommands(
		extractAllCommandsFromAST(script, command),
	);
	const cwdMap = effectiveCwd(script, sessionCwd, refs);
	for (const ref of refs) {
		const text = `${getBasename(ref)} ${getCommandArgs(ref).join(" ")}`.trim();
		const refCwd = cwdMap.get(ref) ?? sessionCwd;
		if (evaluateRuleForCommand(rule, text, refCwd)) return true;
	}
	return false;
}

const NO_FORCE_PUSH: Rule = {
	name: "no-force-push",
	tool: "bash",
	field: "command",
	pattern: "\\bgit\\s+push\\b.*--force(?!-with-lease)",
	reason: "no force push",
};

describe("evaluateRuleForCommand (bash)", () => {
	it("fires on a matching AST-extracted command", () => {
		assert.equal(fires(NO_FORCE_PUSH, "git push --force"), true);
	});

	it("does not fire on a non-matching command", () => {
		assert.equal(fires(NO_FORCE_PUSH, "git push"), false);
		assert.equal(fires(NO_FORCE_PUSH, "ls -la"), false);
	});

	it("respects requires (must also match)", () => {
		const rule: Rule = {
			...NO_FORCE_PUSH,
			name: "no-force-push-to-main",
			// Fires only if the push targets main.
			requires: "\\bmain\\b",
		};
		assert.equal(fires(rule, "git push --force origin main"), true);
		assert.equal(fires(rule, "git push --force origin feature-x"), false);
	});

	it("respects unless (exemption)", () => {
		const rule: Rule = {
			...NO_FORCE_PUSH,
			unless: "--force-with-lease",
		};
		assert.equal(fires(rule, "git push --force-with-lease"), false);
		assert.equal(fires(rule, "git push --force"), true);
	});

	it("respects when.cwd (fires only when cwd matches)", () => {
		const rule: Rule = {
			...NO_FORCE_PUSH,
			name: "no-force-push-personal",
			when: { cwd: "/personal/" },
		};
		assert.equal(fires(rule, "git push --force", "/home/me/personal/proj"), true);
		assert.equal(fires(rule, "git push --force", "/home/me/work/proj"), false);
	});

	it("when.cwd sees the per-command effective cwd (cd X && cmd)", () => {
		const rule: Rule = {
			name: "no-amend-in-personal",
			tool: "bash",
			field: "command",
			pattern: "\\bgit\\s+commit\\b.*--amend",
			reason: "don't amend in personal repos",
			when: { cwd: "/personal/" },
		};
		// Session starts in /work. `cd` to /home/me/personal/foo inside the
		// same command string \u2192 effectiveCwd for the amend ref is that path.
		assert.equal(
			fires(rule, "cd /home/me/personal/foo && git commit --amend", "/work"),
			true,
		);
		// Different cd target, rule should stay silent.
		assert.equal(
			fires(rule, "cd /home/me/work/foo && git commit --amend", "/work"),
			false,
		);
	});

	it("catches wrapped commands (sh -c 'git push --force')", () => {
		assert.equal(fires(NO_FORCE_PUSH, "sh -c 'git push --force'"), true);
	});

	it("returns false when called with a non-bash rule", () => {
		const writeRule: Rule = {
			name: "no-secrets",
			tool: "write",
			field: "content",
			pattern: "PRIVATE_KEY",
			reason: "no",
		};
		assert.equal(evaluateRuleForCommand(writeRule, "git push --force", "/"), false);
	});
});

// ---------------------------------------------------------------------------
// prepareBashContext + evaluateBashRuleWithContext + evaluateBashRule
//
// These cover the parse-once-per-tool-call optimisation path. The context
// produced by prepareBashContext must be equivalent to running the full AST
// pipeline manually, and evaluating any rule against that context must
// produce the same verdict as the one-shot convenience wrapper.
// ---------------------------------------------------------------------------

describe("prepareBashContext", () => {
	it("produces refs + cwdMap matching the raw AST pipeline", () => {
		const command = "cd /tmp/A && git push --force && cd /tmp/B && git commit --amend";
		const sessionCwd = "/home/me";

		// Reference: run the pipeline by hand against the SAME script instance
		// the candidate uses. We can't compare refs across two separate parses
		// because each parse allocates fresh Command nodes; comparing content
		// (stringified text + effective cwd) is the honest equivalence check.
		const ctx = prepareBashContext(command, sessionCwd);

		assert.equal(ctx.rawCommand, command);
		assert.equal(ctx.sessionCwd, sessionCwd);

		// Rebuild the expected refs/cwds from the context's own script-level
		// state so ref identity holds. The context exposes refs + cwdMap
		// directly, so we can assert content consistency against stringified.
		assert.equal(ctx.refs.length, ctx.stringified.length);
		for (let i = 0; i < ctx.refs.length; i++) {
			const ref = ctx.refs[i]!;
			const expectedText =
				`${getBasename(ref)} ${getCommandArgs(ref).join(" ")}`.trim();
			const expectedCwd = ctx.cwdMap.get(ref) ?? sessionCwd;
			const entry = ctx.stringified[i]!;
			assert.equal(entry.ref, ref, `ref[${i}] identity preserved`);
			assert.equal(entry.text, expectedText, `stringified[${i}].text matches`);
			assert.equal(entry.cwd, expectedCwd, `stringified[${i}].cwd matches`);
		}

		// Also confirm the pipeline produces a structurally-equivalent shape
		// when run independently: same ref count, same stringified texts, same
		// per-ref effective cwds.
		const script = parseBash(command);
		const { commands: rawRefs } = expandWrapperCommands(
			extractAllCommandsFromAST(script, command),
		);
		const rawCwdMap = effectiveCwd(script, sessionCwd, rawRefs);
		assert.equal(rawRefs.length, ctx.refs.length, "same number of extracted refs");
		for (let i = 0; i < rawRefs.length; i++) {
			const ref = rawRefs[i]!;
			const expectedText =
				`${getBasename(ref)} ${getCommandArgs(ref).join(" ")}`.trim();
			const expectedCwd = rawCwdMap.get(ref) ?? sessionCwd;
			assert.equal(ctx.stringified[i]?.text, expectedText);
			assert.equal(ctx.stringified[i]?.cwd, expectedCwd);
		}

		// Spot-check content: the first git command runs in /tmp/A, the second
		// in /tmp/B, regardless of the session cwd (/home/me).
		const gitPushEntry = ctx.stringified.find((e) => e.text.startsWith("git push"));
		const gitCommitEntry = ctx.stringified.find((e) => e.text.startsWith("git commit"));
		assert.ok(gitPushEntry, "expected git push to be extracted");
		assert.ok(gitCommitEntry, "expected git commit to be extracted");
		assert.equal(gitPushEntry.cwd, "/tmp/A");
		assert.equal(gitCommitEntry.cwd, "/tmp/B");
	});

	it("falls back to sessionCwd when no `cd` is present", () => {
		const ctx = prepareBashContext("git push --force", "/home/me/repo");
		assert.equal(ctx.stringified.length, 1);
		assert.equal(ctx.stringified[0]?.cwd, "/home/me/repo");
		assert.equal(ctx.stringified[0]?.text, "git push --force");
	});
});

describe("evaluateBashRuleWithContext", () => {
	it("returns the same verdict as evaluateBashRule for the same inputs", () => {
		const commands = [
			"git push --force",
			"git push --force-with-lease",
			"ls -la",
			"sh -c 'git push --force'",
			"cd /tmp/A && git push --force",
			"echo 'git push --force'",
		];
		for (const cmd of commands) {
			const ctx = prepareBashContext(cmd, "/repo");
			const viaContext = evaluateBashRuleWithContext(NO_FORCE_PUSH, ctx);
			const viaOneShot = evaluateBashRule(NO_FORCE_PUSH, cmd, "/repo");
			assert.equal(
				viaContext,
				viaOneShot,
				`context vs one-shot disagree on: ${cmd}`,
			);
		}
	});

	it("evaluates multiple rules against a single prepared context", () => {
		const command = "cd /tmp/A && git push --force && cd /tmp/B && git commit --amend";
		const ctx = prepareBashContext(command, "/home/me");

		const noForcePush: Rule = { ...NO_FORCE_PUSH };
		const noAmend: Rule = {
			name: "no-amend",
			tool: "bash",
			field: "command",
			pattern: "\\bgit\\s+commit\\b.*--amend",
			reason: "no amend",
		};
		const noEcho: Rule = {
			name: "no-echo",
			tool: "bash",
			field: "command",
			pattern: "^echo\\b",
			reason: "no echo",
		};

		assert.equal(evaluateBashRuleWithContext(noForcePush, ctx), true);
		assert.equal(evaluateBashRuleWithContext(noAmend, ctx), true);
		assert.equal(evaluateBashRuleWithContext(noEcho, ctx), false);
	});

	it("honours per-ref effective cwd via when.cwd", () => {
		const command = "cd /tmp/A && git push --force && cd /tmp/B && git commit --amend";
		const ctx = prepareBashContext(command, "/home/me");

		const aOnly: Rule = {
			name: "push-in-A",
			tool: "bash",
			field: "command",
			pattern: "^git\\s+push",
			reason: "no push in A",
			when: { cwd: "^/tmp/A" },
		};
		const bOnly: Rule = {
			name: "amend-in-B",
			tool: "bash",
			field: "command",
			pattern: "^git\\s+commit\\b.*--amend",
			reason: "no amend in B",
			when: { cwd: "^/tmp/B" },
		};
		const cOnly: Rule = {
			name: "push-in-B",
			tool: "bash",
			field: "command",
			pattern: "^git\\s+push",
			reason: "no push in B",
			when: { cwd: "^/tmp/B" },
		};

		assert.equal(evaluateBashRuleWithContext(aOnly, ctx), true);
		assert.equal(evaluateBashRuleWithContext(bOnly, ctx), true);
		assert.equal(evaluateBashRuleWithContext(cOnly, ctx), false);
	});

	it("returns false for non-bash rules without touching the context", () => {
		const ctx = prepareBashContext("git push --force", "/repo");
		const writeRule: Rule = {
			name: "no-secrets",
			tool: "write",
			field: "content",
			pattern: "PRIVATE_KEY",
			reason: "no",
		};
		assert.equal(evaluateBashRuleWithContext(writeRule, ctx), false);
	});
});

describe("evaluateBashRule (one-shot backward-compat)", () => {
	// The one-shot function is the pre-optimisation entry point and must keep
	// working so external callers (tests, CLIs) aren't broken by the refactor.
	it("preserves the original (rule, command, sessionCwd) signature", () => {
		assert.equal(evaluateBashRule(NO_FORCE_PUSH, "git push --force", "/repo"), true);
		assert.equal(evaluateBashRule(NO_FORCE_PUSH, "git push", "/repo"), false);
		assert.equal(
			evaluateBashRule(NO_FORCE_PUSH, "sh -c 'git push --force'", "/repo"),
			true,
		);
	});

	it("honours per-command effective cwd end to end", () => {
		const rule: Rule = {
			name: "no-amend-in-personal",
			tool: "bash",
			field: "command",
			pattern: "\\bgit\\s+commit\\b.*--amend",
			reason: "no amend",
			when: { cwd: "/personal/" },
		};
		assert.equal(
			evaluateBashRule(rule, "cd /home/me/personal/x && git commit --amend", "/work"),
			true,
		);
		assert.equal(
			evaluateBashRule(rule, "cd /home/me/work/x && git commit --amend", "/work"),
			false,
		);
	});
});

describe("evaluateRule (write / edit)", () => {
	it("fires on write content matching the pattern", () => {
		const rule: Rule = {
			name: "no-private-key",
			tool: "write",
			field: "content",
			pattern: "BEGIN RSA PRIVATE KEY",
			reason: "no private keys in repo",
		};
		const input: ToolInput = {
			tool: "write",
			path: "/repo/key.pem",
			content: "-----BEGIN RSA PRIVATE KEY-----\n...",
		};
		assert.equal(evaluateRule(rule, input, { cwd: "/repo" }), true);
	});

	it("stays silent when write content does not match", () => {
		const rule: Rule = {
			name: "no-private-key",
			tool: "write",
			field: "content",
			pattern: "BEGIN RSA PRIVATE KEY",
			reason: "no",
		};
		const input: ToolInput = {
			tool: "write",
			path: "/repo/notes.md",
			content: "regular text",
		};
		assert.equal(evaluateRule(rule, input, { cwd: "/repo" }), false);
	});

	it("fires on write path when field=path", () => {
		const rule: Rule = {
			name: "no-node-modules-writes",
			tool: "write",
			field: "path",
			pattern: "/node_modules/",
			reason: "don't touch node_modules",
		};
		const input: ToolInput = {
			tool: "write",
			path: "/repo/node_modules/foo/index.js",
			content: "// patched",
		};
		assert.equal(evaluateRule(rule, input, { cwd: "/repo" }), true);
	});

	it("respects when.cwd for write", () => {
		const rule: Rule = {
			name: "no-secrets-prod",
			tool: "write",
			field: "content",
			pattern: "TODO",
			reason: "no TODOs in prod tree",
			when: { cwd: "/prod/" },
		};
		const input: ToolInput = { tool: "write", path: "x", content: "TODO later" };
		assert.equal(evaluateRule(rule, input, { cwd: "/repo/prod/api" }), true);
		assert.equal(evaluateRule(rule, input, { cwd: "/repo/staging/api" }), false);
	});

	it("fires on edit joined newText by default (field=content)", () => {
		const rule: Rule = {
			name: "no-console-log",
			tool: "edit",
			field: "content",
			pattern: "console\\.log",
			reason: "drop debug logging",
		};
		const input: ToolInput = {
			tool: "edit",
			path: "/repo/a.ts",
			edits: [
				{ oldText: "const x = 1;", newText: "const x = 1;\nconsole.log(x);" },
			],
		};
		assert.equal(evaluateRule(rule, input, { cwd: "/repo" }), true);
	});
});

describe("extractOverride", () => {
	it("extracts reason from a hash-leader override", () => {
		const r = extractOverride(
			"git push --force # steering-override: no-force-push \u2014 coordinated rewrite",
			"no-force-push",
		);
		assert.equal(r, "coordinated rewrite");
	});

	it("extracts reason from a slash-leader override", () => {
		const r = extractOverride(
			"// steering-override: no-console \u2014 debug session only",
			"no-console",
		);
		assert.equal(r, "debug session only");
	});

	it("accepts em dash, en dash, and hyphen as separators", () => {
		assert.equal(
			extractOverride("# steering-override: r \u2014 em", "r"),
			"em",
		);
		assert.equal(
			extractOverride("# steering-override: r \u2013 en", "r"),
			"en",
		);
		assert.equal(
			extractOverride("# steering-override: r - hyphen", "r"),
			"hyphen",
		);
	});

	it("returns null when no override is present", () => {
		assert.equal(extractOverride("git push --force", "no-force-push"), null);
	});

	it("returns null when the override targets a different rule", () => {
		const r = extractOverride(
			"# steering-override: other-rule \u2014 reason",
			"no-force-push",
		);
		assert.equal(r, null);
	});

	it("returns null when reason is empty", () => {
		const r = extractOverride("# steering-override: r \u2014   ", "r");
		assert.equal(r, null);
	});

	it("stacked overrides: looking up first rule returns its reason only", () => {
		const text =
			"cmd # steering-override: rule-a \u2014 reason-a # steering-override: rule-b \u2014 reason-b";
		assert.equal(extractOverride(text, "rule-a"), "reason-a");
	});

	it("stacked overrides: looking up second rule returns its reason only", () => {
		const text =
			"cmd # steering-override: rule-a \u2014 reason-a # steering-override: rule-b \u2014 reason-b";
		assert.equal(extractOverride(text, "rule-b"), "reason-b");
	});

	it("stacked overrides: unrelated lookup returns null (no bleed from either)", () => {
		const text =
			"cmd # steering-override: rule-a \u2014 reason-a # steering-override: rule-b \u2014 reason-b";
		assert.equal(extractOverride(text, "rule-c"), null);
	});

	it("stacked overrides: empty reason on first is skipped, scanner finds second match for same rule", () => {
		// First `foo` override has no reason (whitespace only). The scanner
		// must keep going and surface the second `foo` override's reason.
		const text =
			"# steering-override: foo \u2014   # steering-override: foo \u2014 actual reason";
		assert.equal(extractOverride(text, "foo"), "actual reason");
	});
});

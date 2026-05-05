// SPDX-License-Identifier: MIT
// Part of @cad0p/pi-steering-hooks.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	effectiveCwd,
	expandWrapperCommands,
	extractAllCommandsFromAST,
	getBasename,
	getCommandArgs,
	parse as parseBash,
} from "unbash-walker";
import {
	evaluateRule,
	evaluateRuleForCommand,
	extractOverride,
	type ToolInput,
} from "./evaluator.ts";
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

	it("respects cwdPattern (fires only when cwd matches)", () => {
		const rule: Rule = {
			...NO_FORCE_PUSH,
			name: "no-force-push-personal",
			cwdPattern: "/personal/",
		};
		assert.equal(fires(rule, "git push --force", "/home/me/personal/proj"), true);
		assert.equal(fires(rule, "git push --force", "/home/me/work/proj"), false);
	});

	it("cwdPattern sees the per-command effective cwd (cd X && cmd)", () => {
		const rule: Rule = {
			name: "no-amend-in-personal",
			tool: "bash",
			field: "command",
			pattern: "\\bgit\\s+commit\\b.*--amend",
			reason: "don't amend in personal repos",
			cwdPattern: "/personal/",
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

	it("respects cwdPattern for write", () => {
		const rule: Rule = {
			name: "no-secrets-prod",
			tool: "write",
			field: "content",
			pattern: "TODO",
			reason: "no TODOs in prod tree",
			cwdPattern: "/prod/",
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
});

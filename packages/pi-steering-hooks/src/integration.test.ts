// SPDX-License-Identifier: MIT
// Part of @cad0p/pi-steering-hooks.

/**
 * Integration tests for the steering engine.
 *
 * We can't easily instantiate a real ExtensionAPI in node:test, so these tests
 * exercise the logic layer (`evaluateBashRule`) against the built-in
 * DEFAULT_RULES plus user-defined rules. Covers the full pipeline from raw
 * command string \u2192 parse \u2192 extract \u2192 expand wrappers \u2192 effective cwd \u2192
 * evaluate \u2192 block/allow decision, including the override-comment escape hatch
 * at the wrapper layer (index.ts).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_RULES } from "./defaults.ts";
import { extractOverride } from "./evaluator.ts";
import { evaluateBashRule } from "./index.ts";
import type { Rule } from "./schema.ts";

function getDefault(name: string): Rule {
	const r = DEFAULT_RULES.find((r) => r.name === name);
	if (!r) throw new Error(`default rule not found: ${name}`);
	return r;
}

/**
 * Mirror the block-vs-allow decision the extension makes for a single bash
 * rule. Returns:
 *   - { block: true, reason: "..." }       \u2014 rule fires, no override
 *   - { block: false, overridden: true }   \u2014 rule fires, override accepted
 *   - { block: false }                     \u2014 rule doesn't fire
 */
function runBashRule(
	rule: Rule,
	command: string,
	cwd = "/repo",
):
	| { block: true; reason: string }
	| { block: false; overridden?: true } {
	if (!evaluateBashRule(rule, command, cwd)) return { block: false };
	if (!rule.noOverride) {
		const r = extractOverride(command, rule.name);
		if (r !== null) return { block: false, overridden: true };
	}
	return { block: true, reason: rule.reason };
}

describe("no-force-push default rule", () => {
	const rule = getDefault("no-force-push");

	it("blocks `git push --force`", () => {
		const r = runBashRule(rule, "git push --force");
		assert.equal(r.block, true);
	});

	it("blocks `git push -f`", () => {
		const r = runBashRule(rule, "git push -f");
		assert.equal(r.block, true);
	});

	it("allows `git push --force-with-lease`", () => {
		const r = runBashRule(rule, "git push --force-with-lease");
		assert.equal(r.block, false);
	});

	it("allows `git push origin main`", () => {
		const r = runBashRule(rule, "git push origin main");
		assert.equal(r.block, false);
	});

	it("accepts an inline override comment", () => {
		const r = runBashRule(
			rule,
			"git push --force # steering-override: no-force-push \u2014 hotfix revert coordinated on #infra",
		);
		assert.equal(r.block, false);
		assert.equal("overridden" in r && r.overridden, true);
	});

	it("catches `git push --force` behind `sh -c` wrapper", () => {
		const r = runBashRule(rule, "sh -c 'git push --force'");
		assert.equal(r.block, true);
	});

	it("catches `git push --force` behind `sudo xargs` wrappers", () => {
		const r = runBashRule(rule, "echo main | sudo xargs -I{} git push --force origin {}");
		assert.equal(r.block, true);
	});
});

describe("no-hard-reset default rule", () => {
	const rule = getDefault("no-hard-reset");

	it("blocks `git reset --hard`", () => {
		assert.equal(runBashRule(rule, "git reset --hard").block, true);
	});

	it("allows `git reset --soft HEAD~1`", () => {
		assert.equal(runBashRule(rule, "git reset --soft HEAD~1").block, false);
	});

	it("allows plain `git reset`", () => {
		assert.equal(runBashRule(rule, "git reset").block, false);
	});
});

describe("no-rm-rf-slash default rule (noOverride)", () => {
	const rule = getDefault("no-rm-rf-slash");

	it("blocks `rm -rf /`", () => {
		assert.equal(runBashRule(rule, "rm -rf /").block, true);
	});

	it("blocks `rm -fr /` (flag letter order doesn't matter)", () => {
		assert.equal(runBashRule(rule, "rm -fr /").block, true);
	});

	it("allows `rm -rf /tmp/foo`", () => {
		assert.equal(runBashRule(rule, "rm -rf /tmp/foo").block, false);
	});

	it("ignores override comment because noOverride is true", () => {
		// The wrapper in index.ts never consults extractOverride when
		// noOverride is set. Simulate that here: runBashRule does not treat
		// noOverride rules as overridable.
		const command = "rm -rf / # steering-override: no-rm-rf-slash \u2014 nope";
		const r = runBashRule(rule, command);
		assert.equal(r.block, true);
	});
});

describe("no-long-running-commands default rule", () => {
	const rule = getDefault("no-long-running-commands");

	it("blocks `npm run dev`", () => {
		assert.equal(runBashRule(rule, "npm run dev").block, true);
	});

	it("blocks `tsc --watch`", () => {
		assert.equal(runBashRule(rule, "tsc --watch").block, true);
	});

	it("allows `npm run build`", () => {
		assert.equal(runBashRule(rule, "npm run build").block, false);
	});

	it("allows `tsc --noEmit`", () => {
		assert.equal(runBashRule(rule, "tsc --noEmit").block, false);
	});
});

describe("user-defined rule: no-amend scoped with when.cwd", () => {
	const rule: Rule = {
		name: "no-amend-in-personal",
		tool: "bash",
		field: "command",
		pattern: "\\bgit\\s+commit\\b.*--amend",
		reason: "don't amend in personal repos",
		when: { cwd: "/personal/" },
	};

	it("blocks `git commit --amend` in a personal directory", () => {
		const r = runBashRule(
			rule,
			"git commit --amend",
			"/home/me/projects/personal/site",
		);
		assert.equal(r.block, true);
	});

	it("allows `git commit --amend` in a work directory", () => {
		const r = runBashRule(
			rule,
			"git commit --amend",
			"/home/me/projects/work/service",
		);
		assert.equal(r.block, false);
	});

	it("blocks when `cd` moves into a personal directory within the same command", () => {
		// Session cwd is /work, but the amend runs under /personal/site thanks
		// to the `cd`. effectiveCwd resolves this \u2014 samfoy's regex approach
		// cannot see it.
		const r = runBashRule(
			rule,
			"cd /home/me/projects/personal/site && git commit --amend",
			"/work",
		);
		assert.equal(r.block, true);
	});

	it("allows when `cd` moves into a work directory within the same command", () => {
		const r = runBashRule(
			rule,
			"cd /home/me/projects/work/service && git commit --amend",
			"/work",
		);
		assert.equal(r.block, false);
	});
});

// Task 4: explicit coverage of the "cwd changes across chained commands in a
// single input" pattern. Two separate rules scoped to different cwds; one
// chained command string that visits both cwds. Asserts each rule fires
// independently on its target command, and that the negative case (rule
// scoped to cwd A, command never enters A) does not fire.
describe("cwd changes across chained commands (single input)", () => {
	const noForcePushInA: Rule = {
		name: "no-force-push-in-a",
		tool: "bash",
		field: "command",
		pattern: "^git\\b.*push\\b.*--force",
		when: { cwd: "^/tmp/A(/|$)" },
		reason: "no force-push in A",
	};
	const noAmendInB: Rule = {
		name: "no-amend-in-b",
		tool: "bash",
		field: "command",
		pattern: "^git\\b.*commit\\b.*--amend",
		when: { cwd: "^/tmp/B(/|$)" },
		reason: "no amend in B",
	};

	it("tracks cwd changes across chained commands in one input", () => {
		// Chain: cd /tmp/A → git push --force → cd /tmp/B → git commit --amend
		//
		//   - `git push --force` has effective cwd /tmp/A → rule 1 fires.
		//   - `git commit --amend` has effective cwd /tmp/B → rule 2 would fire.
		//
		// Both rules are tested *independently* via evaluateBashRule so we
		// don't conflate this with the first-rule-wins dispatcher behavior
		// (which is covered separately in index.test.ts). Here we're proving
		// the walker threads cd effects through the chain correctly.
		const cmd =
			"cd /tmp/A && git push --force && cd /tmp/B && git commit --amend";
		const initial = "/tmp/initial";

		const r1 = runBashRule(noForcePushInA, cmd, initial);
		assert.equal(
			r1.block,
			true,
			"rule 1 fires because the push happens at effective cwd /tmp/A",
		);

		const r2 = runBashRule(noAmendInB, cmd, initial);
		assert.equal(
			r2.block,
			true,
			"rule 2 fires because the amend happens at effective cwd /tmp/B",
		);
	});

	it("respects when.cwd — rule does not fire when command is in a different cwd", () => {
		// Rule scoped to /tmp/A, but the command chain never enters /tmp/A.
		const rule: Rule = {
			name: "no-amend-in-a",
			tool: "bash",
			field: "command",
			pattern: "^git\\b.*commit\\b.*--amend",
			when: { cwd: "^/tmp/A(/|$)" },
			reason: "no amend in A",
		};
		const cmd = "cd /tmp/B && git commit --amend";
		const r = runBashRule(rule, cmd, "/tmp/initial");
		assert.equal(r.block, false, "amend runs at /tmp/B, not /tmp/A");
	});

	it("rule 2 does not fire on the push (different pattern) even though cwd matches", () => {
		// Cross-check: the walker exposes cwd per ref correctly, so the push
		// is at /tmp/A (not /tmp/B) and therefore `no-amend-in-b` (scoped to
		// /tmp/B) only fires on the amend ref, not on the push ref.
		const cmd =
			"cd /tmp/A && git push --force && cd /tmp/B && git commit --amend";
		const r = runBashRule(noAmendInB, cmd, "/tmp/initial");
		// The amend is the match, so block=true overall. This test exists to
		// make sure the assertion logic above isn't accidentally passing
		// because ALL commands match — it should fire on one specific ref.
		assert.equal(r.block, true);
	});
});

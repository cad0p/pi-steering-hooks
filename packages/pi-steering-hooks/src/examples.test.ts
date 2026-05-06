// SPDX-License-Identifier: MIT
// Part of @cad0p/pi-steering-hooks.

/**
 * Smoke tests for the shipped rule packs under `examples/`.
 *
 * Each example's `steering.json` is loaded from disk as the authoritative
 * source, so these tests would break if the committed JSON drifts from the
 * documented behaviour in the accompanying README. That's by design — the
 * tests double as a spec for the examples directory.
 *
 * Structure: one `describe` per example. Each example exercises its rules
 * against a handful of realistic inputs covering both the expected fire
 * cases and a few silent-cases (to catch accidental over-match).
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { DEFAULT_RULES } from "./defaults.ts";
import type { SteeringConfig } from "./schema.ts";
import { evaluateBashRule } from "./index.ts";
import { buildRules } from "./loader.ts";

const here = dirname(fileURLToPath(import.meta.url));
const EXAMPLES_DIR = join(here, "..", "examples");

function loadExample(name: string, file = "steering.json"): SteeringConfig {
	const raw = readFileSync(join(EXAMPLES_DIR, name, file), "utf8");
	return JSON.parse(raw) as SteeringConfig;
}

/**
 * Build the effective rule list for an example exactly as the loader would:
 * defaults + this one config layer (no global, no ancestors). Lets a test
 * say "does the combined effect of defaults + this example produce the
 * expected firing behaviour?".
 */
function rulesFor(example: string, file = "steering.json") {
	const cfg = loadExample(example, file);
	return buildRules([cfg], DEFAULT_RULES);
}

function getRule(name: string, rules: ReturnType<typeof rulesFor>) {
	const r = rules.find((r) => r.name === name);
	if (!r) throw new Error(`rule ${name} not present after merge`);
	return r;
}

describe("examples/force-push-strict", () => {
	const rules = rulesFor("force-push-strict");

	it("disables the default no-force-push rule", () => {
		assert.equal(rules.find((r) => r.name === "no-force-push"), undefined);
	});

	it("installs no-force-push-strict", () => {
		assert.ok(rules.find((r) => r.name === "no-force-push-strict"));
	});

	const rule = () => getRule("no-force-push-strict", rules);

	it("blocks `git push --force`", () => {
		assert.equal(evaluateBashRule(rule(), "git push --force", "/repo"), true);
	});

	it("blocks `git push --force-with-lease` (differs from default)", () => {
		assert.equal(
			evaluateBashRule(rule(), "git push --force-with-lease", "/repo"),
			true,
		);
	});

	it("blocks `git push -f origin`", () => {
		assert.equal(evaluateBashRule(rule(), "git push -f origin", "/repo"), true);
	});

	it("allows `git push origin main` (plain push)", () => {
		assert.equal(
			evaluateBashRule(rule(), "git push origin main", "/repo"),
			false,
		);
	});

	it("catches `git push --force-with-lease` through sh -c", () => {
		// Extra check that swapping the default for the stricter rule keeps
		// the AST backend's wrapper-expansion semantics.
		assert.equal(
			evaluateBashRule(rule(), "sh -c 'git push --force-with-lease'", "/repo"),
			true,
		);
	});
});

describe("examples/no-amend", () => {
	const rules = rulesFor("no-amend");
	const rule = () => getRule("no-amend", rules);

	it("installs no-amend alongside the defaults", () => {
		assert.ok(rules.find((r) => r.name === "no-amend"));
		// Defaults should still be present — this example doesn't disable anything.
		assert.ok(rules.find((r) => r.name === "no-force-push"));
	});

	it("blocks `git commit --amend`", () => {
		assert.equal(evaluateBashRule(rule(), "git commit --amend", "/repo"), true);
	});

	it("blocks `git commit --amend -m fix`", () => {
		assert.equal(
			evaluateBashRule(rule(), "git commit --amend -m fix", "/repo"),
			true,
		);
	});

	it("allows `git commit -m msg`", () => {
		assert.equal(
			evaluateBashRule(rule(), 'git commit -m "msg"', "/repo"),
			false,
		);
	});

	it("blocks `git -C /other commit --amend` (handles git pre-subcommand flags)", () => {
		assert.equal(
			evaluateBashRule(rule(), "git -C /other commit --amend", "/repo"),
			true,
		);
	});
});

describe("examples/no-amend (cwd-scoped variant)", () => {
	const rules = rulesFor("no-amend", "steering.cwd-scoped.json");
	const rule = () => getRule("no-amend-in-personal", rules);

	it("blocks `git commit --amend` inside the cwdPattern tree", () => {
		assert.equal(
			evaluateBashRule(
				rule(),
				"git commit --amend",
				"/home/me/projects/personal/site",
			),
			true,
		);
	});

	it("allows `git commit --amend` outside the cwdPattern tree", () => {
		assert.equal(
			evaluateBashRule(
				rule(),
				"git commit --amend",
				"/home/me/projects/work/service",
			),
			false,
		);
	});

	it("blocks when `cd` walks the effective cwd into the scoped tree", () => {
		// Session cwd is elsewhere, but the amend runs under the personal tree
		// thanks to the &&-joined cd. This is the case the AST backend exists
		// to catch.
		assert.equal(
			evaluateBashRule(
				rule(),
				"cd /home/me/projects/personal/site && git commit --amend",
				"/tmp",
			),
			true,
		);
	});
});

describe("examples/draft-prs-only", () => {
	const rules = rulesFor("draft-prs-only");
	const rule = () => getRule("pr-create-must-be-draft", rules);

	it("blocks `gh pr create --title …` without --draft", () => {
		assert.equal(
			evaluateBashRule(rule(), 'gh pr create --title "feat: x"', "/repo"),
			true,
		);
	});

	it("allows `gh pr create --draft --title …` (unless exempts)", () => {
		assert.equal(
			evaluateBashRule(
				rule(),
				'gh pr create --draft --title "feat: x"',
				"/repo",
			),
			false,
		);
	});

	it("allows `gh pr ready 42` (different subcommand, pattern doesn't match)", () => {
		assert.equal(evaluateBashRule(rule(), "gh pr ready 42", "/repo"), false);
	});

	it("allows `gh pr list`", () => {
		assert.equal(evaluateBashRule(rule(), "gh pr list", "/repo"), false);
	});
});

describe("examples/combined-git-discipline", () => {
	const rules = rulesFor("combined-git-discipline");

	it("disables the default no-force-push in favour of the stricter rule", () => {
		assert.equal(rules.find((r) => r.name === "no-force-push"), undefined);
		assert.ok(rules.find((r) => r.name === "no-force-push-strict"));
	});

	it("retains the upstream safety defaults that it doesn't disable", () => {
		// These three come straight from DEFAULT_RULES.
		assert.ok(rules.find((r) => r.name === "no-hard-reset"));
		assert.ok(rules.find((r) => r.name === "no-rm-rf-slash"));
		assert.ok(rules.find((r) => r.name === "no-long-running-commands"));
	});

	it("blocks `git push --force-with-lease` via the strict rule", () => {
		const rule = getRule("no-force-push-strict", rules);
		assert.equal(
			evaluateBashRule(rule, "git push --force-with-lease", "/repo"),
			true,
		);
	});

	it("blocks `git commit --amend` via no-amend", () => {
		const rule = getRule("no-amend", rules);
		assert.equal(evaluateBashRule(rule, "git commit --amend", "/repo"), true);
	});

	it("blocks `gh pr create` without --draft", () => {
		const rule = getRule("pr-create-must-be-draft", rules);
		assert.equal(
			evaluateBashRule(rule, 'gh pr create --title "x"', "/repo"),
			true,
		);
	});

	it("still blocks `git reset --hard HEAD` via the retained default", () => {
		const rule = getRule("no-hard-reset", rules);
		assert.equal(
			evaluateBashRule(rule, "git reset --hard HEAD", "/repo"),
			true,
		);
	});

	it("still blocks `rm -rf /` via the retained default", () => {
		const rule = getRule("no-rm-rf-slash", rules);
		assert.equal(evaluateBashRule(rule, "rm -rf /", "/repo"), true);
	});
});

// SPDX-License-Identifier: MIT
// Part of @cad0p/pi-steering-hooks.

/**
 * Invariants for DEFAULT_RULES. These guard against accidental edits that
 * would change the public safety contract — every default rule must have
 * a non-empty name/pattern/reason, a valid regex, and `no-rm-rf-slash`
 * must stay un-overridable.
 *
 * Pattern semantics (what each default matches / doesn't match) are
 * spot-checked here with raw `new RegExp(...)` .test() calls rather than
 * going through the evaluator, so a pattern typo surfaces as a
 * defaults.test failure (not an integration-test failure halfway across
 * the suite).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_RULES } from "./defaults.ts";

describe("DEFAULT_RULES shape", () => {
	it("has the expected rule count (four)", () => {
		// Locking the count keeps additions/removals a deliberate, reviewed edit.
		assert.equal(DEFAULT_RULES.length, 4);
	});

	it("has unique rule names", () => {
		const names = DEFAULT_RULES.map((r) => r.name);
		assert.equal(new Set(names).size, names.length);
	});

	it("every rule has non-empty name, pattern, reason", () => {
		for (const r of DEFAULT_RULES) {
			assert.ok(r.name.length > 0, `empty name: ${JSON.stringify(r)}`);
			assert.ok(r.pattern.length > 0, `empty pattern in ${r.name}`);
			assert.ok(r.reason.length > 0, `empty reason in ${r.name}`);
		}
	});

	it("every rule has a valid regex pattern (requires/unless too)", () => {
		for (const r of DEFAULT_RULES) {
			assert.doesNotThrow(() => new RegExp(r.pattern), `bad pattern in ${r.name}`);
			if (r.requires !== undefined) {
				assert.doesNotThrow(() => new RegExp(r.requires as string), `bad requires in ${r.name}`);
			}
			if (r.unless !== undefined) {
				assert.doesNotThrow(() => new RegExp(r.unless as string), `bad unless in ${r.name}`);
			}
		}
	});

	it("every default rule targets the bash tool (current scope)", () => {
		// If we ever add a write/edit default, this test should be updated
		// explicitly — keeps the scope of DEFAULT_RULES visible.
		for (const r of DEFAULT_RULES) {
			assert.equal(r.tool, "bash", `unexpected tool on ${r.name}: ${r.tool}`);
		}
	});

	it("no-rm-rf-slash carries noOverride: true", () => {
		const rule = DEFAULT_RULES.find((r) => r.name === "no-rm-rf-slash");
		assert.ok(rule, "no-rm-rf-slash not found in defaults");
		assert.equal(rule?.noOverride, true);
	});
});

describe("DEFAULT_RULES pattern spot-checks", () => {
	function pattern(name: string): RegExp {
		const r = DEFAULT_RULES.find((r) => r.name === name);
		if (!r) throw new Error(`default rule not found: ${name}`);
		return new RegExp(r.pattern);
	}

	it("no-force-push matches `git push --force`", () => {
		assert.equal(pattern("no-force-push").test("git push --force"), true);
	});

	it("no-force-push matches `git push -f`", () => {
		assert.equal(pattern("no-force-push").test("git push -f"), true);
	});

	it("no-force-push does NOT match `git push --force-with-lease`", () => {
		assert.equal(pattern("no-force-push").test("git push --force-with-lease"), false);
	});

	it("no-force-push does NOT match plain `git push origin main`", () => {
		assert.equal(pattern("no-force-push").test("git push origin main"), false);
	});

	it("no-force-push matches `git push origin main --force`", () => {
		assert.equal(
			pattern("no-force-push").test("git push origin main --force"),
			true,
		);
	});

	it("no-force-push matches `git -C /other push --force` (pre-subcommand flag)", () => {
		assert.equal(
			pattern("no-force-push").test("git -C /other push --force"),
			true,
		);
	});

	it("no-force-push matches `git -c rerere.enabled=false push --force` (key=val config)", () => {
		assert.equal(
			pattern("no-force-push").test(
				"git -c rerere.enabled=false push --force",
			),
			true,
		);
	});

	it("no-force-push matches `git --git-dir=/path push --force` (long-form pre-subcommand)", () => {
		assert.equal(
			pattern("no-force-push").test("git --git-dir=/path push --force"),
			true,
		);
	});

	it("no-force-push matches `git push --force-bar` (other --force-* suffix, accepted over-match)", () => {
		assert.equal(
			pattern("no-force-push").test("git push --force-bar"),
			true,
		);
	});

	it("no-hard-reset matches `git reset --hard`", () => {
		assert.equal(pattern("no-hard-reset").test("git reset --hard"), true);
	});

	it("no-hard-reset matches `git reset --hard HEAD`", () => {
		assert.equal(pattern("no-hard-reset").test("git reset --hard HEAD"), true);
	});

	it("no-hard-reset does NOT match `git reset --soft`", () => {
		assert.equal(pattern("no-hard-reset").test("git reset --soft HEAD~1"), false);
	});

	it("no-hard-reset matches `git -C /other reset --hard` (pre-subcommand flag)", () => {
		assert.equal(
			pattern("no-hard-reset").test("git -C /other reset --hard"),
			true,
		);
	});

	it("no-hard-reset matches `git -c rerere.enabled=false reset --hard` (key=val config)", () => {
		assert.equal(
			pattern("no-hard-reset").test(
				"git -c rerere.enabled=false reset --hard",
			),
			true,
		);
	});

	it("no-rm-rf-slash matches `rm -rf /`", () => {
		assert.equal(pattern("no-rm-rf-slash").test("rm -rf /"), true);
	});

	it("no-rm-rf-slash matches `rm -fr /` (flag order agnostic)", () => {
		assert.equal(pattern("no-rm-rf-slash").test("rm -fr /"), true);
	});

	it("no-rm-rf-slash matches `rm -r -f /` (separated flags)", () => {
		assert.equal(pattern("no-rm-rf-slash").test("rm -r -f /"), true);
	});

	it("no-rm-rf-slash matches `rm --recursive --force /` (long-form flags)", () => {
		assert.equal(
			pattern("no-rm-rf-slash").test("rm --recursive --force /"),
			true,
		);
	});

	it("no-rm-rf-slash matches `rm -Rf /` (uppercase R)", () => {
		assert.equal(pattern("no-rm-rf-slash").test("rm -Rf /"), true);
	});

	it("no-rm-rf-slash does NOT match `rm -rf /tmp`", () => {
		assert.equal(pattern("no-rm-rf-slash").test("rm -rf /tmp"), false);
	});

	it("no-rm-rf-slash does NOT match `rm /tmp` (no flags)", () => {
		assert.equal(pattern("no-rm-rf-slash").test("rm /tmp"), false);
	});

	it("no-rm-rf-slash does NOT match `rm -r /tmp` (missing force flag)", () => {
		assert.equal(pattern("no-rm-rf-slash").test("rm -r /tmp"), false);
	});

	it("no-rm-rf-slash does NOT match `rm -f /` (missing recursive flag)", () => {
		assert.equal(pattern("no-rm-rf-slash").test("rm -f /"), false);
	});

	it("no-rm-rf-slash does NOT match `rm -rf .`", () => {
		assert.equal(pattern("no-rm-rf-slash").test("rm -rf ."), false);
	});

	it("no-long-running-commands matches `npm run dev`", () => {
		assert.equal(pattern("no-long-running-commands").test("npm run dev"), true);
	});

	it("no-long-running-commands matches `tsc --watch`", () => {
		assert.equal(pattern("no-long-running-commands").test("tsc --watch"), true);
	});

	it("no-long-running-commands does NOT match `npm run build`", () => {
		assert.equal(pattern("no-long-running-commands").test("npm run build"), false);
	});
});

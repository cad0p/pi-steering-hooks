// SPDX-License-Identifier: MIT
// Part of pi-steering.

/**
 * Invariants for v2 DEFAULT_RULES. Ported from v1's `../defaults.test.ts`
 * with ZERO semantic drift — the patterns are byte-for-byte identical
 * and the spot-check cases match v1's exact expectations. If a case
 * here flips vs. its v1 counterpart, the pattern drifted and the port
 * is broken.
 *
 * Two suites:
 *
 *   - Shape invariants (count, uniqueness, non-empty fields, valid
 *     regex) — guards against accidental edits to the default safety
 *     contract.
 *   - Pattern spot-checks — assert raw `new RegExp(...)` behavior for
 *     each default. Keeps pattern typos visible as defaults-test
 *     failures, not as evaluator-test noise.
 *
 * We also smoke-drive {@link buildEvaluator} with ONLY {@link
 * DEFAULT_RULES} + {@link DEFAULT_PLUGINS} on a handful of
 * representative commands, so the end-to-end path (load → merge →
 * parse → walk → evaluate) sees the same verdicts the regex tests
 * predict. This is the regression fence v1's
 * `integration.test.ts` / `examples.test.ts` used to be.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { BashToolCallEvent } from "@earendil-works/pi-coding-agent";
import { DEFAULT_PLUGINS, DEFAULT_RULES } from "./defaults.ts";
import { buildEvaluator } from "./evaluator.ts";
import { resolvePlugins } from "./plugin-merger.ts";
import {
	makeCtx,
	makeTrackedHost as makeHost,
} from "./__test-helpers__.ts";

// ---------------------------------------------------------------------------
// Shape invariants
// ---------------------------------------------------------------------------

describe("v2/defaults: DEFAULT_RULES shape", () => {
	it("has the expected rule count (four)", () => {
		// Locking the count keeps additions/removals a deliberate,
		// reviewed edit.
		assert.equal(DEFAULT_RULES.length, 4);
	});

	it("has unique rule names", () => {
		const names = DEFAULT_RULES.map((r) => r.name);
		assert.equal(new Set(names).size, names.length);
	});

	it("every rule has non-empty name, pattern, reason", () => {
		for (const r of DEFAULT_RULES) {
			assert.ok(r.name.length > 0, `empty name: ${JSON.stringify(r)}`);
			const patternLen =
				typeof r.pattern === "string"
					? r.pattern.length
					: r.pattern.source.length;
			assert.ok(patternLen > 0, `empty pattern in ${r.name}`);
			assert.ok(r.reason.length > 0, `empty reason in ${r.name}`);
		}
	});

	it("every rule has a valid regex pattern (requires/unless too)", () => {
		for (const r of DEFAULT_RULES) {
			if (typeof r.pattern === "string") {
				assert.doesNotThrow(
					() => new RegExp(r.pattern as string),
					`bad pattern in ${r.name}`,
				);
			}
			if (r.requires !== undefined && typeof r.requires === "string") {
				assert.doesNotThrow(
					() => new RegExp(r.requires as string),
					`bad requires in ${r.name}`,
				);
			}
			if (r.unless !== undefined && typeof r.unless === "string") {
				assert.doesNotThrow(
					() => new RegExp(r.unless as string),
					`bad unless in ${r.name}`,
				);
			}
		}
	});

	it("every default rule targets the bash tool (current scope)", () => {
		// If we ever add a write/edit default, this test should be
		// updated explicitly — keeps the scope of DEFAULT_RULES visible.
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

describe("v2/defaults: DEFAULT_PLUGINS shape", () => {
	it("is empty by default (Phase 3 ships no built-in plugins)", () => {
		// Phase 4 will add the git plugin. When that lands this test flips
		// to assert the expected plugin list — keeping a count lock so the
		// ship-surface stays deliberate.
		assert.deepEqual(DEFAULT_PLUGINS, []);
	});
});

// ---------------------------------------------------------------------------
// Pattern spot-checks
// ---------------------------------------------------------------------------

describe("v2/defaults: DEFAULT_RULES pattern spot-checks", () => {
	function pattern(name: string): RegExp {
		const r = DEFAULT_RULES.find((r) => r.name === name);
		if (!r) throw new Error(`default rule not found: ${name}`);
		// Defaults are authored as string patterns (see `./defaults.ts`);
		// compile to RegExp for assertion via `.test(...)`.
		if (typeof r.pattern !== "string") {
			throw new Error(
				`default rule ${name} uses RegExp pattern; update this helper`,
			);
		}
		return new RegExp(r.pattern);
	}

	it("no-force-push matches `git push --force`", () => {
		assert.equal(pattern("no-force-push").test("git push --force"), true);
	});

	it("no-force-push matches `git push -f`", () => {
		assert.equal(pattern("no-force-push").test("git push -f"), true);
	});

	it("no-force-push does NOT match `git push --force-with-lease`", () => {
		assert.equal(
			pattern("no-force-push").test("git push --force-with-lease"),
			false,
		);
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
		assert.equal(pattern("no-force-push").test("git push --force-bar"), true);
	});

	it("no-hard-reset matches `git reset --hard`", () => {
		assert.equal(pattern("no-hard-reset").test("git reset --hard"), true);
	});

	it("no-hard-reset matches `git reset --hard HEAD`", () => {
		assert.equal(pattern("no-hard-reset").test("git reset --hard HEAD"), true);
	});

	it("no-hard-reset does NOT match `git reset --soft`", () => {
		assert.equal(
			pattern("no-hard-reset").test("git reset --soft HEAD~1"),
			false,
		);
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
		assert.equal(
			pattern("no-long-running-commands").test("npm run build"),
			false,
		);
	});

	it("no-long-running-commands matches `pnpm dev`", () => {
		assert.equal(pattern("no-long-running-commands").test("pnpm dev"), true);
	});

	it("no-long-running-commands matches `pnpm run dev`", () => {
		assert.equal(pattern("no-long-running-commands").test("pnpm run dev"), true);
	});

	it("no-long-running-commands does NOT match `pnpm build`", () => {
		assert.equal(
			pattern("no-long-running-commands").test("pnpm build"),
			false,
		);
	});

	it("no-long-running-commands matches `vite` (bare = dev server)", () => {
		assert.equal(pattern("no-long-running-commands").test("vite"), true);
	});

	it("no-long-running-commands matches `vite dev`", () => {
		assert.equal(pattern("no-long-running-commands").test("vite dev"), true);
	});

	it("no-long-running-commands does NOT match `vite build`", () => {
		assert.equal(pattern("no-long-running-commands").test("vite build"), false);
	});

	it("no-long-running-commands matches `astro dev`", () => {
		assert.equal(pattern("no-long-running-commands").test("astro dev"), true);
	});

	it("no-long-running-commands does NOT match `astro build`", () => {
		assert.equal(
			pattern("no-long-running-commands").test("astro build"),
			false,
		);
	});

	it("no-long-running-commands matches `next dev`", () => {
		assert.equal(pattern("no-long-running-commands").test("next dev"), true);
	});

	it("no-long-running-commands does NOT match `next build`", () => {
		assert.equal(pattern("no-long-running-commands").test("next build"), false);
	});

	it("no-long-running-commands matches `deno task dev`", () => {
		assert.equal(
			pattern("no-long-running-commands").test("deno task dev"),
			true,
		);
	});

	it("no-long-running-commands does NOT match `deno task build`", () => {
		assert.equal(
			pattern("no-long-running-commands").test("deno task build"),
			false,
		);
	});

	it("no-long-running-commands matches `bun dev`", () => {
		assert.equal(pattern("no-long-running-commands").test("bun dev"), true);
	});

	it("no-long-running-commands matches `bun run dev`", () => {
		assert.equal(pattern("no-long-running-commands").test("bun run dev"), true);
	});

	it("no-long-running-commands does NOT match `bun install`", () => {
		assert.equal(
			pattern("no-long-running-commands").test("bun install"),
			false,
		);
	});
});

// ---------------------------------------------------------------------------
// End-to-end: DEFAULT_RULES through buildEvaluator
// ---------------------------------------------------------------------------

/**
 * Build an evaluator driven ONLY by {@link DEFAULT_RULES} +
 * {@link DEFAULT_PLUGINS} so the rules' effective behavior (including
 * the walker + wrapper expansion) gets end-to-end coverage. Everything
 * else (predicates, observers, user-rules) is already exercised in
 * `evaluator.test.ts`; this suite is the regression fence for the
 * shipped defaults.
 */
function defaultsEvaluator() {
	const resolved = resolvePlugins(DEFAULT_PLUGINS, {});
	return buildEvaluator({ rules: DEFAULT_RULES }, resolved, makeHost());
}

function bashEvent(command: string): BashToolCallEvent {
	return {
		type: "tool_call",
		toolCallId: "t1",
		toolName: "bash",
		input: { command },
	};
}

describe("v2/defaults: end-to-end via buildEvaluator", () => {
	it("blocks `git push --force`", async () => {
		const ev = defaultsEvaluator();
		const r = await ev.evaluate(bashEvent("git push --force"), makeCtx("/r"), 0);
		assert.equal((r as { block?: boolean } | undefined)?.block, true);
		assert.match(
			(r as { reason?: string } | undefined)?.reason ?? "",
			/no-force-push/,
		);
	});

	it("allows `git push --force-with-lease`", async () => {
		const ev = defaultsEvaluator();
		const r = await ev.evaluate(
			bashEvent("git push --force-with-lease"),
			makeCtx("/r"),
			0,
		);
		assert.equal(r, undefined);
	});

	it("catches `git push --force` behind `sh -c` wrapper", async () => {
		// The AST backend's wrapper-expansion sees the inner command even
		// behind sh/bash -c. Regex-on-raw would miss this — the whole
		// reason the walker exists.
		const ev = defaultsEvaluator();
		const r = await ev.evaluate(
			bashEvent("sh -c 'git push --force'"),
			makeCtx("/r"),
			0,
		);
		assert.equal((r as { block?: boolean } | undefined)?.block, true);
	});

	it("does NOT block `echo 'git push --force'` (basename is echo)", async () => {
		const ev = defaultsEvaluator();
		const r = await ev.evaluate(
			bashEvent("echo 'git push --force'"),
			makeCtx("/r"),
			0,
		);
		assert.equal(r, undefined);
	});

	it("blocks `git reset --hard HEAD`", async () => {
		const ev = defaultsEvaluator();
		const r = await ev.evaluate(
			bashEvent("git reset --hard HEAD"),
			makeCtx("/r"),
			0,
		);
		assert.equal((r as { block?: boolean } | undefined)?.block, true);
		assert.match(
			(r as { reason?: string } | undefined)?.reason ?? "",
			/no-hard-reset/,
		);
	});

	it("allows `git reset --soft HEAD~1`", async () => {
		const ev = defaultsEvaluator();
		const r = await ev.evaluate(
			bashEvent("git reset --soft HEAD~1"),
			makeCtx("/r"),
			0,
		);
		assert.equal(r, undefined);
	});

	it("blocks `rm -rf /` and ignores override (noOverride: true)", async () => {
		const ev = defaultsEvaluator();
		const r = await ev.evaluate(
			bashEvent("rm -rf / # steering-override: no-rm-rf-slash — nope"),
			makeCtx("/r"),
			0,
		);
		assert.equal((r as { block?: boolean } | undefined)?.block, true);
		assert.match(
			(r as { reason?: string } | undefined)?.reason ?? "",
			/no-rm-rf-slash/,
		);
		// noOverride rules should NOT advertise the "To override" hint,
		// because the rule has no override path.
		assert.doesNotMatch(
			(r as { reason?: string } | undefined)?.reason ?? "",
			/To override/,
		);
	});

	it("allows `rm -rf /tmp/foo` (safe path)", async () => {
		const ev = defaultsEvaluator();
		const r = await ev.evaluate(
			bashEvent("rm -rf /tmp/foo"),
			makeCtx("/r"),
			0,
		);
		assert.equal(r, undefined);
	});

	it("blocks `npm run dev`", async () => {
		const ev = defaultsEvaluator();
		const r = await ev.evaluate(bashEvent("npm run dev"), makeCtx("/r"), 0);
		assert.equal((r as { block?: boolean } | undefined)?.block, true);
		assert.match(
			(r as { reason?: string } | undefined)?.reason ?? "",
			/no-long-running-commands/,
		);
	});

	it("allows `npm run build`", async () => {
		const ev = defaultsEvaluator();
		const r = await ev.evaluate(
			bashEvent("npm run build"),
			makeCtx("/r"),
			0,
		);
		assert.equal(r, undefined);
	});
});

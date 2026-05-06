// SPDX-License-Identifier: MIT
// Part of @cad0p/pi-steering-hooks.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { buildRules, loadConfigs } from "./loader.ts";
import type { Rule, SteeringConfig } from "./schema.ts";

const DEMO_DEFAULT: Rule = {
	name: "default-rule",
	tool: "bash",
	field: "command",
	pattern: "demo",
	reason: "default reason",
};

function makeRule(overrides: Partial<Rule> & { name: string }): Rule {
	return {
		tool: "bash",
		field: "command",
		pattern: "x",
		reason: "r",
		...overrides,
	};
}

describe("loadConfigs", () => {
	let origHome: string | undefined;
	let tmpRoot: string;

	beforeEach(() => {
		origHome = process.env.HOME;
		tmpRoot = mkdtempSync(join(tmpdir(), "pi-steering-loader-"));
		// Point HOME at a scratch directory so the global baseline doesn't leak
		// into the test from the real user's config.
		process.env.HOME = tmpRoot;
	});

	afterEach(() => {
		if (origHome === undefined) delete process.env.HOME;
		else process.env.HOME = origHome;
		rmSync(tmpRoot, { recursive: true, force: true });
	});

	it("returns empty array when no configs exist anywhere in the walk", () => {
		const cwd = join(tmpRoot, "project", "nested");
		// No files written. HOME points at tmpRoot which has no .pi/agent/…
		// The walk still visits tmpRoot itself but finds nothing.
		const configs = loadConfigs(cwd);
		assert.deepEqual(configs, []);
	});

	it("includes the global baseline at $HOME/.pi/agent/steering.json", () => {
		const globalDir = join(tmpRoot, ".pi", "agent");
		mkdirSync(globalDir, { recursive: true });
		writeFileSync(
			join(globalDir, "steering.json"),
			JSON.stringify({ disable: ["default-rule"] }),
		);
		const configs = loadConfigs(tmpRoot);
		assert.equal(configs.length, 1);
		assert.deepEqual(configs[0]?.disable, ["default-rule"]);
	});

	it("collects ancestor configs outermost-first between $HOME and cwd", () => {
		const outer = join(tmpRoot, "a");
		const inner = join(tmpRoot, "a", "b");
		mkdirSync(join(outer, ".pi"), { recursive: true });
		mkdirSync(join(inner, ".pi"), { recursive: true });
		writeFileSync(
			join(outer, ".pi", "steering.json"),
			JSON.stringify({
				rules: [{ name: "outer", tool: "bash", field: "command", pattern: "o", reason: "o" }],
			}),
		);
		writeFileSync(
			join(inner, ".pi", "steering.json"),
			JSON.stringify({
				rules: [{ name: "inner", tool: "bash", field: "command", pattern: "i", reason: "i" }],
			}),
		);
		const configs = loadConfigs(inner);
		// tmpRoot (HOME) has no .pi/steering.json → global baseline not added. Walk
		// emits [tmpRoot, a, a/b] → reversed is still outermost-first at index 0.
		assert.equal(configs.length, 2);
		assert.equal(configs[0]?.rules?.[0]?.name, "outer");
		assert.equal(configs[1]?.rules?.[0]?.name, "inner");
	});

	it("handles a malformed .pi/steering.json without throwing", () => {
		const dir = join(tmpRoot, "bad");
		mkdirSync(join(dir, ".pi"), { recursive: true });
		writeFileSync(join(dir, ".pi", "steering.json"), "{ not valid json");
		const configs = loadConfigs(dir);
		// Malformed file yields {} (not dropped), so the walk length matches.
		assert.equal(configs.length, 1);
		assert.deepEqual(configs[0], {});
	});

	it("stops at $HOME and does not ascend into /", () => {
		const cwd = join(tmpRoot, "x");
		mkdirSync(cwd, { recursive: true });
		// Place a .pi/steering.json at tmpRoot (HOME) itself — must be collected.
		mkdirSync(join(tmpRoot, ".pi"), { recursive: true });
		writeFileSync(
			join(tmpRoot, ".pi", "steering.json"),
			JSON.stringify({
				rules: [{ name: "home", tool: "bash", field: "command", pattern: "h", reason: "h" }],
			}),
		);
		const configs = loadConfigs(cwd);
		assert.equal(configs.length, 1);
		assert.equal(configs[0]?.rules?.[0]?.name, "home");
	});

	it("ignores a legacy <cwd>/steering.json at an ancestor (reads only .pi/steering.json)", () => {
		// Pre-.pi-convention configs sat at the project root as a bare
		// `steering.json`. The loader now reads only `<ancestor>/.pi/steering.json`,
		// matching pi's project-local extension layout. A bare `steering.json`
		// at an ancestor must be ignored so the migration path is unambiguous:
		// users move the file to `.pi/steering.json` to keep it active.
		const dir = join(tmpRoot, "legacy");
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "steering.json"),
			JSON.stringify({
				rules: [{ name: "legacy-rule", tool: "bash", field: "command", pattern: "l", reason: "l" }],
			}),
		);
		const configs = loadConfigs(dir);
		// Neither HOME nor any ancestor has a `.pi/steering.json`; the legacy
		// file at `<dir>/steering.json` is silently ignored.
		assert.deepEqual(configs, []);
	});

	it("walks up toward filesystem root when cwd is outside $HOME", () => {
		// When the session cwd lives outside $HOME (e.g. /var/project/sub on a
		// shared server), the walker keeps going past $HOME up to `/`. Lock
		// that behavior in so a future change can't silently truncate it.
		const outsideRoot = mkdtempSync(
			join(tmpdir(), "pi-steering-walkup-outside-"),
		);
		const nested = join(outsideRoot, "project", "sub");
		mkdirSync(nested, { recursive: true });
		// .pi/steering.json sits at the outside-HOME tmpdir root.
		mkdirSync(join(outsideRoot, ".pi"), { recursive: true });
		writeFileSync(
			join(outsideRoot, ".pi", "steering.json"),
			JSON.stringify({
				rules: [
					{
						name: "outside-home",
						tool: "bash",
						field: "command",
						pattern: "o",
						reason: "o",
					},
				],
			}),
		);

		// Point HOME at an unrelated tmp dir so the walk can't short-circuit on
		// it. The `beforeEach` already reset HOME to `tmpRoot`; we swap to a
		// sibling here so neither ancestor nor descendant of `nested`.
		const unrelatedHome = mkdtempSync(
			join(tmpdir(), "pi-steering-walkup-home-"),
		);
		process.env.HOME = unrelatedHome;

		try {
			const configs = loadConfigs(nested);
			const names = configs
				.flatMap((c) => c.rules ?? [])
				.map((r) => r.name);
			assert.ok(
				names.includes("outside-home"),
				`expected walk to reach outsideRoot\u2019s .pi/steering.json; got names=${names.join(",")}`,
			);
		} finally {
			rmSync(outsideRoot, { recursive: true, force: true });
			rmSync(unrelatedHome, { recursive: true, force: true });
			// `afterEach` will restore HOME to its original value. We explicitly
			// reset to `tmpRoot` here so the assertion above doesn\u2019t leak an
			// unrelated HOME into any subsequent teardown logging.
			process.env.HOME = tmpRoot;
		}
	});
});

describe("buildRules", () => {
	it("returns defaults unchanged when configs is empty", () => {
		const out = buildRules([], [DEMO_DEFAULT]);
		assert.deepEqual(out.rules, [DEMO_DEFAULT]);
		assert.equal(
			out.defaultNoOverride,
			false,
			"no layer set defaultNoOverride \u2192 implicit false (backward-compat)",
		);
	});

	it("inner layer overrides a rule by name", () => {
		const outer: SteeringConfig = {
			rules: [makeRule({ name: "shared", reason: "outer" })],
		};
		const inner: SteeringConfig = {
			rules: [makeRule({ name: "shared", reason: "inner" })],
		};
		const out = buildRules([outer, inner], []);
		assert.equal(out.rules.length, 1);
		assert.equal(out.rules[0]?.reason, "inner");
	});

	it("inner layer can disable a default rule", () => {
		const inner: SteeringConfig = { disable: ["default-rule"] };
		const out = buildRules([inner], [DEMO_DEFAULT]);
		assert.deepEqual(out.rules, []);
	});

	it("disable is additive \u2014 once disabled, later layer cannot re-enable by omission", () => {
		const outer: SteeringConfig = { disable: ["default-rule"] };
		const inner: SteeringConfig = {}; // no disable list
		const out = buildRules([outer, inner], [DEMO_DEFAULT]);
		assert.deepEqual(out.rules, []);
	});

	it("adds net-new rules from configs on top of defaults", () => {
		const cfg: SteeringConfig = {
			rules: [makeRule({ name: "custom", reason: "c" })],
		};
		const out = buildRules([cfg], [DEMO_DEFAULT]);
		const names = out.rules.map((r) => r.name).sort();
		assert.deepEqual(names, ["custom", "default-rule"]);
	});

	it("global \u2192 outer \u2192 inner precedence on the same rule name", () => {
		const global: SteeringConfig = {
			rules: [makeRule({ name: "r", reason: "global" })],
		};
		const outer: SteeringConfig = {
			rules: [makeRule({ name: "r", reason: "outer" })],
		};
		const inner: SteeringConfig = {
			rules: [makeRule({ name: "r", reason: "inner" })],
		};
		const out = buildRules([global, outer, inner], []);
		assert.equal(out.rules.length, 1);
		assert.equal(out.rules[0]?.reason, "inner");
	});
});

// defaultNoOverride merge semantics (walk-up): inner layer wins, unset
// doesn't override the running value, implicit default is false. Per-rule
// `noOverride` always wins \u2014 covered in index.test.ts (integration) because
// it's an evaluator concern.
describe("buildRules: defaultNoOverride merge semantics", () => {
	it("config with `defaultNoOverride: true` surfaces in the result", () => {
		const cfg: SteeringConfig = { defaultNoOverride: true };
		const out = buildRules([cfg], []);
		assert.equal(out.defaultNoOverride, true);
	});

	it("inner layer's `defaultNoOverride: true` overrides outer's `false`", () => {
		const outer: SteeringConfig = { defaultNoOverride: false };
		const inner: SteeringConfig = { defaultNoOverride: true };
		const out = buildRules([outer, inner], []);
		assert.equal(out.defaultNoOverride, true);
	});

	it("inner layer with `defaultNoOverride` unset leaves outer's value in place", () => {
		// Walk-up semantic: undefined from a layer does NOT override the running
		// value. This matches how `disable`/`rules` treat absent fields.
		const outer: SteeringConfig = { defaultNoOverride: true };
		const inner: SteeringConfig = {}; // no defaultNoOverride key at all
		const out = buildRules([outer, inner], []);
		assert.equal(out.defaultNoOverride, true);
	});

	it("inner layer's explicit `defaultNoOverride: false` overrides outer's `true`", () => {
		// Explicit `false` at an inner layer is a deliberate opt-out and should
		// win \u2014 distinguishing it from the \"unset\" case above.
		const outer: SteeringConfig = { defaultNoOverride: true };
		const inner: SteeringConfig = { defaultNoOverride: false };
		const out = buildRules([outer, inner], []);
		assert.equal(out.defaultNoOverride, false);
	});
});

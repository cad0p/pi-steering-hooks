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
		mkdirSync(inner, { recursive: true });
		writeFileSync(
			join(outer, "steering.json"),
			JSON.stringify({
				rules: [{ name: "outer", tool: "bash", field: "command", pattern: "o", reason: "o" }],
			}),
		);
		writeFileSync(
			join(inner, "steering.json"),
			JSON.stringify({
				rules: [{ name: "inner", tool: "bash", field: "command", pattern: "i", reason: "i" }],
			}),
		);
		const configs = loadConfigs(inner);
		// tmpRoot (HOME) has no steering.json → global baseline not added. Walk
		// emits [tmpRoot, a, a/b] → reversed is still outermost-first at index 0.
		assert.equal(configs.length, 2);
		assert.equal(configs[0]?.rules?.[0]?.name, "outer");
		assert.equal(configs[1]?.rules?.[0]?.name, "inner");
	});

	it("handles a malformed steering.json without throwing", () => {
		const dir = join(tmpRoot, "bad");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "steering.json"), "{ not valid json");
		const configs = loadConfigs(dir);
		// Malformed file yields {} (not dropped), so the walk length matches.
		assert.equal(configs.length, 1);
		assert.deepEqual(configs[0], {});
	});

	it("stops at $HOME and does not ascend into /", () => {
		const cwd = join(tmpRoot, "x");
		mkdirSync(cwd, { recursive: true });
		// Place a steering.json at tmpRoot (HOME) itself — must be collected.
		writeFileSync(
			join(tmpRoot, "steering.json"),
			JSON.stringify({
				rules: [{ name: "home", tool: "bash", field: "command", pattern: "h", reason: "h" }],
			}),
		);
		const configs = loadConfigs(cwd);
		assert.equal(configs.length, 1);
		assert.equal(configs[0]?.rules?.[0]?.name, "home");
	});
});

describe("buildRules", () => {
	it("returns defaults unchanged when configs is empty", () => {
		const out = buildRules([], [DEMO_DEFAULT]);
		assert.deepEqual(out, [DEMO_DEFAULT]);
	});

	it("inner layer overrides a rule by name", () => {
		const outer: SteeringConfig = {
			rules: [makeRule({ name: "shared", reason: "outer" })],
		};
		const inner: SteeringConfig = {
			rules: [makeRule({ name: "shared", reason: "inner" })],
		};
		const out = buildRules([outer, inner], []);
		assert.equal(out.length, 1);
		assert.equal(out[0]?.reason, "inner");
	});

	it("inner layer can disable a default rule", () => {
		const inner: SteeringConfig = { disable: ["default-rule"] };
		const out = buildRules([inner], [DEMO_DEFAULT]);
		assert.deepEqual(out, []);
	});

	it("disable is additive \u2014 once disabled, later layer cannot re-enable by omission", () => {
		const outer: SteeringConfig = { disable: ["default-rule"] };
		const inner: SteeringConfig = {}; // no disable list
		const out = buildRules([outer, inner], [DEMO_DEFAULT]);
		assert.deepEqual(out, []);
	});

	it("adds net-new rules from configs on top of defaults", () => {
		const cfg: SteeringConfig = {
			rules: [makeRule({ name: "custom", reason: "c" })],
		};
		const out = buildRules([cfg], [DEMO_DEFAULT]);
		const names = out.map((r) => r.name).sort();
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
		assert.equal(out.length, 1);
		assert.equal(out[0]?.reason, "inner");
	});
});

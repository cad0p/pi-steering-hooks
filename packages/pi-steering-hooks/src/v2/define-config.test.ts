// SPDX-License-Identifier: MIT
// Part of @cad0p/pi-steering-hooks.

/**
 * Type-inference + runtime tests for {@link defineConfig}.
 *
 * The main value of `defineConfig` is compile-time — typos in
 * `observer: "description-read"` (when the plugin actually registers
 * `description-reads`) should be REJECTED at type-check. `@ts-expect-error`
 * in this file serves as the assertion: if the type machinery stops
 * catching the typo, the `@ts-expect-error` directive itself errors at
 * type-check and the file fails to compile.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { defineConfig } from "./define-config.ts";
import type { Observer, Plugin, PredicateContext } from "./schema.ts";

const readObserver = {
	name: "description-reads",
	onResult: () => {},
} as const satisfies Observer;

const syncObserver = {
	name: "sync-done",
	onResult: () => {},
} as const satisfies Observer;

const gitPlugin = {
	name: "git",
	observers: [{ name: "branch-changed", onResult: () => {} }],
} as const satisfies Plugin;

describe("v2/defineConfig: runtime behavior", () => {
	it("returns a SteeringConfig with the fields the caller passed", () => {
		const cfg = defineConfig({
			defaultNoOverride: true,
			plugins: [gitPlugin],
			observers: [readObserver],
			rules: [
				{
					name: "some-rule",
					tool: "bash",
					field: "command",
					pattern: /./,
					reason: "r",
					observer: "description-reads",
				},
			],
		});
		assert.equal(cfg.defaultNoOverride, true);
		assert.equal(cfg.plugins?.[0]?.name, "git");
		assert.equal(cfg.observers?.[0]?.name, "description-reads");
		assert.equal(cfg.rules?.[0]?.observer, "description-reads");
	});

	it("normalizes readonly inputs to mutable arrays", () => {
		// Tuple literals from `const`-generics land as readonly; output
		// should be a plain array (SteeringConfig fields aren't readonly).
		// Register rules matching the disable entries so the generic
		// AllRuleNames constraint (ADR §8) accepts them.
		const disables = ["x", "y"] as const;
		const cfg = defineConfig({
			rules: [
				{ name: "x", tool: "bash", field: "command", pattern: /./, reason: "r" },
				{ name: "y", tool: "bash", field: "command", pattern: /./, reason: "r" },
			],
			disable: disables,
		});
		assert.deepEqual(cfg.disable, ["x", "y"]);
		// Sanity: the returned array is detached from the input, so
		// callers can freely mutate the built config without poisoning
		// the (probably module-scoped) source.
		cfg.disable?.push("z");
		assert.equal(disables.length, 2);
	});

	it("omits keys the caller didn't pass (no undefined leakage)", () => {
		const cfg = defineConfig({});
		assert.deepEqual(Object.keys(cfg), []);
	});
});

describe("v2/defineConfig: type-level checks", () => {
	it("allows observer name references drawn from inline observers", () => {
		const cfg = defineConfig({
			observers: [readObserver, syncObserver],
			rules: [
				{
					name: "r1",
					tool: "bash",
					field: "command",
					pattern: /./,
					reason: "r",
					observer: "description-reads",
				},
				{
					name: "r2",
					tool: "bash",
					field: "command",
					pattern: /./,
					reason: "r",
					observer: "sync-done",
				},
			],
		});
		assert.equal(cfg.rules?.length, 2);
	});

	it("allows observer name references drawn from plugin observers", () => {
		const cfg = defineConfig({
			plugins: [gitPlugin],
			rules: [
				{
					name: "r-plug",
					tool: "bash",
					field: "command",
					pattern: /./,
					reason: "r",
					observer: "branch-changed",
				},
			],
		});
		assert.equal(cfg.rules?.[0]?.observer, "branch-changed");
	});

	it("rejects unknown observer names at type-check", () => {
		const cfg = defineConfig({
			observers: [readObserver] as const,
			rules: [
				{
					name: "r-typo",
					tool: "bash",
					field: "command",
					pattern: /./,
					reason: "r",
					// @ts-expect-error — typo: "description-read" vs. "description-reads".
					observer: "description-read",
				},
			],
		});
		assert.equal(cfg.rules?.length, 1);
	});

	it("rejects unknown observer names with no observers registered", () => {
		const cfg = defineConfig({
			rules: [
				{
					name: "r-no-obs",
					tool: "bash",
					field: "command",
					pattern: /./,
					reason: "r",
					// @ts-expect-error — nothing registered, so any string is invalid.
					observer: "sync-done",
				},
			],
		});
		assert.equal(cfg.rules?.length, 1);
	});

	it("accepts inline Observer objects regardless of name registry", () => {
		const cfg = defineConfig({
			rules: [
				{
					name: "r-inline",
					tool: "bash",
					field: "command",
					pattern: /./,
					reason: "r",
					observer: { name: "ad-hoc", onResult: () => {} },
				},
			],
		});
		assert.equal(
			typeof cfg.rules?.[0]?.observer === "object"
				? cfg.rules?.[0]?.observer?.name
				: undefined,
			"ad-hoc",
		);
	});

	it("allows const-asserted tuples of plugins (tuple literal type flows)", () => {
		const pluginTuple = [gitPlugin] as const;
		const cfg = defineConfig({
			plugins: pluginTuple,
			rules: [
				{
					name: "r-tuple",
					tool: "bash",
					field: "command",
					pattern: /./,
					reason: "r",
					observer: "branch-changed",
				},
			],
		});
		assert.equal(cfg.plugins?.length, 1);
	});

	it("rule-name omitted `observer` field compiles regardless", () => {
		const cfg = defineConfig({
			rules: [
				{
					name: "r-no-observer",
					tool: "bash",
					field: "command",
					pattern: /./,
					reason: "r",
				},
			],
		});
		assert.equal(cfg.rules?.[0]?.observer, undefined);
	});
});

// ---------------------------------------------------------------------------
// ADR §8 generic constraints — disable / disablePlugins / writes ↔ happened.
// ---------------------------------------------------------------------------
//
// These tests pin the ADR §8 compile-time contract:
//
//   - `disable`        typed against union of registered rule names
//   - `disablePlugins` typed against union of registered plugin names
//   - `when.happened.type` typed against union of declared `writes`
//
// Same `@ts-expect-error` strategy as above: if the type machinery
// stops enforcing the constraint, the directive itself errors at
// type-check and this file fails to compile.

describe("v2/defineConfig: type constraints (ADR §8)", () => {
	it("disable accepts registered rule names (plugin + user)", () => {
		const plugin = {
			name: "p",
			rules: [
				{
					name: "plugin-rule",
					tool: "bash",
					field: "command",
					pattern: /./,
					reason: "r",
				},
			],
		} as const satisfies Plugin;
		const cfg = defineConfig({
			plugins: [plugin],
			rules: [
				{
					name: "user-rule",
					tool: "bash",
					field: "command",
					pattern: /./,
					reason: "r",
				},
			],
			disable: ["plugin-rule", "user-rule"],
		});
		assert.deepEqual(cfg.disable, ["plugin-rule", "user-rule"]);
	});

	it("disable rejects unknown rule names at type-check", () => {
		const plugin = {
			name: "p",
			rules: [
				{
					name: "known-rule",
					tool: "bash",
					field: "command",
					pattern: /./,
					reason: "r",
				},
			],
		} as const satisfies Plugin;
		const cfg = defineConfig({
			plugins: [plugin],
			// @ts-expect-error — "unknown-rule" is not a registered rule name.
			disable: ["unknown-rule"],
		});
		assert.equal(cfg.disable?.length, 1);
	});

	it("disablePlugins accepts registered plugin names", () => {
		const p1 = { name: "p1" } as const satisfies Plugin;
		const p2 = { name: "p2" } as const satisfies Plugin;
		const cfg = defineConfig({
			plugins: [p1, p2],
			disablePlugins: ["p1"],
		});
		assert.deepEqual(cfg.disablePlugins, ["p1"]);
	});

	it("disablePlugins rejects unknown plugin names at type-check", () => {
		const p1 = { name: "p1" } as const satisfies Plugin;
		const p2 = { name: "p2" } as const satisfies Plugin;
		const cfg = defineConfig({
			plugins: [p1, p2],
			// @ts-expect-error — "p3" is not a registered plugin.
			disablePlugins: ["p3"],
		});
		assert.equal(cfg.disablePlugins?.length, 1);
	});

	it("when.happened.type rejects strings outside the writes union", () => {
		const cfg = defineConfig({
			rules: [
				{
					name: "r",
					tool: "bash",
					field: "command",
					pattern: /./,
					reason: "r",
					writes: ["allowed-type"],
					when: {
						happened: {
							// @ts-expect-error — "forbidden-type" not in writes union.
							type: "forbidden-type",
							in: "agent_loop",
						},
					},
				},
			],
		});
		assert.equal(cfg.rules?.length, 1);
	});

	it("when.happened.type accepts strings in the rule's own writes union", () => {
		const cfg = defineConfig({
			rules: [
				{
					name: "r",
					tool: "bash",
					field: "command",
					pattern: /./,
					reason: "r",
					writes: ["self-type"],
					when: { happened: { type: "self-type", in: "agent_loop" } },
				},
			],
		});
		assert.equal(cfg.rules?.[0]?.name, "r");
	});

	it("when.happened.type accepts strings from an inline observer's writes", () => {
		const observer = {
			name: "obs",
			writes: ["sync-done"],
			onResult: () => {},
		} as const satisfies Observer;
		const cfg = defineConfig({
			observers: [observer],
			rules: [
				{
					name: "r",
					tool: "bash",
					field: "command",
					pattern: /./,
					reason: "r",
					when: { happened: { type: "sync-done", in: "agent_loop" } },
				},
			],
		});
		assert.equal(cfg.rules?.[0]?.when?.happened?.type, "sync-done");
	});

	it("when.happened.type accepts strings from a plugin rule's writes", () => {
		const plugin = {
			name: "p",
			rules: [
				{
					name: "pr",
					tool: "bash",
					field: "command",
					pattern: /./,
					reason: "r",
					writes: ["plugin-type"],
				},
			],
		} as const satisfies Plugin;
		const cfg = defineConfig({
			plugins: [plugin],
			rules: [
				{
					name: "r",
					tool: "bash",
					field: "command",
					pattern: /./,
					reason: "r",
					when: { happened: { type: "plugin-type", in: "agent_loop" } },
				},
			],
		});
		assert.equal(cfg.rules?.[0]?.when?.happened?.type, "plugin-type");
	});

	it("when.happened.type accepts strings from a plugin observer's writes", () => {
		const plugin = {
			name: "p",
			observers: [
				{
					name: "obs",
					writes: ["plugin-obs-type"],
					onResult: () => {},
				},
			],
		} as const satisfies Plugin;
		const cfg = defineConfig({
			plugins: [plugin],
			rules: [
				{
					name: "r",
					tool: "bash",
					field: "command",
					pattern: /./,
					reason: "r",
					when: {
						happened: { type: "plugin-obs-type", in: "agent_loop" },
					},
				},
			],
		});
		assert.equal(cfg.rules?.[0]?.when?.happened?.type, "plugin-obs-type");
	});

	it("G10 — Plugin.predicates without definePredicate requires the cast", () => {
		// Authors who skip `definePredicate` lose the variance cast it
		// internalizes. Direct assignment of a typed-arg handler into
		// `Plugin.predicates: Record<string, PredicateHandler>` (unknown
		// arg) must fail — `definePredicate`'s whole point.
		const plugin: Plugin = {
			name: "p",
			predicates: {
				// @ts-expect-error — typed-arg handler not assignable to the
				// loose record shape without the definePredicate cast.
				commitFormat: (
					_args: { pattern: RegExp },
					_ctx: PredicateContext,
				) => true,
			},
		};
		assert.equal(plugin.name, "p");
	});
});

// SPDX-License-Identifier: MIT
// Part of pi-steering.

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
import shippedGitPlugin from "./plugins/git/index.ts";
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

describe("defineConfig: runtime behavior", () => {
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
		// Register rules matching the disabledRules entries so the generic
		// AllRuleNames constraint (ADR §8) accepts them.
		const disables = ["x", "y"] as const;
		const cfg = defineConfig({
			rules: [
				{ name: "x", tool: "bash", field: "command", pattern: /./, reason: "r" },
				{ name: "y", tool: "bash", field: "command", pattern: /./, reason: "r" },
			],
			disabledRules: disables,
		});
		assert.deepEqual(cfg.disabledRules, ["x", "y"]);
		// Sanity: the returned array is detached from the input, so
		// callers can freely mutate the built config without poisoning
		// the (probably module-scoped) source.
		cfg.disabledRules?.push("z");
		assert.equal(disables.length, 2);
	});

	it("omits keys the caller didn't pass (no undefined leakage)", () => {
		const cfg = defineConfig({});
		assert.deepEqual(Object.keys(cfg), []);
	});
});

describe("defineConfig: type-level checks", () => {
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
// ADR §8 generic constraints — disabledRules / disabledPlugins / writes ↔ happened.
// ---------------------------------------------------------------------------
//
// These tests pin the ADR §8 compile-time contract:
//
//   - `disabledRules` typed against union of registered rule names
//   - `disabledPlugins` typed against union of registered plugin names
//   - `when.happened.event` typed against union of declared `writes`
//
// Same `@ts-expect-error` strategy as above: if the type machinery
// stops enforcing the constraint, the directive itself errors at
// type-check and this file fails to compile.

describe("defineConfig: type constraints (ADR §8)", () => {
	it("disabledRules accepts registered rule names (plugin + user)", () => {
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
			disabledRules: ["plugin-rule", "user-rule"],
		});
		assert.deepEqual(cfg.disabledRules, ["plugin-rule", "user-rule"]);
	});

	it("disabledRules rejects unknown rule names at type-check", () => {
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
			disabledRules: ["unknown-rule"],
		});
		assert.equal(cfg.disabledRules?.length, 1);
	});

	it("disabledPlugins accepts registered plugin names", () => {
		const p1 = { name: "p1" } as const satisfies Plugin;
		const p2 = { name: "p2" } as const satisfies Plugin;
		const cfg = defineConfig({
			plugins: [p1, p2],
			disabledPlugins: ["p1"],
		});
		assert.deepEqual(cfg.disabledPlugins, ["p1"]);
	});

	it("disabledPlugins rejects unknown plugin names at type-check", () => {
		const p1 = { name: "p1" } as const satisfies Plugin;
		const p2 = { name: "p2" } as const satisfies Plugin;
		const cfg = defineConfig({
			plugins: [p1, p2],
			// @ts-expect-error — "p3" is not a registered plugin.
			disabledPlugins: ["p3"],
		});
		assert.equal(cfg.disabledPlugins?.length, 1);
	});

	it("when.happened.event rejects strings outside the writes union", () => {
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
							event: "forbidden-type",
							in: "agent_loop",
						},
					},
				},
			],
		});
		assert.equal(cfg.rules?.length, 1);
	});

	it("when.happened.event accepts strings in the rule's own writes union", () => {
		const cfg = defineConfig({
			rules: [
				{
					name: "r",
					tool: "bash",
					field: "command",
					pattern: /./,
					reason: "r",
					writes: ["self-type"],
					when: { happened: { event: "self-type", in: "agent_loop" } },
				},
			],
		});
		assert.equal(cfg.rules?.[0]?.name, "r");
	});

	it("when.happened.event accepts strings from an inline observer's writes", () => {
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
					when: { happened: { event: "sync-done", in: "agent_loop" } },
				},
			],
		});
		assert.equal(cfg.rules?.[0]?.when?.happened?.event, "sync-done");
	});

	it("when.happened.event accepts strings from a plugin rule's writes", () => {
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
					when: { happened: { event: "plugin-type", in: "agent_loop" } },
				},
			],
		});
		assert.equal(cfg.rules?.[0]?.when?.happened?.event, "plugin-type");
	});

	it("when.happened.event accepts strings from a plugin observer's writes", () => {
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
						happened: { event: "plugin-obs-type", in: "agent_loop" },
					},
				},
			],
		});
		assert.equal(cfg.rules?.[0]?.when?.happened?.event, "plugin-obs-type");
	});

	it("G10 — Plugin.predicates accepts typed-arg handlers without a cast", () => {
		// Pins Item 2 of PR #5: `Plugin.predicates` is now
		// `Record<string, AnyPredicateHandler>` (where
		// `AnyPredicateHandler = PredicateHandler<any>`), which leverages
		// TS's bivariance fallback so a specifically-typed handler
		// assigns into the registry slot directly — no cast, no
		// `definePredicate` wrapper needed at the plug-in site.
		//
		// Pre-Item-2 this test pinned the OPPOSITE behavior (typed-arg
		// handlers were rejected by the `PredicateHandler<unknown>` slot,
		// motivating `definePredicate`). If TS's variance rules change
		// under us the `@ts-expect-error` version of this test would
		// reappear in git history — `definePredicate` is still exported
		// for handler AUTHORS who want the generic narrowing sugar on
		// their handler declaration.
		const plugin: Plugin = {
			name: "p",
			predicates: {
				commitFormat: (
					_args: { pattern: RegExp },
					_ctx: PredicateContext,
				) => true,
			},
		};
		assert.equal(plugin.name, "p");
	});
});

describe("defineConfig: bare-annotation footgun (ADR §8 authoring pattern)", () => {
	// These tests pin the ASYMMETRIC failure modes of bare type annotations
	// vs. `as const satisfies` so the JSDoc authoring-pattern guidance in
	// `schema.ts` (Rule.writes / Observer.writes / Plugin.name) stays
	// truthful. If TS's literal-inference behavior changes under us, or a
	// refactor narrows/widens one of the helper types, these tests will
	// surface the change loud enough to update the docs.
	//
	// The two failure modes:
	//   - NAME fields (plugin.name, rule.name): bare annotation widens to
	//     `string`, which makes `AllPluginNames` / `AllRuleNames` = `string`.
	//     Typos in `disabledRules` / `disabledPlugins` then compile silently.
	//     This is the "no typo detection" footgun.
	//   - `writes` arrays: bare annotation widens `readonly ["x"]` to
	//     `readonly string[]`, which can't project string literals, so
	//     `AllWrites` collapses to `never`. EVERY `when.happened.event`
	//     reference is rejected. This is the "can't use writes at all"
	//     failure — louder, but still a footgun if you don't know why.

	it("bare `: Plugin` annotation widens `name` — typos in disabledPlugins compile silently", () => {
		const widePlugin: Plugin = { name: "known-plugin" };
		// No @ts-expect-error: this COMPILES cleanly because `widePlugin.name`
		// has type `string`, so `AllPluginNames` = `string`, so any string
		// satisfies `disabledPlugins`. If TS future-fixes literal inference
		// on bare annotations OR a refactor narrows `AllPluginNames`, this
		// line starts erroring — signal to update the JSDoc footgun note.
		const cfg = defineConfig({
			plugins: [widePlugin],
			disabledPlugins: ["typo-name"],
		});
		assert.equal(cfg.disabledPlugins?.[0], "typo-name");
	});

	it("`as const satisfies Plugin` preserves `name` — typos caught at type-check", () => {
		const narrowPlugin = { name: "known-plugin" } as const satisfies Plugin;
		const cfg = defineConfig({
			plugins: [narrowPlugin],
			// @ts-expect-error — "typo-name" not in AllPluginNames union
			// (which is the literal "known-plugin" thanks to `as const`).
			disabledPlugins: ["typo-name"],
		});
		assert.equal(cfg.disabledPlugins?.length, 1);
	});

	it("bare `: Observer` annotation widens `writes` — collapses AllWrites to never", () => {
		const wideObserver: Observer = {
			name: "obs",
			writes: ["sync-done"],
			onResult: () => {},
		};
		const cfg = defineConfig({
			observers: [wideObserver],
			rules: [
				{
					name: "r",
					tool: "bash",
					field: "command",
					pattern: /./,
					reason: "r",
					// @ts-expect-error — bare-annotated observer widens
					// `writes` to `readonly string[]`, which collapses
					// `AllWrites` to `never`. "sync-done" is rejected even
					// though it IS in the runtime value — type info was lost
					// at annotation time.
					when: { happened: { event: "sync-done", in: "agent_loop" } },
				},
			],
		});
		assert.equal(cfg.rules?.length, 1);
	});

	it("`as const satisfies Observer` preserves `writes` — type is referenceable", () => {
		const narrowObserver = {
			name: "obs",
			writes: ["sync-done"],
			onResult: () => {},
		} as const satisfies Observer;
		const cfg = defineConfig({
			observers: [narrowObserver],
			rules: [
				{
					name: "r",
					tool: "bash",
					field: "command",
					pattern: /./,
					reason: "r",
					when: { happened: { event: "sync-done", in: "agent_loop" } },
				},
			],
		});
		assert.equal(cfg.rules?.[0]?.when?.happened?.event, "sync-done");
	});
});

describe("defineConfig: cross-module plugin typo detection (F2 regression fence)", () => {
	// The F2 finding: gitPlugin's emitted .d.ts was widening rule names
	// to `Rule<string, string>[]`, which silently disabled typo detection
	// on `disabledRules: [...]` for consumers importing the shipped plugin.
	// `as const satisfies Rule` at the source and `as const satisfies
	// readonly Rule[]` on the collection preserve the tuple + literals.
	//
	// These tests pin that the SHIPPED `gitPlugin` (not an inline copy)
	// carries literal rule names through to `defineConfig` generics.
	// If the widening regresses, the @ts-expect-error directives stop
	// firing and these tests fail to compile — loud signal.

	it("disabledRules accepts rule names from the imported gitPlugin", () => {
		const cfg = defineConfig({
			plugins: [shippedGitPlugin],
			disabledRules: ["no-main-commit"],
		});
		assert.equal(cfg.disabledRules?.[0], "no-main-commit");
	});

	it("disabledRules rejects typos in imported-plugin rule names", () => {
		const cfg = defineConfig({
			plugins: [shippedGitPlugin],
			// @ts-expect-error — "no-main-commit-typo" is not a registered
			// rule name on the imported gitPlugin. If this directive stops
			// firing, the .d.ts widening regression documented as F2 in
			// the phase-a3b review has returned.
			disabledRules: ["no-main-commit-typo"],
		});
		assert.equal(cfg.disabledRules?.length, 1);
	});

	it("disabledPlugins accepts the imported gitPlugin's name", () => {
		const cfg = defineConfig({
			plugins: [shippedGitPlugin],
			disabledPlugins: ["git"],
		});
		assert.equal(cfg.disabledPlugins?.[0], "git");
	});

	it("disabledPlugins rejects a typo on the imported gitPlugin's name", () => {
		const cfg = defineConfig({
			plugins: [shippedGitPlugin],
			// @ts-expect-error — "gti" is not a registered plugin name.
			disabledPlugins: ["gti"],
		});
		assert.equal(cfg.disabledPlugins?.length, 1);
	});
});

// ---------------------------------------------------------------------------
// Rule discriminated union — `tool` gates the legal `field` values (R4).
//
// These tests pin the (tool, field) combinations that TS accepts and the
// ones it rejects. The discriminated Rule union (BashRule | WriteRule |
// EditRule) replaced a flat `Rule` that accepted any `field` value
// regardless of `tool` — an author could write
// `{ tool: "bash", field: "path", ... }` and the evaluator would
// silently run the rule against the command text (bash always uses the
// extracted command). The union surfaces those typos at compile time.
// ---------------------------------------------------------------------------

describe("Rule discriminated union: tool gates field", () => {
	it("bash + command typechecks", () => {
		const cfg = defineConfig({
			rules: [
				{
					name: "bash-ok",
					tool: "bash",
					field: "command",
					pattern: /^rm\b/,
					reason: "r",
				},
			],
		});
		assert.equal(cfg.rules?.length, 1);
	});

	it("write + path / content typecheck", () => {
		const cfg = defineConfig({
			rules: [
				{
					name: "write-path",
					tool: "write",
					field: "path",
					pattern: /^\/etc\//,
					reason: "r",
				},
				{
					name: "write-content",
					tool: "write",
					field: "content",
					pattern: /SECRET/,
					reason: "r",
				},
			],
		});
		assert.equal(cfg.rules?.length, 2);
	});

	it("edit + path / content typecheck", () => {
		const cfg = defineConfig({
			rules: [
				{
					name: "edit-path",
					tool: "edit",
					field: "path",
					pattern: /^\/etc\//,
					reason: "r",
				},
				{
					name: "edit-content",
					tool: "edit",
					field: "content",
					pattern: /SECRET/,
					reason: "r",
				},
			],
		});
		assert.equal(cfg.rules?.length, 2);
	});

	it("bash rules reject `field: \"path\"` (type error)", () => {
		const cfg = defineConfig({
			rules: [
				// @ts-expect-error — bash rules must use `field: "command"`.
				// Previously silently misbehaved (evaluator always tested
				// the extracted command regardless of `field`).
				{
					name: "bash-path-bad",
					tool: "bash",
					field: "path",
					pattern: /^x/,
					reason: "r",
				},
			],
		});
		assert.equal(cfg.rules?.length, 1);
	});

	it("bash rules reject `field: \"content\"` (type error)", () => {
		const cfg = defineConfig({
			rules: [
				// @ts-expect-error — bash rules must use `field: "command"`.
				{
					name: "bash-content-bad",
					tool: "bash",
					field: "content",
					pattern: /^x/,
					reason: "r",
				},
			],
		});
		assert.equal(cfg.rules?.length, 1);
	});

	it("write rules reject `field: \"command\"` (type error)", () => {
		const cfg = defineConfig({
			rules: [
				// @ts-expect-error — write rules test `path` / `content`,
				// never `command` (write has no command).
				{
					name: "write-command-bad",
					tool: "write",
					field: "command",
					pattern: /^x/,
					reason: "r",
				},
			],
		});
		assert.equal(cfg.rules?.length, 1);
	});

	it("edit rules reject `field: \"command\"` (type error)", () => {
		const cfg = defineConfig({
			rules: [
				// @ts-expect-error — edit rules test `path` / `content`,
				// never `command`.
				{
					name: "edit-command-bad",
					tool: "edit",
					field: "command",
					pattern: /^x/,
					reason: "r",
				},
			],
		});
		assert.equal(cfg.rules?.length, 1);
	});
});

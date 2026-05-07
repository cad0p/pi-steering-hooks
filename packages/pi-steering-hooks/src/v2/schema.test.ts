// SPDX-License-Identifier: MIT
// Part of @cad0p/pi-steering-hooks.

/**
 * Type-level smoke tests for the v2 schema.
 *
 * These tests act as compile-time regression fences: if the schema's
 * shape drifts incompatibly, these fail to TYPECHECK (not just to run).
 * Runtime assertions are trivial — they exist so `node --test` has
 * something to report green.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type {
	Observer,
	Plugin,
	PredicateContext,
	PredicateFn,
	PredicateHandler,
	Rule,
	SteeringConfig,
	WhenClause,
} from "./schema.ts";

describe("v2/schema: shape smoke tests", () => {
	it("Rule accepts a minimal bash rule with a string pattern", () => {
		const rule: Rule = {
			name: "test",
			tool: "bash",
			field: "command",
			pattern: "^git push --force",
			reason: "nope",
		};
		assert.equal(rule.name, "test");
	});

	it("Rule accepts RegExp in pattern / requires / unless", () => {
		const rule: Rule = {
			name: "regex-rule",
			tool: "bash",
			field: "command",
			pattern: /^git push/,
			requires: /--force/,
			unless: /--force-with-lease/,
			reason: "nope",
		};
		assert.ok(rule.pattern instanceof RegExp);
	});

	it("Rule accepts PredicateFn in requires / unless", () => {
		const always: PredicateFn = async (_ctx) => true;
		const rule: Rule = {
			name: "fn-rule",
			tool: "bash",
			field: "command",
			pattern: "^git",
			requires: always,
			unless: async (ctx) => ctx.tool === "bash",
			reason: "nope",
		};
		assert.equal(typeof rule.requires, "function");
	});

	it("WhenClause accepts cwd as pattern or object with onUnknown", () => {
		const w1: WhenClause = { cwd: "^/workplace" };
		const w2: WhenClause = { cwd: /^\/workplace/ };
		const w3: WhenClause = {
			cwd: { pattern: /^\/workplace/, onUnknown: "block" },
		};
		assert.ok(w1.cwd !== undefined);
		assert.ok(w2.cwd !== undefined);
		assert.ok(w3.cwd !== undefined);
	});

	it("WhenClause.not composes recursively", () => {
		const w: WhenClause = {
			not: {
				cwd: /^\/home/,
				not: {
					cwd: /^\/home\/guest/,
				},
			},
		};
		assert.ok(w.not?.not?.cwd !== undefined);
	});

	it("WhenClause.condition accepts a PredicateFn", () => {
		const w: WhenClause = {
			condition: (ctx) => ctx.tool === "bash",
		};
		assert.equal(typeof w.condition, "function");
	});

	it("WhenClause accepts plugin-registered custom keys", () => {
		// Shape a plugin predicate registers. Consumers widen the
		// index signature to carry arbitrary shapes.
		const w: WhenClause = {
			// @ts-expect-no-error: plugin key with structured arg
			commitsAhead: { wrt: "origin/main", eq: 1 },
		};
		assert.ok("commitsAhead" in w);
	});

	it("Observer accepts minimal shape (name + onResult)", () => {
		const obs: Observer = {
			name: "spy",
			onResult: (_ev, _ctx) => {},
		};
		assert.equal(obs.name, "spy");
	});

	it("Observer.watch accepts every documented filter", () => {
		const obs: Observer = {
			name: "filtered",
			watch: {
				toolName: "bash",
				inputMatches: { command: /^git/ },
				exitCode: "success",
			},
			onResult: () => {},
		};
		assert.equal(obs.watch?.exitCode, "success");
	});

	it("Plugin accepts every documented extension point", () => {
		const fakeHandler: PredicateHandler<{ wrt: string }> = (args, _ctx) =>
			args.wrt.startsWith("origin/");
		const plugin: Plugin = {
			name: "fake",
			predicates: { commitsAhead: fakeHandler as PredicateHandler },
			rules: [
				{
					name: "r",
					tool: "bash",
					field: "command",
					pattern: /^x/,
					reason: "n",
				},
			],
			observers: [{ name: "o", onResult: () => {} }],
			// trackers and trackerExtensions left undefined — the
			// schema-level type is just `Record<string, Tracker<unknown>>`,
			// constructing a live tracker here would pull in walker
			// runtime code we don't need for a shape test.
		};
		assert.equal(plugin.name, "fake");
	});

	it("Rule.observer accepts inline Observer and string reference", () => {
		const inline: Rule = {
			name: "inline-obs",
			tool: "bash",
			field: "command",
			pattern: /./,
			reason: "r",
			observer: { name: "o", onResult: () => {} },
		};
		const byName: Rule<"o"> = {
			name: "by-name",
			tool: "bash",
			field: "command",
			pattern: /./,
			reason: "r",
			observer: "o",
		};
		assert.equal(byName.observer, "o");
		assert.ok(typeof inline.observer === "object");
	});

	it("SteeringConfig accepts every top-level field", () => {
		const cfg: SteeringConfig = {
			defaultNoOverride: true,
			disable: ["no-force-push"],
			disablePlugins: ["git"],
			disableDefaults: false,
			plugins: [],
			rules: [],
			observers: [],
		};
		assert.equal(cfg.defaultNoOverride, true);
	});

	it("PredicateContext exposes the documented surface", () => {
		// Pure shape test — we never invoke the context.
		const fake: PredicateContext = {
			cwd: "/",
			tool: "bash",
			input: { tool: "bash", command: "echo" },
			turnIndex: 0,
			exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
			appendEntry: () => {},
			findEntries: () => [],
		};
		assert.equal(fake.cwd, "/");
	});
});

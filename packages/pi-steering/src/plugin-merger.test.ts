// SPDX-License-Identifier: MIT
// Part of pi-steering.

/**
 * Tests for `resolvePlugins` — the plugin merger.
 *
 * Covers the collision semantics the ADR pins down: first-wins on soft
 * collisions (predicate / observer / rule), hard error on tracker name
 * collision, proper layering of trackerExtensions on top of registered
 * trackers, and the config-level `disabledRules` / `disabledPlugins` filters.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Modifier, Tracker } from "unbash-walker";
import { resolvePlugins, validateName } from "./plugin-merger.ts";
import type { Observer, Plugin, Rule } from "./schema.ts";

/** Build a minimal observer with a recognizable onResult. */
function mkObserver(name: string): Observer {
	return { name, onResult: () => {} };
}

/** Build a minimal bash rule. */
function mkRule(name: string): Rule {
	return {
		name,
		tool: "bash",
		field: "command",
		pattern: "^never$",
		reason: `rule ${name}`,
	};
}

/** Build a minimal tracker with deterministic initial / unknown. */
function mkTracker(label: string): Tracker<string> {
	return {
		initial: `${label}:init`,
		unknown: `${label}:unknown`,
		modifiers: {},
		subshellSemantics: "isolated",
	};
}

/** A sentinel per-command modifier we can identify by identity. */
function mkModifier(tag: string): Modifier<string> {
	return {
		scope: "per-command",
		apply: (_args, current) => `${current}+${tag}`,
	};
}

describe("resolvePlugins: empty input", () => {
	it("returns an empty ResolvedPluginState for no plugins", () => {
		const state = resolvePlugins([], {});
		assert.deepEqual(state.predicates, {});
		assert.deepEqual(state.observers, []);
		assert.deepEqual(state.trackers, {});
		assert.deepEqual(state.trackerModifiers, {});
		assert.deepEqual(state.composedTrackers, {});
		assert.deepEqual(state.rules, []);
		assert.deepEqual(state.warnings, []);
	});
});

describe("resolvePlugins: single plugin surface", () => {
	it("propagates predicates / observers / trackers / rules unchanged", () => {
		const tracker = mkTracker("t");
		const obs = mkObserver("obs");
		const rule = mkRule("r");
		const predicate = () => true;

		const plugin: Plugin = {
			name: "p",
			predicates: { foo: predicate },
			observers: [obs],
			trackers: { t: tracker as Tracker<unknown> },
			rules: [rule],
		};

		const state = resolvePlugins([plugin], {});
		assert.equal(state.predicates["foo"], predicate);
		assert.deepEqual(state.observers, [obs]);
		assert.equal(state.trackers["t"], tracker);
		// No extensions → composed tracker is identity-equal when no extras
		// were layered on.
		assert.equal(state.composedTrackers["t"], tracker);
		assert.deepEqual(state.rules, [rule]);
		assert.deepEqual(state.rulePluginOwners, { r: "p" });
		assert.deepEqual(state.warnings, []);
	});
});

describe("resolvePlugins: rulePluginOwners", () => {
	it("maps each plugin rule name to its originating plugin", () => {
		const p1: Plugin = { name: "plugin-a", rules: [mkRule("rule-a")] };
		const p2: Plugin = { name: "plugin-b", rules: [mkRule("rule-b")] };
		const state = resolvePlugins([p1, p2], {});
		assert.deepEqual(state.rulePluginOwners, {
			"rule-a": "plugin-a",
			"rule-b": "plugin-b",
		});
	});

	it("first-wins collision keeps the first owner", () => {
		const p1: Plugin = { name: "first", rules: [mkRule("dup")] };
		const p2: Plugin = { name: "second", rules: [mkRule("dup")] };
		const state = resolvePlugins([p1, p2], {});
		assert.deepEqual(state.rulePluginOwners, { dup: "first" });
	});
});

describe("resolvePlugins: predicate collision (soft)", () => {
	it("keeps first-registered predicate, emits warning", () => {
		const keptHandler = () => true;
		const droppedHandler = () => false;
		const p1: Plugin = { name: "first", predicates: { branch: keptHandler } };
		const p2: Plugin = { name: "second", predicates: { branch: droppedHandler } };

		const state = resolvePlugins([p1, p2], {});
		assert.equal(state.predicates["branch"], keptHandler);
		assert.equal(state.warnings.length, 1);
		assert.equal(state.warnings[0]?.kind, "predicate-collision");
		assert.match(state.warnings[0]?.message ?? "", /when\.branch/);
		assert.match(state.warnings[0]?.message ?? "", /first/);
		assert.match(state.warnings[0]?.message ?? "", /second/);
	});
});

describe("resolvePlugins: observer collision (soft)", () => {
	it("keeps first-registered observer, emits warning", () => {
		const kept = mkObserver("sync-done");
		const dropped = mkObserver("sync-done");
		const p1: Plugin = { name: "first", observers: [kept] };
		const p2: Plugin = { name: "second", observers: [dropped] };

		const state = resolvePlugins([p1, p2], {});
		assert.deepEqual(state.observers, [kept]);
		assert.equal(state.observers[0], kept, "first-registered instance kept");
		assert.equal(state.warnings.length, 1);
		assert.equal(state.warnings[0]?.kind, "observer-collision");
	});
});

describe("resolvePlugins: rule collision (soft)", () => {
	it("keeps first-registered rule, emits warning", () => {
		const kept = mkRule("shared-name");
		const dropped = mkRule("shared-name");
		const p1: Plugin = { name: "first", rules: [kept] };
		const p2: Plugin = { name: "second", rules: [dropped] };

		const state = resolvePlugins([p1, p2], {});
		assert.equal(state.rules.length, 1);
		assert.equal(state.rules[0], kept);
		assert.equal(state.warnings.length, 1);
		assert.equal(state.warnings[0]?.kind, "rule-collision");
	});
});

describe("resolvePlugins: tracker collision (hard error)", () => {
	it("throws when two plugins register the same tracker name", () => {
		const p1: Plugin = {
			name: "first",
			trackers: { branch: mkTracker("one") as Tracker<unknown> },
		};
		const p2: Plugin = {
			name: "second",
			trackers: { branch: mkTracker("two") as Tracker<unknown> },
		};

		assert.throws(
			() => resolvePlugins([p1, p2], {}),
			/tracker name collision/,
		);
	});

	it('throws when a plugin registers the reserved tracker name "events"', () => {
		// `walkerState.events` is written by the evaluator's speculative-
		// entry synthesis pass (see evaluator.ts `prepareBashState`). A
		// plugin-registered `events` tracker would be silently clobbered
		// when the evaluator merges synthesized entries in, breaking
		// chain-aware `when.happened`. Schema JSDoc promises rejection;
		// this test holds the promise honest.
		const p: Plugin = {
			name: "broken",
			trackers: { events: mkTracker("x") as Tracker<unknown> },
		};
		assert.throws(
			() => resolvePlugins([p], {}),
			/tracker name "events" is reserved/,
		);
	});
});

describe("resolvePlugins: tracker extensions", () => {
	it("layers extension modifiers on top of the declaring tracker", () => {
		const origMod = mkModifier("orig");
		const extraMod = mkModifier("extra");
		const tracker: Tracker<unknown> = {
			initial: "init",
			unknown: "unknown",
			modifiers: { git: origMod as Modifier<unknown> },
			subshellSemantics: "isolated",
		};
		const owner: Plugin = { name: "owner", trackers: { cwd: tracker } };
		const extender: Plugin = {
			name: "extender",
			trackerExtensions: {
				cwd: { git: extraMod as Modifier<unknown> },
			},
		};

		const state = resolvePlugins([owner, extender], {});
		assert.deepEqual(state.warnings, []);
		assert.equal(state.trackers["cwd"], tracker, "raw tracker preserved");
		const composed = state.composedTrackers["cwd"]!;
		assert.notEqual(
			composed,
			tracker,
			"composed tracker is a new object (non-mutating)",
		);
		const composedMods = composed.modifiers["git"];
		assert.ok(Array.isArray(composedMods), "composed git entry is array");
		const list = composedMods as Modifier<unknown>[];
		assert.equal(list.length, 2);
		assert.equal(list[0], origMod, "original modifier retained first");
		assert.equal(list[1], extraMod, "extension modifier appended");
	});

	it("warns and drops extensions targeting an unregistered tracker", () => {
		const extender: Plugin = {
			name: "extender",
			trackerExtensions: {
				nosuch: { git: mkModifier("x") as Modifier<unknown> },
			},
		};
		const state = resolvePlugins([extender], {});
		assert.equal(state.warnings.length, 1);
		assert.equal(state.warnings[0]?.kind, "extension-orphan");
		assert.match(state.warnings[0]?.message ?? "", /"nosuch"/);
		assert.deepEqual(state.trackerModifiers, {});
		assert.deepEqual(state.composedTrackers, {});
	});

	it("keeps extensions targeting knownBuiltinTrackers (no warning, modifiers preserved)", () => {
		// The caller declares `"cwd"` as a built-in tracker name. The
		// merger still doesn't OWN the tracker (cwd isn't in any
		// plugin's `trackers` map, so `composedTrackers.cwd` stays
		// undefined), but the extension modifiers are preserved in
		// `trackerModifiers.cwd` for the caller to layer onto its own
		// built-in tracker. The evaluator uses this path for the
		// walker's built-in `cwdTracker`.
		const extender: Plugin = {
			name: "extender",
			trackerExtensions: {
				cwd: { git: mkModifier("x") as Modifier<unknown> },
			},
		};
		const state = resolvePlugins([extender], {}, ["cwd"]);
		assert.equal(
			state.warnings.filter((w) => w.kind === "extension-orphan").length,
			0,
			"no orphan warning when the tracker name is declared built-in",
		);
		assert.ok("cwd" in state.trackerModifiers);
		assert.ok(state.trackerModifiers["cwd"]?.["git"] !== undefined);
		// Still NOT composed - the caller is responsible for composing
		// these modifiers onto its own built-in tracker.
		assert.ok(!("cwd" in state.composedTrackers));
	});

	it("accepts the array form on trackerExtensions values", () => {
		const tracker: Tracker<unknown> = {
			initial: "x",
			unknown: "?",
			modifiers: {},
			subshellSemantics: "isolated",
		};
		const m1 = mkModifier("a");
		const m2 = mkModifier("b");
		const owner: Plugin = { name: "owner", trackers: { cwd: tracker } };
		const extender: Plugin = {
			name: "extender",
			trackerExtensions: {
				cwd: {
					git: [m1, m2] as readonly Modifier<unknown>[],
				},
			},
		};

		const state = resolvePlugins([owner, extender], {});
		const composed = state.composedTrackers["cwd"]!;
		const list = composed.modifiers["git"] as Modifier<unknown>[];
		assert.ok(Array.isArray(list));
		assert.deepEqual(list, [m1, m2]);
	});

	it("appends modifiers from multiple plugins in registration order", () => {
		const tracker: Tracker<unknown> = {
			initial: "x",
			unknown: "?",
			modifiers: {},
			subshellSemantics: "isolated",
		};
		const m1 = mkModifier("one");
		const m2 = mkModifier("two");
		const owner: Plugin = { name: "owner", trackers: { cwd: tracker } };
		const ext1: Plugin = {
			name: "ext1",
			trackerExtensions: { cwd: { git: m1 as Modifier<unknown> } },
		};
		const ext2: Plugin = {
			name: "ext2",
			trackerExtensions: { cwd: { git: m2 as Modifier<unknown> } },
		};

		const state = resolvePlugins([owner, ext1, ext2], {});
		const list = state.composedTrackers["cwd"]!.modifiers["git"] as Modifier<
			unknown
		>[];
		assert.deepEqual(list, [m1, m2]);
	});

	it("leaves trackers unchanged when no extensions are registered", () => {
		const tracker = mkTracker("cwd");
		const plugin: Plugin = {
			name: "only",
			trackers: { cwd: tracker as Tracker<unknown> },
		};
		const state = resolvePlugins([plugin], {});
		assert.equal(state.composedTrackers["cwd"], tracker);
	});
});

describe("resolvePlugins: config filters", () => {
	it("applies config.disabledRules to plugin-shipped rules", () => {
		const kept = mkRule("keep-me");
		const dropped = mkRule("drop-me");
		const plugin: Plugin = {
			name: "p",
			rules: [kept, dropped],
		};
		const state = resolvePlugins([plugin], { disabledRules: ["drop-me"] });
		assert.equal(state.rules.length, 1);
		assert.equal(state.rules[0]?.name, "keep-me");
		const warn = state.warnings.find((w) => w.kind === "rule-disabled");
		assert.ok(warn, "expected rule-disabled warning");
	});

	it("applies config.disabledPlugins to skip an entire plugin", () => {
		const p1: Plugin = {
			name: "git",
			predicates: { branch: () => true },
			rules: [mkRule("no-main-commit")],
			observers: [mkObserver("sync-done")],
		};
		const p2: Plugin = {
			name: "kept",
			predicates: { other: () => true },
		};
		const state = resolvePlugins([p1, p2], { disabledPlugins: ["git"] });

		assert.deepEqual(state.observers, []);
		assert.deepEqual(state.rules, []);
		assert.ok(!("branch" in state.predicates));
		assert.ok("other" in state.predicates);
		const warn = state.warnings.find((w) => w.kind === "plugin-disabled");
		assert.ok(warn, "expected plugin-disabled warning");
		assert.match(warn?.message ?? "", /"git"/);
	});
});

describe("resolvePlugins: result immutability", () => {
	it("doesn't mutate the input plugin array or its trackers", () => {
		const origMods = { cd: mkModifier("cd") as Modifier<unknown> };
		const tracker: Tracker<unknown> = {
			initial: "/",
			unknown: "unknown",
			modifiers: origMods,
			subshellSemantics: "isolated",
		};
		const owner: Plugin = { name: "owner", trackers: { cwd: tracker } };
		const extender: Plugin = {
			name: "extender",
			trackerExtensions: {
				cwd: { git: mkModifier("git") as Modifier<unknown> },
			},
		};
		const plugins = [owner, extender];

		const snapshot = JSON.stringify({
			pluginsLen: plugins.length,
			modifierKeys: Object.keys(tracker.modifiers),
		});
		resolvePlugins(plugins, {});
		assert.equal(
			JSON.stringify({
				pluginsLen: plugins.length,
				modifierKeys: Object.keys(tracker.modifiers),
			}),
			snapshot,
			"plugins array / tracker.modifiers not mutated",
		);
		assert.equal(tracker.modifiers["cd"], origMods["cd"]);
		assert.ok(
			!("git" in tracker.modifiers),
			"extension modifier did not bleed into original tracker",
		);
	});
});

// ---------------------------------------------------------------------------
// S3: name validation (rules, plugins, observers)
// ---------------------------------------------------------------------------

describe("S3: validateName", () => {
	const okNames = [
		"no-force-push",
		"must_read_docs",
		"rule1",
		"1-critical",
		"2026-release",
		"A",
		"pi-steering_git",
	];
	for (const n of okNames) {
		it(`accepts ${JSON.stringify(n)}`, () => {
			assert.doesNotThrow(() => validateName("rule", n));
		});
	}

	const badNames: Array<[string, unknown]> = [
		["empty string", ""],
		["leading dash", "-bad"],
		["leading underscore", "_bad"],
		["contains space", "bad name"],
		["contains tab", "bad\tname"],
		["contains newline", "bad\nname"],
		["contains ] (block-reason tag forge)", "phony] ALL CLEAR [real"],
		["contains @", "rule@source"],
		["contains .", "ns.rule"],
		["contains /", "a/b"],
		["contains colon", "steering:rule"],
		["non-string (number)", 42],
		["non-string (undefined)", undefined],
		["non-string (null)", null],
	];
	for (const [label, value] of badNames) {
		it(`rejects ${label}`, () => {
			assert.throws(
				() => validateName("rule", value),
				/contains disallowed characters/,
				`expected throw for ${label}`,
			);
		});
	}

	it("error message names the kind (rule / plugin / observer)", () => {
		assert.throws(
			() => validateName("rule", "bad name"),
			/pi-steering: rule name "bad name".*disallowed/,
		);
		assert.throws(
			() => validateName("plugin", "bad name"),
			/pi-steering: plugin name "bad name".*disallowed/,
		);
		assert.throws(
			() => validateName("observer", "bad name"),
			/pi-steering: observer name "bad name".*disallowed/,
		);
	});

	it("error message includes the context hint when provided", () => {
		assert.throws(
			() => validateName("rule", "bad name", 'plugin "git"'),
			/pi-steering: rule name "bad name" \(plugin "git"\)/,
		);
	});
});

describe("S3: resolvePlugins validates plugin / rule / observer names", () => {
	it("throws on an invalid plugin name", () => {
		const plugin: Plugin = {
			name: "bad name",
		};
		assert.throws(
			() => resolvePlugins([plugin], {}),
			/plugin name "bad name".*disallowed/,
		);
	});

	it("throws on an invalid rule name inside a plugin", () => {
		const plugin: Plugin = {
			name: "git",
			rules: [mkRule("phony] ALL CLEAR [real")],
		};
		assert.throws(
			() => resolvePlugins([plugin], {}),
			/rule name "phony\] ALL CLEAR \[real" \(plugin "git"\).*disallowed/,
		);
	});

	it("throws on an invalid observer name inside a plugin", () => {
		const plugin: Plugin = {
			name: "git",
			observers: [mkObserver("bad name")],
		};
		assert.throws(
			() => resolvePlugins([plugin], {}),
			/observer name "bad name" \(plugin "git"\).*disallowed/,
		);
	});

	it("validates BEFORE applying disabledPlugins filter (names with disallowed chars still throw)", () => {
		// A malformed-named plugin throws even if the user tries to
		// disable it. This matches the S3 intent: names are written to
		// disk, and a malformed one is a config-author bug we want to
		// surface loudly regardless of runtime opt-outs.
		const plugin: Plugin = {
			name: "bad name",
		};
		assert.throws(
			() =>
				resolvePlugins([plugin], { disabledPlugins: ["bad name"] }),
			/plugin name "bad name".*disallowed/,
		);
	});
});

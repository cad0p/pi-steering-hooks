// SPDX-License-Identifier: MIT
// Part of @cad0p/pi-steering-hooks.

/**
 * End-to-end exercise of the pi extension wiring in `register()`.
 *
 * Uses a lightweight mock of `ExtensionAPI` that captures `on(...)` handlers
 * and records `appendEntry(...)` calls. We then drive the extension by firing
 * `session_start` (which loads configs + defaults) and synthetic `tool_call`
 * events, and assert on:
 *   - the handler's return value (block / allow)
 *   - the audit-log side effect for accepted overrides
 *
 * Why not reuse `evaluateBashRule` directly (already done in
 * `integration.test.ts`)? Because the blocking decision, the override escape
 * hatch, and the `steering-override` audit entry all live in `register()` —
 * we need an actual handler invocation to verify them.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { DEFAULT_RULES as DEFAULTS_DIRECT } from "./defaults.ts";
import {
	evaluateRule as evaluateRuleDirect,
	evaluateRuleForCommand as evaluateRuleForCommandDirect,
	extractOverride as extractOverrideDirect,
} from "./evaluator.ts";
import register, {
	DEFAULT_RULES,
	buildRules,
	evaluateRule,
	evaluateRuleForCommand,
	extractOverride,
	loadConfigs,
	parseConfig,
} from "./index.ts";
import {
	buildRules as buildRulesDirect,
	loadConfigs as loadConfigsDirect,
	parseConfig as parseConfigDirect,
} from "./loader.ts";

/* -------------------------------------------------------------------------- */
/* Mock ExtensionAPI                                                          */
/* -------------------------------------------------------------------------- */

type EventName = "session_start" | "tool_call";

interface Entry {
	kind: string;
	data: unknown;
}

interface MockPi {
	api: unknown; // passed to register() as ExtensionAPI (cast at call site)
	handlers: Partial<Record<EventName, (event: unknown, ctx: unknown) => unknown>>;
	entries: Entry[];
}

function makeMockPi(): MockPi {
	const handlers: MockPi["handlers"] = {};
	const entries: Entry[] = [];
	const api = {
		on(event: EventName, handler: (e: unknown, ctx: unknown) => unknown) {
			handlers[event] = handler;
		},
		appendEntry(kind: string, data: unknown) {
			entries.push({ kind, data });
		},
	};
	return { api, handlers, entries };
}

function fireSessionStart(mock: MockPi, cwd: string): void {
	const h = mock.handlers.session_start;
	if (!h) throw new Error("session_start handler not registered");
	// Event payload is unused by our extension — we only read ctx.cwd.
	h({}, { cwd });
}

interface BlockResult {
	block?: boolean;
	reason?: string;
}

function fireBashToolCall(
	mock: MockPi,
	command: string,
	cwd: string,
): BlockResult | undefined {
	const h = mock.handlers.tool_call;
	if (!h) throw new Error("tool_call handler not registered");
	const event = {
		type: "tool_call",
		toolName: "bash",
		toolCallId: "call-1",
		input: { command },
	};
	return h(event, { cwd }) as BlockResult | undefined;
}

function fireWriteToolCall(
	mock: MockPi,
	path: string,
	content: string,
	cwd: string,
): BlockResult | undefined {
	const h = mock.handlers.tool_call;
	if (!h) throw new Error("tool_call handler not registered");
	const event = {
		type: "tool_call",
		toolName: "write",
		toolCallId: "call-2",
		input: { path, content },
	};
	return h(event, { cwd }) as BlockResult | undefined;
}

function fireEditToolCall(
	mock: MockPi,
	path: string,
	edits: ReadonlyArray<{ oldText: string; newText: string }>,
	cwd: string,
): BlockResult | undefined {
	const h = mock.handlers.tool_call;
	if (!h) throw new Error("tool_call handler not registered");
	const event = {
		type: "tool_call",
		toolName: "edit",
		toolCallId: "call-3",
		input: { path, edits },
	};
	return h(event, { cwd }) as BlockResult | undefined;
}

/* -------------------------------------------------------------------------- */
/* Test harness: isolated $HOME per test                                      */
/* -------------------------------------------------------------------------- */

let origHome: string | undefined;
let tmpHome: string;

function useIsolatedHome() {
	beforeEach(() => {
		origHome = process.env.HOME;
		tmpHome = mkdtempSync(join(tmpdir(), "pi-steering-register-"));
		process.env.HOME = tmpHome;
	});
	afterEach(() => {
		if (origHome === undefined) delete process.env.HOME;
		else process.env.HOME = origHome;
		rmSync(tmpHome, { recursive: true, force: true });
	});
}

/* -------------------------------------------------------------------------- */
/* session_start + tool_call with default rules                               */
/* -------------------------------------------------------------------------- */

describe("register(): default rules wiring", () => {
	useIsolatedHome();

	it("blocks `git push --force` via default rule", () => {
		const mock = makeMockPi();
		// biome-ignore lint: mock cast is intentional
		register(mock.api as never);
		fireSessionStart(mock, tmpHome);

		const result = fireBashToolCall(mock, "git push --force", tmpHome);
		assert.ok(result, "expected a ToolCallEventResult");
		assert.equal(result?.block, true);
		assert.match(result?.reason ?? "", /no-force-push/);
	});

	it("allows `git push --force-with-lease`", () => {
		const mock = makeMockPi();
		register(mock.api as never);
		fireSessionStart(mock, tmpHome);

		const result = fireBashToolCall(mock, "git push --force-with-lease", tmpHome);
		assert.equal(result, undefined);
	});

	it("blocks `git push --force` behind `sh -c` wrapper", () => {
		const mock = makeMockPi();
		register(mock.api as never);
		fireSessionStart(mock, tmpHome);

		const result = fireBashToolCall(mock, "sh -c 'git push --force'", tmpHome);
		assert.equal(result?.block, true);
		assert.match(result?.reason ?? "", /no-force-push/);
	});

	it("blocks `git -C /other/dir push --force` (pre-subcommand flag bypass)", () => {
		// Regression: previously the `^git\s+push` anchor let this slip through.
		// The pattern now accepts short/long pre-subcommand flags before `push`.
		const mock = makeMockPi();
		register(mock.api as never);
		fireSessionStart(mock, tmpHome);

		const result = fireBashToolCall(
			mock,
			"git -C /other/dir push --force",
			tmpHome,
		);
		assert.equal(result?.block, true);
		assert.match(result?.reason ?? "", /no-force-push/);
	});

	it("does NOT block `echo 'git push --force'` (echo args are not AST-extracted)", () => {
		// `echo` receives the string as an argument; it's not a nested command.
		// Wrapper expansion only recurses into known command-running wrappers
		// (sh/bash -c, sudo, xargs, …).
		const mock = makeMockPi();
		register(mock.api as never);
		fireSessionStart(mock, tmpHome);

		const result = fireBashToolCall(mock, "echo 'git push --force'", tmpHome);
		assert.equal(result, undefined);
	});

	it("blocks `rm -rf /` and ignores override (noOverride: true)", () => {
		const mock = makeMockPi();
		register(mock.api as never);
		fireSessionStart(mock, tmpHome);

		const result = fireBashToolCall(
			mock,
			"rm -rf / # steering-override: no-rm-rf-slash — test override",
			tmpHome,
		);
		assert.equal(result?.block, true);
		assert.match(result?.reason ?? "", /no-rm-rf-slash/);
		// noOverride rules must NOT append an audit entry — override is ignored.
		assert.equal(mock.entries.length, 0);
	});
});

/* -------------------------------------------------------------------------- */
/* Override escape hatch + audit log                                          */
/* -------------------------------------------------------------------------- */

describe("register(): inline override escape hatch", () => {
	useIsolatedHome();

	it("accepts override comment, does not block, appends audit entry", () => {
		const mock = makeMockPi();
		register(mock.api as never);
		fireSessionStart(mock, tmpHome);

		const result = fireBashToolCall(
			mock,
			"git push --force # steering-override: no-force-push — coordinated revert",
			tmpHome,
		);
		assert.equal(result, undefined, "accepted override should not block");

		assert.equal(mock.entries.length, 1);
		const entry = mock.entries[0];
		assert.equal(entry?.kind, "steering-override");
		const data = entry?.data as {
			rule: string;
			reason: string;
			command: string;
			timestamp: string;
		};
		assert.equal(data.rule, "no-force-push");
		assert.equal(data.reason, "coordinated revert");
		assert.match(data.command, /git push --force/);
		assert.match(data.timestamp, /^\d{4}-\d{2}-\d{2}T/);
	});

	it("override targeted at a different rule does NOT suppress the block", () => {
		const mock = makeMockPi();
		register(mock.api as never);
		fireSessionStart(mock, tmpHome);

		const result = fireBashToolCall(
			mock,
			"git push --force # steering-override: some-other-rule — unrelated",
			tmpHome,
		);
		assert.equal(result?.block, true);
		assert.equal(mock.entries.length, 0);
	});
});

/* -------------------------------------------------------------------------- */
/* User-defined rules via steering.json                                       */
/* -------------------------------------------------------------------------- */

describe("register(): user-defined rules via steering.json", () => {
	useIsolatedHome();

	it("blocks a write to a .env file via a user-defined write rule", () => {
		// Global baseline under the isolated HOME.
		mkdirSync(join(tmpHome, ".pi", "agent"), { recursive: true });
		writeFileSync(
			join(tmpHome, ".pi", "agent", "steering.json"),
			JSON.stringify({
				rules: [
					{
						name: "no-env-files",
						tool: "write",
						field: "path",
						pattern: "(^|/)\\.env(\\.|$)",
						reason: "never write .env files — contains secrets",
					},
				],
			}),
		);

		const mock = makeMockPi();
		register(mock.api as never);
		fireSessionStart(mock, tmpHome);

		const result = fireWriteToolCall(
			mock,
			join(tmpHome, "project", ".env"),
			"SECRET_KEY=abc",
			tmpHome,
		);
		assert.equal(result?.block, true);
		assert.match(result?.reason ?? "", /no-env-files/);
	});

	it("blocks an edit that inserts a debugger statement (content rule)", () => {
		mkdirSync(join(tmpHome, ".pi", "agent"), { recursive: true });
		writeFileSync(
			join(tmpHome, ".pi", "agent", "steering.json"),
			JSON.stringify({
				rules: [
					{
						name: "no-debugger",
						tool: "edit",
						field: "content",
						pattern: "\\bdebugger\\b",
						reason: "don't commit debugger statements",
					},
				],
			}),
		);

		const mock = makeMockPi();
		register(mock.api as never);
		fireSessionStart(mock, tmpHome);

		const result = fireEditToolCall(
			mock,
			join(tmpHome, "project", "a.ts"),
			[{ oldText: "const x = 1;", newText: "const x = 1;\ndebugger;" }],
			tmpHome,
		);
		assert.equal(result?.block, true);
		assert.match(result?.reason ?? "", /no-debugger/);
	});

	it("when.cwd gates whether the rule fires", () => {
		mkdirSync(join(tmpHome, ".pi", "agent"), { recursive: true });
		writeFileSync(
			join(tmpHome, ".pi", "agent", "steering.json"),
			JSON.stringify({
				rules: [
					{
						name: "no-echo-in-special",
						tool: "bash",
						field: "command",
						pattern: "\\becho\\b",
						reason: "echo not allowed in special tree",
						when: { cwd: "/special/" },
					},
				],
			}),
		);

		const mock = makeMockPi();
		register(mock.api as never);
		fireSessionStart(mock, tmpHome);

		// cwd does not match → should NOT block.
		assert.equal(fireBashToolCall(mock, "echo hi", "/home/me/normal"), undefined);

		// cwd matches → should block.
		const blocked = fireBashToolCall(mock, "echo hi", "/home/me/special/sub");
		assert.equal(blocked?.block, true);
		assert.match(blocked?.reason ?? "", /no-echo-in-special/);
	});

	it("disable list removes a default rule", () => {
		mkdirSync(join(tmpHome, ".pi", "agent"), { recursive: true });
		writeFileSync(
			join(tmpHome, ".pi", "agent", "steering.json"),
			JSON.stringify({ disable: ["no-force-push"] }),
		);

		const mock = makeMockPi();
		register(mock.api as never);
		fireSessionStart(mock, tmpHome);

		// Rule disabled → push --force no longer blocked. (Other defaults still
		// apply, but we're not triggering them.)
		assert.equal(fireBashToolCall(mock, "git push --force", tmpHome), undefined);
	});
});

/* -------------------------------------------------------------------------- */
/* Config-level defaultNoOverride                                             */
/* -------------------------------------------------------------------------- */

// End-to-end for the `defaultNoOverride` config field: that per-rule
// `noOverride` still wins, that an absent per-rule setting falls back to the
// config default, and that the prior behavior is preserved when the field is
// unset (backward compatibility).
describe("register(): defaultNoOverride (config-level fallback)", () => {
	useIsolatedHome();

	it(
		"`defaultNoOverride: true` + rule without `noOverride` → override ignored, command blocked",
		() => {
			mkdirSync(join(tmpHome, ".pi", "agent"), { recursive: true });
			writeFileSync(
				join(tmpHome, ".pi", "agent", "steering.json"),
				JSON.stringify({
					defaultNoOverride: true,
					rules: [
						{
							name: "no-echo-strict",
							tool: "bash",
							field: "command",
							pattern: "^echo\\b",
							reason: "echo blocked in strict-by-default tree",
							// no explicit noOverride → inherits `defaultNoOverride: true`
						},
					],
				}),
			);

			const mock = makeMockPi();
			register(mock.api as never);
			fireSessionStart(mock, tmpHome);

			const result = fireBashToolCall(
				mock,
				"echo hi # steering-override: no-echo-strict \u2014 tried to escape",
				tmpHome,
			);
			assert.equal(
				result?.block,
				true,
				"defaultNoOverride: true promotes the rule to a hard block",
			);
			assert.match(result?.reason ?? "", /no-echo-strict/);
			// No audit entry: override path is not entered for non-overridable rules.
			assert.equal(mock.entries.length, 0);
			// The block reason should NOT include the "To override" hint, because
			// the rule effectively has no override path.
			assert.doesNotMatch(result?.reason ?? "", /To override/);
		},
	);

	it(
		"`defaultNoOverride: true` + rule with explicit `noOverride: false` → override allowed (per-rule wins)",
		() => {
			mkdirSync(join(tmpHome, ".pi", "agent"), { recursive: true });
			writeFileSync(
				join(tmpHome, ".pi", "agent", "steering.json"),
				JSON.stringify({
					defaultNoOverride: true,
					rules: [
						{
							name: "no-echo-flexible",
							tool: "bash",
							field: "command",
							pattern: "^echo\\b",
							reason: "echo blocked but overridable",
							noOverride: false, // explicit opt-in: override allowed despite config default
						},
					],
				}),
			);

			const mock = makeMockPi();
			register(mock.api as never);
			fireSessionStart(mock, tmpHome);

			const result = fireBashToolCall(
				mock,
				"echo hi # steering-override: no-echo-flexible \u2014 explicit opt-in",
				tmpHome,
			);
			assert.equal(
				result,
				undefined,
				"per-rule `noOverride: false` beats `defaultNoOverride: true`",
			);
			assert.equal(mock.entries.length, 1);
			assert.equal(mock.entries[0]?.kind, "steering-override");
			assert.equal(
				(mock.entries[0]?.data as { rule: string }).rule,
				"no-echo-flexible",
			);
		},
	);

	it(
		"no `defaultNoOverride` anywhere + rule without `noOverride` → override allowed (backward-compat)",
		() => {
			// Lock in the prior behavior: existing configs that don't touch
			// `defaultNoOverride` continue to allow overrides on plain rules.
			mkdirSync(join(tmpHome, ".pi", "agent"), { recursive: true });
			writeFileSync(
				join(tmpHome, ".pi", "agent", "steering.json"),
				JSON.stringify({
					rules: [
						{
							name: "no-echo-loose",
							tool: "bash",
							field: "command",
							pattern: "^echo\\b",
							reason: "echo blocked",
							// no noOverride, no defaultNoOverride at any layer
						},
					],
				}),
			);

			const mock = makeMockPi();
			register(mock.api as never);
			fireSessionStart(mock, tmpHome);

			const result = fireBashToolCall(
				mock,
				"echo hi # steering-override: no-echo-loose \u2014 prior behavior",
				tmpHome,
			);
			assert.equal(result, undefined, "override still works");
			assert.equal(mock.entries.length, 1);
			assert.equal(
				(mock.entries[0]?.data as { rule: string }).rule,
				"no-echo-loose",
			);
		},
	);
});

/* -------------------------------------------------------------------------- */
/* Non-targeted tool calls pass through                                       */
/* -------------------------------------------------------------------------- */

describe("register(): unrelated tool calls pass through", () => {
	useIsolatedHome();

	it("returns undefined for a tool call that matches no rule", () => {
		const mock = makeMockPi();
		register(mock.api as never);
		fireSessionStart(mock, tmpHome);

		const result = fireBashToolCall(mock, "ls -la", tmpHome);
		assert.equal(result, undefined);
	});

	it("returns undefined for a `read` tool call (not in any rule's tool set)", () => {
		const mock = makeMockPi();
		register(mock.api as never);
		fireSessionStart(mock, tmpHome);

		const h = mock.handlers.tool_call;
		assert.ok(h);
		const event = {
			type: "tool_call",
			toolName: "read",
			toolCallId: "call-read",
			input: { path: "/etc/passwd" },
		};
		const result = h?.(event, { cwd: tmpHome });
		assert.equal(result, undefined);
	});
});

/* -------------------------------------------------------------------------- */
/* Multi-rule firing: precedence + override-then-continue                     */
/* -------------------------------------------------------------------------- */

// Covers the intended "one steering at a time" semantics:
//   1. When multiple rules could match a single event, only the first
//      matching rule (in merged-list order) fires; others are not evaluated.
//   2. When the first matching rule is overridden via inline comment,
//      evaluation CONTINUES with the next rule — so if a second rule also
//      matches, it still blocks. This means an operator can address one
//      violation at a time without a single override silencing all of them.
describe("register(): multi-rule firing semantics", () => {
	useIsolatedHome();

	it("first matching rule wins: later matching rules don't fire or surface", () => {
		mkdirSync(join(tmpHome, ".pi", "agent"), { recursive: true });
		// Add a user rule `no-push` that would also match `git push --force`.
		// DEFAULT_RULES contains `no-force-push` first, and buildRules appends
		// user rules after defaults — so `no-force-push` is the first matcher.
		writeFileSync(
			join(tmpHome, ".pi", "agent", "steering.json"),
			JSON.stringify({
				rules: [
					{
						name: "no-push",
						tool: "bash",
						field: "command",
						pattern: "^git\\s+push\\b",
						reason: "pushes are gated by CI only",
					},
				],
			}),
		);

		const mock = makeMockPi();
		register(mock.api as never);
		fireSessionStart(mock, tmpHome);

		const result = fireBashToolCall(mock, "git push --force origin main", tmpHome);
		assert.equal(result?.block, true);
		assert.match(
			result?.reason ?? "",
			/no-force-push/,
			"first matching rule (no-force-push) wins",
		);
		assert.doesNotMatch(
			result?.reason ?? "",
			/no-push/,
			"second matching rule (no-push) is not evaluated",
		);
	});

	it("chained commands: first rule that matches ANY extracted command wins", () => {
		mkdirSync(join(tmpHome, ".pi", "agent"), { recursive: true });
		// Two user rules; the first one present in the merged list wins when
		// both would match *different* commands in the same chain. We add
		// `no-amend` as a user rule on top of the default `no-force-push`.
		writeFileSync(
			join(tmpHome, ".pi", "agent", "steering.json"),
			JSON.stringify({
				rules: [
					{
						name: "no-amend",
						tool: "bash",
						field: "command",
						pattern: "^git\\s+commit\\b.*--amend",
						reason: "no amend",
					},
				],
			}),
		);

		const mock = makeMockPi();
		register(mock.api as never);
		fireSessionStart(mock, tmpHome);

		// Chain fires two rules (no-force-push for push --force, no-amend for
		// commit --amend). Only no-force-push should surface — it's first in
		// the merged rule list (defaults come before user rules).
		const result = fireBashToolCall(
			mock,
			"cd /tmp/A && git push --force && cd /tmp/B && git commit --amend",
			tmpHome,
		);
		assert.equal(result?.block, true);
		assert.match(result?.reason ?? "", /no-force-push/);
		assert.doesNotMatch(result?.reason ?? "", /no-amend/);
	});

	it("overriding first rule advances to next: the second rule still blocks if it matches", () => {
		mkdirSync(join(tmpHome, ".pi", "agent"), { recursive: true });
		// Second user rule `no-push` also matches a force-push. Overriding
		// `no-force-push` should let evaluation continue to `no-push`, which
		// then blocks (no override for it).
		writeFileSync(
			join(tmpHome, ".pi", "agent", "steering.json"),
			JSON.stringify({
				rules: [
					{
						name: "no-push",
						tool: "bash",
						field: "command",
						pattern: "^git\\s+push\\b",
						reason: "pushes are gated by CI only",
					},
				],
			}),
		);

		const mock = makeMockPi();
		register(mock.api as never);
		fireSessionStart(mock, tmpHome);

		const cmd =
			"git push --force origin main # steering-override: no-force-push — hotfix";
		const result = fireBashToolCall(mock, cmd, tmpHome);
		assert.equal(result?.block, true, "second rule no-push still blocks after override");
		assert.match(result?.reason ?? "", /no-push/);
		assert.doesNotMatch(result?.reason ?? "", /no-force-push/);

		// And the override audit entry was recorded before the second block.
		const overrideEntry = mock.entries.find(
			(e) =>
				e.kind === "steering-override" &&
				(e.data as { rule: string }).rule === "no-force-push",
		);
		assert.ok(
			overrideEntry,
			"accepted override for no-force-push was audited before no-push blocked",
		);
	});

	it("overriding first rule advances to next: allow when the next rule doesn't match", () => {
		mkdirSync(join(tmpHome, ".pi", "agent"), { recursive: true });
		// Only the default no-force-push applies; override makes it allow.
		const mock = makeMockPi();
		register(mock.api as never);
		fireSessionStart(mock, tmpHome);

		const cmd =
			"git push --force origin main # steering-override: no-force-push — hotfix";
		const result = fireBashToolCall(mock, cmd, tmpHome);
		assert.equal(result, undefined, "override lets the command through");
	});
});

/* -------------------------------------------------------------------------- */
/* Public re-exports                                                          */
/* -------------------------------------------------------------------------- */

describe("public re-exports", () => {
	// Consumers embedding the engine (building their own extensions, a CLI
	// that lints commands, a test harness, …) import these from the package
	// root. If one stops being re-exported, this test fails.
	it("re-exports DEFAULT_RULES (same identity)", () => {
		assert.equal(DEFAULT_RULES, DEFAULTS_DIRECT);
	});

	it("re-exports evaluateRule (same identity)", () => {
		assert.equal(evaluateRule, evaluateRuleDirect);
	});

	it("re-exports evaluateRuleForCommand (same identity)", () => {
		assert.equal(evaluateRuleForCommand, evaluateRuleForCommandDirect);
	});

	it("re-exports extractOverride (same identity)", () => {
		assert.equal(extractOverride, extractOverrideDirect);
	});

	it("re-exports parseConfig (same identity)", () => {
		assert.equal(parseConfig, parseConfigDirect);
	});

	it("re-exports loadConfigs (same identity)", () => {
		assert.equal(loadConfigs, loadConfigsDirect);
	});

	it("re-exports buildRules (same identity)", () => {
		assert.equal(buildRules, buildRulesDirect);
	});
});

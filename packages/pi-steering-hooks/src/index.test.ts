// SPDX-License-Identifier: MIT
// Part of @cad0p/pi-steering-hooks.

/**
 * End-to-end exercise of the pi extension wiring in v2 `register()`.
 *
 * Uses an in-memory mock of `ExtensionAPI` that captures `on(...)`
 * handlers and records `appendEntry(...)` + `exec(...)` calls. We then
 * drive the extension by firing lifecycle events in order
 * (`agent_start`, `session_start`, `tool_call`, `tool_result`) and
 * assert on:
 *
 *   - the `tool_call` handler's return value (block / allow),
 *   - the audit-log side effect for accepted overrides,
 *   - the observer-dispatcher side effect on matching tool_result
 *     events,
 *   - the walk-up TS-config loader: {@link buildSessionRuntime} reads
 *     `.pi/steering.ts` from an isolated `$HOME`.
 *
 * Why not reuse the v2 evaluator / dispatcher tests directly? Because
 * `register()` wires lifecycle events + config loading + fail-open
 * error handling into a single surface. None of the unit suites cover
 * the glue. Phase 3c is exactly this glue — hence end-to-end here.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type {
	ExtensionContext,
	ToolCallEvent,
	ToolCallEventResult,
	ToolResultEvent,
} from "@mariozechner/pi-coding-agent";
import register, { buildSessionRuntime } from "./index.ts";

/* -------------------------------------------------------------------------- */
/* Mock ExtensionAPI                                                          */
/* -------------------------------------------------------------------------- */

type EventName =
	| "agent_start"
	| "session_start"
	| "tool_call"
	| "tool_result";

interface Entry {
	kind: string;
	data: unknown;
}

/**
 * In-memory mock of pi's ExtensionAPI. Only implements the surface the
 * steering extension actually consumes:
 *   - `on()` captures handlers keyed by event name.
 *   - `exec()` + `appendEntry()` are recorded for assertion.
 *
 * Everything else throws if touched so accidental reliance on
 * unsupported API surfaces breaks loudly during migration.
 */
interface MockPi {
	api: unknown; // cast at call site to ExtensionAPI
	handlers: Partial<
		Record<EventName, (event: unknown, ctx: unknown) => unknown>
	>;
	entries: Entry[];
	execCalls: Array<{ cmd: string; args: string[] }>;
	warnings: string[];
	errors: string[];
}

function makeMockPi(): MockPi {
	const handlers: MockPi["handlers"] = {};
	const entries: Entry[] = [];
	const execCalls: MockPi["execCalls"] = [];
	const warnings: string[] = [];
	const errors: string[] = [];
	const api = {
		on(event: EventName, handler: (e: unknown, ctx: unknown) => unknown) {
			handlers[event] = handler;
		},
		appendEntry(kind: string, data: unknown) {
			entries.push({ kind, data });
		},
		async exec(cmd: string, args: string[]) {
			execCalls.push({ cmd, args });
			return { stdout: "", stderr: "", code: 0, killed: false };
		},
	};
	return { api, handlers, entries, execCalls, warnings, errors };
}

function fireAgentStart(mock: MockPi): void {
	const h = mock.handlers.agent_start;
	if (!h) throw new Error("agent_start handler not registered");
	h({ type: "agent_start" }, {});
}

/**
 * Build a minimal ExtensionContext stub. Only `cwd` + `sessionManager`
 * are populated — the evaluator + dispatcher read those; everything
 * else throws on access.
 */
function makeExtensionCtx(cwd: string): ExtensionContext {
	return {
		cwd,
		sessionManager: {
			getEntries: () => [],
		} as unknown as ExtensionContext["sessionManager"],
	} as ExtensionContext;
}

async function fireSessionStart(mock: MockPi, cwd: string): Promise<void> {
	const h = mock.handlers.session_start;
	if (!h) throw new Error("session_start handler not registered");
	// Extension's session_start returns a Promise; await it.
	await h(
		{ type: "session_start", reason: "startup" },
		makeExtensionCtx(cwd),
	);
}

async function fireBashToolCall(
	mock: MockPi,
	command: string,
	cwd: string,
): Promise<ToolCallEventResult | undefined> {
	const h = mock.handlers.tool_call;
	if (!h) throw new Error("tool_call handler not registered");
	const event: ToolCallEvent = {
		type: "tool_call",
		toolName: "bash",
		toolCallId: "call-1",
		input: { command },
	};
	const r = await h(event, makeExtensionCtx(cwd));
	return r as ToolCallEventResult | undefined;
}

async function fireWriteToolCall(
	mock: MockPi,
	path: string,
	content: string,
	cwd: string,
): Promise<ToolCallEventResult | undefined> {
	const h = mock.handlers.tool_call;
	if (!h) throw new Error("tool_call handler not registered");
	const event: ToolCallEvent = {
		type: "tool_call",
		toolName: "write",
		toolCallId: "call-2",
		input: { path, content },
	};
	const r = await h(event, makeExtensionCtx(cwd));
	return r as ToolCallEventResult | undefined;
}

async function fireEditToolCall(
	mock: MockPi,
	path: string,
	edits: ReadonlyArray<{ oldText: string; newText: string }>,
	cwd: string,
): Promise<ToolCallEventResult | undefined> {
	const h = mock.handlers.tool_call;
	if (!h) throw new Error("tool_call handler not registered");
	const event: ToolCallEvent = {
		type: "tool_call",
		toolName: "edit",
		toolCallId: "call-3",
		input: { path, edits: [...edits] },
	};
	const r = await h(event, makeExtensionCtx(cwd));
	return r as ToolCallEventResult | undefined;
}

async function fireBashToolResult(
	mock: MockPi,
	input: Record<string, unknown>,
	exitCode: number,
	cwd: string,
): Promise<void> {
	const h = mock.handlers.tool_result;
	if (!h) throw new Error("tool_result handler not registered");
	const event = {
		type: "tool_result",
		toolCallId: "call-1",
		toolName: "bash",
		input,
		content: [],
		isError: exitCode !== 0,
		details: { exitCode },
	} as unknown as ToolResultEvent;
	await h(event, makeExtensionCtx(cwd));
}

/* -------------------------------------------------------------------------- */
/* Test harness: isolated $HOME per test                                      */
/* -------------------------------------------------------------------------- */

let origHome: string | undefined;
let tmpHome: string;

function useIsolatedHome() {
	beforeEach(() => {
		origHome = process.env["HOME"];
		tmpHome = mkdtempSync(join(tmpdir(), "pi-steering-register-v2-"));
		process.env["HOME"] = tmpHome;
	});
	afterEach(() => {
		if (origHome === undefined) delete process.env["HOME"];
		else process.env["HOME"] = origHome;
		rmSync(tmpHome, { recursive: true, force: true });
	});
}

/**
 * Write a TS config file at `.pi/steering.ts` under `dir`. Body is the
 * default-exported object literal body (without the `export default`
 * wrapper) so call sites read as declarative configs.
 */
function writeSteeringConfig(dir: string, body: string): void {
	mkdirSync(join(dir, ".pi"), { recursive: true });
	writeFileSync(
		join(dir, ".pi", "steering.ts"),
		`// Generated by index.test.ts\nexport default ${body};\n`,
		"utf8",
	);
}

/* -------------------------------------------------------------------------- */
/* session_start + tool_call with default rules                               */
/* -------------------------------------------------------------------------- */

describe("register(): default rules wiring", () => {
	useIsolatedHome();

	it("blocks `git push --force` via default rule", async () => {
		const mock = makeMockPi();
		register(mock.api as never);
		await fireSessionStart(mock, tmpHome);

		const result = await fireBashToolCall(mock, "git push --force", tmpHome);
		assert.ok(result, "expected a ToolCallEventResult");
		assert.equal(result?.block, true);
		assert.match(result?.reason ?? "", /no-force-push/);
	});

	it("allows `git push --force-with-lease`", async () => {
		const mock = makeMockPi();
		register(mock.api as never);
		await fireSessionStart(mock, tmpHome);

		const result = await fireBashToolCall(
			mock,
			"git push --force-with-lease",
			tmpHome,
		);
		assert.equal(result, undefined);
	});

	it("blocks `git push --force` behind `sh -c` wrapper", async () => {
		const mock = makeMockPi();
		register(mock.api as never);
		await fireSessionStart(mock, tmpHome);

		const result = await fireBashToolCall(
			mock,
			"sh -c 'git push --force'",
			tmpHome,
		);
		assert.equal(result?.block, true);
		assert.match(result?.reason ?? "", /no-force-push/);
	});

	it("blocks `git -C /other/dir push --force` (pre-subcommand flag bypass)", async () => {
		const mock = makeMockPi();
		register(mock.api as never);
		await fireSessionStart(mock, tmpHome);

		const result = await fireBashToolCall(
			mock,
			"git -C /other/dir push --force",
			tmpHome,
		);
		assert.equal(result?.block, true);
		assert.match(result?.reason ?? "", /no-force-push/);
	});

	it("does NOT block `echo 'git push --force'` (echo args are not AST-extracted)", async () => {
		const mock = makeMockPi();
		register(mock.api as never);
		await fireSessionStart(mock, tmpHome);

		const result = await fireBashToolCall(
			mock,
			"echo 'git push --force'",
			tmpHome,
		);
		assert.equal(result, undefined);
	});

	it("blocks `rm -rf /` and ignores override (noOverride: true)", async () => {
		const mock = makeMockPi();
		register(mock.api as never);
		await fireSessionStart(mock, tmpHome);

		const result = await fireBashToolCall(
			mock,
			"rm -rf / # steering-override: no-rm-rf-slash — test override",
			tmpHome,
		);
		assert.equal(result?.block, true);
		assert.match(result?.reason ?? "", /no-rm-rf-slash/);
		// noOverride rules must NOT append an audit entry.
		assert.equal(mock.entries.length, 0);
	});
});

/* -------------------------------------------------------------------------- */
/* Override escape hatch + audit log                                          */
/* -------------------------------------------------------------------------- */

describe("register(): inline override escape hatch", () => {
	useIsolatedHome();

	it("accepts override comment, does not block, appends audit entry", async () => {
		// The v2 default is `defaultNoOverride: true` (fail-closed per
		// ADR). Users who want overridable rules must opt in explicitly —
		// the config here flips the default back to false so the shipped
		// no-force-push rule becomes overridable.
		writeSteeringConfig(tmpHome, "{ defaultNoOverride: false }");

		const mock = makeMockPi();
		register(mock.api as never);
		await fireSessionStart(mock, tmpHome);

		const result = await fireBashToolCall(
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

	it("override targeted at a different rule does NOT suppress the block", async () => {
		writeSteeringConfig(tmpHome, "{ defaultNoOverride: false }");

		const mock = makeMockPi();
		register(mock.api as never);
		await fireSessionStart(mock, tmpHome);

		const result = await fireBashToolCall(
			mock,
			"git push --force # steering-override: some-other-rule — unrelated",
			tmpHome,
		);
		assert.equal(result?.block, true);
		assert.equal(mock.entries.length, 0);
	});

	it("v2 default (fail-closed) blocks override attempts on shipped rules", async () => {
		// NO config layer → defaultNoOverride defaults to `true`. The
		// override comment is ignored and the block fires.
		const mock = makeMockPi();
		register(mock.api as never);
		await fireSessionStart(mock, tmpHome);

		const result = await fireBashToolCall(
			mock,
			"git push --force # steering-override: no-force-push — hotfix",
			tmpHome,
		);
		assert.equal(result?.block, true);
		// The block reason should NOT include "To override" — rule is
		// non-overridable under fail-closed default.
		assert.doesNotMatch(result?.reason ?? "", /To override/);
		assert.equal(mock.entries.length, 0);
	});
});

/* -------------------------------------------------------------------------- */
/* User-defined rules via .pi/steering.ts                                     */
/* -------------------------------------------------------------------------- */

describe("register(): user-defined rules via .pi/steering.ts", () => {
	useIsolatedHome();

	it("blocks a write to a .env file via a user-defined write rule", async () => {
		writeSteeringConfig(
			tmpHome,
			`{
				rules: [
					{
						name: "no-env-files",
						tool: "write",
						field: "path",
						pattern: /(^|\\/)\\.env(\\.|$)/,
						reason: "never write .env files — contains secrets",
					},
				],
			}`,
		);

		const mock = makeMockPi();
		register(mock.api as never);
		await fireSessionStart(mock, tmpHome);

		const result = await fireWriteToolCall(
			mock,
			join(tmpHome, "project", ".env"),
			"SECRET_KEY=abc",
			tmpHome,
		);
		assert.equal(result?.block, true);
		assert.match(result?.reason ?? "", /no-env-files/);
	});

	it("blocks an edit that inserts a debugger statement (content rule)", async () => {
		writeSteeringConfig(
			tmpHome,
			`{
				rules: [
					{
						name: "no-debugger",
						tool: "edit",
						field: "content",
						pattern: /\\bdebugger\\b/,
						reason: "don't commit debugger statements",
					},
				],
			}`,
		);

		const mock = makeMockPi();
		register(mock.api as never);
		await fireSessionStart(mock, tmpHome);

		const result = await fireEditToolCall(
			mock,
			join(tmpHome, "project", "a.ts"),
			[{ oldText: "const x = 1;", newText: "const x = 1;\ndebugger;" }],
			tmpHome,
		);
		assert.equal(result?.block, true);
		assert.match(result?.reason ?? "", /no-debugger/);
	});

	it("when.cwd gates whether the rule fires", async () => {
		writeSteeringConfig(
			tmpHome,
			`{
				rules: [
					{
						name: "no-echo-in-special",
						tool: "bash",
						field: "command",
						pattern: /\\becho\\b/,
						reason: "echo not allowed in special tree",
						when: { cwd: /\\/special\\// },
					},
				],
			}`,
		);

		const mock = makeMockPi();
		register(mock.api as never);
		await fireSessionStart(mock, tmpHome);

		// cwd does not match → should NOT block.
		assert.equal(
			await fireBashToolCall(mock, "echo hi", "/home/me/normal"),
			undefined,
		);

		// cwd matches → should block.
		const blocked = await fireBashToolCall(
			mock,
			"echo hi",
			"/home/me/special/sub",
		);
		assert.equal(blocked?.block, true);
		assert.match(blocked?.reason ?? "", /no-echo-in-special/);
	});

	it("disable list removes a default rule", async () => {
		writeSteeringConfig(tmpHome, '{ disable: ["no-force-push"] }');

		const mock = makeMockPi();
		register(mock.api as never);
		await fireSessionStart(mock, tmpHome);

		// Rule disabled → push --force no longer blocked.
		assert.equal(
			await fireBashToolCall(mock, "git push --force", tmpHome),
			undefined,
		);
	});

	it("disableDefaults: true removes BOTH default rules and default plugins", async () => {
		// No user rule → combined with disableDefaults: true, nothing
		// blocks. Proves DEFAULT_RULES aren't leaking through when the
		// user opts out of defaults entirely.
		writeSteeringConfig(tmpHome, "{ disableDefaults: true }");

		const mock = makeMockPi();
		register(mock.api as never);
		await fireSessionStart(mock, tmpHome);

		assert.equal(
			await fireBashToolCall(mock, "git push --force", tmpHome),
			undefined,
		);
		assert.equal(
			await fireBashToolCall(mock, "rm -rf /", tmpHome),
			undefined,
			"disableDefaults skips even the noOverride no-rm-rf-slash",
		);
	});
});

/* -------------------------------------------------------------------------- */
/* Observer wiring via tool_result                                            */
/* -------------------------------------------------------------------------- */

describe("register(): observer dispatcher wiring", () => {
	useIsolatedHome();

	it("runs observers on matching tool_result events", async () => {
		// Use a module-scoped sentinel so the dynamically-imported config
		// can signal the test. The loader uses `await import(url)` with a
		// file:// URL; we bake the assertion hook directly into the
		// observer's onResult via a global counter.
		writeSteeringConfig(
			tmpHome,
			`{
				observers: [
					{
						name: "count-bash-success",
						watch: { toolName: "bash", exitCode: "success" },
						onResult: (event, ctx) => {
							ctx.appendEntry("bash-success", { cmd: (event.input as {command: string}).command });
						},
					},
				],
			}`,
		);

		const mock = makeMockPi();
		register(mock.api as never);
		await fireSessionStart(mock, tmpHome);

		await fireBashToolResult(
			mock,
			{ command: "echo hi" },
			0,
			tmpHome,
		);

		const recorded = mock.entries.find((e) => e.kind === "bash-success");
		assert.ok(recorded, "observer should have written an entry");
		// The engine auto-injects `_agentLoopIndex` into every observer/
		// predicate write so `when.happened: { in: "agent_loop" }` can
		// filter by scope. First agent_start happens implicitly at
		// session setup time — agentLoopIndex here is 0 because no
		// agent_start events have fired in this test.
		assert.deepEqual(recorded.data, {
			cmd: "echo hi",
			_agentLoopIndex: 0,
		});
	});

	it("observer watch filter gates firing (failure exit code excluded)", async () => {
		writeSteeringConfig(
			tmpHome,
			`{
				observers: [
					{
						name: "count-bash-success",
						watch: { toolName: "bash", exitCode: "success" },
						onResult: (_event, ctx) => {
							ctx.appendEntry("bash-success");
						},
					},
				],
			}`,
		);

		const mock = makeMockPi();
		register(mock.api as never);
		await fireSessionStart(mock, tmpHome);

		await fireBashToolResult(
			mock,
			{ command: "exit 1" },
			1, // failure
			tmpHome,
		);

		assert.equal(
			mock.entries.find((e) => e.kind === "bash-success"),
			undefined,
		);
	});
});

/* -------------------------------------------------------------------------- */
/* Non-targeted tool calls pass through                                       */
/* -------------------------------------------------------------------------- */

describe("register(): unrelated tool calls pass through", () => {
	useIsolatedHome();

	it("returns undefined for a tool call that matches no rule", async () => {
		const mock = makeMockPi();
		register(mock.api as never);
		await fireSessionStart(mock, tmpHome);

		const result = await fireBashToolCall(mock, "ls -la", tmpHome);
		assert.equal(result, undefined);
	});

	it("returns undefined for a `read` tool call (not in any rule's tool set)", async () => {
		const mock = makeMockPi();
		register(mock.api as never);
		await fireSessionStart(mock, tmpHome);

		const h = mock.handlers.tool_call;
		assert.ok(h);
		const event = {
			type: "tool_call",
			toolName: "read",
			toolCallId: "call-read",
			input: { path: "/etc/passwd" },
		};
		const result = await h(event, makeExtensionCtx(tmpHome));
		assert.equal(result, undefined);
	});
});

/* -------------------------------------------------------------------------- */
/* Agent-loop index threading                                                 */
/* -------------------------------------------------------------------------- */

describe("register(): agent_start bumps agentLoopIndex threaded into evaluator", () => {
	useIsolatedHome();

	it("passes the current agentLoopIndex into predicate context", async () => {
		// Rule uses when.condition to assert agentLoopIndex threading.
		// The condition appends an audit entry the test consults to
		// confirm the agentLoopIndex the evaluator saw.
		writeSteeringConfig(
			tmpHome,
			`{
				rules: [
					{
						name: "capture-turn",
						tool: "bash",
						field: "command",
						pattern: /^echo/,
						reason: "capture",
						when: {
							condition: (ctx) => {
								ctx.appendEntry("captured", { agentLoopIndex: ctx.agentLoopIndex });
								return false; // never fires; only side effect matters
							},
						},
					},
				],
			}`,
		);

		const mock = makeMockPi();
		register(mock.api as never);
		await fireSessionStart(mock, tmpHome);

		// Each agent_start bumps the engine's internal counter by 1.
		// Fire 5 times so the first tool_call sees agentLoopIndex === 5.
		fireAgentStart(mock);
		fireAgentStart(mock);
		fireAgentStart(mock);
		fireAgentStart(mock);
		fireAgentStart(mock);
		await fireBashToolCall(mock, "echo hi", tmpHome);

		const captured = mock.entries.find((e) => e.kind === "captured");
		assert.ok(captured);
		assert.deepEqual(
			(captured.data as { agentLoopIndex: number }).agentLoopIndex,
			5,
		);
	});
});

/* -------------------------------------------------------------------------- */
/* Fail-open on config load error                                             */
/* -------------------------------------------------------------------------- */

describe("register(): fail-open on config load error", () => {
	useIsolatedHome();

	it("broken config layer is skipped by the loader (per-layer fail-open)", async () => {
		// The loader's per-layer error handling (throws inside
		// import'd module) logs a warn but doesn't stop the session.
		// Write a syntactically-invalid TS config to prove the session
		// still starts and the defaults still apply.
		mkdirSync(join(tmpHome, ".pi"), { recursive: true });
		writeFileSync(
			join(tmpHome, ".pi", "steering.ts"),
			"export default this is not valid typescript;\n",
			"utf8",
		);

		// Suppress the expected console.warn from the loader.
		const origWarn = console.warn;
		const warnings: string[] = [];
		console.warn = (msg: unknown) => {
			warnings.push(String(msg));
		};

		try {
			const mock = makeMockPi();
			register(mock.api as never);
			await fireSessionStart(mock, tmpHome);

			// Defaults still apply (broken layer skipped, not fatal).
			const result = await fireBashToolCall(
				mock,
				"git push --force",
				tmpHome,
			);
			assert.equal(result?.block, true);
			assert.ok(
				warnings.some((w) => w.includes("failed to load config")),
				"expected loader warn about the broken layer",
			);
		} finally {
			console.warn = origWarn;
		}
	});
});

/* -------------------------------------------------------------------------- */
/* buildSessionRuntime direct coverage (two-pass disableDefaults merge)       */
/* -------------------------------------------------------------------------- */

describe("buildSessionRuntime: two-pass disableDefaults merge", () => {
	useIsolatedHome();

	it("inner `disableDefaults: true` wins — defaults are NOT injected", async () => {
		writeSteeringConfig(tmpHome, "{ disableDefaults: true }");

		const host = {
			exec: async () => ({
				stdout: "",
				stderr: "",
				code: 0,
				killed: false,
			}),
			appendEntry: () => {},
		};
		const { config } = await buildSessionRuntime(tmpHome, host);
		// `disableDefaults: true` in the user layer suppresses DEFAULT_RULES
		// entirely — config.rules ends up undefined (merger returns a
		// rules-absent SteeringConfig when no layer ships rules and
		// defaults are skipped).
		assert.equal(config.rules, undefined);
		assert.equal(config.disableDefaults, true);
	});

	it("no `disableDefaults` — DEFAULT_RULES are injected", async () => {
		// No config file at all.
		const host = {
			exec: async () => ({
				stdout: "",
				stderr: "",
				code: 0,
				killed: false,
			}),
			appendEntry: () => {},
		};
		const { config } = await buildSessionRuntime(tmpHome, host);
		assert.ok(config.rules);
		const names = config.rules.map((r) => r.name);
		assert.ok(names.includes("no-force-push"));
		assert.ok(names.includes("no-rm-rf-slash"));
	});

	it("`disable` filters default rules out of the merged config", async () => {
		writeSteeringConfig(tmpHome, '{ disable: ["no-force-push"] }');
		const host = {
			exec: async () => ({
				stdout: "",
				stderr: "",
				code: 0,
				killed: false,
			}),
			appendEntry: () => {},
		};
		const { config } = await buildSessionRuntime(tmpHome, host);
		const names = (config.rules ?? []).map((r) => r.name);
		assert.ok(!names.includes("no-force-push"));
		// Other defaults still present.
		assert.ok(names.includes("no-rm-rf-slash"));
	});
});

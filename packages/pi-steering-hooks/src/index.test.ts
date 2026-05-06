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
import register from "./index.ts";

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

	it("cwdPattern gates whether the rule fires", () => {
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
						cwdPattern: "/special/",
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

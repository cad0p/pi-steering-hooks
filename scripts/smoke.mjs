#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Part of cad0p/pi-steering-hooks.
//
// Isolated smoke test for the @cad0p/pi-steering-hooks extension.
//
// Loads the built extension entry via its published shape (dynamic import of
// the dist/index.js default export), mocks the pi ExtensionAPI surface the
// extension calls into, and drives it with synthetic `session_start` +
// `tool_call` events. Asserts block/allow + override-audit behavior for a
// fixed matrix of cases.
//
// Why this harness and not real pi + LLM? The LLM-driven smoke path hits
// provider-side safety refusals on adversarial commands like `rm -rf /` and
// `git push --force`, which makes it unreliable as a regression gate. The
// synthetic harness exercises the exact same extension code path (the
// `register()` entry that pi would call, the same tool_call event shape pi
// emits) without the non-determinism of the LLM layer.
//
// Usage:
//   pnpm -r build                                   # build the extension
//   node scripts/smoke.mjs                          # run against defaults only
//   node scripts/smoke.mjs /path/to/steering-dir    # + user rules from that dir's .pi/steering.json

import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";

const repoRoot = resolve(new URL("..", import.meta.url).pathname);
const distEntry = join(
	repoRoot,
	"packages/pi-steering-hooks/dist/index.js",
);

/* -------------------------------------------------------------------------- */
/* Mock pi ExtensionAPI                                                       */
/* -------------------------------------------------------------------------- */

function makeMockPi() {
	const handlers = {};
	const entries = [];
	const api = {
		on(event, handler) {
			handlers[event] = handler;
		},
		appendEntry(kind, data) {
			entries.push({ kind, data });
		},
	};
	return { api, handlers, entries };
}

function fireSessionStart(mock, cwd) {
	const h = mock.handlers.session_start;
	if (!h) throw new Error("session_start handler not registered");
	h({}, { cwd });
}

function fireBashToolCall(mock, command, cwd) {
	const h = mock.handlers.tool_call;
	if (!h) throw new Error("tool_call handler not registered");
	const event = {
		type: "tool_call",
		toolName: "bash",
		toolCallId: "call-1",
		input: { command },
	};
	return h(event, { cwd });
}

/* -------------------------------------------------------------------------- */
/* Test matrix                                                                */
/* -------------------------------------------------------------------------- */

/**
 * @typedef {{
 *   label: string,
 *   command: string,
 *   expect: "block" | "allow" | "allow+audit",
 *   expectRule?: string,     // required when expect="block" or "allow+audit"
 * }} SmokeCase
 */

/** @type {SmokeCase[]} */
const CASES = [
	{
		label: "default no-force-push blocks `git push --force origin main`",
		command: "git push --force origin main",
		expect: "block",
		expectRule: "no-force-push",
	},
	{
		label: "plain `git push origin main` is allowed",
		command: "git push origin main",
		expect: "allow",
	},
	{
		label: "`git commit --amend` is allowed (no-amend not in defaults)",
		command: 'git commit --amend -m "x"',
		expect: "allow",
	},
	{
		label: "override comment unblocks no-force-push and audits the override",
		// Both default no-force-push and user test-no-force-push match this
		// command. Overriding just no-force-push would advance to
		// test-no-force-push (which would still block — see the multi-rule
		// firing tests). For an isolated 'override accepted' assertion we
		// override both so the chain passes through cleanly and we can
		// observe the no-force-push audit entry.
		command:
			"git push --force origin main " +
			"# steering-override: no-force-push \u2014 smoke test " +
			"# steering-override: test-no-force-push \u2014 smoke test",
		expect: "allow+audit",
		expectRule: "no-force-push",
	},
	{
		label: "AST backend: `echo 'git push --force'` is NOT a false positive",
		command: "echo 'git push --force'",
		expect: "allow",
	},
	{
		label: "no-rm-rf-slash (noOverride) blocks `rm -rf /`",
		command: "rm -rf /",
		expect: "block",
		expectRule: "no-rm-rf-slash",
	},
	{
		label: "no-rm-rf-slash ignores override comment (noOverride)",
		command: "rm -rf / # steering-override: no-rm-rf-slash \u2014 nope",
		expect: "block",
		expectRule: "no-rm-rf-slash",
	},
	{
		label: "user-defined test-no-force-push also fires (loaded via steering.json)",
		command: "git push --force origin main",
		expect: "block",
		// Defaults come first in the merged list, so no-force-push wins over
		// the user rule. This case asserts the merged-list precedence.
		expectRule: "no-force-push",
		requiresUserRule: true,
	},
];

/* -------------------------------------------------------------------------- */
/* Runner                                                                     */
/* -------------------------------------------------------------------------- */

async function main() {
	const userRulesDir = process.argv[2];
	let sessionDir;
	let cleanup = () => {};
	if (userRulesDir) {
		sessionDir = resolve(userRulesDir);
	} else {
		// Create an isolated session dir with a user rule so the requiresUserRule
		// case has something to load. Project-local config lives under `.pi/`,
		// matching pi's extension layout (same place as `.pi/extensions/`).
		sessionDir = mkdtempSync(join(tmpdir(), "pi-poc-smoke-"));
		mkdirSync(join(sessionDir, ".pi"), { recursive: true });
		writeFileSync(
			join(sessionDir, ".pi", "steering.json"),
			JSON.stringify(
				{
					rules: [
						{
							name: "test-no-force-push",
							tool: "bash",
							field: "command",
							pattern: "^git\\b.*push\\b.*--force",
							reason: "blocked by smoke-test rule",
						},
					],
				},
				null,
				2,
			),
		);
		cleanup = () => rmSync(sessionDir, { recursive: true, force: true });
	}

	// Isolate $HOME so no outer ~/.pi/agent/steering.json leaks in.
	const tmpHome = mkdtempSync(join(tmpdir(), "pi-poc-smoke-home-"));
	mkdirSync(join(tmpHome, ".pi", "agent"), { recursive: true });
	const origHome = process.env.HOME;
	process.env.HOME = tmpHome;

	let passed = 0;
	let failed = 0;
	const failures = [];

	try {
		// Load the built extension.
		const mod = await import(distEntry);
		const register = mod.default;
		if (typeof register !== "function") {
			throw new Error(
				`expected default export to be a function, got ${typeof register}`,
			);
		}

		const mock = makeMockPi();
		register(mock.api);
		fireSessionStart(mock, sessionDir);

		for (const c of CASES) {
			// Track entries added by this case specifically so we can assert
			// audit-log side effects without cross-contamination.
			const entriesBefore = mock.entries.length;
			const result = fireBashToolCall(mock, c.command, sessionDir);
			const blocked = result && result.block === true;
			const newEntries = mock.entries.slice(entriesBefore);

			let ok = false;
			let detail = "";
			if (c.expect === "block") {
				if (!blocked) {
					detail = `expected block, got ${JSON.stringify(result)}`;
				} else if (
					c.expectRule &&
					!(result.reason ?? "").includes(c.expectRule)
				) {
					detail = `block reason does not mention "${c.expectRule}": ${result.reason}`;
				} else {
					ok = true;
					detail = result.reason ?? "(no reason)";
				}
			} else if (c.expect === "allow") {
				if (blocked) {
					detail = `expected allow, got block: ${result?.reason}`;
				} else {
					ok = true;
					detail = "allowed";
				}
			} else if (c.expect === "allow+audit") {
				if (blocked) {
					detail = `expected allow+audit, got block: ${result?.reason}`;
				} else {
					const audit = newEntries.find(
						(e) =>
							e.kind === "steering-override" &&
							(!c.expectRule || e.data?.rule === c.expectRule),
					);
					if (!audit) {
						detail = `no steering-override audit entry for rule=${c.expectRule}. entries=${JSON.stringify(newEntries)}`;
					} else {
						ok = true;
						detail = `audited: ${audit.data.reason}`;
					}
				}
			} else {
				detail = `unknown expect: ${c.expect}`;
			}

			const sym = ok ? "\u2713" : "\u2717";
			const line = `${sym} ${c.label}`;
			console.log(`${line}\n    ${detail}`);
			if (ok) passed++;
			else {
				failed++;
				failures.push({ label: c.label, detail });
			}
		}
	} finally {
		if (origHome === undefined) delete process.env.HOME;
		else process.env.HOME = origHome;
		cleanup();
		rmSync(tmpHome, { recursive: true, force: true });
	}

	console.log(`\n${passed}/${passed + failed} cases passed`);
	if (failed > 0) {
		console.error(`\nFailures:`);
		for (const f of failures) console.error(`  - ${f.label}\n    ${f.detail}`);
		process.exit(1);
	}
}

main().catch((e) => {
	console.error(e);
	process.exit(2);
});

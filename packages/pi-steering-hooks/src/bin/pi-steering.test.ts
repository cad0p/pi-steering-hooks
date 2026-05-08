// SPDX-License-Identifier: MIT
// Part of pi-steering.

/**
 * Tests for the `pi-steering` CLI (`./pi-steering.ts`).
 *
 * Runs the CLI as a subprocess via `node --experimental-strip-types
 * src/bin/pi-steering.ts …`. This mirrors real invocation (the built
 * shebang script runs under a fresh node) and sidesteps the
 * `node:test` worker's stdout sharing — patching
 * `process.stdout.write` in-process swallows the worker's TAP frames.
 *
 * File IO fixtures live under `mkdtempSync`; each test cleans up its
 * directory in `afterEach`.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// subprocess runner
// ---------------------------------------------------------------------------

const CLI_PATH = resolve(
	dirname(fileURLToPath(import.meta.url)),
	"pi-steering.ts",
);

interface RunResult {
	code: number;
	stdout: string;
	stderr: string;
}

/**
 * Run the CLI as a child process under `node --experimental-strip-types`.
 * Returns the exit code and captured stdout/stderr. Never throws for
 * non-zero exit codes — the caller asserts on `code`.
 *
 * Accepts an optional `cwd` so tests for the `list` subcommand can
 * point the walk-up loader at a scratch directory without polluting
 * the project.
 */
function runCli(...args: string[]): Promise<RunResult>;
function runCli(
	opts: { cwd?: string },
	...args: string[]
): Promise<RunResult>;
function runCli(
	first?: string | { cwd?: string },
	...rest: string[]
): Promise<RunResult> {
	let cwd: string | undefined;
	let args: string[];
	if (typeof first === "object" && first !== null) {
		cwd = first.cwd;
		args = rest;
	} else {
		args = first === undefined ? [...rest] : [first, ...rest];
	}
	return new Promise((resolvePromise, rejectPromise) => {
		const child = spawn(
			process.execPath,
			["--experimental-strip-types", CLI_PATH, ...args],
			{
				stdio: ["ignore", "pipe", "pipe"],
				...(cwd !== undefined ? { cwd } : {}),
			},
		);
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk: string) => {
			stderr += chunk;
		});
		child.on("error", rejectPromise);
		child.on("close", (code) => {
			// Filter the Node experimental-strip-types warning so tests
			// assert against clean stderr. The warning is
			// version-dependent; drop any line mentioning it.
			const cleanedStderr = stderr
				.split("\n")
				.filter((line) => !/ExperimentalWarning/.test(line))
				.filter((line) => !/Use `node --trace-warnings/.test(line))
				.join("\n");
			resolvePromise({
				code: code ?? -1,
				stdout,
				stderr: cleanedStderr,
			});
		});
	});
}

// ---------------------------------------------------------------------------
// tmpdir fixture
// ---------------------------------------------------------------------------

let scratch: string;

beforeEach(() => {
	scratch = mkdtempSync(join(tmpdir(), "pi-steering-cli-"));
});

afterEach(() => {
	rmSync(scratch, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// top-level
// ---------------------------------------------------------------------------

describe("pi-steering CLI: help + dispatch", () => {
	it("--help prints usage and exits 0", async () => {
		const r = await runCli("--help");
		assert.equal(r.code, 0);
		assert.match(r.stdout, /pi-steering — tools for/);
		assert.match(r.stdout, /import-json/);
		assert.match(r.stdout, /list \[--format=/);
		assert.equal(r.stderr.trim(), "");
	});

	it("-h prints usage and exits 0", async () => {
		const r = await runCli("-h");
		assert.equal(r.code, 0);
		assert.match(r.stdout, /USAGE/);
	});

	it("no args prints usage and exits 0", async () => {
		const r = await runCli();
		assert.equal(r.code, 0);
		assert.match(r.stdout, /USAGE/);
	});

	it("unknown subcommand writes to stderr and exits 1", async () => {
		const r = await runCli("migrate");
		assert.equal(r.code, 1);
		assert.match(r.stderr, /unknown subcommand "migrate"/);
		// Help still gets written to stdout for context.
		assert.match(r.stdout, /USAGE/);
	});
});

// ---------------------------------------------------------------------------
// import-json: argument parsing
// ---------------------------------------------------------------------------

describe("pi-steering import-json: argument parsing", () => {
	it("requires an input file", async () => {
		const r = await runCli("import-json");
		assert.equal(r.code, 1);
		assert.match(r.stderr, /requires an input file/);
	});

	it("rejects unknown flags", async () => {
		const r = await runCli("import-json", "--nope");
		assert.equal(r.code, 1);
		assert.match(r.stderr, /unknown flag "--nope"/);
	});

	it("rejects -o without an argument", async () => {
		const r = await runCli("import-json", "input.json", "-o");
		assert.equal(r.code, 1);
		assert.match(r.stderr, /-o requires an argument/);
	});

	it("rejects more than one positional argument", async () => {
		const r = await runCli("import-json", "a.json", "b.json");
		assert.equal(r.code, 1);
		assert.match(r.stderr, /too many positional arguments/);
	});
});

// ---------------------------------------------------------------------------
// import-json: IO error paths
// ---------------------------------------------------------------------------

describe("pi-steering import-json: IO errors", () => {
	it("missing file -> stderr + exit 1", async () => {
		const r = await runCli("import-json", join(scratch, "nope.json"));
		assert.equal(r.code, 1);
		assert.match(r.stderr, /cannot read /);
	});

	it("invalid JSON -> stderr + exit 1", async () => {
		const path = join(scratch, "bad.json");
		writeFileSync(path, "{ not json", "utf8");
		const r = await runCli("import-json", path);
		assert.equal(r.code, 1);
		assert.match(r.stderr, /not valid JSON/);
	});
});

// ---------------------------------------------------------------------------
// import-json: happy path
// ---------------------------------------------------------------------------

const VALID_V1 = {
	disable: ["no-force-push"],
	rules: [
		{
			name: "no-amend",
			tool: "bash",
			field: "command",
			pattern: "^git\\s+commit\\b.*--amend",
			reason: "Don't rewrite history.",
		},
	],
};

describe("pi-steering import-json: conversion", () => {
	it("stdout mode: writes defineConfig output and exits 0", async () => {
		const path = join(scratch, "steering.json");
		writeFileSync(path, JSON.stringify(VALID_V1), "utf8");

		const r = await runCli("import-json", path);
		assert.equal(r.code, 0);
		assert.equal(r.stderr.trim(), "");
		assert.match(
			r.stdout,
			/import \{ defineConfig \} from "pi-steering"/,
		);
		assert.match(r.stdout, /export default defineConfig\(/);
		assert.match(r.stdout, /"no-amend"/);
		assert.match(r.stdout, /"Don't rewrite history\."/);
		// Preserve the `disable` field verbatim.
		assert.match(r.stdout, /"disable":\s*\[\s*"no-force-push"\s*\]/);
	});

	it("-o mode: writes file + reports path, exits 0", async () => {
		const inputPath = join(scratch, "steering.json");
		const outputPath = join(scratch, "steering.ts");
		writeFileSync(inputPath, JSON.stringify(VALID_V1), "utf8");

		const r = await runCli("import-json", inputPath, "-o", outputPath);
		assert.equal(r.code, 0);
		assert.match(r.stdout, new RegExp(`Wrote ${outputPath}`));
		assert.equal(r.stderr.trim(), "");

		const written = readFileSync(outputPath, "utf8");
		assert.match(written, /import \{ defineConfig \}/);
		assert.match(written, /"no-amend"/);
		// The generated file should be valid enough that a user can
		// drop it in and `tsc --noEmit` it. Sanity check: trailing
		// newline, no BOM.
		assert.ok(written.endsWith("\n"));
		assert.ok(!written.startsWith("\uFEFF"));
	});

	it("--output long form works the same as -o", async () => {
		const inputPath = join(scratch, "steering.json");
		const outputPath = join(scratch, "out.ts");
		writeFileSync(inputPath, JSON.stringify(VALID_V1), "utf8");

		const r = await runCli("import-json", inputPath, "--output", outputPath);
		assert.equal(r.code, 0);
		const written = readFileSync(outputPath, "utf8");
		assert.match(written, /defineConfig/);
	});

	it("FromJSONError propagates as exit 2 with path info", async () => {
		// `plugins` is a v2-only construct; `fromJSON` rejects it.
		const inputPath = join(scratch, "steering.json");
		writeFileSync(
			inputPath,
			JSON.stringify({ plugins: [{ name: "git" }] }),
			"utf8",
		);

		const r = await runCli("import-json", inputPath);
		assert.equal(r.code, 2);
		assert.match(r.stderr, /conversion failed at <root>\.plugins/);
		assert.equal(r.stdout, "");
	});
});

// ---------------------------------------------------------------------------
// `list` subcommand
// ---------------------------------------------------------------------------

/**
 * Write a minimal steering config at `dir/.pi/steering/index.ts`. The
 * module body is `export default { ... } satisfies SteeringConfig;`
 * with a local type stub so the config doesn't need to resolve the
 * `pi-steering` package from the scratch dir.
 */
function writeScratchConfig(dir: string, body: string): void {
	const pi = join(dir, ".pi", "steering");
	mkdirSync(pi, { recursive: true });
	writeFileSync(join(pi, "index.ts"), body, "utf8");
}

describe("pi-steering list", () => {
	it("prints 'no config' when no .pi/steering exists", async () => {
		const r = await runCli({ cwd: scratch }, "list");
		assert.equal(r.code, 0);
		assert.match(r.stdout, /No steering config found\./);
	});

	it("--format=json with no config returns empty structure", async () => {
		const r = await runCli({ cwd: scratch }, "list", "--format=json");
		assert.equal(r.code, 0);
		const parsed = JSON.parse(r.stdout) as {
			plugins: unknown[];
			userRules: unknown[];
			disabled: { rules: unknown[] };
		};
		assert.deepEqual(parsed.plugins, []);
		assert.deepEqual(parsed.userRules, []);
		assert.deepEqual(parsed.disabled.rules, []);
	});

	it("text format groups plugin + user rules and lists disables", async () => {
		writeScratchConfig(
			scratch,
			`export default {
				plugins: [
					{
						name: "git",
						rules: [
							{
								name: "no-main-commit",
								tool: "bash",
								field: "command",
								pattern: /^git\\s+commit/,
								when: { branch: /^main$/ },
								reason: "no",
							},
						],
					},
				],
				rules: [
					{
						name: "my-rule",
						tool: "bash",
						field: "command",
						pattern: /^echo/,
						reason: "no",
					},
				],
				disable: ["some-disabled-rule"],
			};`,
		);
		const r = await runCli({ cwd: scratch }, "list");
		assert.equal(r.code, 0);
		assert.match(
			r.stdout,
			/Resolved config: 1 plugin, 2 rules, 0 observers\./,
		);
		assert.match(r.stdout, /git\s+\[pi-steering\/plugins\/git\]/);
		assert.match(r.stdout, /no-main-commit\s+bash\s+when: branch/);
		assert.match(r.stdout, /User \(\.pi\/steering\/index\.ts\):/);
		assert.match(r.stdout, /my-rule\s+bash/);
		assert.match(r.stdout, /Disabled rules: some-disabled-rule/);
	});

	it("--format=json emits a parseable structure with all sections", async () => {
		writeScratchConfig(
			scratch,
			`export default {
				plugins: [{ name: "git", rules: [] }],
				rules: [
					{
						name: "u1",
						tool: "bash",
						field: "command",
						pattern: /^ls/,
						reason: "no",
					},
				],
				observers: [
					{
						name: "obs1",
						writes: ["thing-happened"],
						onResult: () => {},
					},
				],
			};`,
		);
		const r = await runCli({ cwd: scratch }, "list", "--format=json");
		assert.equal(r.code, 0);
		const parsed = JSON.parse(r.stdout) as {
			plugins: Array<{ name: string; source?: string; rules: unknown[] }>;
			userRules: Array<{ name: string; tool: string }>;
			userObservers: Array<{ name: string; writes: string[] }>;
			disabled: { rules: unknown[]; plugins: unknown[] };
		};
		assert.equal(parsed.plugins[0]?.name, "git");
		assert.equal(parsed.plugins[0]?.source, "pi-steering/plugins/git");
		assert.equal(parsed.userRules[0]?.name, "u1");
		assert.equal(parsed.userObservers[0]?.name, "obs1");
		assert.deepEqual(parsed.userObservers[0]?.writes, ["thing-happened"]);
	});

	it("rejects an unknown --format value", async () => {
		const r = await runCli({ cwd: scratch }, "list", "--format=yaml");
		assert.equal(r.code, 1);
		assert.match(r.stderr, /unknown --format value "yaml"/);
	});

	it("rejects unknown flags", async () => {
		const r = await runCli({ cwd: scratch }, "list", "--nope");
		assert.equal(r.code, 1);
		assert.match(r.stderr, /unknown flag "--nope"/);
	});

	it("list --help prints per-subcommand help", async () => {
		const r = await runCli({ cwd: scratch }, "list", "--help");
		assert.equal(r.code, 0);
		assert.match(r.stdout, /pi-steering list — show the resolved config/);
		assert.match(r.stdout, /--format=text\|json/);
	});

	it("summarizes happened: predicate with its type", async () => {
		writeScratchConfig(
			scratch,
			`export default {
				rules: [
					{
						name: "rq",
						tool: "bash",
						field: "command",
						pattern: /^git push/,
						when: { happened: { type: "tests-passed", in: "agent_loop" } },
						reason: "no",
					},
				],
			};`,
		);
		const r = await runCli({ cwd: scratch }, "list");
		assert.equal(r.code, 0);
		assert.match(r.stdout, /when: happened:tests-passed/);
	});

	it("marks disabled rules with '(disabled)' suffix in text output (F4)", async () => {
		writeScratchConfig(
			scratch,
			`export default {
				plugins: [
					{
						name: "git",
						rules: [
							{ name: "active-rule", tool: "bash", field: "command", pattern: /./, reason: "r" },
							{ name: "disabled-rule", tool: "bash", field: "command", pattern: /./, reason: "r" },
						],
					},
				],
				disable: ["disabled-rule"],
			};`,
		);
		const r = await runCli({ cwd: scratch }, "list");
		assert.equal(r.code, 0);
		// Active rule: no suffix.
		assert.match(r.stdout, /active-rule\s+bash\s*$/m);
		// Disabled rule: (disabled) suffix.
		assert.match(r.stdout, /disabled-rule\s+bash\s+\(disabled\)/);
		// Footer unchanged.
		assert.match(r.stdout, /Disabled rules: disabled-rule/);
	});

	it("marks disabled plugins with '(disabled)' suffix on the header (F4)", async () => {
		writeScratchConfig(
			scratch,
			`export default {
				plugins: [
					{
						name: "git",
						rules: [
							{ name: "some-rule", tool: "bash", field: "command", pattern: /./, reason: "r" },
						],
					},
				],
				disablePlugins: ["git"],
			};`,
		);
		const r = await runCli({ cwd: scratch }, "list");
		assert.equal(r.code, 0);
		// Plugin header carries the (disabled) suffix.
		assert.match(r.stdout, /git\s+\[pi-steering\/plugins\/git\]\s+\(disabled\)/);
		assert.match(r.stdout, /Disabled plugins: git/);
	});

	it("JSON output tags disabled rules and plugins with 'disabled: true' (F4)", async () => {
		writeScratchConfig(
			scratch,
			`export default {
				plugins: [
					{
						name: "git",
						rules: [
							{ name: "active-rule", tool: "bash", field: "command", pattern: /./, reason: "r" },
							{ name: "disabled-rule", tool: "bash", field: "command", pattern: /./, reason: "r" },
						],
					},
					{ name: "also-disabled" },
				],
				disable: ["disabled-rule"],
				disablePlugins: ["also-disabled"],
			};`,
		);
		const r = await runCli({ cwd: scratch }, "list", "--format=json");
		assert.equal(r.code, 0);
		const parsed = JSON.parse(r.stdout) as {
			plugins: Array<{
				name: string;
				disabled?: boolean;
				rules: Array<{ name: string; disabled?: boolean }>;
			}>;
		};
		const git = parsed.plugins.find((p) => p.name === "git");
		const also = parsed.plugins.find((p) => p.name === "also-disabled");
		assert.ok(git);
		assert.ok(also);
		assert.equal(git.disabled, undefined, "git plugin is active; no disabled flag");
		assert.equal(also.disabled, true, "also-disabled plugin carries disabled: true");
		const active = git.rules.find((r) => r.name === "active-rule");
		const disabled = git.rules.find((r) => r.name === "disabled-rule");
		assert.ok(active);
		assert.ok(disabled);
		assert.equal(active.disabled, undefined);
		assert.equal(disabled.disabled, true);
	});
});

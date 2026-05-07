// SPDX-License-Identifier: MIT
// Part of @cad0p/pi-steering-hooks.

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
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
 */
function runCli(...args: string[]): Promise<RunResult> {
	return new Promise((resolvePromise, rejectPromise) => {
		const child = spawn(
			process.execPath,
			["--experimental-strip-types", CLI_PATH, ...args],
			{ stdio: ["ignore", "pipe", "pipe"] },
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
			/import \{ defineConfig \} from "@cad0p\/pi-steering-hooks"/,
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

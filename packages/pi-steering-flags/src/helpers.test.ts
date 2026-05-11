// SPDX-License-Identifier: MIT
// Part of pi-steering-flags.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Word } from "pi-steering";
import { INFO_ONLY, getFlagValue, hasEnvAssignment, hasFlag } from "./helpers.ts";

/** Minimal Word for tests — tests don't exercise the walker, just the helpers. */
function W(value: string): Word {
	return { value, text: value, pos: 0, end: value.length } as Word;
}

describe("hasFlag", () => {
	it("finds bare flag", () => {
		assert.equal(hasFlag([W("--profile"), W("dev")], "--profile"), true);
	});

	it("finds attached-value flag", () => {
		assert.equal(hasFlag([W("--profile=dev")], "--profile"), true);
	});

	it("does not confuse prefix collisions (--profile-foo vs --profile)", () => {
		assert.equal(hasFlag([W("--profile-foo")], "--profile"), false);
	});

	it("handles empty args", () => {
		assert.equal(hasFlag([], "--profile"), false);
	});

	it("handles undefined args", () => {
		assert.equal(hasFlag(undefined, "--profile"), false);
	});

	it("finds short flag", () => {
		assert.equal(hasFlag([W("-p"), W("dev")], "-p"), true);
	});

	it("does not match flag appearing as a positional value", () => {
		// `cmd --profile-unrelated --profile dev` — the first token
		// is a different flag, the second is ours.
		assert.equal(
			hasFlag([W("--profile-unrelated"), W("--profile"), W("dev")], "--profile"),
			true,
		);
	});
});

describe("getFlagValue", () => {
	it("returns value for separated form", () => {
		assert.equal(
			getFlagValue([W("--profile"), W("dev")], "--profile"),
			"dev",
		);
	});

	it("returns value for attached form", () => {
		assert.equal(getFlagValue([W("--profile=dev")], "--profile"), "dev");
	});

	it("returns empty-string attached form as ''", () => {
		// `--profile=` is a flag with an empty attached value; callers
		// can check against `""` if they need to differentiate.
		assert.equal(getFlagValue([W("--profile=")], "--profile"), "");
	});

	it("returns null when flag is trailing (no value)", () => {
		assert.equal(getFlagValue([W("--profile")], "--profile"), null);
	});

	it("returns null when flag is absent", () => {
		assert.equal(getFlagValue([W("other")], "--profile"), null);
	});

	it("returns null when args is undefined", () => {
		assert.equal(getFlagValue(undefined, "--profile"), null);
	});

	it("returns the next token even if it looks like a flag", () => {
		// Documented behavior: callers who want strict validation
		// should post-check the return.
		assert.equal(
			getFlagValue([W("--profile"), W("--other-flag")], "--profile"),
			"--other-flag",
		);
	});
});

describe("hasEnvAssignment", () => {
	it("finds AWS_PROFILE= prefix in envAssignments", () => {
		assert.equal(
			hasEnvAssignment([W("AWS_PROFILE=dev")], "AWS_PROFILE"),
			true,
		);
	});

	it("does not match partial variable names (AWS vs AWS_PROFILE)", () => {
		assert.equal(hasEnvAssignment([W("AWS_PROFILE=dev")], "AWS"), false);
	});

	it("finds one of several assignments", () => {
		assert.equal(
			hasEnvAssignment(
				[W("PATH=/usr/bin"), W("AWS_PROFILE=dev"), W("DEBUG=1")],
				"AWS_PROFILE",
			),
			true,
		);
	});

	it("returns false on empty envAssignments", () => {
		assert.equal(hasEnvAssignment([], "AWS_PROFILE"), false);
	});

	it("returns false on undefined envAssignments", () => {
		assert.equal(hasEnvAssignment(undefined, "AWS_PROFILE"), false);
	});
});

describe("INFO_ONLY", () => {
	it("matches -h", () => {
		assert.ok(INFO_ONLY.test("cr -h"));
	});

	it("matches --help", () => {
		assert.ok(INFO_ONLY.test("cr --help"));
	});

	it("matches -v", () => {
		assert.ok(INFO_ONLY.test("cr -v"));
	});

	it("matches --version", () => {
		assert.ok(INFO_ONLY.test("cr --version"));
	});

	it("does NOT match --helpful (word-boundary)", () => {
		assert.ok(!INFO_ONLY.test("cr --helpful"));
	});

	it("does NOT match -hh", () => {
		assert.ok(!INFO_ONLY.test("cr -hh"));
	});

	it("does NOT match when there is no flag", () => {
		assert.ok(!INFO_ONLY.test("cr --description foo.md"));
	});
});

// SPDX-License-Identifier: MIT
// Part of @cad0p/pi-steering-hooks.

/**
 * Tests for the git plugin's shipped rules (`./rules.ts`).
 *
 * These verify the rule definitions themselves - pattern shape,
 * `when` wiring, `noOverride` semantics - against the evaluator
 * pipeline. Each test constructs a minimal config with the plugin
 * loaded and runs a bash tool_call through `buildEvaluator`.
 *
 * End-to-end wiring (walker branch state driving predicate behavior,
 * plugin registration) is in `./integration.test.ts`; this file
 * focuses on the rule definition's static shape.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type {
	BashToolCallEvent,
	ExecResult as PiExecResult,
} from "@earendil-works/pi-coding-agent";
import {
	makeCtx,
	makeTrackedHost,
} from "../../v2/__test-helpers__.ts";
import { buildEvaluator } from "../../v2/evaluator.ts";
import { resolvePlugins } from "../../v2/plugin-merger.ts";
import gitPlugin from "./index.ts";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function bashEvent(command: string): BashToolCallEvent {
	return {
		type: "tool_call",
		toolCallId: "t1",
		toolName: "bash",
		input: { command },
	};
}

/**
 * Build an evaluator that includes the git plugin with a stub `exec`
 * returning the given fake branch on `git branch --show-current`.
 * Every other `git` call returns exit 1 so predicates fall back to
 * their `onUnknown` policy.
 */
function buildWithBranch(branchName: string) {
	const host = makeTrackedHost({
		exec: async (cmd, args): Promise<PiExecResult> => {
			if (
				cmd === "git" &&
				args[0] === "branch" &&
				args[1] === "--show-current"
			) {
				return {
					stdout: `${branchName}\n`,
					stderr: "",
					code: 0,
					killed: false,
				};
			}
			return { stdout: "", stderr: "", code: 1, killed: false };
		},
	});
	const resolved = resolvePlugins([gitPlugin], {});
	const evaluator = buildEvaluator({}, resolved, host);
	return { evaluator, host };
}

// ---------------------------------------------------------------------------
// no-main-commit
// ---------------------------------------------------------------------------

describe("rules: no-main-commit shape", () => {
	it("exists on the plugin with the expected name + pattern + overridable flag", () => {
		const rule = gitPlugin.rules?.find((r) => r.name === "no-main-commit");
		assert.ok(rule);
		assert.equal(rule.tool, "bash");
		assert.equal(rule.field, "command");
		assert.equal(rule.noOverride, false);
		assert.ok(
			typeof rule.pattern === "string"
				? rule.pattern.includes("commit")
				: rule.pattern.source.includes("commit"),
		);
		assert.ok(
			rule.when !== undefined &&
				"branch" in (rule.when as Record<string, unknown>),
		);
	});

	it("fires on `git commit` when branch predicate resolves to main", async () => {
		const { evaluator } = buildWithBranch("main");
		const res = await evaluator.evaluate(
			bashEvent("git commit -m 'x'"),
			makeCtx("/repo"),
			0,
		);
		assert.ok(res && res.block === true);
		assert.match(res.reason!, /\[steering:no-main-commit@[^\]]+\]/);
	});

	it("allows `git commit` on a feature branch", async () => {
		const { evaluator } = buildWithBranch("feat-login");
		const res = await evaluator.evaluate(
			bashEvent("git commit -m 'x'"),
			makeCtx("/repo"),
			0,
		);
		assert.equal(res, undefined);
	});

	it("fires on each protected-branch alias (master / mainline / trunk)", async () => {
		for (const branchName of ["master", "mainline", "trunk"]) {
			const { evaluator } = buildWithBranch(branchName);
			const res = await evaluator.evaluate(
				bashEvent("git commit -m 'x'"),
				makeCtx("/repo"),
				0,
			);
			assert.ok(
				res && res.block === true,
				`expected block for branch=${branchName}`,
			);
		}
	});

	it("does NOT fire on git log (non-commit subcommand) even on main", async () => {
		const { evaluator } = buildWithBranch("main");
		const res = await evaluator.evaluate(
			bashEvent("git log --oneline"),
			makeCtx("/repo"),
			0,
		);
		assert.equal(res, undefined);
	});

	it("catches `git -C /other commit` via pre-subcommand flag slot", async () => {
		const { evaluator } = buildWithBranch("main");
		const res = await evaluator.evaluate(
			bashEvent("git -C /other commit -m 'x'"),
			makeCtx("/repo"),
			0,
		);
		assert.ok(res && res.block === true);
	});

	it("overridable via `# steering-override: no-main-commit` comment", async () => {
		// noOverride: false on the rule - author-supplied override
		// comment on the raw tool_call command is accepted, the event
		// doesn't block, and the override is audit-logged.
		const { evaluator, host } = buildWithBranch("main");
		const res = await evaluator.evaluate(
			bashEvent(
				"git commit -m 'release' # steering-override: no-main-commit - release bump",
			),
			makeCtx("/repo"),
			0,
		);
		assert.equal(res, undefined);
		assert.ok(
			host.appended.some((e) => e.type === "steering-override"),
			"expected a steering-override audit entry",
		);
	});
});

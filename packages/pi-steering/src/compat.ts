// SPDX-License-Identifier: MIT
// Part of pi-steering.

/**
 * `fromJSON` — convert the v1 JSON config shape to a v2
 * {@link SteeringConfig}.
 *
 * Per the accepted ADR ("Design → File layout and loader behavior"):
 * JSON is not a first-class config format in v2. `fromJSON` exists so
 * `.pi/steering.json` files authored against the PoC shape can be
 * loaded programmatically — either as a library call (this module)
 * or via the `pi-steering import-json` CLI wrapping it.
 *
 * Scope:
 *
 *   - Top-level v1 fields: `disable`, `defaultNoOverride`, `rules`.
 *   - Rule fields: `name`, `tool`, `field`, `pattern` (stays a string —
 *     v2 accepts `string | RegExp`), `requires`, `unless`, `reason`,
 *     `noOverride`, `when.cwd` (string pattern).
 *
 * Rejected (throws):
 *
 *   - Plugins (JSON can't express function-typed handlers).
 *   - Observers (ditto — `onResult` is a function).
 *   - Function-valued fields on rules (ditto).
 *   - `when.<customKey>` — plugin-registered predicates have no
 *     JSON-expressible binding.
 *   - `when.not` or `when.condition` (also function-shaped or recursive).
 *
 * Callers that hit one of the rejection cases should author the
 * offending rule / plugin directly in TypeScript; `fromJSON` is only
 * for the trivial pattern-string path.
 */

import type { Rule, SteeringConfig, WhenClause } from "./schema.ts";

/**
 * Error thrown when the input JSON uses a feature the v1 → v2 helper
 * can't represent. Carries a `path` pointing at the offending location
 * (e.g. `rules[2].when.branch`) so callers can point the user at the
 * rule to rewrite in TypeScript.
 */
export class FromJSONError extends Error {
	readonly path: string;

	constructor(message: string, path: string) {
		super(`${message} (at ${path})`);
		this.name = "FromJSONError";
		this.path = path;
	}
}

/** Narrow `unknown` to a plain (non-array) object. */
function isPlainObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Convert v1 JSON into a v2 {@link SteeringConfig}.
 *
 * The input is typed `unknown` deliberately — this helper accepts
 * whatever came out of `JSON.parse`, validates the shape, and throws
 * {@link FromJSONError} on anything it can't represent.
 */
export function fromJSON(json: unknown): SteeringConfig {
	if (!isPlainObject(json)) {
		throw new FromJSONError(
			"expected a JSON object at the top level",
			"<root>",
		);
	}

	// Pre-flight: loudly reject v2-only keys that shouldn't appear in
	// v1 JSON. If a user lands here by mistake (e.g. calling fromJSON
	// on an already-v2 object), we'd rather tell them than silently
	// drop their plugins / observers.
	for (const forbidden of [
		"plugins",
		"observers",
		"disablePlugins",
		"disabledPlugins",
		"disabledRules",
		"disableDefaults",
	] as const) {
		if (forbidden in json) {
			throw new FromJSONError(
				`JSON config cannot express \`${forbidden}\`; ` +
					`author that configuration directly in TypeScript instead`,
				`<root>.${forbidden}`,
			);
		}
	}

	const out: SteeringConfig = {};

	if ("disable" in json) {
		const disable = json["disable"];
		if (!Array.isArray(disable) || !disable.every((x) => typeof x === "string")) {
			throw new FromJSONError(
				"`disable` must be a string array",
				"<root>.disable",
			);
		}
		// v1 JSON's `disable` → v2 TS `disabledRules`. The JSON key is
		// preserved for legacy on-disk configs; the TS shape uses the
		// past-participle form.
		out.disabledRules = [...disable];
	}

	if ("defaultNoOverride" in json) {
		const v = json["defaultNoOverride"];
		if (typeof v !== "boolean") {
			throw new FromJSONError(
				"`defaultNoOverride` must be a boolean",
				"<root>.defaultNoOverride",
			);
		}
		out.defaultNoOverride = v;
	}

	if ("rules" in json) {
		const rules = json["rules"];
		if (!Array.isArray(rules)) {
			throw new FromJSONError(
				"`rules` must be an array",
				"<root>.rules",
			);
		}
		out.rules = rules.map((rule, i) =>
			convertRule(rule, `<root>.rules[${i}]`),
		);
	}

	return out;
}

/** Convert a single v1 JSON rule, scoping errors with `path`. */
function convertRule(raw: unknown, path: string): Rule {
	if (!isPlainObject(raw)) {
		throw new FromJSONError("rule must be an object", path);
	}

	// Required: name, tool, field, pattern, reason.
	const name = raw["name"];
	if (typeof name !== "string" || name.length === 0) {
		throw new FromJSONError("`name` must be a non-empty string", `${path}.name`);
	}
	const tool = raw["tool"];
	if (tool !== "bash" && tool !== "write" && tool !== "edit") {
		throw new FromJSONError(
			"`tool` must be one of 'bash' | 'write' | 'edit'",
			`${path}.tool`,
		);
	}
	const field = raw["field"];
	if (field !== "command" && field !== "path" && field !== "content") {
		throw new FromJSONError(
			"`field` must be one of 'command' | 'path' | 'content'",
			`${path}.field`,
		);
	}
	// Validate the (tool, field) combination per the discriminated
	// Rule union: bash rules test against `command`; write / edit
	// rules test against `path` or `content`.
	if (tool === "bash" && field !== "command") {
		throw new FromJSONError(
			`bash rules must use \`field: "command"\` (got "${field}")`,
			`${path}.field`,
		);
	}
	if ((tool === "write" || tool === "edit") && field === "command") {
		throw new FromJSONError(
			`${tool} rules must use \`field: "path"\` or \`field: "content"\` ` +
				`(got "command")`,
			`${path}.field`,
		);
	}
	const pattern = raw["pattern"];
	if (typeof pattern !== "string") {
		throw new FromJSONError(
			"JSON rules must use a string `pattern` (v2 accepts RegExp in TS)",
			`${path}.pattern`,
		);
	}
	const reason = raw["reason"];
	if (typeof reason !== "string") {
		throw new FromJSONError(
			"`reason` must be a string",
			`${path}.reason`,
		);
	}

	const rule: Rule =
		tool === "bash"
			? { name, tool, field: "command", pattern, reason }
			: {
					name,
					tool,
					// Narrowed by the (tool, field) check above.
					field: field as "path" | "content",
					pattern,
					reason,
				};

	// Optional: requires / unless (string patterns only).
	if ("requires" in raw) {
		const v = raw["requires"];
		if (typeof v !== "string") {
			throw new FromJSONError(
				"JSON rules must use string `requires` (functions aren't JSON-expressible)",
				`${path}.requires`,
			);
		}
		rule.requires = v;
	}
	if ("unless" in raw) {
		const v = raw["unless"];
		if (typeof v !== "string") {
			throw new FromJSONError(
				"JSON rules must use string `unless` (functions aren't JSON-expressible)",
				`${path}.unless`,
			);
		}
		rule.unless = v;
	}

	// Optional: noOverride.
	if ("noOverride" in raw) {
		const v = raw["noOverride"];
		if (typeof v !== "boolean") {
			throw new FromJSONError(
				"`noOverride` must be a boolean",
				`${path}.noOverride`,
			);
		}
		rule.noOverride = v;
	}

	// Optional: when. V1 JSON supports only `when.cwd` (string pattern).
	// Every other key under `when` is plugin-specific and can't be
	// expressed in JSON.
	if ("when" in raw) {
		rule.when = convertWhen(raw["when"], `${path}.when`);
	}

	// V1 JSON has no `observer` field — observers are v2-only. But if
	// someone hand-edits `observer: "name"` into their JSON, warn loudly.
	if ("observer" in raw) {
		throw new FromJSONError(
			"JSON rules cannot reference observers; observers are v2-only (TS)",
			`${path}.observer`,
		);
	}

	return rule;
}

/** Convert the v1 `when` object into a v2 {@link WhenClause}. */
function convertWhen(raw: unknown, path: string): WhenClause {
	if (!isPlainObject(raw)) {
		throw new FromJSONError("`when` must be an object", path);
	}
	const out: WhenClause = {};
	for (const key of Object.keys(raw)) {
		if (key !== "cwd") {
			throw new FromJSONError(
				`JSON config cannot express \`when.${key}\`; ` +
					`plugin-registered predicates and \`when.not\` / \`when.condition\` are v2-only (TS)`,
				`${path}.${key}`,
			);
		}
	}
	if ("cwd" in raw) {
		const v = raw["cwd"];
		if (typeof v !== "string") {
			throw new FromJSONError(
				"JSON `when.cwd` must be a string pattern",
				`${path}.cwd`,
			);
		}
		out.cwd = v;
	}
	return out;
}

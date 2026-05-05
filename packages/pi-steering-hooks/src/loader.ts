// SPDX-License-Identifier: MIT
// Part of @cad0p/pi-steering-hooks.

/**
 * Config discovery and merging.
 *
 * Walks from the session cwd up to `$HOME` / filesystem root collecting
 * `steering.json` files, plus a global baseline at `~/.pi/agent/steering.json`.
 * Configs are returned outermost-first so `buildRules` can apply later
 * layers (inner ancestors, then cwd) on top of earlier ones.
 *
 * Precedence (applied by `buildRules`):
 *   defaults → global → outermost ancestor → ... → cwd
 *
 * Rule lookup is by `name`; later layers override earlier ones.
 * `disable[]` entries are additive (union across all layers).
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Rule, SteeringConfig } from "./schema.ts";

/**
 * Parse a `steering.json` file. Returns an empty config on any parse error —
 * the loader is best-effort by design: we'd rather run with the default ruleset
 * than crash the session because one ancestor directory has malformed JSON.
 */
export function parseConfig(path: string): SteeringConfig {
	try {
		const raw = readFileSync(path, "utf8");
		const parsed = JSON.parse(raw) as SteeringConfig;
		// Light shape normalization. Trust the type at runtime — the evaluator
		// is defensive about missing fields anyway.
		const out: SteeringConfig = {};
		if (Array.isArray(parsed.disable)) out.disable = parsed.disable;
		if (Array.isArray(parsed.rules)) out.rules = parsed.rules;
		return out;
	} catch {
		return {};
	}
}

/**
 * Walk from `cwd` up to `$HOME` (or filesystem root, whichever comes first),
 * collecting every `steering.json` found. Returns the ordered list
 * `[global, outermost-ancestor, ..., cwd]` — so inner layers come last.
 *
 * The global baseline lives at `$HOME/.pi/agent/steering.json`. If `$HOME` is
 * unset we still walk to the filesystem root.
 */
export function loadConfigs(cwd: string): SteeringConfig[] {
	const home = process.env.HOME ?? "";
	const configs: SteeringConfig[] = [];

	// Global baseline (prepended so it applies before any ancestor layer).
	if (home !== "") {
		const globalPath = join(home, ".pi", "agent", "steering.json");
		if (existsSync(globalPath)) configs.push(parseConfig(globalPath));
	}

	// Walk up from cwd to $HOME (inclusive), collect ancestors outermost-first.
	const ancestors: string[] = [];
	const seen = new Set<string>();
	let current = cwd;
	while (true) {
		if (seen.has(current)) break; // symlink-loop guard
		seen.add(current);
		ancestors.push(current);
		if (current === home || current === "/") break;
		const parent = dirname(current);
		if (parent === current) break; // filesystem root (`dirname("/") === "/"`)
		current = parent;
	}
	ancestors.reverse(); // outermost first

	for (const dir of ancestors) {
		const p = join(dir, "steering.json");
		if (existsSync(p)) configs.push(parseConfig(p));
	}

	return configs;
}

/**
 * Merge configs into the final rule list. Later layers override earlier ones
 * by rule `name`. `disable[]` is additive (union across all layers).
 *
 * Precedence applied to the `configs` argument (caller supplies outermost-first):
 *
 *   defaults ← overridden by configs[0] ← ... ← configs[n-1]
 *
 * Rules whose name appears in the accumulated `disable` set are filtered out.
 */
export function buildRules(
	configs: readonly SteeringConfig[],
	defaults: readonly Rule[],
): Rule[] {
	const byName = new Map<string, Rule>();
	for (const r of defaults) byName.set(r.name, r);

	const disabled = new Set<string>();
	for (const cfg of configs) {
		if (cfg.disable) for (const name of cfg.disable) disabled.add(name);
		if (cfg.rules) for (const r of cfg.rules) byName.set(r.name, r);
	}

	const out: Rule[] = [];
	for (const rule of byName.values()) {
		if (disabled.has(rule.name)) continue;
		out.push(rule);
	}
	return out;
}

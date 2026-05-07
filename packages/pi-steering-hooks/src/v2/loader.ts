// SPDX-License-Identifier: MIT
// Part of @cad0p/pi-steering-hooks.

/**
 * TS-only config loader — walk-up discovery + merge.
 *
 * Per the accepted ADR ("Design → File layout and loader behavior"):
 *
 *   - Walk up from the session cwd to `$HOME` (inclusive), checking each
 *     layer for `.pi/steering/index.ts` FIRST, then `.pi/steering.ts`.
 *     First hit wins per layer. A bare `<ancestor>/steering.ts` is
 *     intentionally NOT discovered.
 *   - Inner (closer to session cwd) layers take precedence on name
 *     collisions — matches pi's project-local → global convention and
 *     the v1 JSON loader's inner-over-outer semantics.
 *   - Node ≥ 22 required (native type-stripping via `await import()`).
 *     Loader throws a clear "upgrade Node" error on older runtimes.
 *   - File extensions: `.ts` only. Other files under `.pi/steering/` are
 *     warned about and skipped — a user might keep helpers there.
 *
 * Merge semantics ({@link buildConfig}):
 *
 *   - `rules`:            concat; inner layer's rule name overrides outer's.
 *   - `plugins`:          concat in declaration order; inner layers first.
 *   - `observers`:        concat; inner name overrides outer.
 *   - `disable`,
 *     `disablePlugins`:   union across layers.
 *   - `defaultNoOverride`,
 *     `disableDefaults`:  inner wins if set.
 *
 * Engine hard-errors on tracker NAME collisions (two plugins both
 * registering a tracker called `branch`); soft-warns on all other
 * collisions (rule name, observer name, predicate key, tracker-extension
 * `(tracker, basename)` pair).
 *
 * NOTE: this module loads + merges CONFIG SHAPES. It does NOT execute
 * predicates, observers, or resolve plugin wiring. Those are Phase 3's
 * evaluator concerns.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type {
	Observer,
	Plugin,
	Rule,
	SteeringConfig,
} from "./schema.ts";

/**
 * Minimum Node version that supports native `.ts` import via type
 * stripping (without a `--experimental-strip-types` flag). Shipped
 * stable in Node 22.6+. We require 22.x outright to keep the error
 * message simple.
 */
const MIN_NODE_MAJOR = 22;

/**
 * Runtime check: throws with an actionable message when Node is older
 * than the minimum supported version.
 */
function assertNodeVersion(): void {
	const raw = process.versions.node;
	const major = Number.parseInt(raw.split(".")[0] ?? "0", 10);
	if (Number.isNaN(major) || major < MIN_NODE_MAJOR) {
		throw new Error(
			`@cad0p/pi-steering-hooks requires Node >= ${MIN_NODE_MAJOR} ` +
				`for native .ts loading (found ${raw}). ` +
				`Upgrade Node, or stay on v1 JSON configs (\`.pi/steering.json\`).`,
		);
	}
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/**
 * Candidate file paths for a given directory's `.pi/steering/...` slot,
 * in priority order. First existing file wins.
 *
 * Exported for tests — not part of the library's public API.
 */
export function configCandidates(dir: string): string[] {
	return [
		join(dir, ".pi", "steering", "index.ts"),
		join(dir, ".pi", "steering.ts"),
	];
}

/**
 * Return the non-`.ts` files that exist under `<dir>/.pi/steering/` so
 * callers can warn about them. Uses a best-effort fs read: a missing
 * directory returns an empty list.
 */
function unexpectedFilesUnderSteering(dir: string): string[] {
	const steeringDir = join(dir, ".pi", "steering");
	if (!existsSync(steeringDir)) return [];
	try {
		const entries = readdirSync(steeringDir);
		const out: string[] = [];
		for (const name of entries) {
			const full = join(steeringDir, name);
			try {
				const st = statSync(full);
				if (!st.isFile()) continue;
				if (name === "index.ts") continue;
				if (name.endsWith(".ts")) continue; // allow helpers like `rules.ts`
				out.push(full);
			} catch {
				// skip unreadable entry
			}
		}
		return out;
	} catch {
		return [];
	}
}

/**
 * Walk up from `cwd` to `$HOME` (inclusive, or to the filesystem root
 * if HOME is unset / outside the cwd's ancestry), returning the list
 * of directories INNER-FIRST — so `[cwd, cwd/parent, ..., HOME]`.
 *
 * Exported for tests.
 */
export function ancestorChain(cwd: string): string[] {
	const home = process.env["HOME"] ?? "";
	const out: string[] = [];
	const seen = new Set<string>();
	let current = resolve(cwd);
	while (true) {
		if (seen.has(current)) break; // symlink-loop guard
		seen.add(current);
		out.push(current);
		if (current === home || current === "/") break;
		const parent = dirname(current);
		if (parent === current) break; // filesystem root
		current = parent;
	}
	return out;
}

/**
 * Find the config file (if any) for a single layer. Returns `null`
 * when neither candidate exists at that layer.
 *
 * Exported for tests.
 */
export function findConfigFile(dir: string): string | null {
	for (const candidate of configCandidates(dir)) {
		if (existsSync(candidate)) return candidate;
	}
	return null;
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

/**
 * Dynamic-import a single config file and return the merged `default`
 * export or the module namespace itself. Accepts either a module that
 * `export default`s a {@link SteeringConfig} or a module whose
 * namespace already matches the config shape.
 *
 * Throws a scoped error when the import fails OR the result isn't an
 * object — the loader surfaces these per-layer without bringing the
 * whole session down (a single bad layer shouldn't nuke the engine).
 */
async function importConfigFile(path: string): Promise<SteeringConfig> {
	const url = pathToFileURL(path).href;
	const mod = (await import(url)) as {
		default?: unknown;
	} & Record<string, unknown>;

	const candidate =
		mod.default !== undefined ? mod.default : (mod as unknown);
	if (candidate === null || typeof candidate !== "object") {
		throw new Error(
			`config at ${path} must export a SteeringConfig object ` +
				`(got ${candidate === null ? "null" : typeof candidate}).`,
		);
	}
	return candidate as SteeringConfig;
}

/**
 * Walk up from `cwd` collecting config layers. Returns INNER-FIRST
 * (caller passes to {@link buildConfig}, which expects inner-first so
 * early entries take precedence on collisions).
 *
 * Errors within a single layer (bad default export, import failure)
 * are logged via `console.warn` and the layer is skipped. This matches
 * the v1 JSON loader's best-effort posture — a broken ancestor config
 * shouldn't prevent the session from starting with a sensible subset.
 *
 * @throws when Node is older than {@link MIN_NODE_MAJOR}.
 */
export async function loadConfigs(cwd: string): Promise<SteeringConfig[]> {
	assertNodeVersion();

	const dirs = ancestorChain(cwd);
	const out: SteeringConfig[] = [];
	for (const dir of dirs) {
		const file = findConfigFile(dir);
		if (file === null) {
			// Warn about stray files under `.pi/steering/` that the
			// loader won't pick up (e.g. `.js`, `.mjs`, `.mts`). Only
			// surface these when the directory exists but has no
			// `index.ts` — otherwise a project without any steering
			// directory would spam the console.
			const steeringDir = join(dir, ".pi", "steering");
			if (existsSync(steeringDir)) {
				for (const stray of unexpectedFilesUnderSteering(dir)) {
					console.warn(
						`[pi-steering-hooks] ignoring non-.ts file under .pi/steering/: ${stray}`,
					);
				}
			}
			continue;
		}
		try {
			out.push(await importConfigFile(file));
		} catch (err) {
			console.warn(
				`[pi-steering-hooks] failed to load config at ${file}: ${String(err)}`,
			);
		}
	}
	return out;
}

// ---------------------------------------------------------------------------
// Merging
// ---------------------------------------------------------------------------

/**
 * Soft-warn helper — shared by the collision detection branches below
 * so the phrasing is consistent and easy to adjust later.
 */
function warnCollision(kind: string, name: string): void {
	console.warn(
		`[pi-steering-hooks] duplicate ${kind} "${name}"; keeping first-registered entry.`,
	);
}

/**
 * Collect plugins across layers, warning on duplicate plugin names.
 * First-registered wins (inner layer is first — matches pi's
 * project-local → global convention).
 */
function mergePlugins(layers: readonly SteeringConfig[]): Plugin[] {
	const seen = new Set<string>();
	const out: Plugin[] = [];
	for (const layer of layers) {
		if (!layer.plugins) continue;
		for (const plugin of layer.plugins) {
			if (seen.has(plugin.name)) {
				warnCollision("plugin", plugin.name);
				continue;
			}
			seen.add(plugin.name);
			out.push(plugin);
		}
	}
	return out;
}

/**
 * Merge rules across layers — inner layer's rule name overrides outer.
 * Declaration order within a layer is preserved; cross-layer order is
 * "first layer that mentions a given rule name wins for its slot".
 */
function mergeRules(layers: readonly SteeringConfig[]): Rule[] {
	const byName = new Map<string, Rule>();
	for (const layer of layers) {
		if (!layer.rules) continue;
		for (const rule of layer.rules) {
			if (!byName.has(rule.name)) {
				byName.set(rule.name, rule);
			}
			// Else: an inner layer already placed this rule. We intentionally
			// do NOT warn here — overriding a rule by name is the documented
			// way to customize behavior from an outer layer.
		}
	}
	return [...byName.values()];
}

/**
 * Merge observers across layers — inner layer's observer name
 * overrides outer. Soft-warn on duplicate names WITHIN a single layer
 * (authoring mistake); cross-layer overrides are silent (intentional
 * customization).
 */
function mergeObservers(layers: readonly SteeringConfig[]): Observer[] {
	const byName = new Map<string, Observer>();
	for (const layer of layers) {
		if (!layer.observers) continue;
		const seenInLayer = new Set<string>();
		for (const obs of layer.observers) {
			if (seenInLayer.has(obs.name)) {
				warnCollision("observer", obs.name);
				continue;
			}
			seenInLayer.add(obs.name);
			if (!byName.has(obs.name)) {
				byName.set(obs.name, obs);
			}
		}
	}
	return [...byName.values()];
}

/**
 * Merge simple string-list fields (`disable`, `disablePlugins`) as a
 * union across layers. Preserves first-seen order for deterministic
 * output in tests.
 */
function mergeStringUnion(
	layers: readonly SteeringConfig[],
	key: "disable" | "disablePlugins",
): string[] | undefined {
	const seen = new Set<string>();
	let any = false;
	for (const layer of layers) {
		const list = layer[key];
		if (list === undefined) continue;
		any = true;
		for (const item of list) seen.add(item);
	}
	return any ? [...seen] : undefined;
}

/**
 * Merge `defaultNoOverride`. Inner wins. If no layer specifies the
 * field AND the caller supplied a `defaults` config, that layer's
 * value is used. Otherwise returns `undefined` — buildConfig callers
 * typically coerce the final undefined into the ADR-mandated `true`
 * at predicate-evaluation time (fail-closed).
 *
 * NOTE we intentionally do NOT bake the `true` default into the
 * merged config here. The merged config reflects what the user
 * declared; Phase 3's evaluator applies the `?? true` fallback when
 * deciding whether overrides are allowed. Keeping the two concerns
 * separate lets tests assert "layers were merged correctly" without
 * also asserting "the fail-closed default was applied".
 */
function mergeBool(
	layers: readonly SteeringConfig[],
	key: "defaultNoOverride" | "disableDefaults",
): boolean | undefined {
	// Layers are passed inner-first. Walk left-to-right and keep the
	// FIRST layer that sets the field — that's the innermost explicit
	// value.
	for (const layer of layers) {
		const v = layer[key];
		if (typeof v === "boolean") return v;
	}
	return undefined;
}

/**
 * Assert no two plugins register a tracker with the same name — a hard
 * error per the ADR ("Precedence: first-wins everywhere" exception:
 * tracker name collisions are always a bug).
 */
function assertTrackerNameUnique(plugins: readonly Plugin[]): void {
	const seen = new Map<string, string>(); // trackerName -> pluginName
	for (const plugin of plugins) {
		if (!plugin.trackers) continue;
		for (const trackerName of Object.keys(plugin.trackers)) {
			const prior = seen.get(trackerName);
			if (prior !== undefined) {
				throw new Error(
					`[pi-steering-hooks] tracker name collision: ` +
						`both plugins "${prior}" and "${plugin.name}" register ` +
						`a tracker called "${trackerName}". Two plugins ` +
						`claiming the same state dimension is always a bug — ` +
						`rename one tracker or disable one plugin.`,
				);
			}
			seen.set(trackerName, plugin.name);
		}
	}
}

/**
 * Warn on soft collisions — predicate keys and tracker extensions.
 * (Rule / observer / plugin collisions are warned during their own
 * merge passes.) First-registered wins in every case.
 */
function warnSoftPluginCollisions(plugins: readonly Plugin[]): void {
	const predicateSeen = new Map<string, string>();
	const extensionSeen = new Map<string, string>(); // "tracker/basename" -> pluginName
	for (const plugin of plugins) {
		if (plugin.predicates) {
			for (const key of Object.keys(plugin.predicates)) {
				const prior = predicateSeen.get(key);
				if (prior !== undefined) {
					warnCollision(`predicate (\`when.${key}\`)`, key);
					continue;
				}
				predicateSeen.set(key, plugin.name);
			}
		}
		if (plugin.trackerExtensions) {
			for (const trackerName of Object.keys(plugin.trackerExtensions)) {
				const extns = plugin.trackerExtensions[trackerName];
				if (!extns) continue;
				for (const basename of Object.keys(extns)) {
					const key = `${trackerName}/${basename}`;
					const prior = extensionSeen.get(key);
					if (prior !== undefined) {
						warnCollision("tracker extension", key);
						continue;
					}
					extensionSeen.set(key, plugin.name);
				}
			}
		}
	}
}

/**
 * Merge `layers` (inner-first) into a single effective
 * {@link SteeringConfig}. An optional `defaults` config is treated as
 * the OUTERMOST layer — its fields apply when no real layer specifies
 * them, otherwise real layers override.
 *
 * Emits soft-warn console.warn calls for non-fatal collisions; throws
 * for tracker-name collisions.
 */
export function buildConfig(
	layers: readonly SteeringConfig[],
	defaults?: SteeringConfig,
): SteeringConfig {
	// Build the effective inner-first layer list. `defaults` goes at
	// the END (outermost position) so inner real layers override it.
	const effective: SteeringConfig[] = [...layers];
	if (defaults !== undefined) effective.push(defaults);

	const plugins = mergePlugins(effective);
	assertTrackerNameUnique(plugins);
	warnSoftPluginCollisions(plugins);

	const rules = mergeRules(effective);
	const observers = mergeObservers(effective);

	const out: SteeringConfig = {};
	if (plugins.length > 0) out.plugins = plugins;
	if (rules.length > 0) out.rules = rules;
	if (observers.length > 0) out.observers = observers;

	const disable = mergeStringUnion(effective, "disable");
	if (disable !== undefined) out.disable = disable;
	const disablePlugins = mergeStringUnion(effective, "disablePlugins");
	if (disablePlugins !== undefined) out.disablePlugins = disablePlugins;

	const defaultNoOverride = mergeBool(effective, "defaultNoOverride");
	if (defaultNoOverride !== undefined) {
		out.defaultNoOverride = defaultNoOverride;
	}
	const disableDefaults = mergeBool(effective, "disableDefaults");
	if (disableDefaults !== undefined) out.disableDefaults = disableDefaults;

	return out;
}

/**
 * Convenience: load all layers for `cwd`, then merge with optional
 * `defaults`. Equivalent to `buildConfig(await loadConfigs(cwd), defaults)`.
 */
export async function loadSteeringConfig(
	cwd: string,
	defaults?: SteeringConfig,
): Promise<SteeringConfig> {
	const layers = await loadConfigs(cwd);
	return buildConfig(layers, defaults);
}

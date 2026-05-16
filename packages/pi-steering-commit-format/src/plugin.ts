// SPDX-License-Identifier: MIT
// Part of pi-steering-commit-format.

/**
 * Default plugin: convenience for the common case (no extension, no
 * custom formats). If you want different formats, build your own
 * predicate via {@link commitFormatFactory} and register it in your
 * own plugin.
 *
 * Mirrors the `pi-steering-flags` shape: `as const satisfies Plugin`
 * preserves literal types so `defineConfig({ plugins: [commitFormatPlugin] })`
 * can cross-reference the predicate names at compile time.
 */

import type { Plugin } from "pi-steering";
import { BUILTIN_FORMATS } from "./builtin-formats.ts";
import { commitFormatFactory } from "./factory.ts";

const commitFormat = commitFormatFactory(BUILTIN_FORMATS);

export const commitFormatPlugin = {
	name: "commit-format",
	predicates: { commitFormat },
} as const satisfies Plugin;

export default commitFormatPlugin;

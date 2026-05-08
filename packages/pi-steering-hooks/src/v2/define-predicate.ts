// SPDX-License-Identifier: MIT
// Part of @cad0p/pi-steering-hooks.

/**
 * `definePredicate<T>` — ~5-LOC helper for declaring typed plugin
 * predicate handlers.
 *
 * Parallels {@link defineConfig} — pure pass-through at runtime, all
 * the value is in the type signature. Internalizes the variance cast
 * that plugin authors currently have to write at both the declaration
 * AND the plug-in site inside `Plugin.predicates`.
 *
 * See ADR §10 for the motivating usage.
 */

import type { PredicateHandler } from "./schema.ts";

/**
 * Wrap a typed {@link PredicateHandler} into the `PredicateHandler`
 * shape the {@link Plugin.predicates} record expects. The handler is
 * returned unchanged at runtime; the cast just sheds the generic
 * argument type so the returned value is assignable to the loose
 * `Record<string, PredicateHandler>` the registry uses.
 *
 * @example
 *   interface CommitFormatArgs {
 *     pattern: RegExp;
 *     onUnknown?: "allow" | "block";
 *   }
 *
 *   export const commitFormat = definePredicate<CommitFormatArgs>(
 *     (args, ctx) => {
 *       // `args` is narrowed to CommitFormatArgs here.
 *       const msg = extractCommitMessage(ctx.input.args ?? []);
 *       return args.pattern.test(msg);
 *     },
 *   );
 *
 *   // Plug into a plugin:
 *   export const gitPlugin: Plugin = {
 *     name: "git",
 *     predicates: { commitFormat },
 *   };
 */
export function definePredicate<T>(
	handler: PredicateHandler<T>,
): PredicateHandler {
	return handler as PredicateHandler;
}

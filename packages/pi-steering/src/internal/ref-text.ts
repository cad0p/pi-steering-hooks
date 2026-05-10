// SPDX-License-Identifier: MIT
// Part of pi-steering.

/**
 * Render a {@link CommandRef} as the string form both the evaluator's
 * `BashRefState.text` and the speculative-entry synthesis's
 * `ToolResultEvent.input.command` shape use.
 *
 * Lives under `internal/` because it's consumed by multiple evaluator
 * modules (evaluator prep, speculative synthesis) and is the canonical
 * way to stringify a ref for observer-watch matching via
 * {@link matchesWatch}. Keeping it here avoids a cyclic import through
 * `evaluator-internals/` and gives downstream refactors a stable import
 * path that doesn't move when evaluator internals are reshuffled.
 *
 * @internal — not part of the public pi-steering surface.
 */

import {
	getBasename,
	getCommandArgs,
	type CommandRef,
} from "unbash-walker";

/**
 * Render a {@link CommandRef} as `"{basename} {args joined by space}"`,
 * trimmed. Empty args produce `"{basename}"` with no trailing space.
 *
 * This string is what observer `watch.inputMatches.command` patterns
 * run against (both for real events via {@link matchesWatch} and for
 * synthetic speculative events via the synthesis helper), so every
 * call site must use this single implementation to avoid drift.
 */
export function refToText(ref: CommandRef): string {
	return `${getBasename(ref)} ${getCommandArgs(ref).join(" ")}`.trim();
}

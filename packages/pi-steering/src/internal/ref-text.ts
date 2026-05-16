// SPDX-License-Identifier: MIT
// Part of pi-steering.

/**
 * Canonical stringification of a bash {@link CommandRef} for observer
 * watch matching. Every call site must use this one implementation to
 * avoid drift across observer-dispatch + speculative-entry synthesis.
 *
 * @internal — not part of the public pi-steering surface.
 */

import {
	getBasename,
	getCommandArgs,
	type CommandRef,
} from "unbash-walker";

/** Render a ref as `"{basename} {args joined by space}"`, trimmed. */
export function refToText(ref: CommandRef): string {
	return `${getBasename(ref)} ${getCommandArgs(ref).join(" ")}`.trim();
}

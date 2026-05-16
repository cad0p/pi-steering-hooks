// SPDX-License-Identifier: MIT
// Part of pi-steering-flags.

/**
 * `when.requiresFlag` \u2014 block unless a specified flag (or one of its
 * env-var equivalents) is present in the evaluated command.
 *
 * Shorthand form accepts a bare flag string:
 *   `when: { requiresFlag: "--profile" }`
 *
 * Object form accepts a mix of alternatives:
 *   `when: { requiresFlag: { flag: "--profile", env: "AWS_PROFILE" } }`
 *
 * Fires (rule BLOCKS) when NONE of the listed equivalents appear.
 */

import { definePredicate } from "pi-steering";
import { hasEnvAssignment, hasFlag } from "../helpers.ts";
import type { RequiresFlagArgs } from "../types.ts";

export const requiresFlag = definePredicate<RequiresFlagArgs | string>(
	(args, ctx) => {
		const norm: RequiresFlagArgs =
			typeof args === "string" ? { flag: args } : (args ?? {});

		const flags: string[] = [];
		if (typeof norm.flag === "string") flags.push(norm.flag);
		if (Array.isArray(norm.flags)) flags.push(...norm.flags);

		const envs: string[] = [];
		if (typeof norm.env === "string") envs.push(norm.env);
		if (Array.isArray(norm.envs)) envs.push(...norm.envs);

		// Malformed arg (no flags AND no envs) \u2014 nothing to check, don't
		// fire. Rule author's bug, but failing closed would turn every
		// evaluation of this rule into a block, which is worse.
		if (flags.length === 0 && envs.length === 0) return false;

		const argsList = ctx.input?.args;
		const envList = ctx.input?.envAssignments;

		for (const flag of flags) {
			if (hasFlag(argsList, flag)) return false; // satisfied
		}
		for (const env of envs) {
			if (hasEnvAssignment(envList, env)) return false; // satisfied
		}

		// None of the equivalents present \u2014 fire.
		return true;
	},
);

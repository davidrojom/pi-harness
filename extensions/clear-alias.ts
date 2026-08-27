/**
 * /clear — alias for the built-in /new command.
 *
 * Starts a fresh session, exactly like /new. Handy for muscle memory
 * carried over from other CLI agents (Claude Code, Codex, etc.).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.registerCommand("clear", {
		description: "Start a new session (alias for /new)",
		handler: async (_args, ctx) => {
			await ctx.newSession();
		},
	});
}

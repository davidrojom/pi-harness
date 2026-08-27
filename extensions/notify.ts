/**
 * Pi Notify — native notifications for Pi
 *
 * Notifies you when:
 *  - The agent has asked a question and is waiting for your decision (ask_user_question)
 *  - A task has finished and Pi is waiting for your input (agent_settled)
 *
 * On macOS it uses native notifications via osascript (they show up even when
 * the terminal is not focused and persist in Notification Center).
 * On other systems it falls back to OSC 777 (iTerm2, Ghostty, WezTerm, rxvt-unicode).
 *
 * Customization:
 *  - SOUND: macOS sound name ("" to disable). E.g. "Glass", "Ping", "Hero",
 *    "Submarine", "Funk", "Pop"...
 *  - /notify-test command to verify notifications work.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";

const SOUND = "Glass";

function notify(title: string, body: string): void {
	if (process.platform === "darwin") {
		// Escape quotes and backslashes for AppleScript
		const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
		const script =
			`display notification "${esc(body)}" with title "${esc(title)}"` +
			(SOUND ? ` sound name "${SOUND}"` : "");
		execFile("/usr/bin/osascript", ["-e", script], () => {
			/* fire-and-forget: ignore permission errors */
		});
	} else {
		// Multi-terminal fallback: OSC 777
		process.stdout.write(`\x1b]777;notify;${title};${body}\x07`);
	}
}

function formatDuration(ms: number): string {
	const total = Math.round(ms / 1000);
	if (total < 60) return `${total}s`;
	const m = Math.floor(total / 60);
	if (m < 60) return `${m}m ${total % 60}s`;
	return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export default function (pi: ExtensionAPI) {
	let runStart = 0;

	pi.on("agent_start", async () => {
		runStart = Date.now();
	});

	// The agent has asked a structured question and is blocked waiting for your answer
	pi.on("tool_execution_start", async (event) => {
		if (event.toolName !== "ask_user_question") return;
		const args = event.args as { questions?: Array<{ question?: string }> } | undefined;
		const first = Array.isArray(args?.questions) ? args?.questions[0]?.question : undefined;
		notify("Pi needs your input", first ?? "The agent is waiting for your decision to continue");
	});

	// The run has settled: no retries, compaction, or queued continuation left.
	// This is the "task finished / waiting for input" moment.
	pi.on("agent_settled", async (_event, ctx) => {
		const project = ctx.cwd.split("/").filter(Boolean).pop() ?? "";
		const dur = runStart > 0 ? `Finished in ${formatDuration(Date.now() - runStart)}` : "Finished";
		notify(`Pi${project ? ` — ${project}` : ""}`, `${dur}. Waiting for your input.`);
	});

	pi.registerCommand("notify-test", {
		description: "Test Pi notifications",
		handler: async (_args, ctx) => {
			notify("Pi", "Notifications are working ✔");
			ctx.ui.notify("Test notification sent", "info");
		},
	});
}

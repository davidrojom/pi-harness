/**
 * remember-model — keep the active model across /new (and /clear).
 *
 * pi resolves the model of a brand-new session from the defaults in
 * settings.json, so a model picked with /model or Ctrl+P is lost on
 * /new. This extension saves the active model just before a new
 * session starts and restores it in the fresh one.
 *
 * Covers every path that creates an empty session: the built-in /new
 * and /clear aliases (e.g. clear-alias.ts) — both go through
 * ctx.newSession() and emit the same events. /resume, /fork and
 * /clone are not touched: those restore the model from the session
 * file on their own.
 *
 * State lives in ~/.pi/agent/last-model.json because the extension
 * instance is recreated on session replacement. Startup is also left
 * alone, so launching pi still uses your configured default model.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const STATE_FILE = path.join(os.homedir(), ".pi", "agent", "last-model.json");

type ThinkingLevelName =
	| "off"
	| "minimal"
	| "low"
	| "medium"
	| "high"
	| "xhigh"
	| "max";

const THINKING_LEVELS: readonly ThinkingLevelName[] = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
];

interface SavedModel {
	provider: string;
	id: string;
	thinkingLevel?: string;
}

function saveState(state: SavedModel): void {
	try {
		fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + "\n");
	} catch {
		// Best effort; fall back to the configured default model.
	}
}

function loadState(): SavedModel | undefined {
	try {
		const parsed = JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) as SavedModel;
		if (typeof parsed.provider === "string" && typeof parsed.id === "string") {
			return parsed;
		}
	} catch {
		// No state file yet or unreadable; keep the default model.
	}
	return undefined;
}

export default function (pi: ExtensionAPI) {
	// Track manual model changes (/model, Ctrl+P) so the state stays
	// current. "restore" is excluded: resuming an old session must not
	// overwrite the last manually chosen model.
	pi.on("model_select", (event, ctx) => {
		if (event.source === "restore") return;
		saveState({
			provider: event.model.provider,
			id: event.model.id,
			thinkingLevel: ctx.thinkingLevel,
		});
	});

	// Capture the active model right before /new (or /clear) drops it.
	pi.on("session_before_switch", (event, ctx) => {
		if (event.reason !== "new" || !ctx.model) return;
		saveState({
			provider: ctx.model.provider,
			id: ctx.model.id,
			thinkingLevel: ctx.thinkingLevel,
		});
	});

	// Restore it in the fresh session.
	pi.on("session_start", async (event, ctx) => {
		if (event.reason !== "new") return;
		const saved = loadState();
		if (!saved) return;
		const model = ctx.modelRegistry.find(saved.provider, saved.id);
		if (!model || !ctx.modelRegistry.hasConfiguredAuth(model)) return;
		const restored = await pi.setModel(model);
		if (!restored) return;
		const level = THINKING_LEVELS.find((l) => l === saved.thinkingLevel);
		if (level) {
			pi.setThinkingLevel(level);
		}
		// Re-save: the setModel call above emits model_select and may
		// have recorded a stale thinking level.
		saveState({
			provider: saved.provider,
			id: saved.id,
			thinkingLevel: saved.thinkingLevel,
		});
		ctx.ui.notify(`Model restored: ${saved.provider}/${saved.id}`, "info");
	});
}

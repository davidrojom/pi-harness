/**
 * auto-resume
 *
 * Detects when the agent run fails because the active model hit a
 * rate/quota limit (usage limit reached, 429, quota exceeded, ...),
 * then polls the provider with a tiny probe request until it responds
 * again, and automatically continues the session where it left off.
 *
 * Behavior:
 * - message_end: assistant messages with stopReason "error" matching the
 *   limit-error pattern are recorded.
 * - agent_settled: if a limit error ended the run (Pi already exhausted its
 *   own auto-retries), start waiting mode.
 * - Waiting mode: probe the active model every POLL_INTERVAL_MS with a
 *   maxTokens=16 request. On success, inject a custom "auto-resume" message
 *   with triggerTurn to continue the pending task.
 * - Cancels when: the user sends a new prompt, the model changes, the session
 *   shuts down, probes keep failing with non-limit errors, the max wait is
 *   exceeded, or too many consecutive resumes fail again.
 *
 * Commands:
 * - /quota-stop    Cancel a pending auto-resume wait.
 * - /quota-status  Show whether we are waiting, next probe time, attempts.
 * - /quota-test    Simulate the full flow with a fake limit error (fast poll)
 *                  to verify the extension without actually running out of
 *                  tokens.
 *
 * Notes:
 * - The wait lives in memory. Closing pi (or /reload) drops it.
 * - Probes go straight to the provider API; they do not touch the session
 *   and do not fire agent events.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import type { AssistantMessage, Model, UserMessage } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** How often to probe the provider while waiting (default: 5 minutes). */
const POLL_INTERVAL_MS = 5 * 60_000;
/** Delay before the first probe after a run fails with a limit error. */
const FIRST_PROBE_DELAY_MS = POLL_INTERVAL_MS;
/** Give up waiting after this long (default: 6 hours). */
const MAX_WAIT_MS = 6 * 60 * 60_000;
/** Cancel if this many consecutive probes fail with non-limit errors (auth, network, ...). */
const MAX_CONSECUTIVE_NON_LIMIT_FAILURES = 3;
/**
 * If the probe succeeds but the real request keeps failing with limit errors,
 * stop after this many consecutive resume cycles to avoid a probe/resume loop.
 */
const MAX_CONSECUTIVE_RESUMES = 3;
/** Tiny response budget for probe requests. */
const PROBE_MAX_TOKENS = 16;

/** Test-mode (/quota-test) timings. */
const TEST_FIRST_PROBE_DELAY_MS = 2_000;
const TEST_POLL_INTERVAL_MS = 5_000;
const TEST_MAX_WAIT_MS = 2 * 60_000;

/**
 * Errors worth waiting for. Fuses pi-ai's internal quota patterns with
 * common rate-limit wording. Only applied to stopReason === "error".
 */
const LIMIT_ERROR_PATTERN =
	/usage[ _-]?limit|usage_limit_reached|rate[ _-]?limit|too many requests|429|overloaded|quota|insufficient[_ ]quota|out of budget|billing|GoUsageLimitError|FreeUsageLimitError|available balance|ResourceExhausted/i;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

interface WaitingState {
	model: Model;
	modelLabel: string;
	errorText: string;
	pendingPrompt: string | undefined;
	startedAt: number;
	attempt: number;
	nonLimitFailures: number;
	nextProbeAt: number;
	maxWaitMs: number;
	timer: ReturnType<typeof setTimeout> | undefined;
	abort: AbortController;
	testMode: boolean;
}

export default function (pi: ExtensionAPI) {
	let lastLimitError: string | null = null;
	let pendingPrompt: string | undefined;
	let waiting: WaitingState | null = null;
	let resuming = false;
	let resumeCount = 0;

	// -------------------------------------------------------------------------
	// Helpers
	// -------------------------------------------------------------------------

	function clearTimer() {
		if (waiting?.timer) {
			clearTimeout(waiting.timer);
			waiting.timer = undefined;
		}
	}

	function cancelWaiting(reason: string | undefined, ctx: ExtensionContext | undefined) {
		if (!waiting) return;
		clearTimer();
		waiting.abort.abort();
		waiting = null;
		if (ctx) ctx.ui.setStatus("auto-resume", undefined);
		if (reason && ctx) ctx.ui.notify(`auto-resume cancelled: ${reason}`, "warning");
	}

	function updateStatus(ctx: ExtensionContext) {
		if (!waiting) return;
		const next = new Date(waiting.nextProbeAt).toLocaleTimeString();
		const mode = waiting.testMode ? "test" : "waiting";
		ctx.ui.setStatus(
			"auto-resume",
			`⏳ auto-resume: ${waiting.modelLabel} limited (${mode}) · next probe ${next} (attempt ${waiting.attempt + 1})`,
		);
	}

	async function startWaiting(ctx: ExtensionContext, testMode: boolean) {
		const model = ctx.model;
		if (!model) return;

		// Fail fast when we cannot authenticate probes at all.
		const apiKey = await ctx.modelRegistry.getApiKeyForProvider(model.provider);
		if (!apiKey) {
			ctx.ui.notify(
				`auto-resume: no API key for "${model.provider}", not waiting. Re-run your prompt when the limit resets.`,
				"warning",
			);
			lastLimitError = null;
			return;
		}

		cancelWaiting(undefined, ctx);
		resumeCount = 0;
		const firstDelay = testMode ? TEST_FIRST_PROBE_DELAY_MS : FIRST_PROBE_DELAY_MS;
		const now = Date.now();
		waiting = {
			model,
			modelLabel: `${model.provider}/${model.id}`,
			errorText: lastLimitError ?? "unknown limit error",
			pendingPrompt,
			startedAt: now,
			attempt: 0,
			nonLimitFailures: 0,
			nextProbeAt: now + firstDelay,
			maxWaitMs: testMode ? TEST_MAX_WAIT_MS : MAX_WAIT_MS,
			timer: undefined,
			abort: new AbortController(),
			testMode,
		};
		lastLimitError = null;

		const intervalMin = Math.round((testMode ? TEST_POLL_INTERVAL_MS : POLL_INTERVAL_MS) / 60_000);
		ctx.ui.notify(
			`auto-resume: ${waiting.modelLabel} hit a rate/quota limit. ` +
				`Will probe every ${testMode ? "5s" : `${intervalMin}m`} and continue automatically when it recovers. ` +
				`Use /quota-stop to cancel.`,
			"warning",
		);
		updateStatus(ctx);
		waiting.timer = setTimeout(() => void runProbe(ctx), firstDelay);
	}

	/** One probe request against the provider, straight via pi-ai. */
	async function probeOnce(
		model: Model,
		apiKey: string | undefined,
		signal: AbortSignal,
	): Promise<{ ok: boolean; error?: string }> {
		const ping: UserMessage = { role: "user", content: "ping", timestamp: Date.now() };
		try {
			const result: AssistantMessage = await completeSimple(
				model,
				{ messages: [ping] },
				{ apiKey, maxTokens: PROBE_MAX_TOKENS, reasoning: "minimal", signal },
			);
			if (result.stopReason === "error") {
				return { ok: false, error: result.errorMessage ?? "unknown provider error" };
			}
			return { ok: true };
		} catch (err) {
			return { ok: false, error: err instanceof Error ? err.message : String(err) };
		}
	}

	async function runProbe(ctx: ExtensionContext) {
		const state = waiting;
		if (!state) return;

		if (Date.now() - state.startedAt >= state.maxWaitMs) {
			cancelWaiting(
				`waited longer than ${Math.round(state.maxWaitMs / 60_000)} minutes. Re-run your prompt manually.`,
				ctx,
			);
			return;
		}

		updateStatus(ctx);
		const apiKey = await ctx.modelRegistry.getApiKeyForProvider(state.model.provider);
		const result = await probeOnce(state.model, apiKey, state.abort.signal);
		if (waiting !== state) return; // cancelled while probing

		if (result.ok) {
			void recover(ctx, state);
			return;
		}

		const errorText = result.error ?? "";
		if (LIMIT_ERROR_PATTERN.test(errorText)) {
			// Still limited — keep waiting.
			state.nonLimitFailures = 0;
		} else {
			state.nonLimitFailures++;
			if (state.nonLimitFailures >= MAX_CONSECUTIVE_NON_LIMIT_FAILURES) {
				cancelWaiting(`probes keep failing with a non-limit error (${errorText})`, ctx);
				return;
			}
		}

		state.attempt++;
		const delay = state.testMode ? TEST_POLL_INTERVAL_MS : POLL_INTERVAL_MS;
		state.nextProbeAt = Date.now() + delay;
		updateStatus(ctx);
		state.timer = setTimeout(() => void runProbe(ctx), delay);
	}

	async function recover(ctx: ExtensionContext, state: WaitingState) {
		clearTimer();
		waiting = null;
		ctx.ui.setStatus("auto-resume", undefined);

		const waitedMs = Date.now() - state.startedAt;
		resumeCount++;
		resuming = true;

		const content = state.testMode
			? "[quota-test] Auto-resume test succeeded: the simulated provider limit recovered. Reply with one short sentence confirming you received this."
			: "The rate/quota limit that interrupted the previous request has recovered. Continue with the pending task from where it failed.";

		ctx.ui.notify(
			`auto-resume: ${state.modelLabel} responded again after ${Math.round(waitedMs / 1000)}s — continuing...`,
			"info",
		);
		pi.sendMessage(
			{
				customType: "auto-resume",
				content,
				display: true,
				details: {
					model: state.modelLabel,
					originalError: state.errorText,
					pendingPrompt: state.pendingPrompt,
					waitedMs,
					attempts: state.attempt + 1,
					testMode: state.testMode,
				},
			},
			{ triggerTurn: true, deliverAs: "steer" },
		);
	}

	// -------------------------------------------------------------------------
	// Events
	// -------------------------------------------------------------------------

	pi.on("before_agent_start", async (event) => {
		// Our own resume trigger: consume the flag once, do nothing else.
		if (resuming) {
			resuming = false;
			return;
		}
		// The user took over while we were waiting: cancel silently.
		if (waiting) cancelWaiting(undefined, undefined);
		pendingPrompt = event.prompt;
		lastLimitError = null;
	});

	pi.on("message_end", async (event) => {
		const message = event.message as AssistantMessage;
		if (message.role !== "assistant") return;

		if (message.stopReason === "error") {
			const text = [
				message.errorMessage ?? "",
				...message.content.map((block) => (block.type === "text" ? block.text : "")),
			].join("\n");
			if (LIMIT_ERROR_PATTERN.test(text)) {
				lastLimitError = message.errorMessage ?? (text.slice(0, 200) || "limit error");
			}
		} else if (message.stopReason !== "aborted") {
			// A successful response clears both the error and the resume streak.
			lastLimitError = null;
			resumeCount = 0;
		}
	});

	pi.on("agent_settled", async (_event, ctx) => {
		if (waiting || resuming || !lastLimitError) return;
		if (resumeCount >= MAX_CONSECUTIVE_RESUMES) {
			ctx.ui.notify(
				`auto-resume: gave up after ${resumeCount} consecutive resume attempts still hit the limit. Re-run your prompt later.`,
				"warning",
			);
			resumeCount = 0;
			lastLimitError = null;
			return;
		}
		await startWaiting(ctx, false);
	});

	pi.on("model_select", async (_event, ctx) => {
		if (waiting) cancelWaiting("the model changed", ctx);
	});

	pi.on("session_shutdown", async () => {
		cancelWaiting(undefined, undefined);
		resuming = false;
	});

	// -------------------------------------------------------------------------
	// Rendering
	// -------------------------------------------------------------------------

	pi.registerMessageRenderer("auto-resume", (message, { expanded, outputPad }, theme) => {
		const label = theme.fg("success", theme.bold("⚡ auto-resume"));
		const content = typeof message.content === "string" ? message.content : "";
		let text = `${label} ${theme.fg("muted", content)}`;
		if (expanded && message.details) {
			text += `\n${theme.fg("dim", JSON.stringify(message.details, null, 2))}`;
		}
		return new Text(text, outputPad, 0);
	});

	// -------------------------------------------------------------------------
	// Commands
	// -------------------------------------------------------------------------

	pi.registerCommand("quota-stop", {
		description: "Cancel a pending auto-resume wait",
		handler: async (_args, ctx) => {
			if (!waiting) {
				ctx.ui.notify("auto-resume: not currently waiting.", "info");
				return;
			}
			const label = waiting.modelLabel;
			cancelWaiting(undefined, ctx);
			ctx.ui.notify(`auto-resume: stopped waiting for ${label}.`, "info");
		},
	});

	pi.registerCommand("quota-status", {
		description: "Show auto-resume status (waiting, next probe, attempts, last error)",
		handler: async (_args, ctx) => {
			if (!waiting) {
				ctx.ui.notify("auto-resume: idle (no limit error being tracked).", "info");
				return;
			}
			const next = new Date(waiting.nextProbeAt).toLocaleTimeString();
			const waitedMin = Math.round((Date.now() - waiting.startedAt) / 60_000);
			ctx.ui.notify(
				[
					`auto-resume: waiting for ${waiting.modelLabel}${waiting.testMode ? " (TEST)" : ""}`,
					`  next probe: ${next} · attempt ${waiting.attempt + 1} · waiting for ${waitedMin}m`,
					`  original error: ${waiting.errorText.slice(0, 120)}`,
					waiting.pendingPrompt ? `  pending prompt: ${waiting.pendingPrompt.slice(0, 80)}` : undefined,
				]
					.filter(Boolean)
					.join("\n"),
				"info",
			);
		},
	});

	pi.registerCommand("quota-test", {
		description: "Simulate a quota error and verify the auto-resume flow end-to-end",
		handler: async (_args, ctx) => {
			if (waiting) {
				ctx.ui.notify("auto-resume: already waiting — /quota-stop first.", "warning");
				return;
			}
			lastLimitError = "[quota-test] simulated usage limit reached";
			await startWaiting(ctx, true);
		},
	});
}

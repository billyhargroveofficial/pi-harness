/**
 * Live output delivery throughput for Pi.
 * Codex uses native provider events and subtracts hidden reasoning from final
 * usage. Live estimates are marked ~; completed spans build a weighted average.
 * Current throughput holds between output events. See codex-throughput.ts.
 * Other providers keep the original pi-live-throughput measurement fallback.
 */

import type { ExtensionAPI, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { CodexThroughput, OutputTotals, formatRate } from "./codex-throughput.ts";
// pi-harness: native Codex output metrics v2 (see docs/codex-throughput.md).

const WIDGET_KEY = "throughput";
const STATUS_KEY = "throughput";
const WINDOW_MS = 3000;
const UPDATE_INTERVAL_MS = 200;
const CHARS_PER_TOKEN = 4;
const MEASUREMENT_MIN_TOKENS = 2;

type DisplayMode = "widget" | "status";

interface Sample {
	t: number;
	tokens: number;
}

interface StreamingState {
	kind: "streaming";
	responseStartTime: number;
	providerRequestTime: number | undefined;
	firstOutputTime: number | undefined;
	measurementStartTime: number | undefined;
	measurementBaseline: number;
	totalChars: number;
	providerOutputBaseline: number;
	lastProviderOutput: number;
	reportedOutputTokens: number;
	usesReportedUsage: boolean;
	samples: Sample[];
	peakRate: number;
	lastRender: number;
	lastOutputTime: number | undefined;
	lastMeasuredRate: number | undefined;
	model: string;
}

interface PromptMetrics {
	inputTokens: number | undefined;
	cacheReadTokens: number | undefined;
	cacheWriteTokens: number | undefined;
	ttftMs: number | undefined;
	approximatePromptRate: number | undefined;
}

interface FinalState {
	kind: "final";
	outputTokens: number;
	elapsedSec: number;
	averageRate: number;
	peakRate: number;
	model: string;
	prompt: PromptMetrics;
}

type ThroughputState = StreamingState | FinalState;

export default function (pi: ExtensionAPI): void {
	const codex = new CodexThroughput();
	const genericTotals = new OutputTotals();
	let genericProvider = "";
	let heldGenericCurrent: number | undefined;
	let mode: DisplayMode = "status";
	let enabled = true;
	let state: ThroughputState | undefined;
	let ui: ExtensionUIContext | undefined;
	let hasUI = false;
	let pendingProviderRequestTime: number | undefined;

	const fmt = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n)));
	const fmtRate = (rate: number): string => (rate >= 100 ? rate.toFixed(0) : rate.toFixed(1));
	const fmtTtft = (ms: number): string => (ms < 1000 ? `${String(Math.round(ms))}ms` : `${(ms / 1000).toFixed(2)}s`);
	const estimatedTokens = (chars: number): number => chars / CHARS_PER_TOKEN;
	const positiveMetric = (value: number): number | undefined =>
		Number.isFinite(value) && value > 0 ? value : undefined;
	const isFirstOutputEvent = (update: { type: string; delta?: string; content?: string }): boolean => {
		switch (update.type) {
			case "text_start":
			case "thinking_start":
			case "toolcall_start":
			case "toolcall_end":
				return true;
			case "text_delta":
			case "thinking_delta":
			case "toolcall_delta":
				return (update.delta?.length ?? 0) > 0;
			case "text_end":
			case "thinking_end":
				return (update.content?.length ?? 0) > 0;
			default:
				return false;
		}
	};

	const promptMetrics = (
		stream: StreamingState,
		usage: { input: number; cacheRead: number; cacheWrite: number },
	): PromptMetrics => {
		const inputTokens = positiveMetric(usage.input);
		const cacheReadTokens = positiveMetric(usage.cacheRead);
		const cacheWriteTokens = positiveMetric(usage.cacheWrite);
		const ttftMs =
			stream.providerRequestTime !== undefined && stream.firstOutputTime !== undefined
				? Math.max(0, stream.firstOutputTime - stream.providerRequestTime)
				: undefined;
		const processedTokens = (inputTokens ?? 0) + (cacheWriteTokens ?? 0);
		const approximatePromptRate =
			processedTokens > 0 && ttftMs !== undefined && ttftMs > 0 ? processedTokens / (ttftMs / 1000) : undefined;
		return { inputTokens, cacheReadTokens, cacheWriteTokens, ttftMs, approximatePromptRate };
	};

	const promptSummary = (prompt: PromptMetrics): string => {
		const parts: string[] = [];
		if (prompt.inputTokens !== undefined) parts.push(`input ${fmt(prompt.inputTokens)} tok`);
		if (prompt.cacheReadTokens !== undefined) parts.push(`cache read ${fmt(prompt.cacheReadTokens)} tok`);
		if (prompt.cacheWriteTokens !== undefined) parts.push(`cache write ${fmt(prompt.cacheWriteTokens)} tok`);
		if (prompt.ttftMs !== undefined) parts.push(`TTFT ${fmtTtft(prompt.ttftMs)}`);
		if (prompt.approximatePromptRate !== undefined) {
			parts.push(`approx. prompt ${fmtRate(prompt.approximatePromptRate)} tok/s`);
		}
		return parts.join(" · ");
	};

	const clearUi = (): void => {
		ui?.setWidget(WIDGET_KEY, undefined);
		ui?.setStatus(STATUS_KEY, undefined);
	};

	const rollingRate = (stream: StreamingState, now: number): number => {
		if (stream.measurementStartTime === undefined) return 0;
		const windowStart = Math.max(stream.measurementStartTime, now - WINDOW_MS);
		stream.samples = stream.samples.filter((sample) => sample.t >= windowStart);
		const elapsedMs = now - windowStart;
		if (elapsedMs <= 0 || stream.samples.length === 0) return stream.lastMeasuredRate ?? 0;
		const tokens = stream.samples.reduce((sum, sample) => sum + sample.tokens, 0);
		const measured = tokens / (elapsedMs / 1000);
		if (measured > 0) stream.lastMeasuredRate = measured;
		return stream.lastMeasuredRate ?? 0;
	};

	const liveOutputTokens = (stream: StreamingState): number =>
		stream.usesReportedUsage ? stream.reportedOutputTokens : estimatedTokens(stream.totalChars);

	const measuredOutputTokens = (stream: StreamingState, total: number): number => {
		if (stream.measurementStartTime === undefined) return 0;
		return Math.max(0, total - stream.measurementBaseline);
	};

	const startMeasurementIfReady = (stream: StreamingState, now: number): boolean => {
		if (stream.measurementStartTime !== undefined) return false;
		const total = liveOutputTokens(stream);
		if (total < MEASUREMENT_MIN_TOKENS) return false;
		stream.measurementStartTime = now;
		stream.measurementBaseline = total;
		stream.samples = [];
		stream.peakRate = 0;
		return true;
	};

	const showLine = (line: string): void => {
		if (mode === "status") {
			ui?.setWidget(WIDGET_KEY, undefined);
			ui?.setStatus(STATUS_KEY, line);
		} else {
			ui?.setStatus(STATUS_KEY, undefined);
			ui?.setWidget(WIDGET_KEY, [line]);
		}
	};

	const render = (): void => {
		if (!hasUI || !enabled) return;
		const codexLine = codex.render(mode);
		if (codexLine) { showLine(codexLine); return; }
		if (!state) return;

		const current = state.kind === "streaming" ? rollingRate(state, state.lastOutputTime ?? performance.now()) : heldGenericCurrent;
		if (current !== undefined && current > 0) heldGenericCurrent = current;
		const average = genericTotals.average(`${genericProvider}/${state.model}`);
		const estimated = state.kind === "streaming" ? !state.usesReportedUsage : false;
		showLine(`momentum ${formatRate(heldGenericCurrent, estimated)} TPS ● accumulated ${formatRate(average)} TPS ● ${codex.input.fields()}`);
	};

	pi.on("session_start", (_event, ctx) => {
		ui = ctx.ui;
		hasUI = ctx.hasUI;
		state = undefined;
		codex.sessionReset(ctx.sessionManager?.getEntries?.() ?? []);
		codex.select(ctx.model);
		genericTotals.pools.clear(); heldGenericCurrent = undefined;
		pendingProviderRequestTime = undefined;
		clearUi(); render();
	});

	pi.on("model_select", (_event, ctx) => {
		ui = ctx.ui; hasUI = ctx.hasUI;
		codex.select(ctx.model); render();
	});
	pi.on("turn_end", (_event, ctx) => {
		if (ctx.sessionManager?.getEntries) codex.input.restore(ctx.sessionManager.getEntries());
		render();
	});

	pi.on("session_shutdown", () => {
		clearUi();
		state = undefined;
		codex.sessionReset();
		pendingProviderRequestTime = undefined;
		ui = undefined;
		hasUI = false;
	});

	pi.on("before_provider_request", (_event, ctx) => {
		pendingProviderRequestTime = performance.now();
		if (ctx.model) codex.prepare(ctx.model, pendingProviderRequestTime);
		else codex.request(pendingProviderRequestTime);
	});

	pi.on("provider_stream_event", (event, ctx) => {
		const at = performance.now(); // before parsing/formatting in this extension
		if (event.api !== "openai-codex-responses" || !event.data || typeof event.data !== "object") return;
		ui = ctx.ui; hasUI = ctx.hasUI;
		if (codex.provider(event.data, at)) render();
	});

	pi.on("message_start", (event, ctx) => {
		if (event.message.role !== "assistant") return;
		ui = ctx.ui;
		hasUI = ctx.hasUI;
		const now = performance.now();
		genericProvider = event.message.provider;
		codex.start(event.message);
		if (codex.active) {
			state = undefined;
			if (pendingProviderRequestTime !== undefined) codex.request(pendingProviderRequestTime);
			pendingProviderRequestTime = undefined;
			render(); return;
		}
		state = {
			kind: "streaming",
			responseStartTime: now,
			providerRequestTime: pendingProviderRequestTime,
			firstOutputTime: undefined,
			measurementStartTime: undefined,
			measurementBaseline: 0,
			totalChars: 0,
			providerOutputBaseline: 0,
			lastProviderOutput: 0,
			reportedOutputTokens: 0,
			usesReportedUsage: false,
			samples: [],
			peakRate: 0,
			lastRender: now,
			lastOutputTime: undefined,
			lastMeasuredRate: undefined,
			model: event.message.responseModel ?? event.message.model,
		};
		pendingProviderRequestTime = undefined;
		render();
	});

	pi.on("message_update", (event, ctx) => {
		if (event.message.role !== "assistant" || state?.kind !== "streaming") return;
		ui = ctx.ui;
		hasUI = ctx.hasUI;
		const stream = state;
		stream.model = event.message.responseModel ?? event.message.model;
		const update = event.assistantMessageEvent;
		const now = performance.now();
		const isDelta =
			update.type === "text_delta" || update.type === "thinking_delta" || update.type === "toolcall_delta";
		const chars = isDelta ? update.delta.length : 0;
		if (stream.firstOutputTime === undefined && isFirstOutputEvent(update)) stream.firstOutputTime = now;
		const providerOutput = event.message.usage.output;
		let providerAdvanced = false;
		let switchedToReportedUsage = false;

		if (Number.isFinite(providerOutput) && providerOutput > stream.lastProviderOutput) {
			const previousOutput = Math.max(stream.lastProviderOutput, stream.providerOutputBaseline);
			stream.lastProviderOutput = providerOutput;
			if (providerOutput > stream.providerOutputBaseline) {
				providerAdvanced = true;
				if (!stream.usesReportedUsage) {
					stream.usesReportedUsage = true;
					stream.samples = [];
					stream.peakRate = 0;
					switchedToReportedUsage = true;
				}
				stream.reportedOutputTokens = providerOutput - stream.providerOutputBaseline;
				stream.samples.push({ t: now, tokens: providerOutput - previousOutput });
			}
		}

		if (chars > 0) {
			stream.lastOutputTime = now;
			stream.totalChars += chars;
			if (!stream.usesReportedUsage) stream.samples.push({ t: now, tokens: estimatedTokens(chars) });
		}

		if (switchedToReportedUsage && stream.measurementStartTime !== undefined) stream.measurementBaseline = 0;
		const startedMeasurement = startMeasurementIfReady(stream, now);

		const usageOnlyUpdate = providerAdvanced && !isDelta;
		if (
			startedMeasurement ||
			switchedToReportedUsage ||
			usageOnlyUpdate ||
			(chars > 0 && now - stream.lastRender >= UPDATE_INTERVAL_MS)
		) {
			stream.lastRender = now;
			render();
		}
	});

	pi.on("message_end", (event, ctx) => {
		if (event.message.role !== "assistant") return;
		ui = ctx.ui; hasUI = ctx.hasUI;
		codex.input.add(event.message);
		if (codex.active) { codex.end(event.message); render(); return; }
		if (state?.kind !== "streaming") return;
		ui = ctx.ui;
		hasUI = ctx.hasUI;
		const now = state.lastOutputTime ?? performance.now();
		const stream = state;
		const outputTokens = event.message.usage.output;
		const windowOutputTokens = Math.max(0, outputTokens - stream.providerOutputBaseline);
		let measurementStart = stream.measurementStartTime ?? stream.responseStartTime;
		let measuredTokens =
			stream.measurementStartTime === undefined ? windowOutputTokens : measuredOutputTokens(stream, windowOutputTokens);
		if (measuredTokens < 1) {
			// The window captured less than a full output token, for example a final provider
			// total at or below the estimated baseline. Fall back to response timing
			// (or reset timing after a reset), retaining the pre-reset token exclusion.
			measurementStart = stream.responseStartTime;
			measuredTokens = windowOutputTokens;
		}
		const elapsedSec = (now - measurementStart) / 1000;
		const averageRate = measuredTokens / Math.max(elapsedSec, 0.001);
		const peakRate = Math.max(stream.peakRate, rollingRate(stream, now), averageRate);
		const finalCurrent = rollingRate(stream, now);
		if (finalCurrent > 0) heldGenericCurrent = finalCurrent;
		genericTotals.add(`${event.message.provider}/${stream.model}`, measuredTokens, elapsedSec * 1000);
		state = {
			kind: "final",
			outputTokens,
			elapsedSec,
			averageRate,
			peakRate,
			model: event.message.responseModel ?? event.message.model,
			prompt: promptMetrics(stream, event.message.usage),
		};
		render();
	});

	pi.registerCommand("throughput", {
		description: "Show live tokens/sec. Args: on|off|widget|status|reset",
		handler: (args, ctx) => {
			ui = ctx.ui;
			hasUI = ctx.hasUI;
			const arg = args.trim().toLowerCase();

			if (!arg || arg === "toggle") {
				enabled = !enabled;
				if (enabled) render();
				else clearUi();
				ctx.ui.notify(`Live throughput: ${enabled ? mode : "off"}`, "info");
				return Promise.resolve();
			}

			switch (arg) {
				case "on":
					enabled = true;
					render();
					ctx.ui.notify(`Live throughput: ${mode}`, "info");
					return Promise.resolve();
				case "off":
					enabled = false;
					clearUi();
					ctx.ui.notify("Live throughput: off", "info");
					return Promise.resolve();
				case "widget":
				case "status":
					mode = arg;
					enabled = true;
					clearUi();
					render();
					ctx.ui.notify(`Live throughput: ${mode}`, "info");
					return Promise.resolve();
				case "reset":
					genericTotals.pools.clear(); heldGenericCurrent = undefined;
					if (codex.active) {
						codex.reset(); clearUi(); render();
						ctx.ui.notify("Accumulated Codex TPS reset; active response remains whole for native usage", "info");
						return Promise.resolve();
					}
					if (state?.kind === "streaming") {
						const now = performance.now();
						state.responseStartTime = now;
						state.measurementStartTime = now;
						state.measurementBaseline = 0;
						state.providerOutputBaseline =
							state.lastProviderOutput > 0
								? state.lastProviderOutput
								: state.providerOutputBaseline + estimatedTokens(state.totalChars);
						state.totalChars = 0;
						state.reportedOutputTokens = 0;
						state.samples = [];
						state.peakRate = 0;
						state.lastRender = now;
						state.lastOutputTime = undefined;
						state.lastMeasuredRate = undefined;
						clearUi();
						render();
						ctx.ui.notify("Current throughput metrics reset", "info");
					} else if (state?.kind === "final") {
						state = undefined;
						clearUi();
						ctx.ui.notify("Final throughput summary cleared", "info");
					} else {
						ctx.ui.notify("No throughput metrics to reset", "info");
					}
					return Promise.resolve();
				default:
					ctx.ui.notify("Usage: /throughput [on|off|widget|status|reset|toggle]", "error");
					return Promise.resolve();
			}
		},
	});
}

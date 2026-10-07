// pi-harness: conservative output delivery metrics with held last good TPS, v4.
// MIT; original pi-live-throughput copyright/license remains in the package.
import { createHash } from "node:crypto";

type Json = Record<string, any>;
type Sample = { start: number; t: number; chars: number };
type TextPart = { hash: ReturnType<typeof createHash>; chars: number; done: boolean };
type Item = { type: string; parts: Map<number, TextPart>; done: boolean };
const hash = (text: string) => createHash("sha256").update(text, "utf16le").digest("hex");
export const counter = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
// Measurement policy, NOT a claim about a model's physical maximum. Reject,
// never clamp. Short/coalesced observations cannot identify decode throughput.
export const POLICY = Object.freeze({ bucketMs: 50, minSpanMs: 1000, minBuckets: 4,
	minChars: 32, windowMs: 3000, staleMs: 3000, maxTps: 1000, maxBucketShare: 0.8 });
export const formatRate = (value: number | undefined, estimated = true) =>
	value === undefined || !Number.isFinite(value) || value < 0.05 || value > POLICY.maxTps
		? "-" : `${estimated ? "~" : ""}${value.toFixed(1)}`;
export const formatInput = (value: number) => value >= 1000000 ? `${(value / 1000000).toFixed(2)}M`
	: value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(Math.round(value));

/** Only finalized, valid usage; history includes all branches/pre-compaction.
 * Cache read is part of input, never output. Invalid usage is not a zero miss.
 */
export class SessionInput {
	tokens = 0;
	outputTokens = 0;
	cacheHit: number | undefined;
	seen = new WeakSet<object>();
	responses = new Set<string>();
	add(message: Json, updateCache = message.role === "assistant"): void {
		if (!["assistant", "toolResult"].includes(message.role) || this.seen.has(message)) return;
		const id = typeof message.responseId === "string" ? `${message.provider ?? ""}/${message.responseId}` : undefined;
		if (id && this.responses.has(id)) return;
		const usage = message.usage;
		if (!usage || ![usage.input, usage.cacheRead, usage.cacheWrite, usage.output].every(counter)) {
			if (updateCache) this.cacheHit = undefined;
			return;
		}
		const total = usage.input + usage.cacheRead + usage.cacheWrite;
		const output = usage.output;
		if (!counter(total) || !counter(this.tokens + total) || !counter(this.outputTokens + output)) return;
		this.seen.add(message);
		if (id) this.responses.add(id);
		this.tokens += total; this.outputTokens += output;
		if (updateCache) this.cacheHit = total > 0 ? 100 * usage.cacheRead / total : undefined;
	}
	restore(entries: Json[]): void {
		this.tokens = 0; this.outputTokens = 0; this.cacheHit = undefined; this.seen = new WeakSet(); this.responses.clear();
		const ids = new Set<string>();
		for (const entry of entries) {
			if (typeof entry.id === "string") { if (ids.has(entry.id)) continue; ids.add(entry.id); }
			if (entry.type === "message" && entry.message) this.add(entry.message);
			else if (["usage", "compaction", "branch_summary"].includes(entry.type) && entry.usage)
				this.add({ role: "assistant", usage: entry.usage }, false);
		}
	}
	fields(cacheHit = this.cacheHit): string {
		const hit = cacheHit !== undefined && Number.isFinite(cacheHit) && cacheHit >= 0 && cacheHit <= 100 ? `${cacheHit.toFixed(1)}%` : "-";
		const output = this.outputTokens >= 1000 && this.outputTokens < 1000000 && this.outputTokens % 1000 === 0 ? `${this.outputTokens / 1000}k` : formatInput(this.outputTokens);
		return `hit ${hit} in ${formatInput(this.tokens)} out ${output}`;
	}
}

/** First bucket is a baseline, excluded from the numerator. Bursts within
 * 50ms are one observation, not tiny independent intervals. Render ticks,
 * final usage, done snapshots, tool execution and hidden reasoning add nothing.
 * ~ denotes a UTF-16 chars/4 proxy, NOT server decode or exact token timing.
 */
export class OutputWindow {
	first: number | undefined;
	last: number | undefined;
	chars = 0;
	samples: Sample[] = [];
	reason = "warming-up";
	invalid = false;
	currentCharsPerSecond: number | undefined;
	lastEstimated: number | undefined;
	add(t: number, chars: number): void {
		if (chars === 0) return;
		if (this.invalid) return;
		if (!Number.isFinite(t) || t < 0 || !counter(chars) || !counter(this.chars + chars) || (this.last !== undefined && t < this.last)) {
			this.invalid = true; this.reason = "invalid-clock-or-count"; this.currentCharsPerSecond = undefined; return;
		}
		this.first ??= t; this.last = t; this.chars += chars;
		const tail = this.samples.at(-1);
		if (tail && t - tail.start < POLICY.bucketMs) { tail.t = t; tail.chars = this.chars; }
		else this.samples.push({ start: t, t, chars: this.chars });
		while (this.samples.length > 2 && this.samples[1].t <= t - POLICY.windowMs) this.samples.shift();
		this.currentCharsPerSecond = undefined;
		const baseline = this.samples[0];
		const ms = t - baseline.t;
		const received = this.chars - baseline.chars;
		if (ms < POLICY.minSpanMs || this.samples.length < POLICY.minBuckets || received < POLICY.minChars) { this.reason = "insufficient-observation"; return; }
		let largest = 0;
		for (let i = 1; i < this.samples.length; i++) largest = Math.max(largest, this.samples[i].chars - this.samples[i - 1].chars);
		if (largest / received > POLICY.maxBucketShare) { this.reason = "burst-dominated"; return; }
		const value = received / (ms / 1000) / 4;
		if (!Number.isFinite(value) || value > POLICY.maxTps || value < 0.05) { this.reason = "outside-display-policy"; return; }
		this.reason = "ok"; this.currentCharsPerSecond = value * 4; this.lastEstimated = value;
	}
	get spanMs(): number { return this.first === undefined || this.last === undefined ? 0 : this.last - this.first; }
	get estimatedCurrent(): number | undefined { return this.currentCharsPerSecond === undefined ? undefined : this.currentCharsPerSecond / 4; }
	current(now: number, completed = false): number | undefined {
		if (this.invalid || !Number.isFinite(now) || (this.last !== undefined && now < this.last)) return undefined;
		if (!completed && this.last !== undefined && now - this.last > POLICY.staleMs) return undefined;
		return this.estimatedCurrent;
	}
}

/** Native events validate the stream, but final billing usage is not projected
 * onto a short visible-output window. Hashes avoid retaining output content.
 */
export class CodexMeasurement {
	window = new OutputWindow();
	requestTime: number | undefined;
	responseId: string | undefined;
	sequence: number | undefined;
	items = new Map<string, Item>();
	textHash = createHash("sha256");
	textChars = 0;
	invalid = false;
	terminal = false;
	completed = false;
	hasOtherOutput = false;
	nativeTokens: number | undefined;
	reasoningTokens: number | undefined;
	inputTokens: number | undefined;
	cachedTokens: number | undefined;
	fullMs: number | undefined;
	lastEvent: number | undefined;
	model: string;
	constructor(model: string) { this.model = model; }

	provider(data: Json, t: number): void {
		if (!Number.isFinite(t) || t < 0 || (this.lastEvent !== undefined && t < this.lastEvent)) this.invalid = true;
		this.lastEvent = t;
		if (data.type === "response.created") {
			// Only a different response ID constitutes a retry, not duplicate created.
			const id = data.response?.id;
			if (this.responseId && id !== this.responseId) {
				const requestTime = this.requestTime;
				Object.assign(this, new CodexMeasurement(this.model)); this.requestTime = requestTime; this.lastEvent = t;
			} else if (this.responseId) this.invalid = true;
			this.responseId = typeof id === "string" && id.length ? id : undefined;
			if (!this.responseId) this.invalid = true;
		}
		if (!this.responseId || !Number.isFinite(t) || t < 0 || (this.requestTime !== undefined && t < this.requestTime)) this.invalid = true;
		if (this.terminal && data.type !== "response.created") this.invalid = true;
		if (data.sequence_number !== undefined) {
			if (!counter(data.sequence_number) || (this.sequence !== undefined && data.sequence_number !== this.sequence + 1)) this.invalid = true;
			else this.sequence = data.sequence_number;
		}
		if (data.response_id !== undefined && data.response_id !== this.responseId) this.invalid = true;
		const response = data.response;
		if (response?.id !== undefined && response.id !== this.responseId) this.invalid = true;
		if (data.type === "response.output_item.added") {
			const item = data.item;
			if (typeof item?.id !== "string" || this.items.has(item.id) || this.terminal || this.items.size >= 256) { this.invalid = true; return; }
			this.items.set(item.id, { type: item.type, parts: new Map(), done: false });
			if (!["message", "reasoning", "function_call", "custom_tool_call"].includes(item.type)) this.hasOtherOutput = true;
		}
		if (["response.output_text.delta", "response.function_call_arguments.delta", "response.custom_tool_call_input.delta"].includes(data.type)) {
			if (typeof data.delta !== "string") { this.invalid = true; return; }
			if (!data.delta.length) return;
			const item = this.items.get(data.item_id);
			const expectedType = data.type === "response.output_text.delta" ? "message" : data.type === "response.function_call_arguments.delta" ? "function_call" : "custom_tool_call";
			if (!item || item.type !== expectedType || item.done || this.terminal) { this.invalid = true; return; }
			const index = expectedType === "message" ? data.content_index : 0;
			if (!counter(index) || index >= 64) { this.invalid = true; return; }
			const part = item.parts.get(index) ?? { hash: createHash("sha256"), chars: 0, done: false };
			if (part.done) { this.invalid = true; return; }
			part.hash.update(data.delta, "utf16le"); part.chars += data.delta.length; item.parts.set(index, part);
			this.window.add(t, data.delta.length);
			if (expectedType === "message") { this.textHash.update(data.delta, "utf16le"); this.textChars += data.delta.length; }
		}
		if (data.type === "response.output_text.done") {
			const part = this.items.get(data.item_id)?.parts.get(data.content_index);
			if (!part || part.done || typeof data.text !== "string" || part.hash.copy().digest("hex") !== hash(data.text)) this.invalid = true;
			if (part) part.done = true;
		}
		if (data.type === "response.output_item.done") {
			const item = this.items.get(data.item?.id);
			if (!item || item.done || item.type !== data.item.type || this.terminal) { this.invalid = true; return; }
			if (item.type === "message") {
				if (data.item.role !== undefined && data.item.role !== "assistant") this.invalid = true;
				const contents = data.item.content;
				if (!Array.isArray(contents) || contents.length !== item.parts.size) this.invalid = true;
				for (const [index, part] of item.parts) {
					const text = contents?.[index]?.text;
					if (typeof text !== "string" || part.hash.copy().digest("hex") !== hash(text)) this.invalid = true;
				}
			} else if (item.type === "function_call" || item.type === "custom_tool_call") {
				const text = item.type === "function_call" ? data.item.arguments : data.item.input;
				const part = item.parts.get(0);
				if (!part || typeof text !== "string" || part.hash.copy().digest("hex") !== hash(text)) this.invalid = true;
			}
			item.done = true;
		}
		if (["response.completed", "response.done", "response.failed", "response.incomplete", "error"].includes(data.type)) {
			if (this.terminal) this.invalid = true;
			this.terminal = true;
			this.completed = ["response.completed", "response.done"].includes(data.type) && response?.status === "completed";
			const output = response?.usage?.output_tokens;
			const reasoning = response?.usage?.output_tokens_details?.reasoning_tokens;
			if (counter(output) && counter(reasoning) && reasoning <= output) { this.nativeTokens = output - reasoning; this.reasoningTokens = reasoning; }
			if (counter(response?.usage?.input_tokens)) this.inputTokens = response.usage.input_tokens;
			if (counter(response?.usage?.input_tokens_details?.cached_tokens) && this.inputTokens !== undefined && response.usage.input_tokens_details.cached_tokens <= this.inputTokens) this.cachedTokens = response.usage.input_tokens_details.cached_tokens;
			if (this.requestTime !== undefined) this.fullMs = t - this.requestTime;
		}
	}
	finish(message: Json): boolean {
		const sdkText = (Array.isArray(message.content) ? message.content : []).filter((p: Json) => p.type === "text").map((p: Json) => p.text ?? "").join("");
		const textMatches = sdkText.length === this.textChars && hash(sdkText) === this.textHash.copy().digest("hex");
		return this.completed && !this.invalid && !this.window.invalid && !this.hasOtherOutput && !!this.responseId
			&& (message.responseId === undefined || message.responseId === this.responseId)
			&& this.items.size > 0 && [...this.items.values()].every(i => i.done)
			&& this.window.lastEstimated !== undefined && textMatches && !["error", "aborted", "length"].includes(message.stopReason);
	}
	current(now: number, finalValid = false): number | undefined {
		return this.invalid || this.window.invalid || this.hasOtherOutput || (this.terminal && !this.completed)
			? undefined : (this.window.current(now, finalValid) ?? this.window.lastEstimated);
	}
}

export class CodexThroughput {
	active = false;
	measurement: CodexMeasurement | undefined;
	input = new SessionInput();
	selectedModel = "";
	final = false;
	finalValid = false;
	lastRender = 0;
	prepared = false;
	// Last fully validated response, separate from the current window. A failed
	// or unsupported response cannot poison this fallback with provisional TPS.
	heldRate: number | undefined;
	isCodex(message: Json): boolean { return message.api === "openai-codex-responses" || message.provider === "openai-codex"; }
	start(message: Json): void {
		const id = message.responseModel ?? message.model;
		const key = `${message.provider}/${id}`;
		if (this.selectedModel && this.selectedModel !== key) this.select({ id, provider: message.provider, api: message.api });
		this.selectedModel = key;
		if (this.prepared && this.active && this.isCodex(message)) {
			if (this.measurement && (message.responseModel ?? message.model) !== this.measurement.model) this.measurement.invalid = true;
			this.prepared = false; return;
		}
		this.active = this.isCodex(message); if (!this.active) return;
		this.measurement = new CodexMeasurement(message.responseModel ?? message.model);
		this.final = false; this.finalValid = false; this.lastRender = 0;
	}
	prepare(model: Json, t: number): void {
		this.select(model);
		this.prepared = false; this.start({ api: model.api, provider: model.provider, model: model.id });
		this.request(t); this.prepared = this.active; this.selectedModel = `${model.provider}/${model.id}`;
	}
	select(model: Json | undefined): void {
		if (!model) return;
		const key = `${model.provider}/${model.id}`;
		if (this.selectedModel !== key) { this.measurement = undefined; this.final = false; this.finalValid = false; this.prepared = false; this.heldRate = undefined; }
		this.selectedModel = key; this.active = this.isCodex(model);
	}
	request(t: number): void { if (this.active && this.measurement) this.measurement.requestTime = t; }
	provider(data: Json, t: number): boolean {
		if (!this.active || !this.measurement) return false;
		this.measurement.provider(data, t);
		const render = t - this.lastRender >= 200 || this.measurement.terminal || this.measurement.invalid;
		if (render) this.lastRender = t;
		return render;
	}
	end(message: Json): void {
		if (!this.active || !this.measurement || this.final) return;
		this.final = true; this.finalValid = this.measurement.finish(message);
		if (this.finalValid) this.heldRate = this.measurement.window.lastEstimated;
	}
	reset(): void {
		this.heldRate = undefined;
		if (this.final) this.measurement = undefined;
		else if (this.measurement) this.measurement.window = new OutputWindow();
		this.final = false; this.finalValid = false;
	}
	sessionReset(entries: Json[] = []): void {
		this.active = false; this.measurement = undefined; this.prepared = false;
		this.final = false; this.finalValid = false; this.selectedModel = ""; this.heldRate = undefined; this.input.restore(entries);
	}
	render(_mode: "widget" | "status", now = performance.now()): string | undefined {
		if (!this.active) return undefined;
		const m = this.measurement;
		const current = this.final && !this.finalValid ? undefined : m?.current(now, this.finalValid);
		const value = current ?? this.heldRate;
		const cacheHit = m?.terminal ? (m.inputTokens && m.cachedTokens !== undefined ? 100 * m.cachedTokens / m.inputTokens : NaN) : this.input.cacheHit;
		return `${formatRate(value)} TPS ${this.input.fields(cacheHit)}`;
	}
}

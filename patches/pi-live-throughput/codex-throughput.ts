// pi-harness: Codex output delivery metrics, v2.
// MIT; original pi-live-throughput copyright/license remains in the package.
import { createHash } from "node:crypto";

type Json = Record<string, any>;
type Sample = { t: number; chars: number };
type TextPart = { hash: ReturnType<typeof createHash>; chars: number; done: boolean };
type Item = { type: string; parts: Map<number, TextPart>; done: boolean };
// UTF-16 preserves a surrogate pair even when deltas split its two halves.
const hash = (text: string) => createHash("sha256").update(text, "utf16le").digest("hex");
const counter = (value: unknown): value is number =>
	Number.isSafeInteger(value) && (value as number) >= 0;
const rate = (tokens: number, ms: number): number | undefined =>
	ms > 0 && tokens > 0 ? tokens / (ms / 1000) : undefined;
export const formatRate = (value: number | undefined, estimated = false) =>
	value === undefined ? "-" : `${estimated ? "~" : ""}${value.toFixed(1)}`;
export const formatInput = (value: number) => value >= 1000000 ? `${(value / 1000000).toFixed(2)}M`
	: value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(Math.round(value));

/** Read usage metadata only. getEntries keeps pre-compaction messages and
 * earlier branches in the same session. Cached tokens are part of input.
 */
export class SessionInput {
	tokens = 0;
	cacheHit: number | undefined;
	seen = new WeakSet<object>();
	responses = new Set<string>();
	add(message: Json): void {
		if (message.role !== "assistant" || this.seen.has(message)) return;
		this.seen.add(message);
		const id = message.responseId;
		if (typeof id === "string") {
			if (this.responses.has(id)) return;
			this.responses.add(id);
		}
		const usage = message.usage;
		if (!usage) return;
		const input = counter(usage.input) ? usage.input : 0;
		const cached = counter(usage.cacheRead) ? usage.cacheRead : 0;
		const written = counter(usage.cacheWrite) ? usage.cacheWrite : 0;
		const total = input + cached + written;
		this.tokens += total;
		if (total > 0) this.cacheHit = 100 * cached / total;
	}
	restore(entries: Json[]): void {
		this.tokens = 0; this.cacheHit = undefined; this.seen = new WeakSet(); this.responses.clear();
		for (const entry of entries) if (entry.type === "message" && entry.message) this.add(entry.message);
	}
	fields(cacheHit = this.cacheHit): string {
		return `cache hit ${cacheHit === undefined ? "-" : `${cacheHit.toFixed(1)}%`} ● session input ${formatInput(this.tokens)}`;
	}
}

/** A 3-second window ends at the last output event, never at a render tick.
 * Pauses within output count when it resumes. With no new output the last
 * measured value holds. Coalesced events require distinct timestamps.
 */
export class OutputWindow {
	first: number | undefined;
	last: number | undefined;
	chars = 0;
	samples: Sample[] = [];
	currentCharsPerSecond: number | undefined;
	add(t: number, chars: number): void {
		if (!(chars > 0) || !Number.isFinite(t)) return;
		this.first ??= t;
		this.last = t;
		this.chars += chars;
		const tail = this.samples.at(-1);
		if (tail?.t === t) tail.chars = this.chars;
		else this.samples.push({ t, chars: this.chars });
		const cutoff = t - 3000;
		while (this.samples.length > 2 && this.samples[1].t <= cutoff) this.samples.shift();
		const first = this.samples[0];
		if (t > first.t) this.currentCharsPerSecond = (this.chars - first.chars) / ((t - first.t) / 1000);
	}
	get spanMs(): number {
		return this.first === undefined || this.last === undefined ? 0 : this.last - this.first;
	}
	get estimatedTokens(): number { return this.chars / 4; }
	get estimatedRate(): number | undefined { return rate(this.estimatedTokens, this.spanMs); }
	get estimatedCurrent(): number | undefined {
		return this.currentCharsPerSecond === undefined ? undefined : this.currentCharsPerSecond / 4;
	}
}

/** Only sums successful completed spans with native counts. Per-model pools
 * keep unrelated models separate. The weighted mean is sum(tokens)/sum(span).
 */
export class OutputTotals {
	pools = new Map<string, { tokens: number; ms: number; calls: number }>();
	add(model: string, tokens: number, ms: number): void {
		if (!counter(tokens) || !(ms > 0) || tokens <= 0) return;
		const p = this.pools.get(model) ?? { tokens: 0, ms: 0, calls: 0 };
		p.tokens += tokens; p.ms += ms; p.calls++;
		this.pools.set(model, p);
	}
	average(model: string): number | undefined {
		const p = this.pools.get(model);
		return p ? rate(p.tokens, p.ms) : undefined;
	}
}

/** Parsed provider events are timed before Pi normalization. This observes
 * client delivery at the hook, slightly later than the standalone HTTP reader.
 * No fetch/transport/auth replacement and no content or credentials on disk.
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
	sawRawText = false;
	model: string;
	constructor(model: string) { this.model = model; }

	provider(data: Json, t: number): void {
		if (data.type === "response.created") {
			// A transport retry starts a new observation, without summing its
			// unfinished predecessor or carrying its text into the final hash.
			if (this.responseId) {
				const requestTime = this.requestTime;
				Object.assign(this, new CodexMeasurement(this.model));
				this.requestTime = requestTime;
			}
			this.responseId = typeof data.response?.id === "string" ? data.response.id : undefined;
			if (!this.responseId) this.invalid = true;
		}
		if (counter(data.sequence_number)) {
			if (this.sequence !== undefined && data.sequence_number <= this.sequence) this.invalid = true;
			this.sequence = data.sequence_number;
		}
		if (data.response_id !== undefined && data.response_id !== this.responseId) this.invalid = true;
		const response = data.response;
		if (response?.id !== undefined && response.id !== this.responseId) this.invalid = true;
		if (data.type === "response.output_item.added") {
			const item = data.item;
			if (typeof item?.id !== "string" || this.items.has(item.id)) { this.invalid = true; return; }
			this.items.set(item.id, { type: item.type, parts: new Map(), done: false });
			if (!["message", "reasoning", "function_call", "custom_tool_call"].includes(item.type)) this.hasOtherOutput = true;
		}
		if (["response.output_text.delta", "response.function_call_arguments.delta", "response.custom_tool_call_input.delta"].includes(data.type)) {
			if (typeof data.delta !== "string" || !data.delta.length) return;
			const item = this.items.get(data.item_id);
			const expectedType = data.type === "response.output_text.delta" ? "message"
				: data.type === "response.function_call_arguments.delta" ? "function_call" : "custom_tool_call";
			if (!item || item.type !== expectedType || item.done || this.terminal) { this.invalid = true; return; }
			const index = expectedType === "message" ? data.content_index : 0;
			if (!counter(index)) { this.invalid = true; return; }
			const part = item.parts.get(index) ?? { hash: createHash("sha256"), chars: 0, done: false };
			if (part.done) this.invalid = true;
			part.hash.update(data.delta, "utf16le"); part.chars += data.delta.length;
			item.parts.set(index, part);
			this.window.add(t, data.delta.length);
			if (expectedType === "message") {
				this.sawRawText = true; this.textHash.update(data.delta, "utf16le"); this.textChars += data.delta.length;
			}
		}
		if (data.type === "response.output_text.done") {
			const part = this.items.get(data.item_id)?.parts.get(data.content_index);
			if (!part || typeof data.text !== "string" || part.hash.copy().digest("hex") !== hash(data.text)) this.invalid = true;
			if (part) part.done = true;
		}
		if (data.type === "response.output_item.done") {
			const item = this.items.get(data.item?.id);
			if (!item || item.done || item.type !== data.item.type) { this.invalid = true; return; }
			if (item.type === "message") {
				if (data.item.role !== undefined && data.item.role !== "assistant") this.invalid = true;
				for (const [index, part] of item.parts) {
					const text = data.item.content?.[index]?.text;
					if (typeof text !== "string" || part.hash.copy().digest("hex") !== hash(text)) this.invalid = true;
				}
			} else if (item.type === "function_call" || item.type === "custom_tool_call") {
				const text = item.type === "function_call" ? data.item.arguments : data.item.input;
				const part = item.parts.get(0);
				if (part && (typeof text !== "string" || part.hash.copy().digest("hex") !== hash(text))) this.invalid = true;
			}
			item.done = true;
		}
		if (["response.completed", "response.done", "response.failed", "response.incomplete"].includes(data.type)) {
			if (this.terminal) this.invalid = true;
			this.terminal = true;
			this.completed = ["response.completed", "response.done"].includes(data.type) && response?.status === "completed";
			const output = response?.usage?.output_tokens;
			const reasoning = response?.usage?.output_tokens_details?.reasoning_tokens;
			if (counter(output) && counter(reasoning) && reasoning <= output) {
				this.nativeTokens = output - reasoning; this.reasoningTokens = reasoning;
			}
			if (counter(response?.usage?.input_tokens)) this.inputTokens = response.usage.input_tokens;
			if (counter(response?.usage?.input_tokens_details?.cached_tokens)) this.cachedTokens = response.usage.input_tokens_details.cached_tokens;
			if (this.requestTime !== undefined) this.fullMs = t - this.requestTime;
		}
	}

	finish(message: Json): boolean {
		const sdkText = (message.content ?? []).filter((p: Json) => p.type === "text").map((p: Json) => p.text ?? "").join("");
		const textMatches = sdkText.length === this.textChars && hash(sdkText) === this.textHash.copy().digest("hex");
		return this.completed && !this.invalid && !this.hasOtherOutput && !!this.responseId
			&& this.items.size > 0 && [...this.items.values()].every(i => i.done)
			&& this.nativeTokens !== undefined && this.nativeTokens > 0 && this.window.spanMs > 0 && textMatches
			&& !["error", "aborted"].includes(message.stopReason);
	}
}

/** Adapter called by the upstream display. It does not register providers or
 * alter the model request. Exact completed samples accumulate for this process
 * and model; /reload, switching sessions and /throughput reset clear them.
 */
export class CodexThroughput {
	active = false;
	measurement: CodexMeasurement | undefined;
	totals = new OutputTotals();
	input = new SessionInput();
	selectedModel = "";
	heldCurrent: number | undefined;
	heldEstimated = true;
	final = false;
	finalValid = false;
	lastRender = 0;
	prepared = false;
	isCodex(message: Json): boolean {
		return message.api === "openai-codex-responses" || message.provider === "openai-codex";
	}
	start(message: Json): void {
		// WebSocket response.created reaches the raw hook before Pi's
		// message_start. Preserve the measurement prepared at request time.
		if (this.prepared && this.active && this.isCodex(message)) { this.prepared = false; return; }
		this.active = this.isCodex(message);
		if (!this.active) return;
		const model = message.responseModel ?? message.model;
		if (this.measurement && this.measurement.model !== model) this.heldCurrent = undefined;
		this.measurement = new CodexMeasurement(model);
		this.final = false; this.finalValid = false; this.lastRender = 0;
	}
	prepare(model: Json, t: number): void {
		this.prepared = false;
		this.start({ api: model.api, provider: model.provider, model: model.id });
		this.request(t); this.prepared = this.active;
		this.selectedModel = model.id;
	}
	select(model: Json | undefined): void {
		if (!model) return;
		if (this.selectedModel && this.selectedModel !== model.id) { this.heldCurrent = undefined; this.measurement = undefined; }
		this.selectedModel = model.id;
		this.active = this.isCodex(model);
	}
	request(t: number): void { if (this.active && this.measurement) this.measurement.requestTime = t; }
	provider(data: Json, t: number): boolean {
		if (!this.active || !this.measurement) return false;
		this.measurement.provider(data, t);
		const current = this.measurement.window.estimatedCurrent;
		if (current !== undefined) { this.heldCurrent = current; this.heldEstimated = true; }
		const render = t - this.lastRender >= 200 || this.measurement.terminal;
		if (render) this.lastRender = t;
		return render;
	}
	end(message: Json): void {
		const m = this.measurement;
		if (!this.active || !m || this.final) return;
		this.final = true; this.finalValid = m.finish(message);
		if (this.finalValid) {
			this.totals.add(m.model, m.nativeTokens!, m.window.spanMs);
			// The completed usage can rescale the last character window, but
			// cannot provide a native token count for each individual chunk.
			if (m.window.currentCharsPerSecond !== undefined && m.window.chars > 0) {
				this.heldCurrent = m.window.currentCharsPerSecond * m.nativeTokens! / m.window.chars;
				this.heldEstimated = true;
			}
		}
	}
	reset(): void {
		this.totals = new OutputTotals(); this.heldCurrent = undefined;
		this.heldEstimated = true;
		// Reset totals, preserving the active complete response measurement:
		// final usage does not expose an exact count for only its suffix.
		if (this.final) { this.measurement = undefined; this.final = false; this.finalValid = false; }
	}
	sessionReset(entries: Json[] = []): void {
		this.reset(); this.active = false; this.measurement = undefined; this.prepared = false;
		this.selectedModel = ""; this.input.restore(entries);
	}
	render(mode: "widget" | "status"): string | undefined {
		if (!this.active) return undefined;
		const m = this.measurement;
		const average = this.totals.average(this.selectedModel || m?.model || "");
		const cacheHit = m?.inputTokens && m.cachedTokens !== undefined
			? 100 * m.cachedTokens / m.inputTokens : this.input.cacheHit;
		return `momentum ${formatRate(this.heldCurrent, this.heldEstimated)} TPS ● cumulative ${formatRate(average)} TPS ● ${this.input.fields(cacheHit)}`;
	}
}

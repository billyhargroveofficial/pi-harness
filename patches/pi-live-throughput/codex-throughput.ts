// pi-harness: reference-BPE LIVE and session AVG of observed text/tool delivery.
// Both exclude hidden reasoning; AVG excludes TTFT, terminal tail and inter-request idle.
// MIT; original pi-live-throughput copyright/license remains in the package.
import { createHash, randomUUID } from "node:crypto";
import { resolveReferenceTokenizer, type TokenizerResolver } from "./reference-tokenizer.ts";
type Json = Record<string, any>;
export const hash = (text: string) => createHash("sha256").update(text, "utf16le").digest("hex");
export const counter = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const time = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
export const POLICY = Object.freeze({ cadenceMs: 200, minSpanMs: 1000, windowMs: 3000, maxUnits: 256 * 1024 });
export const formatRate = (value: number | undefined) => value === undefined || !Number.isFinite(value) || value < 0 ? "-" : `~${value.toFixed(1)}`;
export const formatInput = (value: number) => value >= 1000000 ? `${(value / 1000000).toFixed(2)}M`
	: value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(Math.round(value));

/** Native in/out accounting is deliberately separate from both TPS counters. */
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

type PrefixPart = { text: string; tokens: number; dirty: boolean };
type Sample = { t: number; tokens: number };
/** Full logical prefixes are re-encoded, never chunks. BPE prefix counts can
 * decrease (unstable suffix); signed changes are retained, not clamped. The
 * first checkpoint is an untimed baseline. Ticks advance time, not volume.
 * No content/token IDs are persisted. RAM is bounded across ALL parts.
 */
export class OutputWindow {
	parts = new Map<string, PrefixPart>();
	units = 0;
	tokens = 0;
	samples: Sample[] = [];
	invalid = false;
	reason = "warming-up";
	lastCheckpoint: number | undefined;
	lastEstimated: number | undefined;
	estimatedCurrent: number | undefined;
	firstContent: Sample | undefined;
	lastContentTime: number | undefined;
	private tokenizer: ReturnType<TokenizerResolver>;
	constructor(resolver: TokenizerResolver = resolveReferenceTokenizer) {
		try { this.tokenizer = resolver(); } catch { this.tokenizer = undefined; }
		if (!this.tokenizer) this.fail("missing-reference-runtime");
	}
	fail(reason: string): void {
		this.invalid = true; this.reason = reason; this.estimatedCurrent = undefined;
		this.parts.clear(); this.units = 0;
	}
	append(partKey: string, delta: string): void {
		if (this.invalid) return;
		if (typeof delta !== "string") { this.fail("malformed-delta"); return; }
		if (!delta.length) return;
		if (this.units + delta.length > POLICY.maxUnits) { this.fail("reference-buffer-limit"); return; }
		const part = this.parts.get(partKey) ?? { text: "", tokens: 0, dirty: false };
		part.text += delta; part.dirty = true; this.units += delta.length; this.parts.set(partKey, part);
	}
	/** Called only for a nonempty raw content delta, never by timers/done events.
	 * Preserve the FIRST atomic prefix as the untimed baseline. Later timestamps
	 * advance even between encode checkpoints, so AVG ends at the actual last
	 * content callback, not the timer/terminal/SDK save callback.
	 */
	content(t: number): void {
		if (this.invalid) return;
		if (!time(t) || (this.lastContentTime !== undefined && t < this.lastContentTime)) { this.fail("invalid-content-clock"); return; }
		if (!this.firstContent) {
			this.checkpoint(t, true);
			if (!this.invalid) this.firstContent = { t, tokens: this.tokens };
		}
		this.lastContentTime = t;
	}
	streamInterval(): { tokens: number; elapsedMs: number } | "unmeasured" | undefined {
		if (this.invalid) return undefined;
		if (!this.firstContent || this.lastContentTime === undefined) return "unmeasured";
		const elapsedMs = this.lastContentTime - this.firstContent.t;
		// Same-time/short delivery is unresolvable, not a native-token division by
		// a tiny callback gap. This is the same 1s observation resolution as LIVE.
		if (elapsedMs < POLICY.minSpanMs) return "unmeasured";
		const tokens = this.tokens - this.firstContent.tokens;
		return counter(tokens) ? { tokens, elapsedMs } : undefined;
	}
	checkpoint(t: number, force = false): number | undefined {
		if (this.invalid) return undefined;
		if (!time(t) || (this.lastCheckpoint !== undefined && t < this.lastCheckpoint)) { this.fail("invalid-clock"); return undefined; }
		if (!force && this.lastCheckpoint !== undefined && t - this.lastCheckpoint < POLICY.cadenceMs) return this.estimatedCurrent;
		if (!this.parts.size) return undefined;
		try {
			for (const part of this.parts.values()) if (part.dirty) {
				const next = this.tokenizer!(part.text);
				if (!counter(next)) { this.fail("invalid-reference-count"); return undefined; }
				const total = this.tokens + (next - part.tokens);
				if (!counter(total)) { this.fail("reference-count-overflow"); return undefined; }
				this.tokens = total; part.tokens = next; part.dirty = false;
			}
		} catch { this.fail("reference-encode-failed"); return undefined; }
		if (!counter(this.tokens)) { this.fail("reference-count-overflow"); return undefined; }
		this.lastCheckpoint = t;
		// Equal times replace volume at that instant, without moving the baseline.
		// The first atomic checkpoint is NOT replaced by a later same-time burst.
		if (this.samples.at(-1)?.t !== t) this.samples.push({ t, tokens: this.tokens });
		else if (this.samples.length > 1) this.samples[this.samples.length - 1] = { t, tokens: this.tokens };
		const cutoff = t - POLICY.windowMs;
		// Keep an observation at/before the left edge; no assumed interpolation.
		while (this.samples.length > 2 && this.samples[1].t <= cutoff) this.samples.shift();
		const baseline = this.samples[0];
		const elapsed = t - baseline.t;
		this.estimatedCurrent = undefined;
		if (elapsed < POLICY.minSpanMs) { this.reason = "warming-up"; return undefined; }
		if (this.tokens < baseline.tokens) {
			this.reason = "negative-prefix-difference"; return undefined;
		}
		const value = (this.tokens - baseline.tokens) * 1000 / elapsed;
		if (!Number.isFinite(value)) { this.fail("rate-overflow"); return undefined; }
		this.reason = "ok"; this.estimatedCurrent = value; this.lastEstimated = value;
		return value;
	}
	current(t: number, completed = false): number | undefined {
		return this.invalid ? undefined : completed ? this.estimatedCurrent : this.checkpoint(t);
	}
	clearContent(): void { this.parts.clear(); this.units = 0; }
}

// Deliberately NEW namespace: old native request durations cannot be migrated
// into stream time. First migration creates a stream epoch; reload restores it.
export const STREAM_ENTRY = "pi-harness:codex-stream-throughput";
export const STREAM_METRIC = "reference-stream-delivery";
export type StreamRecord = {
	v: 1; metric: typeof STREAM_METRIC; kind: "epoch" | "start" | "observation" | "unmeasured" | "unknown";
	origin: string; epoch: string; operation?: string; responseHash?: string;
	provider?: string; api?: string; model?: string; tokens?: number; elapsedMs?: number;
};
const identifier = (s: unknown): s is string => typeof s === "string" && s.length > 0 && s.length <= 256;
export const recordKey = (r: StreamRecord) => `${r.origin}/${r.epoch}/${r.kind === "epoch" ? "epoch" : r.kind === "start" ? "start" : "end"}/${r.operation ?? ""}`;
const signature = (r: Json) => JSON.stringify(Object.keys(r).sort().map(k => [k, r[k]]));
const records = (entries: Json[]): StreamRecord[] => entries.filter(e => e.type === "custom" && e.customType === STREAM_ENTRY).map(e => e.data);
const validRecord = (r: Json): boolean => !!r && r.v === 1 && r.metric === STREAM_METRIC && identifier(r.origin) && identifier(r.epoch)
	&& ["epoch", "start", "observation", "unmeasured", "unknown"].includes(r.kind)
	&& (r.kind === "epoch" || identifier(r.operation))
	&& (r.kind !== "observation" || (identifier(r.responseHash) && identifier(r.provider) && identifier(r.api) && identifier(r.model)
		&& counter(r.tokens) && time(r.elapsedMs) && r.elapsedMs >= POLICY.minSpanMs && r.elapsedMs <= Number.MAX_SAFE_INTEGER));

/** Ratio of validated measured stream intervals, NOT a full-coverage promise.
 * Own branches/models only. Untimed/aborted/missing intervals add neither tokens
 * nor time; gaps remain explicit diagnostics rather than permanently blanking
 * unrelated valid observations. Corrupt/conflicting numerical records still
 * fail closed. Native request records are NEVER reinterpreted as stream time.
 */
export class StreamAverage {
	epoch: string | undefined;
	tokens = 0;
	elapsedMs = 0;
	unknown = false; // Structural corruption, NOT an isolated unmeasured request.
	observations = 0;
	gaps = 0;
	unmeasured = 0;
	pendingOperations = 0;
	restore(entries: Json[], origin: string, pending = new Set<string>()): void {
		this.epoch = undefined; this.tokens = 0; this.elapsedMs = 0; this.unknown = false; this.observations = 0;
		this.gaps = 0; this.unmeasured = 0; this.pendingOperations = 0;
		const source = records(entries), own = source.filter(r => r?.origin === origin);
		let markerIndex = -1;
		const markers = new Set<string>();
		for (let i = 0; i < source.length; i++) {
			const r = source[i];
			if (r?.origin === origin && validRecord(r) && r.kind === "epoch") {
				const key = recordKey(r);
				if (markers.has(key)) continue; // A replay is not a new reset boundary.
				markers.add(key); this.epoch = r.epoch; markerIndex = i;
			}
		}
		if (!this.epoch) return;
		// Corrupt records after this epoch cannot disappear merely because their
		// origin/epoch fields are missing. Explicit foreign-origin inheritance
		// is still excluded. A new epoch clears earlier malformed coverage.
		this.unknown = source.slice(markerIndex + 1).some(r => !r || ((!identifier(r.origin) || r.origin === origin) && !validRecord(r)));
		const seen = new Map<string, StreamRecord>();
		for (const r of own.filter(r => r.epoch === this.epoch)) {
			if (!validRecord(r)) { this.unknown = true; continue; }
			const key = recordKey(r), prior = seen.get(key);
			if (prior && signature(prior) !== signature(r)) this.unknown = true;
			else seen.set(key, r);
		}
		const starts = new Map<string, StreamRecord>(), ends = new Map<string, StreamRecord>();
		for (const r of seen.values()) {
			if (r.kind === "start") starts.set(r.operation!, r);
			else if (r.kind !== "epoch") ends.set(r.operation!, r);
		}
		const responses = new Map<string, string>();
		for (const [op, r] of ends) {
			if (!starts.has(op)) { this.unknown = true; continue; }
			if (r.kind === "unknown") { this.gaps++; continue; }
			if (r.kind === "unmeasured") { this.unmeasured++; continue; }
			const responseKey = `${r.provider}/${r.responseHash}`;
			const attribution = signature({ tokens: r.tokens, elapsedMs: r.elapsedMs, provider: r.provider, api: r.api, model: r.model });
			if (responses.has(responseKey)) { if (responses.get(responseKey) !== attribution) this.unknown = true; continue; }
			responses.set(responseKey, attribution);
			if (!counter(this.tokens + r.tokens!) || !time(this.elapsedMs + r.elapsedMs!) || this.elapsedMs + r.elapsedMs! > Number.MAX_SAFE_INTEGER) {
				this.unknown = true; continue;
			}
			this.tokens += r.tokens!; this.elapsedMs += r.elapsedMs!; this.observations++;
		}
		for (const op of starts.keys()) if (!ends.has(op)) {
			if (pending.has(op)) this.pendingOperations++;
			else this.gaps++; // Crash/reload gap cannot erase independently valid sums.
		}
	}
	get value(): number | undefined {
		const result = this.tokens * 1000 / this.elapsedMs;
		return this.unknown || !this.observations || !Number.isFinite(result) ? undefined : result;
	}
}

/** Minimal durable ledger. appendEntry mutates SessionManager memory BEFORE
 * disk I/O; inspect stable keys before any retry, including after exceptions.
 * A missing temporary UI manager is UNKNOWN, never a thrown lifecycle error.
 */
export class StreamLedger {
	average = new StreamAverage();
	origin = "";
	epoch = "";
	pending = new Set<string>();
	ready = false;
	persistenceUnknown = false;
	private manager: any;
	private appendEntry: ((type: string, record: StreamRecord) => void) | undefined;
	private entries(): Json[] { try { return this.manager?.getEntries?.() ?? []; } catch { return []; } }
	bind(manager: any, appendEntry: (type: string, record: StreamRecord) => void): void {
		this.manager = manager; this.appendEntry = appendEntry;
		try { this.origin = manager?.getSessionId?.() ?? ""; } catch { this.origin = ""; }
		this.ready = identifier(this.origin) && typeof manager?.getEntries === "function";
		this.pending.clear(); this.persistenceUnknown = false; this.refresh();
		this.epoch = this.average.epoch ?? "";
		if (this.ready && !this.epoch) this.reset();
	}
	refresh(): void { this.average.restore(this.entries(), this.origin, this.pending); }
	private persist(record: StreamRecord): boolean {
		if (!this.ready || !this.appendEntry) return false;
		const existing = () => records(this.entries()).filter(r => r && recordKey(r) === recordKey(record));
		let matches = existing();
		if (matches.length) {
			if (matches.some(r => signature(r) !== signature(record))) this.persistenceUnknown = true;
			return !this.persistenceUnknown;
		}
		try { this.appendEntry(STREAM_ENTRY, record); }
		catch {
			// Never append a duplicate to repair a failed disk write.
			this.persistenceUnknown = true; matches = existing();
			this.refresh(); return false;
		}
		matches = existing();
		if (!matches.length || matches.some(r => signature(r) !== signature(record))) this.persistenceUnknown = true;
		this.refresh(); return !this.persistenceUnknown;
	}
	reset(): void {
		this.pending.clear(); this.epoch = randomUUID(); this.persistenceUnknown = false;
		this.persist({ v: 1, metric: STREAM_METRIC, kind: "epoch", origin: this.origin, epoch: this.epoch }); this.refresh();
	}
	begin(): string | undefined {
		if (!this.ready) return undefined;
		const operation = hash(randomUUID()); this.pending.add(operation);
		this.persist({ v: 1, metric: STREAM_METRIC, kind: "start", origin: this.origin, epoch: this.epoch, operation }); this.refresh();
		return operation;
	}
	end(operation: string | undefined, observation?: StreamObservation | "unmeasured"): void {
		if (!operation || !this.pending.has(operation)) return;
		const kind = this.persistenceUnknown || !observation ? "unknown" : observation === "unmeasured" ? "unmeasured" : "observation";
		const r: StreamRecord = { v: 1, metric: STREAM_METRIC, kind, origin: this.origin, epoch: this.epoch, operation };
		if (r.kind === "observation") Object.assign(r, observation);
		this.persist(r); this.pending.delete(operation); this.refresh();
	}
	get value(): number | undefined { return !this.ready || this.persistenceUnknown ? undefined : this.average.value; }
}

export type StreamObservation = Pick<StreamRecord, "responseHash" | "provider" | "api" | "model" | "tokens" | "elapsedMs">;
type Part = { hash: ReturnType<typeof createHash>; units: number; done: boolean };
type Item = { type: string; parts: Map<number, Part>; done: boolean; callId?: string; name?: string; namespace?: string; toolHash?: string };
// Canonical semantic JSON is independent of whitespace/key ordering. It is
// hashed in RAM only; never store arguments or token IDs in the stream ledger.
const canonicalJson = (value: any): string => {
	if (Array.isArray(value)) return JSON.stringify(value.map(v => canonicalJson(v)));
	if (value && typeof value === "object") return JSON.stringify(Object.keys(value).sort().map(k => [k, canonicalJson(value[k])]));
	const encoded = JSON.stringify(value);
	if (encoded === undefined) throw new Error("Non-JSON tool arguments");
	return encoded;
};
const DELTAS = new Map([["response.output_text.delta", "message"], ["response.function_call_arguments.delta", "function_call"], ["response.custom_tool_call_input.delta", "custom_tool_call"]]);
const TERMINALS = new Set(["response.completed", "response.done", "response.failed", "response.incomplete", "error"]);
export const PRECREATED_CONTROL = new Set(["rate_limits.updated", "rate_limits", "codex.rate_limits", "session.created", "session.updated", "ping", "pong", "response.queued", "response.in_progress"]);
/** LIVE/AVG validate observed stream content. Native terminal metadata is
 * retained separately for cache-hit display/raw diagnostics, never TPS scaling.
 */
export class CodexMeasurement {
	window: OutputWindow;
	requestTime: number | undefined;
	responseId: string | undefined;
	sequence: number | undefined;
	items = new Map<string, Item>();
	invalid = false;
	liveInvalid = false;
	liveSuppressed = false;
	terminal = false;
	completed = false;
	nativeTokens: number | undefined;
	fullMs: number | undefined;
	inputTokens: number | undefined;
	cachedTokens: number | undefined;
	lastEvent: number | undefined;
	terminalTime: number | undefined;
	model: string;
	providerId = "openai-codex";
	api = "openai-codex-responses";
	actual = false;
	retryUnknown = false;
	private priorTokens = 0;
	private usedResponses = new Set<string>();
	private precursorId: string | undefined;
	private precursorSequence: number | undefined;
	private resolver: TokenizerResolver;
	private frozen = false;
	private liveTextHash: string | undefined;
	private frozenLive: number | undefined;
	constructor(model: string, resolver: TokenizerResolver = resolveReferenceTokenizer) { this.model = model; this.resolver = resolver; this.window = new OutputWindow(resolver); }
	private rejectLive(reason: string): void { this.liveInvalid = true; this.window.fail(reason); }
	attribute(provider: string, api: string, model: string): void {
		if (this.frozen) return;
		if (![provider, api, model].every(identifier) || api !== "openai-codex-responses") { this.invalid = true; return; }
		if (this.actual && (provider !== this.providerId || api !== this.api || model !== this.model)) this.invalid = true;
		else { this.providerId = provider; this.api = api; this.model = model; this.actual = true; }
	}
	provider(data: Json, t: number): void {
		if (this.frozen) return;
		if (!time(t) || (this.lastEvent !== undefined && t < this.lastEvent) || (this.requestTime !== undefined && t < this.requestTime)) this.invalid = true;
		this.lastEvent = t;
		if (!data || typeof data.type !== "string") { this.invalid = true; return; }
		const type = data.type, response = data.response;
		const controlId = PRECREATED_CONTROL.has(type) ? response?.id ?? data.response_id : undefined;
		if (this.terminal && this.responseId && identifier(controlId) && controlId !== this.responseId) {
			// A retry can deliver queued/in-progress metadata BEFORE its created
			// event. Keep that response's identity/sequence separate from the old
			// attempt; usage coverage is decided when created actually arrives.
			if (this.precursorId && this.precursorId !== controlId) this.invalid = true;
			this.precursorId = controlId;
			if (data.sequence_number !== undefined) {
				if (!counter(data.sequence_number) || (this.precursorSequence !== undefined && data.sequence_number !== this.precursorSequence + 1)) this.invalid = true;
				else this.precursorSequence = data.sequence_number;
			}
			return;
		}
		if (type === "response.created") {
			const id = response?.id;
			if (!identifier(id) || id === this.responseId || this.usedResponses.has(id)) this.invalid = true;
			if (this.responseId && id !== this.responseId) {
				if (!this.terminal || this.nativeTokens === undefined) this.retryUnknown = true;
				else if (!counter(this.priorTokens + this.nativeTokens)) this.retryUnknown = true;
				else this.priorTokens += this.nativeTokens;
				this.window.clearContent(); this.window = new OutputWindow(this.resolver); this.items.clear(); this.liveInvalid = false;
				this.nativeTokens = undefined; this.fullMs = undefined; this.terminalTime = undefined; this.terminal = false; this.completed = false; this.sequence = this.precursorSequence;
			}
			if (this.precursorId && this.precursorId !== id) this.invalid = true;
			this.precursorId = undefined; this.precursorSequence = undefined; this.responseId = identifier(id) ? id : undefined;
			if (this.responseId) this.usedResponses.add(this.responseId);
		} else if (!this.responseId) {
			if (!PRECREATED_CONTROL.has(type)) { this.invalid = true; return; }
			const id = response?.id ?? data.response_id;
			if (id !== undefined) {
				if (!identifier(id) || (this.precursorId && this.precursorId !== id)) this.invalid = true;
				else this.precursorId = id;
			}
		}
		if (data.sequence_number !== undefined) {
			if (!counter(data.sequence_number) || (this.sequence !== undefined && data.sequence_number !== this.sequence + 1)) this.invalid = true;
			else this.sequence = data.sequence_number;
		}
		if (this.responseId && ((data.response_id !== undefined && data.response_id !== this.responseId) || (response?.id !== undefined && response.id !== this.responseId))) this.invalid = true;
		if (this.terminal && !PRECREATED_CONTROL.has(type)) this.invalid = true;
		if (type === "response.output_item.added") {
			const item = data.item;
			if (!identifier(item?.id) || this.items.has(item.id) || !identifier(item.type) || this.terminal) { this.rejectLive("malformed-item"); return; }
			if (this.items.size >= 256) { this.rejectLive("item-limit"); return; }
			this.items.set(item.id, { type: item.type, parts: new Map(), done: false, callId: item.call_id, name: item.name, namespace: item.namespace });
			if (!["message", "reasoning", "function_call", "custom_tool_call"].includes(item.type)) this.rejectLive("unsupported-output");
		}
		if (DELTAS.has(type)) {
			const expected = DELTAS.get(type), item = this.items.get(data.item_id);
			const index = expected === "message" ? data.content_index : 0;
			if (typeof data.delta !== "string" || !item || item.type !== expected || item.done || this.terminal || !counter(index) || index >= 64) { this.rejectLive("malformed-content"); return; }
			const part = item.parts.get(index) ?? { hash: createHash("sha256"), units: 0, done: false };
			if (part.done) { this.rejectLive("content-after-done"); return; }
			part.hash.update(data.delta, "utf16le"); part.units += data.delta.length; item.parts.set(index, part);
			this.window.append(`${data.item_id}/${index}`, data.delta);
			if (data.delta.length) this.window.content(t);
		}
		if (["response.output_text.done", "response.function_call_arguments.done", "response.custom_tool_call_input.done"].includes(type)) {
			const index = type === "response.output_text.done" ? data.content_index : 0;
			const part = this.items.get(data.item_id)?.parts.get(index);
			const text = type === "response.output_text.done" ? data.text : type === "response.function_call_arguments.done" ? data.arguments : data.input;
			if (!part || part.done || typeof text !== "string" || part.hash.copy().digest("hex") !== hash(text)) this.rejectLive("done-hash-mismatch");
			if (part) part.done = true;
		}
		if (type === "response.output_item.done") {
			const item = this.items.get(data.item?.id);
			if (!item || item.done || item.type !== data.item?.type || this.terminal) { this.rejectLive("item-done-mismatch"); return; }
			if (item.type === "message") {
				const content = data.item.content;
				if (data.item.role !== undefined && data.item.role !== "assistant") this.rejectLive("item-role");
				if (!Array.isArray(content) || content.length !== item.parts.size || content.some((p: Json) => p.type !== "output_text")) this.rejectLive("unsupported-message-content");
				for (const [index, part] of item.parts) if (typeof content?.[index]?.text !== "string" || part.hash.copy().digest("hex") !== hash(content[index].text)) this.rejectLive("item-text-hash");
			} else if (["function_call", "custom_tool_call"].includes(item.type)) {
				const text = item.type === "function_call" ? data.item.arguments : data.item.input, part = item.parts.get(0);
				if (!part || typeof text !== "string" || part.hash.copy().digest("hex") !== hash(text)) this.rejectLive("item-tool-hash");
				if (!identifier(data.item.call_id) || !identifier(data.item.name)
					|| (item.callId !== undefined && item.callId !== data.item.call_id)
					|| (item.name !== undefined && item.name !== data.item.name)
					|| (item.namespace !== undefined && item.namespace !== data.item.namespace)) this.rejectLive("item-tool-identity");
				item.callId = data.item.call_id; item.name = data.item.name; item.namespace = data.item.namespace;
				try { item.toolHash = item.type === "function_call" ? hash(canonicalJson(JSON.parse(text))) : hash(text); }
				catch { this.rejectLive("item-tool-json"); }
			}
			item.done = true;
		}
		if (TERMINALS.has(type)) {
			this.terminal = true; this.terminalTime = t; this.completed = ["response.completed", "response.done"].includes(type) && response?.status === "completed";
			// Raw total includes reasoning; absent details do not invalidate it.
			if (identifier(response?.id) && response.id === this.responseId && counter(response?.usage?.output_tokens)) this.nativeTokens = response.usage.output_tokens;
			if (counter(response?.usage?.input_tokens)) this.inputTokens = response.usage.input_tokens;
			const cached = response?.usage?.input_tokens_details?.cached_tokens;
			if (counter(cached) && this.inputTokens !== undefined && cached <= this.inputTokens) this.cachedTokens = cached;
			if (this.requestTime !== undefined) this.fullMs = t - this.requestTime;
		}
	}
	checkpoint(t: number): number | undefined { return this.invalid || this.liveInvalid ? undefined : this.window.checkpoint(this.terminalTime ?? t); }
	freeze(t: number): void {
		if (this.frozen) return;
		// Cut LIVE at the raw terminal, not at delayed message/turn callbacks.
		if (!this.invalid && !this.liveInvalid) this.window.checkpoint(this.terminalTime ?? t, true);
		if (!this.window.invalid) {
			const texts: string[] = [];
			for (const [id, item] of this.items) if (item.type === "message") for (const index of [...item.parts.keys()].sort((a, b) => a - b)) texts.push(this.window.parts.get(`${id}/${index}`)?.text ?? "");
			this.liveTextHash = hash(texts.join(""));
		}
		this.frozenLive = this.window.estimatedCurrent; this.window.clearContent(); this.frozen = true;
	}
	matches(message: Json): boolean {
		return message?.role === "assistant" && (message.responseId === undefined ? !this.completed : message.responseId === this.responseId)
			&& message.provider === this.providerId && message.api === this.api && (message.responseModel ?? message.model) === this.model;
	}
	private validSaved(message: Json): boolean {
		const content: Json[] = Array.isArray(message.content) ? message.content : [];
		const text = content.filter(p => p.type === "text").map(p => p.text ?? "").join("");
		const tools = content.filter(p => p.type === "toolCall");
		const nativeTools = [...this.items.entries()].filter(([, i]) => ["function_call", "custom_tool_call"].includes(i.type));
		let toolsMatch = tools.length === nativeTools.length;
		try {
			for (let i = 0; toolsMatch && i < nativeTools.length; i++) {
				const [id, item] = nativeTools[i], tool = tools[i];
				if (!item.toolHash || tool.id !== `${item.callId}|${id}` || tool.name !== item.name || tool.namespace !== item.namespace) { toolsMatch = false; break; }
				if (item.type === "function_call") toolsMatch = hash(canonicalJson(tool.arguments)) === item.toolHash;
				else {
					// Pi wraps grammar/custom input in exactly one declared property.
					const args = tool.arguments, keys = args && typeof args === "object" && !Array.isArray(args) ? Object.keys(args) : [];
					toolsMatch = keys.length === 1 && typeof args[keys[0]] === "string" && hash(args[keys[0]]) === item.toolHash;
				}
			}
		} catch { toolsMatch = false; }
		return this.frozen && this.matches(message) && this.completed && !this.invalid && !this.liveInvalid && !this.window.invalid
			&& !["error", "aborted", "length"].includes(message.stopReason) && this.liveTextHash === hash(text) && toolsMatch
			&& [...this.items.values()].every(i => i.done);
	}
	finish(message: Json): boolean {
		return !this.liveSuppressed && this.validSaved(message) && this.items.size > 0 && this.frozenLive !== undefined;
	}
	streamObservation(message: Json): StreamObservation | "unmeasured" | undefined {
		if (!this.validSaved(message)) return undefined;
		const interval = this.window.streamInterval();
		if (!interval || interval === "unmeasured") return interval;
		return { ...interval, responseHash: hash(this.responseId!), provider: this.providerId, api: this.api, model: this.model };
	}
	/** Raw usage diagnostic only; NOT used by displayed AVG. */
	observation(message: Json): { responseHash: string; provider: string; api: string; model: string; nativeTokens: number; elapsedMs: number } | undefined {
		if (!this.frozen || !this.matches(message) || this.invalid || this.retryUnknown || this.precursorId !== undefined || !this.terminal || !this.responseId || this.nativeTokens === undefined
			|| !time(this.fullMs) || this.fullMs <= 0 || !counter(this.priorTokens + this.nativeTokens)) return undefined;
		// The saved normalized usage, when supplied, must still match the raw
		// terminal. A failed SDK message may have zero/default usage, so only
		// raw native usage is authoritative for failed/incomplete operations.
		if (this.completed && message.usage && message.usage.output !== this.nativeTokens) return undefined;
		return { responseHash: hash([...this.usedResponses].join("\0")), provider: this.providerId, api: this.api, model: this.model, nativeTokens: this.priorTokens + this.nativeTokens, elapsedMs: this.fullMs };
	}
	current(t: number): number | undefined { return this.liveSuppressed || this.invalid || this.liveInvalid || this.window.invalid ? undefined : this.frozen ? this.frozenLive : this.checkpoint(t); }
}

/** Controller APIs are callable without a UI, for offline integration tests. */
export class CodexThroughput {
	active = false;
	measurement: CodexMeasurement | undefined;
	input = new SessionInput();
	ledger = new StreamLedger();
	selectedModel = "";
	final = false;
	finalValid = false;
	heldRate: number | undefined; // LAST: only a final-saved, validated LIVE observation.
	private operation: { measurement: CodexMeasurement; id?: string; frozen: boolean } | undefined;
	private resolver: TokenizerResolver;
	private committedEntries = new Set<string>();
	private untrackedRequest = false;
	private discardedUntilPrepare = false;
	private endedResponseKeys = new Set<string>();
	private endedMessages = new WeakSet<object>();
	constructor(resolver: TokenizerResolver = resolveReferenceTokenizer) { this.resolver = resolver; }
	isCodex(message: Json): boolean { return message?.api === "openai-codex-responses" || message?.provider === "openai-codex"; }
	bindLedger(manager: any, appendEntry: (type: string, record: StreamRecord) => void): void { this.ledger.bind(manager, appendEntry); }
	select(model: Json | undefined): void {
		const key = model ? `${model.provider}/${model.id}` : "";
		if (key !== this.selectedModel) { this.reset(); this.measurement = undefined; }
		this.selectedModel = key; this.active = !!model && this.isCodex(model);
		// Do not erase an in-flight/frozen stream operation on model_select.
	}
	prepare(model: Json, t: number): void {
		this.closeUnknown(); this.discardedUntilPrepare = false; this.select(model); this.final = false; this.finalValid = false;
		this.untrackedRequest = !this.active;
		if (!this.active) return;
		const m = new CodexMeasurement(model.id, this.resolver); m.requestTime = t;
		if (!time(t)) m.invalid = true;
		this.measurement = m; this.operation = { measurement: m, id: this.ledger.begin(), frozen: false };
	}
	start(message: Json): void {
		if (this.discardedUntilPrepare || !this.isCodex(message)) return;
		if (identifier(message.responseId) && this.endedResponseKeys.has(hash(`${message.provider}/${message.api}/${message.responseId}`))) return;
		if (!this.operation) {
			// No pre-request duration is known; stream AVG can still measure a
			// subsequently correlated first→last content interval.
			this.select({ id: message.responseModel ?? message.model, provider: message.provider, api: message.api });
			const m = new CodexMeasurement(message.responseModel ?? message.model, this.resolver);
			this.operation = { measurement: m, id: this.ledger.begin(), frozen: false }; this.measurement = m;
			this.final = false; this.finalValid = false;
		}
		const m = this.operation.measurement;
		const actualKey = `${message.provider}/${message.responseModel ?? message.model}`;
		if (actualKey !== this.selectedModel) { this.heldRate = undefined; this.selectedModel = actualKey; }
		if (m.actual && !m.matches(message)) m.invalid = true;
		else if (!m.actual) m.attribute(message.provider, message.api, message.responseModel ?? message.model);
		this.untrackedRequest = false; this.active = true;
	}
	provider(data: Json, t: number, attribution?: { provider: string; api: string; model: string }): boolean {
		if (this.discardedUntilPrepare) return false;
		if (!this.operation && this.untrackedRequest && attribution?.api === "openai-codex-responses") {
			// The hook exposes selected rather than actual routed provider. Begin
			// durable stream coverage here; native request duration is unknown,
			// but subsequent first→last content timing can be observed directly.
			const m = new CodexMeasurement(attribution.model, this.resolver); m.retryUnknown = true;
			this.operation = { measurement: m, id: this.ledger.begin(), frozen: false }; this.measurement = m;
			this.untrackedRequest = false; this.active = true;
		}
		const m = this.operation?.measurement;
		if (!m || this.operation?.frozen) return false;
		if (attribution) {
			const actualKey = `${attribution.provider}/${attribution.model}`;
			if (!m.actual && actualKey !== this.selectedModel) { this.heldRate = undefined; this.selectedModel = actualKey; }
			m.attribute(attribution.provider, attribution.api, attribution.model);
		}
		m.provider(data, t);
		// Expensive encode only at checkpoints (at most one per 200ms), not
		// per raw delta. First content checkpoint establishes the baseline.
		const due = m.window.lastCheckpoint === undefined ? m.window.parts.size > 0 : t - m.window.lastCheckpoint >= POLICY.cadenceMs;
		if (due || m.invalid || m.liveInvalid) m.checkpoint(t);
		return due || m.terminal || m.invalid || m.liveInvalid;
	}
	end(message: Json, t = performance.now()): void {
		if (this.discardedUntilPrepare || message?.role !== "assistant" || this.endedMessages.has(message)) return;
		const op = this.operation;
		if (!op || op.frozen) return;
		const m = op.measurement;
		if (identifier(message.responseId)) {
			const key = hash(`${message.provider}/${message.api}/${message.responseId}`);
			if (this.endedResponseKeys.has(key) || (m.responseId !== undefined && message.responseId !== m.responseId)) return;
		}
		if (m.actual && (message.provider !== m.providerId || message.api !== m.api || (message.responseModel ?? message.model) !== m.model)) return;
		this.untrackedRequest = false; this.endedMessages.add(message);
		if (identifier(message.responseId)) this.endedResponseKeys.add(hash(`${message.provider}/${message.api}/${message.responseId}`));
		m.freeze(t); op.frozen = true; this.final = true;
		// No stream commit at message_end: later handlers may replace the assistant.
	}
	commitSaved(messageEntryId: string, manager: any): void {
		if (this.committedEntries.has(messageEntryId)) return;
		const op = this.operation;
		if (!op?.frozen) return;
		let entry: Json | undefined;
		try { entry = manager?.getEntry?.(messageEntryId); } catch { /* unknown */ }
		const message = entry?.type === "message" ? entry.message : undefined;
		if (message && identifier(message.responseId) && message.responseId !== op.measurement.responseId
			&& this.endedResponseKeys.has(hash(`${message.provider}/${message.api}/${message.responseId}`))) return;
		this.committedEntries.add(messageEntryId);
		this.finalValid = !!message && op.measurement.finish(message);
		if (this.finalValid && this.measurement === op.measurement) this.heldRate = op.measurement.current(0);
		this.ledger.end(op.id, message ? op.measurement.streamObservation(message) : undefined); this.operation = undefined;
	}
	closeUnknown(): void {
		this.untrackedRequest = false;
		if (!this.operation) return;
		this.operation.measurement.window.clearContent(); this.ledger.end(this.operation.id); this.operation = undefined;
		this.finalValid = false; this.final = true;
	}
	reset(): void {
		this.heldRate = undefined; this.finalValid = false;
		// Do not destroy the accumulated prefix/first-content boundary needed by
		// independent session AVG. LIVE remains suppressed until the next request.
		if (this.measurement) this.measurement.liveSuppressed = true;
	}
	resetAverage(): void {
		// Raw WS created may precede SDK message_start. Every late event of this
		// pre-reset operation is barred until an actual new pre-request boundary.
		this.discardedUntilPrepare ||= !!this.operation || this.untrackedRequest;
		this.closeUnknown(); this.ledger.reset();
	}
	sessionReset(entries: Json[] = []): void {
		this.active = false; this.measurement?.window.clearContent(); this.measurement = undefined; this.operation = undefined; this.untrackedRequest = false;
		this.final = false; this.finalValid = false; this.selectedModel = ""; this.heldRate = undefined; this.committedEntries.clear();
		this.discardedUntilPrepare = false; this.endedResponseKeys.clear(); this.endedMessages = new WeakSet(); this.input.restore(entries);
	}
	render(_mode: "widget" | "status", now = performance.now()): string {
		const m = this.measurement;
		const live = this.active && (!this.final || this.finalValid) ? m?.current(now) : undefined;
		const cacheHit = m?.terminal ? (m.inputTokens && m.cachedTokens !== undefined ? 100 * m.cachedTokens / m.inputTokens : NaN) : this.input.cacheHit;
		return `${formatRate(this.active ? live ?? this.heldRate : undefined)} ${formatRate(this.active ? this.ledger.value : undefined)} TPS ${this.input.fields(cacheHit)}`;
	}
}

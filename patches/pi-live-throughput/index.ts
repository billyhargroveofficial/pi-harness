/** Conservative client output-delivery proxy. No cumulative TPS; no billing
 * usage projected onto tiny streamed tails. See docs/codex-throughput.md. */
import type { ExtensionAPI, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { CodexThroughput, OutputWindow, formatRate } from "./codex-throughput.ts";
// pi-harness: native Codex output metrics v3 (see docs/codex-throughput.md).

type Json = Record<string, any>;
type DisplayMode = "widget" | "status";
export default function (pi: ExtensionAPI): void {
	const codex = new CodexThroughput();
	let mode: DisplayMode = "status";
	let enabled = true;
	let ui: ExtensionUIContext | undefined;
	let hasUI = false;
	let timer: ReturnType<typeof setInterval> | undefined;
	let lastLine = "";
	let generic: { window: OutputWindow; key: string; final: boolean; valid: boolean } | undefined;
	let selected = "";
	let manager: any;
	let entryCount = -1;
	const syncUsage = (force = false) => {
		if (!manager?.getEntries) return;
		const entries = manager.getEntries();
		if (force || entries.length !== entryCount) { codex.input.restore(entries); entryCount = entries.length; }
	};
	const key = (message: Json) => `${message.provider}/${message.responseModel ?? message.model ?? message.id}`;
	const clearUi = () => { ui?.setWidget("throughput", undefined); ui?.setStatus("throughput", undefined); lastLine = ""; };
	const render = () => {
		if (!hasUI || !enabled) return;
		syncUsage();
		const now = performance.now();
		const value = generic && (!generic.final || generic.valid) ? generic.window.current(now, generic.final) : undefined;
		const line = codex.render(mode, now) ?? `${formatRate(value)} TPS ${codex.input.fields()}`;
		if (line === lastLine) return;
		lastLine = line;
		if (mode === "status") { ui?.setWidget("throughput", undefined); ui?.setStatus("throughput", line); }
		else { ui?.setStatus("throughput", undefined); ui?.setWidget("throughput", [line]); }
	};
	const bind = (ctx: any) => { ui = ctx.ui; hasUI = ctx.hasUI; if (ctx.sessionManager !== manager) { manager = ctx.sessionManager; entryCount = -1; } };
	pi.on("session_start", (_event, ctx) => {
		bind(ctx); generic = undefined; selected = ctx.model ? key(ctx.model) : "";
		codex.sessionReset(ctx.sessionManager?.getEntries?.() ?? []); entryCount = ctx.sessionManager?.getEntries?.().length ?? -1; codex.select(ctx.model);
		if (timer) clearInterval(timer);
		// Timer only clears stale in-flight observations, never adds a token or
		// divides by render time. Final last-response rate is kept until request.
		if (hasUI) { timer = setInterval(render, 500); timer.unref?.(); }
		clearUi(); render();
	});
	pi.on("model_select", (_event, ctx) => {
		bind(ctx); const next = ctx.model ? key(ctx.model) : "";
		if (next !== selected) generic = undefined;
		selected = next; codex.select(ctx.model); render();
	});
	const refreshUsage = (_event: any, ctx: any) => { bind(ctx); syncUsage(true); render(); };
	pi.on("turn_end", refreshUsage);
	pi.on("session_compact", refreshUsage);
	pi.on("session_tree", refreshUsage);
	pi.on("session_shutdown", () => {
		if (timer) clearInterval(timer); timer = undefined;
		clearUi(); generic = undefined; codex.sessionReset(); manager = undefined; entryCount = -1; ui = undefined; hasUI = false;
	});
	pi.on("before_provider_request", (_event, ctx) => {
		bind(ctx); generic = undefined;
		if (ctx.model) codex.prepare(ctx.model, performance.now());
		else { codex.measurement = undefined; codex.final = false; codex.finalValid = false; }
		render();
	});
	pi.on("provider_stream_event", (event, ctx) => {
		const at = performance.now();
		if (event.api !== "openai-codex-responses" || !event.data || typeof event.data !== "object") return;
		bind(ctx);
		if (codex.measurement && ((event.model && event.model !== codex.measurement.model) || (event.provider && ctx.model?.provider && event.provider !== ctx.model.provider))) { codex.measurement.invalid = true; render(); return; }
		if (codex.provider(event.data, at)) render();
	});
	pi.on("message_start", (event, ctx) => {
		if (event.message.role !== "assistant") return;
		bind(ctx); codex.start(event.message);
		if (codex.active) generic = undefined;
		else generic = { window: new OutputWindow(), key: key(event.message), final: false, valid: true };
		render();
	});
	pi.on("message_update", (event, ctx) => {
		if (event.message.role !== "assistant" || codex.active || !generic || generic.final) return;
		bind(ctx);
		if (key(event.message) !== generic.key) { generic.valid = false; generic.window.invalid = true; render(); return; }
		const update = event.assistantMessageEvent;
		// Delivered thinking deltas may be summaries; not output decode counts.
		// Never treat final usage or completed snapshots as a timed output burst.
		if (["text_delta", "toolcall_delta"].includes(update.type)) {
			if (typeof update.delta !== "string") { generic.valid = false; generic.window.invalid = true; }
			else generic.window.add(performance.now(), update.delta.length);
			render();
		}
	});
	pi.on("message_end", (event, ctx) => {
		bind(ctx);
		if (event.message.role === "toolResult") { codex.input.add(event.message, false); render(); return; }
		if (event.message.role !== "assistant") return;
		const duplicateEnd = codex.active ? codex.final : generic?.final;
		if (!duplicateEnd) codex.input.add(event.message);
		if (codex.active) codex.end(event.message);
		else if (generic && !generic.final) {
			generic.final = true;
			generic.valid = generic.valid && !generic.window.invalid && key(event.message) === generic.key
				&& !["error", "aborted", "length"].includes(event.message.stopReason);
		}
		render();
	});
	pi.registerCommand("throughput", {
		description: "Output TPS estimate and session in/out. Args: on|off|widget|status|reset",
		handler: async (args, ctx) => {
			bind(ctx); const arg = args.trim().toLowerCase();
			if (!arg || arg === "toggle") { enabled = !enabled; clearUi(); render(); }
			else if (arg === "on" || arg === "off") { enabled = arg === "on"; clearUi(); render(); }
			else if (arg === "widget" || arg === "status") { mode = arg; enabled = true; clearUi(); render(); }
			else if (arg === "reset") {
				codex.reset();
				if (generic) { if (generic.final) generic = undefined; else generic.window = new OutputWindow(); }
				clearUi(); render(); ctx.ui.notify("TPS observation reset; session usage unchanged", "info"); return;
			} else { ctx.ui.notify("Usage: /throughput [on|off|widget|status|reset|toggle]", "error"); return; }
			ctx.ui.notify(`Live throughput: ${enabled ? mode : "off"}`, "info");
		},
	});
}

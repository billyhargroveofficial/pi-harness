/** HYBRID: ~LIVE reference-BPE delivery, ~AVG native effective operation TPS.
 * LIVE fallback is LAST, not a fresh idle observation. AVG starts at the durable
 * enable/reset epoch; historical usage without operation durations is not AVG.
 */
import { getAgentDir, type ExtensionAPI, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { CodexThroughput, POLICY } from "./codex-throughput.ts";
import { resolveReferenceTokenizer, type TokenizerResolver } from "./reference-tokenizer.ts";

type DisplayMode = "widget" | "status";
export function createThroughputExtension(pi: ExtensionAPI, options: { resolver?: TokenizerResolver; clock?: () => number } = {}): CodexThroughput {
	const codex = new CodexThroughput(options.resolver ?? (() => resolveReferenceTokenizer({ agentDir: getAgentDir() })));
	const clock = options.clock ?? (() => performance.now());
	let mode: DisplayMode = "status";
	let enabled = true;
	let ui: ExtensionUIContext | undefined;
	let hasUI = false;
	let timer: ReturnType<typeof setInterval> | undefined;
	let lastLine = "";
	let manager: any;
	let entryCount = -1;
	const append = (type: string, record: any) => pi.appendEntry(type, record);
	const syncUsage = (force = false) => {
		try {
			const entries = manager?.getEntries?.();
			if (entries && (force || entries.length !== entryCount)) { codex.input.restore(entries); entryCount = entries.length; }
		} catch { /* Temporary/missing UI session managers must not throw. */ }
	};
	const clearUi = () => { ui?.setWidget("throughput", undefined); ui?.setStatus("throughput", undefined); lastLine = ""; };
	const render = () => {
		if (!hasUI || !enabled) return;
		syncUsage();
		const line = codex.render(mode, clock());
		if (line === lastLine) return;
		lastLine = line;
		if (mode === "status") { ui?.setWidget("throughput", undefined); ui?.setStatus("throughput", line); }
		else { ui?.setStatus("throughput", undefined); ui?.setWidget("throughput", [line]); }
	};
	const bind = (ctx: any) => { ui = ctx.ui; hasUI = ctx.hasUI; manager = ctx.sessionManager; };
	pi.on("session_start", (_event, ctx) => {
		bind(ctx); entryCount = -1;
		codex.sessionReset(); syncUsage(true); codex.bindLedger(manager, append); codex.select(ctx.model);
		if (timer) clearInterval(timer);
		// Active silence decays LIVE, never fabricates tokens. No native pending
		// duration is mixed into the completed-operation denominator.
		if (hasUI) { timer = setInterval(render, POLICY.cadenceMs); timer.unref?.(); }
		clearUi(); render();
	});
	pi.on("model_select", (_event, ctx) => { bind(ctx); codex.select(ctx.model); render(); });
	pi.on("before_provider_request", (_event, ctx) => {
		const at = clock(); bind(ctx);
		if (ctx.model) codex.prepare(ctx.model, at);
		else { codex.closeUnknown(); codex.select(undefined); }
		render();
	});
	pi.on("provider_stream_event", (event, ctx) => {
		const at = clock();
		if (event.api !== "openai-codex-responses") return;
		bind(ctx);
		if (codex.provider(event.data as Record<string, any>, at, { provider: event.provider, api: event.api, model: event.model })) render();
	});
	pi.on("message_start", (event, ctx) => {
		if (event.message.role !== "assistant") return;
		bind(ctx); codex.start(event.message); render();
	});
	pi.on("message_end", (event, ctx) => {
		const at = clock(); bind(ctx);
		if (event.message.role === "toolResult") codex.input.add(event.message, false);
		else if (event.message.role === "assistant") codex.end(event.message, at);
		// Freeze only. turn_end resolves the final saved assistant AFTER all
		// message_end replacement handlers. Never bill the early event object.
		render();
	});
	pi.on("turn_end", (event, ctx) => {
		bind(ctx); codex.commitSaved(event.messageEntryId, manager); syncUsage(true); render();
	});
	const refreshUsage = (_event: any, ctx: any) => { bind(ctx); syncUsage(true); render(); };
	pi.on("session_compact", refreshUsage);
	pi.on("session_tree", refreshUsage);
	pi.on("agent_before_settle", (_event, ctx) => {
		bind(ctx); codex.closeUnknown(); render();
		// Covers abort/error paths without turn_end; durable start is closed as
		// UNKNOWN, rather than silently excluding the operation from coverage.
	});
	pi.on("session_shutdown", () => {
		codex.closeUnknown();
		if (timer) clearInterval(timer); timer = undefined;
		clearUi(); codex.sessionReset(); manager = undefined; entryCount = -1; ui = undefined; hasUI = false;
	});
	pi.registerCommand("throughput", {
		description: "Hybrid LIVE/AVG TPS; session in/out. on|off|widget|status|reset|reset-avg|reset-all",
		handler: async (args, ctx) => {
			bind(ctx); const arg = args.trim().toLowerCase();
			if (!arg || arg === "toggle") { enabled = !enabled; clearUi(); render(); }
			else if (arg === "on" || arg === "off") { enabled = arg === "on"; clearUi(); render(); }
			else if (arg === "widget" || arg === "status") { mode = arg; enabled = true; clearUi(); render(); }
			else if (["reset", "reset-avg", "reset-all"].includes(arg)) {
				if (arg !== "reset-avg") codex.reset();
				if (arg !== "reset") codex.resetAverage();
				clearUi(); render(); ctx.ui.notify(arg === "reset" ? "LIVE reset; AVG and session usage unchanged" : "New native AVG measurement epoch; session usage unchanged", "info"); return;
			} else { ctx.ui.notify("Usage: /throughput [on|off|widget|status|reset|reset-avg|reset-all|toggle]", "error"); return; }
			ctx.ui.notify(`Live throughput: ${enabled ? mode : "off"}`, "info");
		},
	});
	return codex;
}
export default function (pi: ExtensionAPI): void { createThroughputExtension(pi); }

/** Display-only compact tool rows. Kept outside npm packages so updates preserve it. */
import { AssistantMessageComponent, ToolExecutionComponent, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container, sliceByColumn, truncateToWidth } from "@earendil-works/pi-tui";

const PATCH = Symbol.for("billy:compact-tool-rows:v1");
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const plain = (text: string) => text.replace(ANSI, "");
const GROUP_PATCH = Symbol.for("billy:compact-tool-groups:v1");
const LABELS: Record<string, string> = { read: "Read", bash: "Bash", grep: "Search", find: "Find", ls: "List", write: "Write", edit: "Update" };
const flat = (value: unknown) => String(value ?? "").replace(/[\r\n\t]+/g, " ").trim();

/** Call metadata only. Never render result bodies/diffs/images to build a group. */
function describeCall(tool: any, state: any) {
	const args = tool.args ?? {};
	const lines: string[] = tool.callRendererComponent?.render(512) ?? [];
	const raw = lines.find(line => plain(line).trim() !== "") ?? "";
	const clean = plain(raw);
	const nativeLabel = clean.trim().replace(/^[⏺●▸]\s*/u, "").match(/^([^()]+)\(/u)?.[1]?.trim();
	const label = ["write", "edit"].includes(tool.toolName)
		? nativeLabel ?? LABELS[tool.toolName]
		: LABELS[tool.toolName] ?? nativeLabel ?? tool.toolName;
	let summary = flat(args.path ?? args.file_path ?? args.command ?? args.description ?? args.pattern ?? args.query ?? args.tool ?? "…");
	if (tool.cwd && summary.startsWith(`${tool.cwd}/`)) summary = summary.slice(tool.cwd.length + 1);
	const theme = state.getTheme?.();
	const dot = process.platform === "darwin" ? "⏺" : "●";
	// Keep the renderer's two-column blink slot, including its off-phase spaces.
	const prefix = /^(?:[⏺●▸] | {2})/u.test(clean) ? sliceByColumn(raw, 0, 2) : `${dot} `;
	const error = tool.result?.isError === true;
	const key = `${tool.toolName}:${label}:${args.tool ?? ""}`;
	return { key, label, summary, prefix, error, theme, hasPrefix: /^(?:[⏺●▸] | {2})/u.test(clean) };
}

/** Expand a visual tool block together: npm may have a mixed read/search group. */
function expandToolBlock(parent: any, members: any[], width: number) {
	const children = parent.children;
	const belongs = (child: any) => child instanceof ToolExecutionComponent ||
		(child instanceof AssistantMessageComponent && child.render(width).every((row: string) => !plain(row).trim()));
	let first = children.indexOf(members[0]);
	let last = children.indexOf(members[members.length - 1]);
	while (first > 0 && belongs(children[first - 1])) first--;
	while (last + 1 < children.length && belongs(children[last + 1])) last++;
	for (const child of children.slice(first, last + 1)) if (child instanceof ToolExecutionComponent) child.setExpanded(true);
	members[0].ui.requestRender();
}

/** Group concrete transcript siblings, not event-global ids: works on replay too. */
function installTranscriptGroups(state: any) {
	const proto = Container.prototype as any;
	if (proto[GROUP_PATCH]) return;
	const originalRender = proto.render;
	const originalMouse = proto.handleMouse;
	proto.render = function (width: number): string[] {
		if (!state.enabled || this.constructor !== Container || !this.children.some((c: any) => c instanceof ToolExecutionComponent)) {
			return originalRender.call(this, width);
		}
		const lines: string[] = [];
		const mouseChildren: any[] = [];
		let previousVisible: any;
		let run: any[] = [];
		let runKey: string | undefined;
		const append = (component: any, rows: string[]) => {
			mouseChildren.push({ component, height: rows.length });
			lines.push(...rows.map(row => width > 0 ? truncateToWidth(row, width, "…") : ""));
		};
		const separate = (rows: string[]) => {
			if (previousVisible instanceof AssistantMessageComponent && rows.length && plain(rows[0]).trim() && lines.length && plain(lines[lines.length - 1]).trim()) {
				append({ render: () => [""], invalidate() {} }, [""]);
			}
		};
		const flush = () => {
			if (!run.length) return;
			const calls = run.map(tool => describeCall(tool, state));
			const first = calls[0];
			const styled = first.theme?.bold(first.label) ?? first.label;
			const errors = calls.filter(c => c.error).length;
			let rows: string[];
			if (run.length === 1) {
				// Standard tools bypass npm's mixed read/search group summary and
				// hidden members. Custom tools keep their own compact call header.
				rows = LABELS[run[0].toolName]
					? [`${first.prefix}${styled}(${first.summary})${errors ? " ✗" : ""}`]
					: run[0].render(width);
			} else {
				const tail = calls.slice(-3);
				const pending = run.findLastIndex(tool => !tool.result || tool.isPartial);
				const prefix = pending >= 0 && calls[pending].hasPrefix ? calls[pending].prefix : first.prefix;
				rows = [`${prefix}${styled}(${calls.length} calls${calls.length > 3 ? " · tail 3" : ""})${errors ? ` ✗${errors}` : ""}`];
				for (let i = 0; i < tail.length; i++) {
					const text = `${i === 0 ? "  ⎿ → " : "    → "}${tail[i].summary}${tail[i].error ? " ✗" : ""}`;
					rows.push(first.theme?.fg("dim", text) ?? text);
				}
			}
			rows = width > 0 ? rows.map(row => truncateToWidth(row, width, "…")) : [];
			separate(rows);
			const members = run;
			const parent = this;
			append({
				render: () => rows,
				invalidate() { for (const member of members) member.invalidate(); },
				handleMouse(event: any) {
					if (event.type !== "click" || event.button !== "left" || !members.some(m => m.result)) return undefined;
					expandToolBlock(parent, members, width);
					return { handled: true };
				},
			}, rows);
			previousVisible = members[members.length - 1];
			run = [];
			runKey = undefined;
		};
		for (const child of this.children) {
			if (child instanceof ToolExecutionComponent && !(child as any).expanded && !(child as any).hideComponent) {
				const key = describeCall(child, state).key;
				if (run.length && key !== runKey) flush();
				run.push(child);
				runKey = key;
				continue;
			}
			const rows = child.render(width);
			// Invisible assistant thinking/tool-only messages do not create fake
			// gaps or move the tail. Visible commentary always breaks a group.
			if (child instanceof AssistantMessageComponent && rows.every((row: string) => !plain(row).trim())) continue;
			flush();
			if (child instanceof ToolExecutionComponent) separate(rows);
			append(child, rows);
			if (rows.some((row: string) => plain(row).trim())) previousVisible = child;
		}
		flush();
		// Preserve mouse hit-testing despite collapsed/omitted sibling rows.
		this.mouseLayout = { width, children: mouseChildren };
		return lines;
	};
	proto.handleMouse = function (event: any) {
		if (state.enabled && this.constructor === Container && typeof event.width === "number" && this.mouseLayout?.width !== event.width) this.render(event.width);
		return originalMouse.call(this, event);
	};
	proto[GROUP_PATCH] = true;
}

export default function (pi: ExtensionAPI) {
	// Patch the same public host class as better-claude-code-ui. Never touch
	// tool execution, result content, model context, or package files.
	const proto = ToolExecutionComponent.prototype as any;
	if (!proto[PATCH]) {
		const state = { enabled: true };
		const originalRender = proto.render;
		const originalMouse = proto.handleMouse;
		proto.render = function (width: number): string[] {
			if (!state.enabled || this.expanded) return originalRender.call(this, width);
			if (this.hideComponent || width < 1) return [];

			// Rendering only the call avoids stdout, diffs, image escape sequences,
			// and streaming previews. Empty calls stay empty (CC grouped members).
			let row: string;
			if (this.callRendererComponent) {
				const lines: string[] = this.callRendererComponent.render(Math.max(width, 512));
				const first = lines.findIndex((line) => plain(line).trim() !== "");
				if (first < 0) return [];
				// Continuation lines beginning with the CC branch marker are details,
				// not arguments. Flatten multiline call arguments, but drop details.
				const header: string[] = [];
				for (const line of lines.slice(first)) {
					if (/^\s*[⎿└├│]/u.test(plain(line))) break;
					// The first line's leading spaces reserve the blinking dot's
					// column during its off phase. Never trim/collapse that slot.
					header.push(header.length === 0 ? line.trimEnd() : line.trim());
				}
				row = header.join(" ");
			} else {
				// Custom/MCP tools without a call renderer also get one safe row.
				const args = this.args ?? {};
				const value = args.path ?? args.command ?? args.description ?? args.query ?? args.tool ?? JSON.stringify(args);
				row = `● ${this.toolName}(${String(value).replace(/[\r\n\t]+/g, " ")})`;
			}
			if (this.result?.isError) row += " ✗";
			return [truncateToWidth(row, width, "…")];
		};
		proto.handleMouse = function (event: any) {
			if (!state.enabled || this.expanded) return originalMouse.call(this, event);
			// The compact row has no leading spacer, unlike the host self-shell.
			if (event.y === 0 && event.type === "click" && event.button === "left" && this.result) {
				this.setExpanded(true);
				this.ui.requestRender();
				return { handled: true };
			}
			return undefined;
		};
		proto[PATCH] = state;
	}

	const state = proto[PATCH];
	installTranscriptGroups(state);
	pi.on("session_start", (_event, ctx) => { state.getTheme = () => ctx.ui.theme; });

	pi.registerCommand("compact-tools", {
		description: "Compact tool calls with same-tool tail groups: on/off/toggle (Ctrl+O expands)",
		async handler(args, ctx) {
			const state = proto[PATCH];
			const option = args.trim().toLowerCase();
			if (option && !["on", "off", "toggle"].includes(option)) {
				ctx.ui.notify("Usage: /compact-tools on|off|toggle", "error");
				return;
			}
			state.enabled = option === "on" ? true : option === "off" ? false : !state.enabled;
			// Changing a local display policy is independent of the global Ctrl+O
			// expanded state. ctx.ui's notification schedules a fresh TUI render.
			ctx.ui.notify(`Compact tools: ${state.enabled ? "on" : "off"} · Ctrl+O раскрывает вывод`, "info");
		},
	});
}

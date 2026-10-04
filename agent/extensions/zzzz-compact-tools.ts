/** Display-only compact tool rows and message separators; kept outside npm. */
import { AssistantMessageComponent, UserMessageComponent, ToolExecutionComponent, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container, truncateToWidth } from "@earendil-works/pi-tui";

const PATCH = Symbol.for("billy:compact-tool-rows:v2");
const LEGACY = Symbol.for("billy:compact-tool-rows:v1");
const SPACING = Symbol.for("billy:message-tool-spacing:v1");
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const plain = (text: string) => text.replace(ANSI, "");

/** A transient spacer, never a mutation of the transcript or model messages. */
function installMessageSpacing() {
	const proto = Container.prototype as any;
	if (proto[SPACING]) return;
	const originalRender = proto.render;
	const originalMouse = proto.handleMouse;
	proto.render = function (width: number): string[] {
		if (this.constructor !== Container || !this.children.some((c: any) => c instanceof AssistantMessageComponent || c instanceof UserMessageComponent)) {
			return originalRender.call(this, width);
		}
		const lines: string[] = [];
		const mouseChildren: any[] = [];
		let previousVisible: any;
		for (const child of this.children) {
			const rows: string[] = child.render(width);
			const visible = rows.some(row => plain(row).trim());
			const afterMessage = previousVisible instanceof AssistantMessageComponent || previousVisible instanceof UserMessageComponent;
			if (visible && afterMessage && rows.length && plain(rows[0]).trim() && lines.length && plain(lines[lines.length - 1]).trim()) {
				lines.push("");
				mouseChildren.push({ component: { render: () => [""], invalidate() {} }, height: 1 });
			}
			lines.push(...rows.map(row => width > 0 ? truncateToWidth(row, width, "…") : ""));
			mouseChildren.push({ component: child, height: rows.length });
			if (visible) previousVisible = child;
		}
		this.mouseLayout = { width, children: mouseChildren };
		return lines;
	};
	proto.handleMouse = function (event: any) {
		if (this.constructor === Container && typeof event.width === "number" && this.mouseLayout?.width !== event.width) this.render(event.width);
		return originalMouse.call(this, event);
	};
	proto[SPACING] = true;
}

export default function (pi: ExtensionAPI) {
	const proto = ToolExecutionComponent.prototype as any;
	// The old optional grouping wrapper closes over v1. Disable that state on
	// /reload, then use an independent v2 state for the original compact rows.
	// This also makes /compact-tools off delegate all the way to the host again.
	if (proto[LEGACY]) proto[LEGACY].enabled = false;
	if (!proto[PATCH]) {
		const state = { enabled: true };
		const originalRender = proto.render;
		const originalMouse = proto.handleMouse;
		proto.render = function (width: number): string[] {
			if (!state.enabled || this.expanded) return originalRender.call(this, width);
			if (this.hideComponent || width < 1) return [];
			let row: string;
			if (this.callRendererComponent) {
				const lines: string[] = this.callRendererComponent.render(Math.max(width, 512));
				const first = lines.findIndex(line => plain(line).trim() !== "");
				if (first < 0) return [];
				const header: string[] = [];
				for (const line of lines.slice(first)) {
					if (/^\s*[⎿└├│]/u.test(plain(line))) break;
					// Preserve the two-column blink slot, even during its off phase.
					header.push(header.length === 0 ? line.trimEnd() : line.trim());
				}
				row = header.join(" ");
			} else {
				const args = this.args ?? {};
				const value = args.path ?? args.command ?? args.description ?? args.query ?? args.tool ?? JSON.stringify(args);
				row = `● ${this.toolName}(${String(value).replace(/[\r\n\t]+/g, " ")})`;
			}
			if (this.result?.isError) row += " ✗";
			return [truncateToWidth(row, width, "…")];
		};
		proto.handleMouse = function (event: any) {
			if (!state.enabled || this.expanded) return originalMouse.call(this, event);
			if (event.y === 0 && event.type === "click" && event.button === "left" && this.result) {
				this.setExpanded(true);
				this.ui.requestRender();
				return { handled: true };
			}
			return undefined;
		};
		proto[PATCH] = state;
	}
	installMessageSpacing();
	pi.registerCommand("compact-tools", {
		description: "One-line tool calls without output: on/off/toggle (Ctrl+O expands)",
		async handler(args, ctx) {
			const state = proto[PATCH];
			const option = args.trim().toLowerCase();
			if (option && !["on", "off", "toggle"].includes(option)) {
				ctx.ui.notify("Usage: /compact-tools on|off|toggle", "error");
				return;
			}
			state.enabled = option === "on" ? true : option === "off" ? false : !state.enabled;
			ctx.ui.notify(`Compact tools: ${state.enabled ? "on" : "off"} · Ctrl+O раскрывает вывод`, "info");
		},
	});
}

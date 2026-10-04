/** Display-only compact tool rows. Kept outside npm packages so updates preserve it. */
import { ToolExecutionComponent, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";

const PATCH = Symbol.for("billy:compact-tool-rows:v1");
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const plain = (text: string) => text.replace(ANSI, "");

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
			// Changing a local display policy is independent of the global Ctrl+O
			// expanded state. ctx.ui's notification schedules a fresh TUI render.
			ctx.ui.notify(`Compact tools: ${state.enabled ? "on" : "off"} · Ctrl+O раскрывает вывод`, "info");
		},
	});
}

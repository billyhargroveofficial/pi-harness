import type { StatusLineCommandConfig } from "./types";
import { visibleWidth, truncateToWidth } from "@earendil-works/pi-tui";
// pi-harness: compact throughput fields in the existing footer, v3.
const UI_KEY = "pi-statusline";
const statusGray = (text: string): string => `\u001b[38;5;8m${text}\u001b[0m`;

export function clearStatusLineUi(ctx: any): void {
  ctx.ui.setWidget(UI_KEY, undefined); ctx.ui.setFooter(undefined);
}
export function applyStatusLineUi(ctx: any, config: StatusLineCommandConfig, lines: string[]): void {
  const pad = " ".repeat(Math.max(0, config.padding ?? 0));
  // Legacy command output is normalized too, so a reload doesn't need another
  // external Python invocation to replace the large separators.
  const padded = (lines.length ? lines : [""]).map(line => pad + line.replace(/ ● /g, " · "));
  if (config.placement === "widget") {
    ctx.ui.setWidget(UI_KEY, padded, { placement: config.widgetPlacement ?? "belowEditor" });
    ctx.ui.setFooter(undefined); return;
  }
  ctx.ui.setWidget(UI_KEY, undefined);
  ctx.ui.setFooter((_tui: unknown, _theme: unknown, footerData: { getExtensionStatuses(): ReadonlyMap<string, string> }) => ({
    render(width: number) {
      const throughput = footerData?.getExtensionStatuses().get("throughput");
      if (!throughput) return padded.map(line => truncateToWidth(line, width, ""));
      if (width <= 0) return [""];
      const output = padded.slice(0, -1);
      let current = padded.at(-1) ?? "";
      // TPS, hit, in, out are wrap units without extra dots between them.
      const fields = throughput.split(/ (?=hit |in |out )/);
      for (let i = 0; i < fields.length; i++) {
        const separator = i === 0 && current ? " · " : current ? " " : "";
        const combined = current + statusGray(separator + fields[i]);
        if (current && visibleWidth(combined) > width) { output.push(truncateToWidth(current, width, "")); current = ""; }
        if (current) current = combined;
        else {
          // Also cope with panes narrower than one field. Never exceed width;
          // split on words when possible, preserving Unicode/ANSI widths.
          for (const word of fields[i].split(" ")) {
            const next = current + statusGray((current ? " " : "") + word);
            if (current && visibleWidth(next) > width) { output.push(truncateToWidth(current, width, "")); current = statusGray(word); }
            else current = next;
          }
        }
      }
      if (current) output.push(truncateToWidth(current, width, ""));
      return output.map(line => truncateToWidth(line, width, ""));
    },
    invalidate() {},
  }));
}

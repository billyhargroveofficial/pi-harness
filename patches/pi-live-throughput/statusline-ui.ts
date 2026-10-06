import type { StatusLineCommandConfig } from "./types";
import { visibleWidth, truncateToWidth } from "@earendil-works/pi-tui";
// pi-harness: compact throughput fields in the existing footer, v1.

const UI_KEY = "pi-statusline";

function padLines(lines: string[], padding: number): string[] {
  const pad = " ".repeat(Math.max(0, padding));
  return lines.length === 0 ? [""] : lines.map((line) => `${pad}${line}`);
}

function skipAnsiSequence(line: string, start: number): number {
  const next = line[start + 1];

  if (next === "[") {
    let i = start + 2;
    while (i < line.length) {
      const ch = line.charCodeAt(i);
      if (ch >= 0x40 && ch <= 0x7e) {
        return i + 1;
      }
      i++;
    }
    return line.length;
  }

  if (next === "]") {
    let i = start + 2;
    while (i < line.length) {
      if (line[i] === "\u0007") {
        return i + 1;
      }
      if (line[i] === "\u001b" && line[i + 1] === "\\") {
        return i + 2;
      }
      i++;
    }
    return line.length;
  }

  return Math.min(line.length, start + 2);
}

function truncateLine(line: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";

  let output = "";
  let width = 0;

  for (let i = 0; i < line.length; ) {
    if (line[i] === "\u001b") {
      const end = skipAnsiSequence(line, i);
      output += line.slice(i, end);
      i = end;
      continue;
    }

    if (width >= maxWidth) {
      return output;
    }

    output += line[i];
    width++;
    i++;
  }

  return output;
}

export function clearStatusLineUi(ctx: any): void {
  ctx.ui.setWidget(UI_KEY, undefined);
  ctx.ui.setFooter(undefined);
}

export function applyStatusLineUi(ctx: any, config: StatusLineCommandConfig, lines: string[]): void {
  const padded = padLines(lines, config.padding ?? 0);

  if (config.placement === "widget") {
    ctx.ui.setWidget(UI_KEY, padded, {
      placement: config.widgetPlacement ?? "belowEditor",
    });
    ctx.ui.setFooter(undefined);
    return;
  }

  ctx.ui.setWidget(UI_KEY, undefined);
  ctx.ui.setFooter((_tui: unknown, _theme: unknown, footerData: { getExtensionStatuses(): ReadonlyMap<string, string> }) => ({
    render(width: number) {
      const throughput = footerData?.getExtensionStatuses().get("throughput");
      if (!throughput) return padded.map((line) => truncateToWidth(line, width, ""));
      const output = padded.slice(0, -1);
      let current = padded.at(-1) ?? "";
      // Wrap between fields when the pane is narrow; no metric is silently
      // dropped and the external status command is not re-run per delta.
      for (const field of throughput.split(" ● ")) {
        const combined = current ? `${current} ● ${field}` : field;
        if (current && visibleWidth(combined) > width) {
          output.push(truncateToWidth(current, width, ""));
          current = field;
        } else current = combined;
      }
      output.push(truncateToWidth(current, width, ""));
      return output.map((line) => truncateToWidth(line, width, ""));
    },
    invalidate() {
      // static until next refresh
    },
  }));
}

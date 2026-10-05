#!/usr/bin/env node
/** Follow the live Pi theme: dark ink on light, white on dark.
 * Applied after zz-orca-style; the color is part of the existing raster cache key.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
const root = join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi/agent"), "npm/node_modules/@fadouse/pi-math/src");
const edits = [
  ["markdown-patch.ts", "export function installMarkdownMathPatch(renderer: TerminalMathRenderer): MathPatchController {", "export function installMarkdownMathPatch(renderer: TerminalMathRenderer, getAppearance: () => string | undefined = () => undefined): MathPatchController {"],
  ["markdown-patch.ts", '      ? "#ffffff"\n      : formulaColor(markdown);', '      ? (getAppearance() === "light" ? "#202124" : "#ffffff")\n      : formulaColor(markdown);'],
  ["index.ts", "  const patch = renderer ? installMarkdownMathPatch(renderer) : undefined;", '  let getAppearance: () => string | undefined = () => undefined;\n  const patch = renderer ? installMarkdownMathPatch(renderer, () => getAppearance()) : undefined;'],
  ["index.ts", '  pi.on("session_start", (_event, ctx) => {\n    if (loadFailure', '  pi.on("session_start", (_event, ctx) => {\n    // Read the current Theme through the UI getter, never capture the old Theme.\n    getAppearance = () => ctx.ui.theme.appearance;\n    if (loadFailure'],
];
const files = new Map();
for (const [file] of edits) if (!files.has(file)) files.set(file, readFileSync(join(root, file), "utf8"));
const states = edits.map(([file, before, after]) => {
  const source = files.get(file);
  if (source.split(after).length === 2) return "patched";
  if (source.split(before).length === 2) return "original";
  throw new Error(`Unexpected pi-math source in ${file}; refusing edit`);
});
if (states.every((s) => s === "patched")) {
  console.log("pi-math live theme: already patched");
} else {
  if (!states.every((s) => s === "original")) throw new Error("Partial pi-math theme patch; inspect before applying");
  for (const [file, before, after] of edits) files.set(file, files.get(file).replace(before, after));
  for (const [file, source] of files) writeFileSync(join(root, file), source);
  console.log("pi-math live theme: patched");
}

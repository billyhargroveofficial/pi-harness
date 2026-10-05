#!/usr/bin/env node
/** Orca clears each terminal row on redraw, erasing multi-row Kitty images.
 * Fit display math into one cell row while retaining MathJax typesetting.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi/agent");
const path = join(agentDir, "npm/node_modules/@fadouse/pi-math/src/markdown-patch.ts");
let source = readFileSync(path, "utf8");
const replacements = [
  [
    "    const maxBlockRows = Math.max(1, Math.floor(MAX_RASTER_HEIGHT_PX / cells.heightPx));",
    '    const orcaKitty = process.env.TERM_PROGRAM?.toLowerCase() === "orca" && protocol === "kitty";\n    const maxBlockRows = orcaKitty ? 1 : Math.max(1, Math.floor(MAX_RASTER_HEIGHT_PX / cells.heightPx));',
  ],
  ["          fitHeight: inline,", "          fitHeight: inline || orcaKitty,"],
];
const states = replacements.map(([before, after]) => {
  const oldCount = source.split(before).length - 1;
  const newCount = source.split(after).length - 1;
  if (oldCount === 1 && newCount === 0) return "original";
  if (oldCount === 0 && newCount === 1) return "patched";
  throw new Error(`Unexpected pi-math source at ${path}: refusing unsafe edit`);
});
if (states.every((state) => state === "patched")) {
  console.log("pi-math Orca one-row: already patched");
  process.exit(0);
}
if (!states.every((state) => state === "original")) {
  throw new Error(`Partially patched pi-math at ${path}: inspect before applying`);
}
for (const [before, after] of replacements) source = source.replace(before, after);
writeFileSync(path, source);
console.log("pi-math Orca one-row: patched");

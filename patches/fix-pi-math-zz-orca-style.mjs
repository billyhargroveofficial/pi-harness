#!/usr/bin/env node
/** White MathJax images and left-aligned display formulas in Orca only.
 * Runs after fix-pi-math-z-orca-one-row.mjs; fail closed on upstream drift.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi/agent");
const root = join(agentDir, "npm/node_modules/@fadouse/pi-math/src");
const patches = [
  {
    path: join(root, "markdown-patch.ts"),
    before: `    const color = formulaColor(markdown);`,
    after: `    const color = process.env.TERM_PROGRAM?.toLowerCase() === "orca" && protocol === "kitty"
      ? "#ffffff"
      : formulaColor(markdown);`,
  },
  {
    path: join(root, "image-layout.ts"),
    before: `  const left =
    area.paddingX + Math.max(0, Math.floor((contentWidth - placement.raster.columns) / 2));`,
    after: `  const left =
    area.paddingX +
    (process.env.TERM_PROGRAM?.toLowerCase() === "orca" && capabilities.images === "kitty"
      ? 0
      : Math.max(0, Math.floor((contentWidth - placement.raster.columns) / 2)));`,
  },
];
const inspected = patches.map(({ path, before, after }) => {
  const content = readFileSync(path, "utf8");
  const oldCount = content.split(before).length - 1;
  // The later theme overlay refines the white branch; accept that successor.
  const comparable = content.replace(
    '? (getAppearance() === "light" ? "#202124" : "#ffffff")',
    '? "#ffffff"',
  );
  const newCount = comparable.split(after).length - 1;
  if (oldCount === 1 && newCount === 0) return { path, content, before, after, state: "original" };
  if (oldCount === 0 && newCount === 1) return { path, content, before, after, state: "patched" };
  throw new Error(`Unexpected pi-math source at ${path}: refusing unsafe edit`);
});
if (inspected.every(({ state }) => state === "patched")) {
  console.log("pi-math Orca white/left: already patched");
  process.exit(0);
}
if (!inspected.every(({ state }) => state === "original")) {
  throw new Error("Partially patched pi-math Orca style: inspect before applying");
}
for (const { path, content, before, after } of inspected) {
  writeFileSync(path, content.replace(before, after));
}
console.log("pi-math Orca white/left: patched");

#!/usr/bin/env node
/** Keep pi-math's transitive xmldom patched across `pi update` / fresh installs.
 * mathjax-full 3 -> speech-rule-engine 4.1.4 pins vulnerable xmldom 0.9.10.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi/agent");
const npmDir = join(agentDir, "npm");
const pkgPath = join(npmDir, "package.json");
const mathPath = join(npmDir, "node_modules/@fadouse/pi-math/package.json");
const xmlPath = join(npmDir, "node_modules/@xmldom/xmldom/package.json");
let pkg;
try {
  readFileSync(mathPath);
  pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
} catch (error) {
  console.error(`pi-math/npm not installed: ${error.message}`);
  process.exit(1);
}
const expected = "0.9.12";
let current;
try { current = JSON.parse(readFileSync(xmlPath, "utf8")).version; } catch { /* install below */ }
const pinned = pkg.overrides?.["speech-rule-engine"]?.["@xmldom/xmldom"] === expected;
if (pinned && current === expected) {
  console.log(`pi-math xmldom ${expected}: already patched`);
  process.exit(0);
}
pkg.overrides ??= {};
pkg.overrides["speech-rule-engine"] = {
  ...pkg.overrides["speech-rule-engine"],
  "@xmldom/xmldom": expected,
};
writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
const installed = spawnSync("npm", ["install", "--prefix", npmDir, "--ignore-scripts", "--no-audit", "--no-fund"], { stdio: "inherit" });
if (installed.error || installed.status !== 0) {
  console.error(installed.error ?? `npm install failed (${installed.status})`);
  process.exit(1);
}
const actual = JSON.parse(readFileSync(xmlPath, "utf8")).version;
if (actual !== expected) throw new Error(`expected xmldom ${expected}, got ${actual}`);
console.log(`pi-math xmldom pinned: ${actual}`);

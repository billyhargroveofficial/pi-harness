#!/usr/bin/env node
// Integration: Orca capability bridge + real pi-math MathJax/Kitty render.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const piCli = realpathSync(execFileSync("which", ["pi"], { encoding: "utf8" }).trim());
const piRequire = createRequire(piCli);
const tuiPath = piRequire.resolve("@earendil-works/pi-tui");
const tui = await import(pathToFileURL(tuiPath).href);
const { createJiti } = piRequire("jiti");
const jiti = createJiti(import.meta.url, { alias: { "@earendil-works/pi-tui": tuiPath } });
const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi/agent");
const mathRoot = join(agentDir, "npm/node_modules/@fadouse/pi-math/src");
const original = Object.fromEntries(["TERM_PROGRAM", "ORCA_IMAGE_PROTOCOL", "PI_IMAGE_PROTOCOL", "TMUX", "TERM"].map((key) => [key, process.env[key]]));
// Import under an explicit opt-out: the bridge must execute at module load,
// before Pi constructs its TUI, not merely in its registration callback.
process.env.PI_IMAGE_PROTOCOL = "none";
const { enableOrcaKittyImages } = await jiti.import(join(agentDir, "extensions/orca-kitty-images.ts"));
assert.equal(process.env.PI_IMAGE_PROTOCOL, "none");
const reset = () => { tui.setCapabilityOverrides({}); tui.resetCapabilitiesCache(); };
function env(patch) {
  for (const [key, value] of Object.entries({ ...original, ...patch })) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  reset();
}
try {
  env({ TERM_PROGRAM: "Orca", ORCA_IMAGE_PROTOCOL: "kitty", PI_IMAGE_PROTOCOL: undefined, TMUX: undefined, TERM: "xterm-256color" });
  assert.equal(tui.getCapabilities().images, null, "Pi does not detect Orca without the bridge");
  enableOrcaKittyImages();
  assert.equal(process.env.PI_IMAGE_PROTOCOL, "kitty", "advertise Kitty before TUI startup");
  reset(); // Pi caches capabilities; in production the bridge runs before first probe.
  assert.equal(tui.getCapabilities().images, "kitty");

  const { createTerminalMathRenderer } = await jiti.import(join(mathRoot, "renderer.ts"));
  const { installMarkdownMathPatch } = await jiti.import(join(mathRoot, "markdown-patch.ts"));
  const renderer = await createTerminalMathRenderer();
  const renderCalls = [];
  let appearance = "dark";
  const math = installMarkdownMathPatch({
    render(...args) {
      renderCalls.push(args);
      return renderer.render(...args);
    },
  }, () => appearance);
  try {
    const identity = (s) => s;
    const theme = Object.fromEntries(["bold", "italic", "strikethrough", "underline", "heading", "codeBlock", "codeBlockBorder", "code", "quote", "quoteBorder", "hr", "listBullet", "link", "linkUrl"].map((k) => [k, identity]));
    for (const source of ["$$\\frac{a}{b}=c$$", "Euler's identity is $e^{i\\pi}+1=0$."]) {
      const markdown = new tui.Markdown(source, 0, 0, theme);
      const lines = markdown.render(80);
      assert.ok(lines.some((line) => line.includes("\x1b_G")), `missing Kitty image for ${source}`);
      assert.ok(lines.some((line) => line.includes("r=1,")), `Orca image must fit one row: ${source}`);
      assert.equal(renderCalls.at(-1)[2], "#ffffff", "Orca formulas must be white");
      if (source.startsWith("$$")) {
        const imageLine = lines.find((line) => line.includes("\x1b_G"));
        assert.equal(imageLine.match(/^ */)[0].length, 0, "display formula must align left");
      }
      assert.equal(markdown.text, source, "LaTeX must survive unchanged in model context");
      assert.deepEqual(markdown.render(80), lines, "cached render must be stable");
    }
    const padded = new tui.Markdown("$$x^2$$", 2, 0, {
      ...theme, codeBlock: (text) => `\x1b[38;2;255;0;0m${text}\x1b[0m`,
    });
    const paddedLine = padded.render(80).find((line) => line.includes("\x1b_G"));
    assert.equal(paddedLine.match(/^ */)[0].length, 2, "preserve content padding without centering");
    assert.equal(renderCalls.at(-1)[2], "#ffffff", "white overrides theme code color");
    appearance = "light";
    const lightLines = padded.render(80);
    assert.equal(renderCalls.at(-1)[2], "#202124", "light theme needs dark ink");
    assert.notEqual(lightLines.find((line) => line.includes("\x1b_G")), paddedLine, "theme switch replaces cached image");
    assert.equal(lightLines.find((line) => line.includes("\x1b_G")).match(/^ */)[0].length, 2);
    appearance = "dark";
    padded.render(80);
    assert.equal(renderCalls.at(-1)[2], "#ffffff", "switching back restores white");
    const code = new tui.Markdown("```tex\n$$\\frac{a}{b}$$\n```", 0, 0, theme);
    assert.ok(!code.render(80).some((line) => line.includes("\x1b_G")), "code fences must remain literal");

    env({ TERM_PROGRAM: "Orca", ORCA_IMAGE_PROTOCOL: "kitty", PI_IMAGE_PROTOCOL: "none", TMUX: undefined, TERM: "xterm-256color" });
    enableOrcaKittyImages();
    assert.equal(tui.getCapabilities().images, null, "honor explicit opt-out");
    env({ TERM_PROGRAM: "Orca", ORCA_IMAGE_PROTOCOL: "kitty", PI_IMAGE_PROTOCOL: undefined, TMUX: "/tmp/tmux", TERM: "tmux-256color" });
    enableOrcaKittyImages();
    assert.equal(tui.getCapabilities().images, null, "don't advertise images through tmux");
    env({ TERM_PROGRAM: "Other", ORCA_IMAGE_PROTOCOL: undefined, PI_IMAGE_PROTOCOL: undefined, TMUX: undefined, TERM: "xterm-256color" });
    enableOrcaKittyImages();
    assert.equal(tui.getCapabilities().images, null, "don't spoof arbitrary terminals");
  } finally { math.uninstall(); }
} finally { env(original); }

const settings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"));
assert.ok(settings.packages.includes("npm:@fadouse/pi-math@0.2.0"));
assert.ok(settings.packages.some((p) => p.source === "npm:pi-claude-code-ui" && p.extensions?.length === 0));
assert.ok(settings.packages.includes("npm:better-claude-code-ui@0.1.8"));
console.log("OK: Orca Kitty images, display + inline MathJax, literal code, fallback, current UI config");

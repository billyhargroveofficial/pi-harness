#!/usr/bin/env node
/**
 * Патч better-claude-code-ui под светлые темы: диффы и «thinking»-глоу.
 *
 * Три бага апстрима, все бьют только по светлой панели (на тёмной панели
 * значения выглядят нормально, поэтому их никто не замечал):
 *
 * Блок 1 — DIFF_CHROME_LIGHT (extension/palette.ts).
 * Схема светлых диффов — единственная фиксированная палитра в расширении,
 * к теме она не привязана. Текст строк берётся из неё (`FG_ADD`/`FG_DEL`,
 * diff.ts:66-67), поэтому на светлой заливке он выцветает:
 *
 *   `#2F9D44` (added)   на заливке `#BED8C3` ≈ 2.4:1
 *   `#D1454B` (removed) на заливке `#EAC2C6` ≈ 2.9:1
 *   `#999999` (номера строк) на заливке `#EDC9CD` ≈ 1.9:1
 *
 * Патч: тёмные значения, читаемые на светлых заливках (все ≥ 4.5:1).
 *
 * Блок 2 — thinking-глоу (extension/spinner.ts).
 * Рампа захардкожена серыми 153 → 185 (`THINKING_INACTIVE_GRAY` /
 * `THINKING_SHIMMER_GRAY`). На тёмном фоне это «подсветка», на светлом —
 * 2.5:1 → 1.8:1, то есть `thinking with max effort` не читается вообще.
 * Патч: конечные точки рампы считаются от `dim` активной темы и схемы
 * (светлая — затемняем к тексту, тёмная — светлим), хардкод остаётся
 * фолбэком для терминалов без truecolor.
 *
 * Блок 3 — подписи колонок `old`/`new` (extension/tools/diff.ts:986-988).
 * Подписи рисуются цветом diff-fg с атрибутом DIM. DIM — это половинная
 * яркость: на белом `#D1454B` превращается в `#E0A5A6` (1.7:1). Патч: на
 * светлой схеме подписи идут без DIM.
 *
 * Идемпотентен, как fix-cc-tools-light-chrome.mjs: блоки с маркером
 * повторно не применяются.
 * Запуск: node ~/.pi/agent/patches/fix-better-cc-ui-light-legibility.mjs
 * После `pi update` — запустить снова (install.sh делает это сам).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const pkgDir = join(homedir(), ".pi/agent/npm/node_modules/better-claude-code-ui/extension");

const FILES = [
	{
		path: join(pkgDir, "index.ts"),
		blocks: [
			{
				name: "status line owned by pi-statusline",
				marker: "registerStatusLine(pi) is disabled",
				original: `	registerBanner(pi);
	registerStatusLine(pi);`,
				patched: `	registerBanner(pi);
	// registerStatusLine(pi) is disabled: two extensions calling ctx.ui.setFooter()
	// race for the single footer slot, and pi-statusline (which runs Claude Code's
	// own statusline command) must own it. Re-enable only if pi-statusline is gone.
	// registerStatusLine(pi);`,
			},
		],
	},
	{
		path: join(pkgDir, "palette.ts"),
		blocks: [
			{
				name: "light diff chrome",
				marker: "light diff chrome, readable on light line washes",
				original: `const DIFF_CHROME_LIGHT: DiffChrome = {
	diffDim: rgb(175, 175, 175),
	diffLineNumber: rgb(153, 153, 153),
	diffRule: rgb(208, 208, 208),
	diffStripe: rgb(224, 224, 224),
	diffSafeMuted: rgb(139, 148, 158),
	diffAddedFg: rgb(47, 157, 68),
	diffRemovedFg: rgb(209, 69, 75),
	branch: rgb(204, 204, 204),
};`,
				patched: `const DIFF_CHROME_LIGHT: DiffChrome = {
	// light diff chrome, readable on light line washes: the diff text and the
	// line-number gutter sit on the added/removed washes (#BED8C2 / #EDC9CD),
	// where the original palette measured 1.9–2.9:1.
	diffDim: rgb(106, 106, 106),
	diffLineNumber: rgb(79, 79, 79),
	diffRule: rgb(190, 190, 190),
	diffStripe: rgb(214, 214, 214),
	diffSafeMuted: rgb(106, 115, 125),
	diffAddedFg: rgb(22, 92, 40),
	diffRemovedFg: rgb(150, 28, 38),
	branch: rgb(138, 138, 138),
};`,
			},
		],
	},
	{
		path: join(pkgDir, "spinner.ts"),
		blocks: [
			{
				name: "spinner types for the glow ramp",
				marker: 'import type { ColorValue, Rgb } from "./palette.js";',
				original: `import { fg as paletteFg, resolvePalette } from "./palette.js";`,
				patched: `import { fg as paletteFg, parseAnsiRgb, resolvePalette } from "./palette.js";
import type { ColorValue, Rgb } from "./palette.js";`,
			},
			{
				name: "thinking glow ramp from theme",
				marker: "THINKING_GLOW_FALLBACK",
				original: `const THINKING_INACTIVE_GRAY = 153;
const THINKING_SHIMMER_GRAY = 185;`,
				patched: `const THINKING_INACTIVE_GRAY = 153;
const THINKING_SHIMMER_GRAY = 185;

/** Fallback glow ramp (grays), used when the theme color can't be resolved. */
const THINKING_GLOW_FALLBACK: Record<"light" | "dark", { from: Rgb; to: Rgb }> = {
	light: { from: { r: 106, g: 106, b: 106 }, to: { r: 40, g: 40, b: 40 } },
	dark: {
		from: { r: THINKING_INACTIVE_GRAY, g: THINKING_INACTIVE_GRAY, b: THINKING_INACTIVE_GRAY },
		to: { r: THINKING_SHIMMER_GRAY, g: THINKING_SHIMMER_GRAY, b: THINKING_SHIMMER_GRAY },
	},
};

/** Linear mix of two colors; t=0 → a, t=1 → b. */
function mixGlowRgb(a: Rgb, b: Rgb, t: number): Rgb {
	return {
		r: Math.round(a.r + (b.r - a.r) * t),
		g: Math.round(a.g + (b.g - a.g) * t),
		b: Math.round(a.b + (b.b - a.b) * t),
	};
}

/** Resolve a palette color value (hex or ANSI sequence) to RGB. */
function glowRgbOf(value: ColorValue | undefined): Rgb | undefined {
	if (typeof value !== "string") return undefined;
	if (value.startsWith("#") && value.length === 7) {
		return {
			r: parseInt(value.slice(1, 3), 16),
			g: parseInt(value.slice(3, 5), 16),
			b: parseInt(value.slice(5, 7), 16),
		};
	}
	return parseAnsiRgb(value);
}

/** Glow endpoints for one scheme: CC animates dimColor → text, so the ramp
 *  starts at the scheme's quietest readable gray (light: the dim token, dark: the
 *  muted token — dim on a dark panel measures ≈2:1) and moves away from the
 *  canvas: light panels darken, dark panels brighten. Replaces the hardcoded
 *  153→185 gray ramp that only read on dark panels. */
function thinkingGlowEndpoints(pal: {
	scheme: "light" | "dark";
	cc: { subtle: ColorValue; inactive: ColorValue };
}): { from: Rgb; to: Rgb } {
	const fallback = THINKING_GLOW_FALLBACK[pal.scheme];
	const from = glowRgbOf(pal.scheme === "light" ? pal.cc.subtle : pal.cc.inactive) ?? fallback.from;
	const target = pal.scheme === "light" ? { r: 20, g: 20, b: 20 } : { r: 240, g: 240, b: 240 };
	return { from, to: mixGlowRgb(from, target, 0.55) };
}`,
			},
			{
				name: "thinking glow paint signature",
				marker: "endpoints: { from: Rgb; to: Rgb } = THINKING_GLOW_FALLBACK.dark,",
				original: `function thinkingGlowPaint(timeMs: number): (s: string) => string {
	const opacity =
		timeMs < THINKING_DELAY_MS
			? 0
			: (Math.sin((((timeMs - THINKING_DELAY_MS) / 1000) * (Math.PI * 2)) / THINKING_GLOW_PERIOD_S) + 1) / 2;
	const v = Math.round(THINKING_INACTIVE_GRAY + (THINKING_SHIMMER_GRAY - THINKING_INACTIVE_GRAY) * opacity);
	return (s) => \`\\x1b[38;2;\${v};\${v};\${v}m\${s}\\x1b[39m\`;
}`,
				patched: `function thinkingGlowPaint(
	timeMs: number,
	endpoints: { from: Rgb; to: Rgb } = THINKING_GLOW_FALLBACK.dark,
): (s: string) => string {
	const opacity =
		timeMs < THINKING_DELAY_MS
			? 0
			: (Math.sin((((timeMs - THINKING_DELAY_MS) / 1000) * (Math.PI * 2)) / THINKING_GLOW_PERIOD_S) + 1) / 2;
	const { r, g, b } = mixGlowRgb(endpoints.from, endpoints.to, opacity);
	return (s) => \`\\x1b[38;2;\${r};\${g};\${b}m\${s}\\x1b[39m\`;
}`,
			},
			{
				name: "spinner paint carries glow endpoints",
				marker: "/** Thinking-status glow endpoints",
				original: `	/** CC's dimColor. */
	dim: (s: string) => string;
}`,
				patched: `	/** CC's dimColor. */
	dim: (s: string) => string;
	/** Thinking-status glow endpoints (dim → away from the canvas). */
	glow: { from: Rgb; to: Rgb };
}`,
			},
			{
				name: "spinner paint resolves glow",
				marker: "glow: thinkingGlowEndpoints(pal),",
				original: `		return {
			accent: (s) => paletteFg(pal.cc.claude, s),
			shimmer: (s) => paletteFg(pal.cc.claudeShimmer, s),
			dim: (s) => theme.fg("dim", s),
		};`,
				patched: `		return {
			accent: (s) => paletteFg(pal.cc.claude, s),
			shimmer: (s) => paletteFg(pal.cc.claudeShimmer, s),
			dim: (s) => theme.fg("dim", s),
			glow: thinkingGlowEndpoints(pal),
		};`,
			},
			{
				name: "spinner glow uses the resolved ramp",
				marker: "thinkingGlowPaint(state.timeMs, paint.glow)",
				original: `	const thinkingPaint = status === "thinking" ? thinkingGlowPaint(state.timeMs) : paint.dim;`,
				patched: `	const thinkingPaint = status === "thinking" ? thinkingGlowPaint(state.timeMs, paint.glow) : paint.dim;`,
			},
		],
	},
	{
		path: join(pkgDir, "tools/diff.ts"),
		blocks: [
			{
				name: "context-line dim helper",
				marker: "function ctxDimOf(",
				original: `const D_DIM = "\\x1b[2m";`,
				patched: `const D_DIM = "\\x1b[2m";

/**
 * Context-line dimming. DIM halves the luminance, which reads as "inactive" on a
 * dark panel but washes out on a light one (default fg + DIM on white ≈ 1.4:1),
 * so the dimming stays dark-scheme-only.
 */
function ctxDimOf(p: ResolvedPalette): string {
	return p.scheme === "light" ? "" : D_DIM;
}`,
			},
			{
				name: "unified context lines readable on light",
				marker: 'emitRow(line.newNum, " ", s.BG_BASE, s.FG_DIM, `${s.BG_BASE}${ctxDimOf(p)}',
				original: 'emitRow(line.newNum, " ", s.BG_BASE, s.FG_DIM, `${s.BG_BASE}${D_DIM}${highlighted}`, s.BG_BASE);',
				patched: 'emitRow(line.newNum, " ", s.BG_BASE, s.FG_DIM, `${s.BG_BASE}${ctxDimOf(p)}${highlighted}`, s.BG_BASE);',
			},
			{
				name: "split context lines readable on light",
				marker: ': isDel || isAdd ? `${bodyBg}${highlighted}` : `${s.BG_BASE}${ctxDimOf(p)}${highlighted}`;',
				original: ': isDel || isAdd ? `${bodyBg}${highlighted}` : `${s.BG_BASE}${D_DIM}${highlighted}`;',
				patched: ': isDel || isAdd ? `${bodyBg}${highlighted}` : `${s.BG_BASE}${ctxDimOf(p)}${highlighted}`;',
			},
			{
				name: "split headers keep full strength on light",
				marker: "ctxDimOf(p)}old",
				original: `	const headerOld = \`\${s.BG_BASE}\${" ".repeat(Math.max(0, numberWidth - 2))}\${s.FG_DEL}\${D_DIM}old\${D_RST}\`;
	const headerNew = \`\${s.BG_BASE}\${" ".repeat(Math.max(0, numberWidth - 2))}\${s.FG_ADD}\${D_DIM}new\${D_RST}\`;`,
				patched: `	// Old/new labels sit on a bare panel: DIM would wash them out (see ctxDimOf).
	const headerOld = \`\${s.BG_BASE}\${" ".repeat(Math.max(0, numberWidth - 2))}\${s.FG_DEL}\${ctxDimOf(p)}old\${D_RST}\`;
	const headerNew = \`\${s.BG_BASE}\${" ".repeat(Math.max(0, numberWidth - 2))}\${s.FG_ADD}\${ctxDimOf(p)}new\${D_RST}\`;`,
			},
		],
	},
];

let failures = 0;
let changes = 0;

for (const file of FILES) {
	let source;
	try {
		source = readFileSync(file.path, "utf8");
	} catch (error) {
		console.error(`не прочитать ${file.path}: ${error.message}`);
		failures += 1;
		continue;
	}
	let changed = false;
	for (const block of file.blocks) {
		if (source.includes(block.marker)) {
			console.log(`уже пропатчено: ${block.name}`);
			continue;
		}
		if (!source.includes(block.original)) {
			console.error(
				`НЕ найден исходный блок «${block.name}» — апстрим изменился, патч нужно переписать вручную:\n  ${file.path}`,
			);
			failures += 1;
			continue;
		}
		source = source.replace(block.original, block.patched);
		console.log(`пропатчено: ${block.name}`);
		changes += 1;
		changed = true;
	}
	if (changed) {
		writeFileSync(file.path, source);
		console.log("файл записан:", file.path);
	}
}

if (failures > 0) {
	process.exitCode = 1;
} else if (changes === 0) {
	console.log("все блоки уже на месте — ничего не делал");
}

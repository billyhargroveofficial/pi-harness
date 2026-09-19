#!/usr/bin/env node
/**
 * Патч pi-claude-code-ui под светлые темы.
 *
 * Блок 1 — chrome на светлых панелях.
 * Баг апстрима (1.0.83): outline/branch chrome берёт theme `dim` и затем ВСЕГДА
 * осветляет его на +64 (`OUTLINE_CHROME_BRIGHTEN`). На тёмных темах это
 * работает, на светлых убивает контраст: `Thought for Xs`, `Turn took …`,
 * рамки сообщений и правила тулов становились почти белыми (#D0D7CD на белом
 * ≈ 1.5:1). Патч: на светлой панели тянуть branch-цвет к theme `text` вместо
 * осветления; в fixed-gray fallback вычитать, а не прибавлять.
 *
 * Блок 2 — stripBackgroundAnsi ломает truecolor-последовательности.
 * Функция разбирает SGR по параметрам и выбрасывает всё, что похоже на фон
 * (48/49, 40–47, 100–107) — но не учитывает, что у расширенных цветов
 * (`38;2;r;g;b`) свои аргументы. Компонента 106 из `#5C6A72` попадала под
 * «фон» и вылетала: `\x1b[38;2;92;106;114m` → `\x1b[38;2;92;114m` (битая
 * последовательность) — текст сообщения пользователя рисовался бледно-зелёным.
 * Патч: 38/48/58 съедают свои аргументы, фоном считаются только самостоятельные
 * коды 49/40–47/100–107.
 *
 * Идемпотентен: блоки, уже помеченные маркером, не применяются повторно.
 * Запуск: node ~/.pi/agent/patches/fix-cc-tools-light-chrome.mjs
 * После обновления пакета pi-claude-code-ui — запустить снова.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const target = join(
	homedir(),
	".pi/agent/npm/node_modules/pi-claude-code-ui/extensions/index.ts",
);

const BLOCKS = [
	{
		name: "light-panel chrome",
		marker: "outlineChromeAnsiForLightPanel",
		original: `/** Outline chrome always brighter than branch; never falls back to identical branch ANSI. */
function outlineChromeAnsiFromBranch(theme?: any): string {
	const t = theme ?? _toolBranchThemeHint;
	const branch = currentToolBranchAnsi(t);
	const fromBranch = ansiRgbBrightenedBy(branch, OUTLINE_CHROME_BRIGHTEN);
	if (fromBranch) return fromBranch;
	let gray = DEFAULT_TOOL_BRANCH_GRAY;
	if (toolBranchColorModeFixed()) {
		gray = getConfiguredToolBranchGray();
	} else if (t) {
		const hint = safeFgAnsi(t, "dim") ?? safeFgAnsi(t, "muted") ?? safeFgAnsi(t, "borderMuted");
		const rgb = hint ? parseAnsiRgb(hint) : null;
		if (rgb) gray = Math.round((rgb.r + rgb.g + rgb.b) / 3);
	}
	return toolBranchRgbAnsi(Math.min(255, gray + OUTLINE_CHROME_BRIGHTEN));
}`,
		patched: `/**
 * Chrome for light panels: brightening washes out on white/cream, so pull the
 * branch color toward the theme text color instead (keeps \`Thought for …\`,
 * \`Turn took …\`, box borders, and code fences legible without matching body text).
 */
function outlineChromeAnsiForLightPanel(branch: string, theme: any): string | null {
	const branchRgb = parseAnsiRgb(branch);
	if (!branchRgb) return null;
	const textHint = safeFgAnsi(theme, "text") ?? safeFgAnsi(theme, "fg");
	const textRgb = textHint ? parseAnsiRgb(textHint) : null;
	const targetRgb = textRgb ?? { r: 70, g: 80, b: 75 };
	const ratio = 0.45;
	const mix = (c: number, tgt: number) => Math.max(0, Math.min(255, Math.round(c + (tgt - c) * ratio)));
	return \`\\x1b[38;2;\${mix(branchRgb.r, targetRgb.r)};\${mix(branchRgb.g, targetRgb.g)};\${mix(branchRgb.b, targetRgb.b)}m\`;
}

/** Outline chrome always reads above branch; dark panels brighten, light panels darken. */
function outlineChromeAnsiFromBranch(theme?: any): string {
	const t = theme ?? _toolBranchThemeHint;
	const branch = currentToolBranchAnsi(t);
	if (t && isLightThemeBackground(t)) {
		const forLightPanel = outlineChromeAnsiForLightPanel(branch, t);
		if (forLightPanel) return forLightPanel;
	}
	const fromBranch = ansiRgbBrightenedBy(branch, OUTLINE_CHROME_BRIGHTEN);
	if (fromBranch) return fromBranch;
	let gray = DEFAULT_TOOL_BRANCH_GRAY;
	if (toolBranchColorModeFixed()) {
		gray = getConfiguredToolBranchGray();
	} else if (t) {
		const hint = safeFgAnsi(t, "dim") ?? safeFgAnsi(t, "muted") ?? safeFgAnsi(t, "borderMuted");
		const rgb = hint ? parseAnsiRgb(hint) : null;
		if (rgb) gray = Math.round((rgb.r + rgb.g + rgb.b) / 3);
	}
	const adjusted = t && isLightThemeBackground(t) ? gray - OUTLINE_CHROME_BRIGHTEN : gray + OUTLINE_CHROME_BRIGHTEN;
	return toolBranchRgbAnsi(Math.max(0, Math.min(255, adjusted)));
}`,
	},
	{
		name: "stripBackgroundAnsi truecolor",
		marker: "Extended colors (38 fg, 48 bg, 58 underline) own their following",
		original: `function stripBackgroundAnsi(text: string): string {
	return text.replace(/\\x1b\\[([0-9;]*)m/g, (match, paramsText: string) => {
		const params = paramsText === "" ? ["0"] : paramsText.split(";");
		const kept: string[] = [];
		for (let i = 0; i < params.length; i++) {
			const code = Number(params[i] || "0");
			if (code === 48) {
				const mode = Number(params[i + 1] || "0");
				i += mode === 2 ? 4 : mode === 5 ? 2 : 0;
				continue;
			}
			if (code === 49 || (code >= 40 && code <= 47) || (code >= 100 && code <= 107)) continue;
			kept.push(params[i]);
		}
		return kept.length === 0 ? "" : \`\\x1b[\${kept.join(";")}m\`;
	});
}`,
		patched: `function stripBackgroundAnsi(text: string): string {
	return text.replace(/\\x1b\\[([0-9;]*)m/g, (match, paramsText: string) => {
		const params = paramsText === "" ? ["0"] : paramsText.split(";");
		const kept: string[] = [];
		for (let i = 0; i < params.length; i++) {
			const code = Number(params[i] || "0");
			// Extended colors (38 fg, 48 bg, 58 underline) own their following
			// params: reading "106" of \`38;2;92;106;114\` as a background code used
			// to mangle the sequence and paint text in the wrong color.
			if (code === 38 || code === 48 || code === 58) {
				const mode = Number(params[i + 1] || "0");
				// mode 2 = r;g;b, mode 5 = palette index, legacy = single index.
				const args = mode === 2 ? 4 : mode === 5 ? 2 : 1;
				if (code === 48) {
					i += args;
					continue;
				}
				for (let k = 0; k <= args && i + k < params.length; k++) kept.push(params[i + k]);
				i += args;
				continue;
			}
			if (code === 49 || (code >= 40 && code <= 47) || (code >= 100 && code <= 107)) continue;
			kept.push(params[i]);
		}
		return kept.length === 0 ? "" : \`\\x1b[\${kept.join(";")}m\`;
	});
}`,
	},
];

let source = readFileSync(target, "utf8");
let changed = 0;

for (const block of BLOCKS) {
	if (source.includes(block.marker)) {
		console.log(`уже пропатчено: ${block.name}`);
		continue;
	}
	if (!source.includes(block.original)) {
		console.error(
			`НЕ найден исходный блок «${block.name}» — апстрим изменился, патч нужно переписать вручную:\n  ${target}`,
		);
		process.exitCode = 1;
		continue;
	}
	source = source.replace(block.original, block.patched);
	console.log(`пропатчено: ${block.name}`);
	changed += 1;
}

if (changed > 0) {
	writeFileSync(target, source);
	console.log("файл записан:", target);
}

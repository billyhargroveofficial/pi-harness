#!/usr/bin/env node
/**
 * Патч pi-statusline: строка не обновляется при смене уровня thinking.
 *
 * Наш статус-лайн печатает живой уровень мышления (из сессии pi), но расширение
 * перерисовывает футер только на session_start / turn_end / model_select /
 * session_compact / tree / switch / fork. pi отдельно шлёт
 * `thinking_level_select` («Fired when the thinking level changes… built-in
 * thinking-level controls change the active thinking level») — его никто не
 * слушает, поэтому после shift+tab уровень в строке остаётся старым до конца
 * следующего хода.
 *
 * Патч: подписка на событие и тот же дебаунс-рефреш, что у model_select.
 * Идемпотентен.
 * Запуск: node ~/.pi/agent/patches/fix-pi-statusline-refresh.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const target = join(homedir(), ".pi/agent/npm/node_modules/pi-statusline/src/index.ts");

const MARKER = 'pi.on("thinking_level_select"';
const ORIGINAL = `  pi.on("model_select", async (_event, ctx) => {
    scheduleRefresh(ctx);
  });
`;
const PATCHED = `  pi.on("model_select", async (_event, ctx) => {
    scheduleRefresh(ctx);
  });

  // pi fires this on shift+tab / pi.setThinkingLevel(); the command line prints
  // the live level, so it has to be re-run when the level changes.
  pi.on("thinking_level_select", async (_event, ctx) => {
    scheduleRefresh(ctx);
  });
`;

let source;
try {
	source = readFileSync(target, "utf8");
} catch (error) {
	console.error(`не прочитать ${target}: ${error.message}`);
	process.exit(1);
}

if (source.includes(MARKER)) {
	console.log("уже пропатчено: refresh on thinking_level_select");
} else if (!source.includes(ORIGINAL)) {
	console.error(
		`НЕ найден исходный блок (ожидался обработчик model_select) — апстрим изменился, патч нужно переписать вручную:\n  ${target}`,
	);
	process.exit(1);
} else {
	writeFileSync(target, source.replace(ORIGINAL, PATCHED));
	console.log("пропатчено: refresh on thinking_level_select");
	console.log("файл записан:", target);
}

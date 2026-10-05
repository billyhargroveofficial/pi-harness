#!/usr/bin/env node
/**
 * Патч pi-statusline: немедленный рефреш при смене уровня мышления
 * (thinking_level_select) и имени текущей сессии (session_info_changed).
 * Оба события используют штатный debounced scheduleRefresh(); остальные
 * механизмы рендера и payload расширения не меняются. Идемпотентен.
 * Запуск: node ~/.pi/agent/patches/fix-pi-statusline-refresh.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const target = join(homedir(), ".pi/agent/npm/node_modules/pi-statusline/src/index.ts");

const operations = [
	{
		marker: 'pi.on("thinking_level_select"',
		anchor: `  pi.on("model_select", async (_event, ctx) => {
    scheduleRefresh(ctx);
  });
`,
		replacement: `  pi.on("model_select", async (_event, ctx) => {
    scheduleRefresh(ctx);
  });

  // pi fires this on shift+tab / pi.setThinkingLevel().
  pi.on("thinking_level_select", async (_event, ctx) => {
    scheduleRefresh(ctx);
  });
`,
		label: "thinking_level_select",
	},
	{
		marker: 'pi.on("session_info_changed"',
		anchor: `  pi.on("session_start", async (_event, ctx) => {
    scheduleRefresh(ctx);
  });
`,
		replacement: `  pi.on("session_start", async (_event, ctx) => {
    scheduleRefresh(ctx);
  });

  // /name updates session_info without starting a model turn.
  pi.on("session_info_changed", async (_event, ctx) => {
    scheduleRefresh(ctx);
  });
`,
		label: "session_info_changed",
	},
];

let source;
try {
	source = readFileSync(target, "utf8");
} catch (error) {
	console.error(`не прочитать ${target}: ${error.message}`);
	process.exit(1);
}

const changed = [];
for (const operation of operations) {
	if (source.includes(operation.marker)) continue;
	if (!source.includes(operation.anchor)) {
		console.error(`НЕ найден блок для ${operation.label} — апстрим изменился, патч требует проверки:\n  ${target}`);
		process.exit(1); // Проверяем все блоки до записи: не оставляем полупатч.
	}
	source = source.replace(operation.anchor, operation.replacement);
	changed.push(operation.label);
}
if (changed.length) {
	writeFileSync(target, source);
	console.log(`пропатчено: refresh on ${changed.join(", ")}`);
} else {
	console.log("уже пропатчено: thinking_level_select, session_info_changed");
}

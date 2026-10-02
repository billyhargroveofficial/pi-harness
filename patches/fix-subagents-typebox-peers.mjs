#!/usr/bin/env node
/**
 * Патч @tintinweb/pi-subagents: хост-пакеты typebox объявлены в dependencies.
 *
 * pi выдаёт расширениям свои копии `typebox` и `@sinclair/typebox` через
 * jiti-алиасы (dist/core/extensions/loader.js, getAliases()). Манифест
 * расширения 0.19.0 держит оба пакета в dependencies, поэтому pi на старте
 * пишет предупреждение: физическая копия в node_modules может перебить
 * маппинг хоста и создать дублирующие модули, классы и лишнюю инициализацию.
 *
 * Патч: переносим оба пакета в peerDependencies с диапазоном "*" — как это
 * сделано в pi-mcp-adapter. Peer-зависимости managed-пакетов pi не
 * устанавливает, так что дублей в дереве не остаётся.
 *
 * Идемпотентен.
 * Запуск: node ~/.pi/agent/patches/fix-subagents-typebox-peers.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const target = join(
	homedir(),
	".pi/agent/npm/node_modules/@tintinweb/pi-subagents/package.json",
);

// Пакеты, которые pi отдаёт расширениям сам (см. docs/packages.md).
const HOST_PACKAGES = ["@sinclair/typebox", "typebox"];

let manifest;
try {
	manifest = JSON.parse(readFileSync(target, "utf8"));
} catch (error) {
	console.error(`не прочитать ${target}: ${error.message}`);
	process.exit(1);
}

const dependencies =
	manifest.dependencies && typeof manifest.dependencies === "object"
		? manifest.dependencies
		: {};
const offenders = HOST_PACKAGES.filter((name) => name in dependencies);

if (offenders.length === 0) {
	console.log("уже пропатчено: typebox-пакеты не в dependencies");
	process.exit(0);
}

manifest.peerDependencies = manifest.peerDependencies ?? {};
for (const name of offenders) {
	delete dependencies[name];
	manifest.peerDependencies[name] = "*";
}

writeFileSync(target, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(
	`пропатчено: ${offenders.join(", ")} -> peerDependencies "*" (dependencies очищены)`,
);
console.log("файл записан:", target);

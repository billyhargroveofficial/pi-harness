#!/usr/bin/env node
/**
 * Hide pi-subagents' persisted child sessions from /sessions, without changing
 * the files or Pi's /resume. Ordinary user forks/branches remain visible.
 * Run after pi update; --target=<actions.ts> is for offline regression tests.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const defaultTarget = join(homedir(), ".pi/agent/npm/node_modules/@vanillagreen/pi-session-manager/extensions/actions.ts");
const targetArg = process.argv.slice(2).find((arg) => arg.startsWith("--target="));
const target = targetArg ? resolve(targetArg.slice("--target=".length)) : defaultTarget;
const marker = "// pi-harness: hide persisted subagent sessions only in /sessions";
const imports = 'import { appendFileSync, existsSync } from "node:fs";';
const patchedImports = 'import { appendFileSync, closeSync, existsSync, openSync, readSync } from "node:fs";';
const original = `export async function loadSessionsForScope(cwd: string, scope: Scope, onProgress?: (loaded: number, total: number) => void): Promise<SessionInfo[]> {
	const customSessionDir = configuredSessionDir(cwd);
	if (customSessionDir) {
		const sessions = await SessionManager.list(cwd, customSessionDir, onProgress);
		if (scope === "all") return sessions;
		const current = canonicalPath(cwd);
		return sessions.filter((session) => canonicalPath(session.cwd) === current);
	}
	return scope === "all" ? SessionManager.listAll(onProgress) : SessionManager.list(cwd, undefined, onProgress);
}`;
const replacement = `${marker}
// pi-subagents writes a parentSession header and an initial session_info name
// ending in #<agent-id's first 8 hex digits>, before any user message. The first
// name stays in the file even if the agent is later renamed. parentSession alone
// is not enough: Pi also uses it for user forks and branch-off sessions.
function isHumanSession(session: SessionInfo): boolean {
	if (!session.parentSessionPath) return true;
	let fd: number | undefined;
	try {
		fd = openSync(session.path, "r");
		const head = Buffer.alloc(8192);
		const length = readSync(fd, head, 0, head.length, 0);
		for (const line of head.toString("utf8", 0, length).split("\\n").slice(1)) {
			if (/"type"\\s*:\\s*"message"/.test(line)) break;
			if (!/"type"\\s*:\\s*"session_info"/.test(line)) continue;
			const entry = JSON.parse(line) as { name?: unknown };
			return !(typeof entry.name === "string" && /#[0-9a-f]{8}$/i.test(entry.name.trim()));
		}
	} catch {
		// Keep unreadable/unknown sessions selectable rather than hiding them.
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
	return true;
}

export async function loadSessionsForScope(cwd: string, scope: Scope, onProgress?: (loaded: number, total: number) => void): Promise<SessionInfo[]> {
	const customSessionDir = configuredSessionDir(cwd);
	if (customSessionDir) {
		const sessions = await SessionManager.list(cwd, customSessionDir, onProgress);
		const current = canonicalPath(cwd);
		return sessions.filter((session) => isHumanSession(session) && (scope === "all" || canonicalPath(session.cwd) === current));
	}
	const sessions = await (scope === "all" ? SessionManager.listAll(onProgress) : SessionManager.list(cwd, undefined, onProgress));
	return sessions.filter(isHumanSession);
}`;

let source;
try {
	source = readFileSync(target, "utf8");
} catch (error) {
	console.error(`не прочитать ${target}: ${error.message}`);
	process.exit(1);
}
if (source.includes(marker)) {
	if (!source.includes(patchedImports) || !source.includes("return sessions.filter(isHumanSession);")) {
		console.error(`неполный патч в ${target}; исправь вручную`);
		process.exit(1);
	}
	console.log("уже пропатчено: /sessions скрывает сохранённых субагентов");
} else if (!source.includes(imports) || !source.includes(original)) {
	console.error(`НЕ найден ожидаемый блок в ${target}; апстрим изменился, патч требует проверки`);
	process.exit(1);
} else {
	writeFileSync(target, source.replace(imports, patchedImports).replace(original, replacement));
	console.log("пропатчено: /sessions скрывает сохранённых субагентов; /resume не изменён");
}

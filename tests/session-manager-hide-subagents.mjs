// Offline patch + behavior regression for @vanillagreen/pi-session-manager.
import assert from 'node:assert/strict';
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const patch = join(repo, 'patches/fix-pi-session-manager-hide-subagents.mjs');
const temp = mkdtempSync(join(tmpdir(), 'pi-session-filter-'));
const sourcePath = join(temp, 'actions.ts');
const original = `import { appendFileSync, existsSync } from "node:fs";
export async function loadSessionsForScope(cwd: string, scope: Scope, onProgress?: (loaded: number, total: number) => void): Promise<SessionInfo[]> {
	const customSessionDir = configuredSessionDir(cwd);
	if (customSessionDir) {
		const sessions = await SessionManager.list(cwd, customSessionDir, onProgress);
		if (scope === "all") return sessions;
		const current = canonicalPath(cwd);
		return sessions.filter((session) => canonicalPath(session.cwd) === current);
	}
	return scope === "all" ? SessionManager.listAll(onProgress) : SessionManager.list(cwd, undefined, onProgress);
}
export function acquirekendexModalLock(): () => void {}
`;
const run = () => spawnSync(process.execPath, [patch, `--target=${sourcePath}`], { encoding: 'utf8' });
const line = (value) => JSON.stringify(value) + '\n';
try {
  writeFileSync(sourcePath, original);
  let result = run(); assert.equal(result.status, 0, result.stderr);
  const patched = readFileSync(sourcePath, 'utf8');
  result = run(); assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(sourcePath, 'utf8'), patched, 'patch is idempotent');
  const code = patched.slice(patched.indexOf('// pi-harness: hide persisted subagent sessions only in /sessions'), patched.indexOf('export function acquirekendexModalLock'))
    .replace('function isHumanSession(session: SessionInfo): boolean', 'function isHumanSession(session)')
    .replace('let fd: number | undefined;', 'let fd;')
    .replace('JSON.parse(line) as { name?: unknown }', 'JSON.parse(line)')
    .replace(/export async function loadSessionsForScope\([^\n]*\): Promise<SessionInfo\[\]>/, 'async function loadSessionsForScope(cwd, scope, onProgress)');
  const records = [];
  const loader = new Function('openSync', 'readSync', 'closeSync', 'configuredSessionDir', 'canonicalPath', 'SessionManager', `${code}\nreturn loadSessionsForScope;`)(
    openSync, readSync, closeSync, () => undefined, (path) => path, {
      list: async (cwd) => records.filter((record) => record.cwd === cwd),
      listAll: async () => records,
    },
  );
  const make = (id, parent, names, beforeName = '') => {
    const path = join(temp, `${id}.jsonl`);
    writeFileSync(path, line({ type: 'session', cwd: '/project', ...(parent ? { parentSession: '/project/root.jsonl' } : {}) })
      + beforeName + names.map((name) => line({ type: 'session_info', name })).join('')
      + line({ type: 'message', message: { role: 'user', content: 'prompt' } }));
    const record = { path, cwd: '/project', parentSessionPath: parent ? '/project/root.jsonl' : undefined };
    records.push(record); return record;
  };
  const root = make('root', false, ['my main session']);
  const renamedAgent = make('agent', true, ['Explore#9286ad75', 'renamed after run'], line({ type: 'model_change', modelId: 'gpt' }) + line({ type: 'thinking_level_change', thinkingLevel: 'xhigh' }));
  const userFork = make('fork', true, ['user fork']);
  const branch = make('branch', true, []);
  const mainWithAgentStyleName = make('named', false, ['Explore#9286ad75']);
  const otherProject = make('other', false, []); otherProject.cwd = '/other';
  // A user prompt mentioning session_info should never hide a normal branch.
  writeFileSync(branch.path, line({ type: 'session', cwd: '/project', parentSession: root.path })
    + line({ type: 'message', message: { role: 'user', content: '"type":"session_info" named Explore#9286ad75' } }));
  assert.deepEqual((await loader('/project', 'current')).map((entry) => entry.path).sort(), [root, userFork, branch, mainWithAgentStyleName].map((entry) => entry.path).sort());
  assert.deepEqual((await loader('/project', 'all')).map((entry) => entry.path).sort(), [root, userFork, branch, mainWithAgentStyleName, otherProject].map((entry) => entry.path).sort());
  // Fixture for custom sessionDir: still filter agent rows in both scopes.
  const customLoader = new Function('openSync', 'readSync', 'closeSync', 'configuredSessionDir', 'canonicalPath', 'SessionManager', `${code}\nreturn loadSessionsForScope;`)(
    openSync, readSync, closeSync, () => '/custom', (path) => path, { list: async () => records },
  );
  assert.equal((await customLoader('/project', 'all')).includes(renamedAgent), false);
  assert.equal((await customLoader('/project', 'current')).includes(renamedAgent), false);
  assert.equal((await customLoader('/project', 'current')).includes(otherProject), false);
  assert.equal((await customLoader('/project', 'all')).includes(otherProject), true);
  // Fail closed on upstream drift, without leaving a half-applied patch.
  writeFileSync(sourcePath, original.replace('export async function loadSessionsForScope(', 'export async function changedUpstream('));
  const drift = readFileSync(sourcePath, 'utf8');
  result = run(); assert.notEqual(result.status, 0);
  assert.equal(readFileSync(sourcePath, 'utf8'), drift);
  // A machine without the optional package must still be able to run install/update.
  const emptyHome = join(temp, 'empty-home'); mkdirSync(emptyHome);
  const optional = spawnSync(process.execPath, [patch], { env: { ...process.env, HOME: emptyHome }, encoding: 'utf8' });
  assert.equal(optional.status, 0, optional.stderr);
  assert.match(optional.stdout, /пропуск: pi-session-manager не установлен/);
  const packageManifest = join(emptyHome, '.pi/agent/npm/node_modules/@vanillagreen/pi-session-manager/package.json');
  mkdirSync(dirname(packageManifest), { recursive: true }); writeFileSync(packageManifest, '{}');
  const installedButChanged = spawnSync(process.execPath, [patch], { env: { ...process.env, HOME: emptyHome }, encoding: 'utf8' });
  assert.notEqual(installedButChanged.status, 0, 'installed package with missing actions.ts must fail');
  const explicitMissing = spawnSync(process.execPath, [patch, `--target=${join(temp, 'missing.ts')}`], { encoding: 'utf8' });
  assert.notEqual(explicitMissing.status, 0);
  console.log('PASS: /sessions hides subagents, keeps human forks, Current/All, custom dir; optional package skip, idempotent/drift-safe');
} finally { rmSync(temp, { recursive: true, force: true }); }

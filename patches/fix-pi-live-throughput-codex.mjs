#!/usr/bin/env node
// Restore the reviewed pi-live-throughput 0.3.0 overlay after npm updates.
// Native provider hooks require Pi >= 1.0.0. No auth or transport changes.
import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const patchDir = dirname(fileURLToPath(import.meta.url));
const explicit = process.argv.find(a => a.startsWith('--target='))?.slice('--target='.length);
const agentDir = process.env.PI_CODING_AGENT_DIR ?? process.env.PI_AGENT_DIR ?? join(homedir(), '.pi/agent');
const packageDir = join(agentDir, 'npm/node_modules/pi-live-throughput');
const target = explicit ?? join(packageDir, 'src/index.ts');
if (!explicit && !existsSync(join(packageDir, 'package.json'))) {
  console.log('пропуск: pi-live-throughput не установлен');
  process.exit(0);
}
const digest = data => createHash('sha256').update(data).digest('hex');
const originalHashes = ['0e2e684dedb9c6dce73aa12d3c8e6f3ce49a1634e2773468c5234253637e0cbf', '177b70be09ae6b4cab2069d89b22a4bae032d98aca89bbe900e579e9a87d3957'];
// The second source is a reviewed compact-display variant on the second host.
const previousIndex = ['b826cd964e6bfa98afd6443c3c19cd6493fcf49b7ed9acdc1de06faba3e05987', 'ad7b3e7b3e07d459f33a6d2a06eb0ef1a092fbf9027c88c4a3b8c8a945f6fcac', '4021f61cc6d6cc75ccc8d58118962d046ef7a066f37164586b6a3ca4c1959328'];
const previousMetrics = ['cf9a7e4936029762e734dad3231542c705baece6f58a169ea3e9c64588ec7b2c', '31b3c9d0dde01a2be1b34abed7ed36029e8ef680f5781ea4c431314296744db8', '8d8adf0b4dbab83c973b0465fe1dd856fca964fee5f3d8ef43bc6ff9e1acf1b8'];
const index = readFileSync(join(patchDir, 'pi-live-throughput/index.ts'));
const metrics = readFileSync(join(patchDir, 'pi-live-throughput/codex-throughput.ts'));
const source = readFileSync(target);
const metricsTarget = join(dirname(target), 'codex-throughput.ts');
if (![...originalHashes, ...previousIndex, digest(index)].includes(digest(source))) {
  throw new Error('pi-live-throughput: исходник изменился; ничего не записано, патч требует проверки');
}
if (existsSync(metricsTarget) && ![...previousMetrics, digest(metrics)].includes(digest(readFileSync(metricsTarget)))) {
  throw new Error('Codex throughput overlay изменён локально; ничего не записано');
}
const writes = [[metricsTarget, metrics], [target, index]].filter(([path, bytes]) => !existsSync(path) || digest(readFileSync(path)) !== digest(bytes));
if (writes.length) {
  const backup = `${target}.pi-harness-original`;
  if (originalHashes.includes(digest(source)) && !existsSync(backup)) writeFileSync(backup, source, { mode: 0o600 });
  for (const [path, bytes] of writes) {
    const tmp = `${path}.pi-harness-tmp`;
    writeFileSync(tmp, bytes); renameSync(tmp, path);
  }
  console.log('пропатчено: guarded output TPS, held last good TPS, compact hit/in/out, no cumulative TPS');
} else console.log('уже пропатчено: Codex throughput');

// Exercise update.sh with a fake pi command and an isolated package/config directory.
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir, tmpdir } from 'node:os';
const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const pkg = process.env.SUBAGENTS_PACKAGE_ROOT ?? join(process.env.PI_CODING_AGENT_DIR ?? homedir() + '/.pi/agent', 'npm/node_modules/@tintinweb/pi-subagents');
const temp = mkdtempSync(join(tmpdir(), 'pi-harness-update-test-'));
try {
  const fakeRepo = join(temp, 'repo');
  for (const name of ['update.sh', 'patches/fix-subagents-live-tools.mjs', 'patches/fix-subagents-live-tools.patch', 'tests/subagents-live-tools.mjs']) {
    mkdirSync(dirname(join(fakeRepo, name)), { recursive: true }); cpSync(join(repo, name), join(fakeRepo, name));
  }
  // This fixture contains only subagents. Other suites are tested independently;
  // keep their updater entry points present without requiring the whole install.
  for (const name of ['compact-tools.mjs', 'orca-math.mjs']) {
    writeFileSync(join(fakeRepo, 'tests', name), 'console.log("SKIP: outside isolated subagents fixture");\n');
  }
  const pristine = join(temp, 'pristine'); cpSync(pkg, pristine, { recursive: true });
  const reverse = spawnSync(process.execPath, [join(repo, 'patches/fix-subagents-live-tools.mjs'), `--target=${pristine}`, '--revert'], { encoding: 'utf8' });
  assert.equal(reverse.status, 0, reverse.stderr);
  const bin = join(temp, 'bin'); mkdirSync(bin);
  writeFileSync(join(bin, 'pi'), `#!/usr/bin/env node
const fs = require('node:fs');
fs.writeFileSync(process.env.MOCK_LOG, JSON.stringify(process.argv.slice(2)));
fs.rmSync(process.env.MOCK_TARGET, { recursive: true, force: true });
fs.cpSync(process.env.MOCK_PRISTINE, process.env.MOCK_TARGET, { recursive: true });
`, { mode: 0o755 });
  const agent = join(temp, 'agent');
  const target = join(agent, 'npm/node_modules/@tintinweb/pi-subagents');
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, PI_CODING_AGENT_DIR: agent, SUBAGENTS_PACKAGE_ROOT: target, MOCK_TARGET: target, MOCK_PRISTINE: pristine, MOCK_LOG: join(temp, 'command.json') };
  const update = (...args) => spawnSync('bash', [join(fakeRepo, 'update.sh'), ...args], { env, encoding: 'utf8', timeout: 60000 });
  const normal = update();
  assert.equal(normal.status, 0, normal.stdout + normal.stderr);
  assert.deepEqual(JSON.parse(readFileSync(env.MOCK_LOG, 'utf8')), ['update', '--extensions']);
  assert.ok(existsSync(join(agent, 'patches/fix-subagents-live-tools.patch')));
  assert.match(normal.stdout, /PASS: live tools/);
  const all = update('--all');
  assert.equal(all.status, 0, all.stdout + all.stderr);
  assert.deepEqual(JSON.parse(readFileSync(env.MOCK_LOG, 'utf8')), ['update', '--all']);
  // Incompatible upstream is installed normally, but no partial overlay is written.
  const ui = join(pristine, 'src/ui/workflow-dialog.ts');
  writeFileSync(ui, readFileSync(ui, 'utf8').replace('function activityBody(', 'function changedUpstreamActivity('));
  const incompatible = update('npm:@tintinweb/pi-subagents');
  assert.notEqual(incompatible.status, 0);
  assert.match(incompatible.stderr, /Upstream updated, but an overlay needs review/);
  assert.equal(readFileSync(join(target, 'src/workflow/host.ts'), 'utf8'), readFileSync(join(pristine, 'src/workflow/host.ts'), 'utf8'));
  assert.ok(!existsSync(join(target, 'src/workflow/live-tools.ts')));
  console.log('PASS: updater reinstalls upstream, restores overlay/payload, forwards flags, runs offline tests, refuses incompatible overlay without blocking upstream update');
} finally { rmSync(temp, { recursive: true, force: true }); }

// Exercise update.sh with a fake pi command and an isolated package/config directory.
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync, lstatSync, symlinkSync } from 'node:fs';
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
  // This fixture exercises the REAL updater + subagents overlay/tests only.
  // Explicit fixture-local stubs satisfy unrelated updater entry points; no
  // production sanitizer, TPS deploy, statusline or auxiliary suite is skipped
  // or modified on a real installation.
  const stub = (name, bytes) => {
    mkdirSync(dirname(join(fakeRepo, name)), { recursive: true });
    writeFileSync(join(fakeRepo, name), bytes);
  };
  stub('assets/codex-only.py', `import os, pathlib, sys
root = pathlib.Path(os.environ['MOCK_FIXTURE_ROOT']).resolve()
for flag in ('--agent-dir', '--home'):
    path = pathlib.Path(sys.argv[sys.argv.index(flag) + 1]).resolve()
    assert path.is_relative_to(root), 'Sanitizer fixture must never target real HOME'
print('SKIP: sanitizer outside isolated subagents fixture')
`);
  stub('assets/statusline.py', '# Inert statusline fixture; never executes the production renderer.\n');
  stub('patches/pi-live-throughput/statusline-ui.ts', '// Inert statusline payload outside isolated subagents fixture.\n');
  stub('assets/deploy-tps-speedometer.sh', `#!/usr/bin/env bash
set -euo pipefail
case "$PI_CODING_AGENT_DIR" in "$MOCK_FIXTURE_ROOT"/*) ;; *) exit 90 ;; esac
if [ "${'${MOCK_TPS_FAILURE:-0}'}" = 1 ]; then
  echo 'TEST-only TPS entrypoint failure' >&2
  exit 23
fi
echo 'SKIP: TPS deployment outside isolated subagents fixture'
`);
  for (const name of ['compact-tools.mjs', 'orca-math.mjs', 'session-manager-hide-subagents.mjs', 'codex-throughput.mjs', 'codex-throughput-extension.mjs']) {
    stub(`tests/${name}`, `console.log('SKIP: ${name} outside isolated subagents fixture');\n`);
  }
  for (const name of ['codex-only.py', 'portable-config.py', 'statusline-session-name.py']) {
    stub(`tests/${name}`, `print('SKIP: ${name} outside isolated subagents fixture')\n`);
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
  const home = join(temp, 'home'); mkdirSync(home);
  const target = join(agent, 'npm/node_modules/@tintinweb/pi-subagents');
  const env = { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, PI_CODING_AGENT_DIR: agent, PI_AGENT_DIR: agent, SUBAGENTS_PACKAGE_ROOT: target, MOCK_FIXTURE_ROOT: temp, MOCK_TPS_FAILURE: '0', MOCK_TARGET: target, MOCK_PRISTINE: pristine, MOCK_LOG: join(temp, 'command.json') };
  const update = (...args) => spawnSync('bash', [join(fakeRepo, 'update.sh'), ...args], { env, encoding: 'utf8', timeout: 60000 });
  const normal = update();
  assert.equal(normal.status, 0, normal.stdout + normal.stderr);
  assert.deepEqual(JSON.parse(readFileSync(env.MOCK_LOG, 'utf8')), ['update', '--extensions']);
  assert.ok(existsSync(join(agent, 'patches/fix-subagents-live-tools.patch')));
  assert.match(normal.stdout, /PASS: live tools/);
  assert.match(normal.stdout, /SKIP: TPS deployment outside isolated subagents fixture/);
  assert.equal(readFileSync(join(home, '.local/share/claude-codex-statusline/statusline.py'), 'utf8'), readFileSync(join(fakeRepo, 'assets/statusline.py'), 'utf8'));
  // Regression: a previous install left a patch symlink pointing at the repo.
  // `cp` used to abort with "source and destination are identical" here.
  const patchName = 'fix-subagents-live-tools.mjs';
  const sourcePatch = join(fakeRepo, 'patches', patchName);
  const installedPatch = join(agent, 'patches', patchName);
  rmSync(installedPatch);
  symlinkSync(sourcePatch, installedPatch);
  const originalPatch = readFileSync(sourcePatch, 'utf8');
  const all = update('--all');
  assert.equal(all.status, 0, all.stdout + all.stderr);
  assert.deepEqual(JSON.parse(readFileSync(env.MOCK_LOG, 'utf8')), ['update', '--all']);
  assert.equal(lstatSync(installedPatch).isSymbolicLink(), false, 'replace old link with independent copy');
  assert.equal(readFileSync(installedPatch, 'utf8'), originalPatch);
  assert.equal(readFileSync(sourcePatch, 'utf8'), originalPatch, 'never overwrite repo patch');
  const repeated = update();
  assert.equal(repeated.status, 0, repeated.stdout + repeated.stderr);
  // The real updater must still propagate an unrelated entrypoint failure;
  // stubbing its implementation must not turn update errors into success.
  env.MOCK_TPS_FAILURE = '1';
  const failedEntrypoint = update('--extensions');
  env.MOCK_TPS_FAILURE = '0';
  assert.equal(failedEntrypoint.status, 23, failedEntrypoint.stdout + failedEntrypoint.stderr);
  assert.match(failedEntrypoint.stderr, /TEST-only TPS entrypoint failure/);
  assert.doesNotMatch(failedEntrypoint.stdout, /Packages updated and overlays verified/);
  // Incompatible upstream is installed normally, but no partial overlay is written.
  const ui = join(pristine, 'src/ui/workflow-dialog.ts');
  writeFileSync(ui, readFileSync(ui, 'utf8').replace('function activityBody(', 'function changedUpstreamActivity('));
  const incompatible = update('npm:@tintinweb/pi-subagents');
  assert.notEqual(incompatible.status, 0);
  assert.match(incompatible.stderr, /Upstream updated, but an overlay needs review/);
  assert.deepEqual(JSON.parse(readFileSync(env.MOCK_LOG, 'utf8')), ['update', 'npm:@tintinweb/pi-subagents']);
  assert.doesNotMatch(incompatible.stdout, /SKIP: TPS deployment/);
  assert.equal(readFileSync(join(target, 'src/workflow/host.ts'), 'utf8'), readFileSync(join(pristine, 'src/workflow/host.ts'), 'utf8'));
  assert.ok(!existsSync(join(target, 'src/workflow/live-tools.ts')));
  console.log('PASS: updater reinstalls upstream, restores overlay/payload, forwards flags, runs offline tests, refuses incompatible overlay without blocking upstream update');
} finally { rmSync(temp, { recursive: true, force: true }); }

// Offline regression tests against the installed package. No model/API calls.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, cpSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const pkg = process.env.SUBAGENTS_PACKAGE_ROOT ?? join(process.env.PI_CODING_AGENT_DIR ?? homedir() + '/.pi/agent', 'npm/node_modules/@tintinweb/pi-subagents');
const root = process.env.PI_PACKAGE_ROOT ?? join(execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim(), '@earendil-works/pi-coding-agent');
const requirePi = createRequire(join(root, 'package.json'));
const { createJiti } = await import(pathToFileURL(requirePi.resolve('jiti')));
const jiti = createJiti(import.meta.url, { alias: {
  '@earendil-works/pi-coding-agent': join(root, 'dist/index.js'),
  '@earendil-works/pi-ai': join(root, 'node_modules/@earendil-works/pi-ai/dist/index.js'),
  '@earendil-works/pi-tui': join(root, 'node_modules/@earendil-works/pi-tui/dist/index.js'),
  'typebox/value': requirePi.resolve('typebox/value'),
  'typebox/compile': requirePi.resolve('typebox/compile'),
  typebox: requirePi.resolve('typebox'),
  '@sinclair/typebox': requirePi.resolve('typebox'),
} });
const { observeWorkflowTools } = await jiti.import(join(pkg, 'src/workflow/live-tools.ts'));
const { runWorkflow } = await jiti.import(join(pkg, 'src/workflow/runtime.ts'));
const { createWorkflowHost } = await jiti.import(join(pkg, 'src/workflow/host.ts'));
const { registerAgents } = await jiti.import(join(pkg, 'src/agent-types.ts'));
const dialog = await jiti.import(join(pkg, 'src/ui/workflow-dialog.ts'));
const { visibleWidth } = await jiti.import('@earendil-works/pi-tui');

function fakeSession() {
  const listeners = new Set();
  return {
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    emit(type, id, name = 'bash') { for (const fn of listeners) fn({ type, toolCallId: id, toolName: name, args: { secret: 'NEVER_COPY_THIS' } }); },
    get size() { return listeners.size; },
  };
}
const session = fakeSession();
const snapshots = [];
const unsubscribe = observeWorkflowTools(session, 3, info => snapshots.push(info));
session.emit('tool_execution_start', 'a');
session.emit('tool_execution_start', 'b');
assert.equal(snapshots.at(-1).toolCalls, 3);
assert.match(snapshots.at(-1).toolActivity, /Running: bash, bash/);
session.emit('tool_execution_end', 'a');
assert.equal(snapshots.at(-1).toolCalls, 4);
assert.match(snapshots.at(-1).toolActivity, /Running: bash\nRecent: bash/);
session.emit('tool_execution_end', 'b');
for (let i = 0; i < 10; i++) {
  session.emit('tool_execution_start', String(i), `tool${i}`);
  session.emit('tool_execution_end', String(i), `tool${i}`);
}
assert.equal(snapshots.at(-1).toolCalls, 15);
assert.equal(snapshots.at(-1).toolActivity, 'Recent: tool4 → tool5 → tool6 → tool7 → tool8 → tool9');
assert.ok(!JSON.stringify(snapshots).includes('NEVER_COPY_THIS'));
unsubscribe(); assert.equal(session.size, 0);
observeWorkflowTools(session, 0)(); assert.equal(session.size, 0);

// Real host wiring: subscribe BEFORE work and release on completion/error/resume.
registerAgents(new Map());
const child = fakeSession();
const record = { id: 'child', status: 'completed', toolUses: 0, session: child, result: 'OK' };
let fail = false;
const manager = {
  getRecord() { return record; },
  async spawnAndWait(_pi, _ctx, _type, _prompt, options, spawned) {
    spawned('child'); options.onSessionCreated(child);
    child.emit('tool_execution_start', 'host', 'read');
    child.emit('tool_execution_end', 'host', 'read'); record.toolUses++;
    if (fail) throw new Error('expected failure');
    return { record };
  },
  async resume() {
    child.emit('tool_execution_start', 'resume', 'bash');
    child.emit('tool_execution_end', 'resume', 'bash'); record.toolUses++;
    if (fail) throw new Error('expected resume failure');
    return record;
  },
};
const host = createWorkflowHost({ pi: {}, ctx: { cwd: tmpdir(), modelRegistry: {}, ui: { notify() {} } }, manager });
const hostProgress = [];
await host.spawnAgent({ agentId: 'wf-agent-0', agentType: 'general-purpose', prompt: 'test', label: 'test', onProgress: info => hostProgress.push(info) });
assert.equal(hostProgress.at(-1).toolCalls, 1); assert.equal(child.size, 0);
await host.resumeAgent('wf-agent-0', 'test', undefined, info => hostProgress.push(info));
assert.equal(hostProgress.at(-1).toolCalls, 2); assert.equal(child.size, 0);
fail = true;
assert.equal((await host.spawnAgent({ agentId: 'wf-agent-1', agentType: 'general-purpose', prompt: 'test' })).ok, false);
assert.equal(child.size, 0);
await assert.rejects(host.resumeAgent('wf-agent-0', 'test', undefined, () => {}), /expected resume failure/);
assert.equal(child.size, 0);

// Runtime: live rows BEFORE resolution, then resume, then reject stale callbacks.
let late;
let firstResolved = false;
const progress = [];
const run = await runWorkflow({
  script: "export const meta = { name: 'test', description: 'test' }; await agent('first', { label: 'first' }); return await agent('next', { resume: 'first' });",
  host: {
    async spawnAgent(request) {
      request.onProgress({ toolCalls: 1, toolActivity: 'Running: bash' });
      assert.equal(firstResolved, false);
      assert.equal(progress.at(-1).toolCalls, 1);
      late = request.onProgress;
      firstResolved = true;
      return { ok: true, text: 'first', toolCalls: 1 };
    },
    async resumeAgent(_id, _prompt, _resolved, onProgress) {
      onProgress({ toolCalls: 2, toolActivity: 'Recent: bash → read' });
      return { ok: true, text: 'resumed', toolCalls: 2 };
    },
    abortAgent() {},
  },
  onProgress(entries) { progress.push(...entries); },
});
assert.equal(run.status, 'completed'); assert.equal(run.value, 'resumed');
assert.ok(progress.some(row => row.state === 'start' && row.toolCalls === 2));
const length = progress.length;
late({ toolCalls: 999, toolActivity: 'STALE' }); assert.equal(progress.length, length);

// Retry resets activity and rejects delayed events from the old attempt.
let control; let attempts = 0; let oldReporter;
const retryProgress = [];
const retry = await runWorkflow({
  script: "export const meta = { name: 'retry', description: 'retry' }; return await agent('test');",
  onControl(c) { control = c; },
  onProgress(entries) { retryProgress.push(...entries); },
  host: {
    async spawnAgent(request) {
      if (++attempts === 1) {
        oldReporter = request.onProgress;
        request.onProgress({ toolCalls: 7, toolActivity: 'OLD' });
        assert.equal(control.retry(request.index), true);
        return { ok: false, error: 'Stopped' };
      }
      const before = retryProgress.length;
      oldReporter({ toolCalls: 999, toolActivity: 'STALE_ATTEMPT' });
      assert.equal(retryProgress.length, before);
      assert.equal(retryProgress.at(-1).toolCalls, undefined);
      request.onProgress({ toolCalls: 1, toolActivity: 'Recent: read' });
      return { ok: true, text: 'retried', toolCalls: 1 };
    }, abortAgent() {},
  },
});
assert.equal(retry.value, 'retried'); assert.equal(attempts, 2);

// Actual dialog layout: activity is visible while running, no false placeholder.
const row = { type: 'workflow_agent', index: 0, label: 'codex', state: 'start', queuedAt: 1, startedAt: 2, toolCalls: 1, toolActivity: 'Running: bash\nRecent: read' };
for (const width of [20, 40, 80, 160]) {
  const lines = dialog.plainWorkflowDialogLines(dialog.layoutWorkflowDialog({
    progress: [row], task: { status: 'running', startTime: 1, workflowName: 'test' },
    state: { ...dialog.initialWorkflowDialogState(), level: 'agents' }, width, now: 3,
  }));
  assert.ok(lines.every(line => visibleWidth(line) <= width), `width ${width}`);
  if (width >= 80) {
    assert.match(lines.join('\n'), /Running: bash/);
    assert.match(lines.join('\n'), /Recent: read/);
    assert.ok(!lines.join('\n').includes('No tool calls yet'));
  }
}

const interruptedLines = dialog.plainWorkflowDialogLines(dialog.layoutWorkflowDialog({
  progress: [row], task: { status: 'killed', startTime: 1, workflowName: 'test' },
  state: { ...dialog.initialWorkflowDialogState(), level: 'agents' }, width: 160, now: 3,
})).join('\n');
assert.match(interruptedLines, /Last active: bash/);
assert.ok(!interruptedLines.includes('Running: bash'));

// Patch survives reinstall, is idempotent/reversible, refuses drift atomically.
const fixture = mkdtempSync(join(tmpdir(), 'pi-subagents-patch-test-'));
const patcher = join(repo, 'patches/fix-subagents-live-tools.mjs');
const patchFiles = ['package.json', 'src/workflow/host.ts', 'src/workflow/runtime.ts', 'src/workflow/progress.ts', 'src/ui/workflow-dialog.ts', 'src/workflow/live-tools.ts'];
const apply = (...args) => spawnSync(process.execPath, [patcher, `--target=${fixture}`, ...args], { encoding: 'utf8' });
try {
  for (const name of patchFiles) { mkdirSync(dirname(join(fixture, name)), { recursive: true }); cpSync(join(pkg, name), join(fixture, name)); }
  assert.equal(apply().status, 0);
  assert.equal(apply('--revert').status, 0);
  const original = readFileSync(join(fixture, 'src/workflow/host.ts'), 'utf8');
  assert.equal(apply('--check').status, 0);
  assert.equal(readFileSync(join(fixture, 'src/workflow/host.ts'), 'utf8'), original);
  assert.equal(apply().status, 0); assert.equal(apply().status, 0);
  assert.equal(apply('--revert').status, 0);
  // One broken hunk must stop ALL writes, including the otherwise compatible host.
  const ui = join(fixture, 'src/ui/workflow-dialog.ts');
  writeFileSync(ui, readFileSync(ui, 'utf8').replace('function activityBody(', 'function upstreamRenamedActivity('));
  assert.notEqual(apply().status, 0);
  assert.equal(readFileSync(join(fixture, 'src/workflow/host.ts'), 'utf8'), original);
} finally { rmSync(fixture, { recursive: true, force: true }); }
console.log('PASS: live tools, parallel same-name calls, bounded/privacy-safe history, host spawn/resume cleanup, runtime live/resume/retry/stale events, narrow UI, patch reinstall/idempotence/revert/drift safety');

// Explicit opt-in: three real Codex invocations (two concurrent children + resume).
if (process.argv.includes('--live')) {
  const sdk = await jiti.import('@earendil-works/pi-coding-agent');
  const { AgentManager } = await jiti.import(join(pkg, 'src/agent-manager.ts'));
  const runtime = await sdk.ModelRuntime.create();
  const model = runtime.getModel('openai-codex', 'gpt-6.1-sol');
  assert.ok(model, 'Configured Codex model required');
  registerAgents(new Map([['live-diagnostic', {
    name: 'live-diagnostic', description: 'Read-only diagnostic',
    builtinToolNames: ['bash', 'read'], extensions: false, skills: false,
    thinking: 'medium', maxTurns: 4, persistSession: false, outputTranscript: false,
    systemPrompt: 'Execute the exact read-only task. Always call requested tools before answering. Never modify files.',
    promptMode: 'replace',
  }]]));
  const liveManager = new AgentManager();
  const liveEvents = [];
  let result;
  const loader = new sdk.DefaultResourceLoader({
    cwd: homedir(), agentDir: sdk.getAgentDir(), noExtensions: true, noSkills: true, noPromptTemplates: true, noContextFiles: true,
    extensionFactories: [pi => pi.registerCommand('live-tools-diagnostic', {
      description: 'Read-only workflow diagnostic',
      handler: async (_args, ctx) => {
        result = await runWorkflow({
          script: `export const meta = { name: 'live-codex', description: 'live Codex tools' };
            const answers = await parallel(['a', 'b'].map(label => () => agent("Call bash exactly: printf 'LIVE_TOOL_OK\\\\n'. Then call read on /Users/billy/.pi/agent/subagents.json. Return LIVE_OK.", { label, agentType: 'live-diagnostic' })));
            const resumed = await agent("Call bash exactly: printf 'RESUME_TOOL_OK\\\\n'. Return RESUME_OK.", { resume: 'a' });
            return { answers, resumed };`,
          host: createWorkflowHost({ pi, ctx, manager: liveManager, workflowId: 'live-test' }),
          onProgress(entries) {
            liveEvents.push(...entries);
            for (const e of entries) if (e.toolActivity && e.state === 'start') {
              const real = liveManager.getRecord(e.recordId);
              assert.equal(real?.status, 'running', 'Progress must arrive before child settles');
              console.log(`LIVE ${e.label} ${e.toolCalls}: ${e.toolActivity.replaceAll('\n', ' | ')}`);
            }
          },
        });
      },
    })],
  });
  await loader.reload();
  const { session: parent } = await sdk.createAgentSession({ model, modelRuntime: runtime, resourceLoader: loader, sessionManager: sdk.SessionManager.inMemory() });
  try {
    await parent.bindExtensions({});
    await parent.prompt('/live-tools-diagnostic');
    assert.equal(result?.status, 'completed', result?.error);
    assert.ok(result.value.answers.every(a => a?.includes('LIVE_OK')));
    assert.match(result.value.resumed, /RESUME_OK/);
    for (const label of ['a', 'b']) assert.ok(liveEvents.some(e => e.label === label && e.state === 'start' && e.toolCalls >= 2));
    console.log('PASS: real Codex parallel + resume, live Activity verified BEFORE completion');
  } finally {
    parent.dispose();
    await liveManager.dispose();
  }
}

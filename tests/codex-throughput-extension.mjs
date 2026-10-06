// Actual Pi loader + UI hook regression. No model calls or credential reads.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const payload = join(repo, 'patches/pi-live-throughput/index.ts');
const patch = join(repo, 'patches/fix-pi-live-throughput-codex.mjs');
const agentDir = process.env.PI_CODING_AGENT_DIR ?? process.env.PI_AGENT_DIR ?? join(homedir(), '.pi/agent');
const installed = join(agentDir, 'npm/node_modules/pi-live-throughput/src/index.ts');
const source = process.env.THROUGHPUT_SOURCE ?? payload;
const globalRoot = spawnSync('npm', ['root', '-g'], { encoding: 'utf8' });
assert.equal(globalRoot.status, 0, globalRoot.stderr);
const piRoot = process.env.PI_CLI_ROOT ?? join(globalRoot.stdout.trim(), '@earendil-works/pi-coding-agent');
const { loadExtensions } = await import(pathToFileURL(join(piRoot, 'dist/core/extensions/loader.js')).href);
const savedFetch = globalThis.fetch;
globalThis.fetch = () => { throw new Error('Network is disabled in throughput tests'); };
const temp = mkdtempSync(join(tmpdir(), 'codex-throughput-test-'));
let clock = 0;
const clockDescriptor = Object.getOwnPropertyDescriptor(performance, 'now');
Object.defineProperty(performance, 'now', { value: () => clock, configurable: true });
try {
  const loaded = await loadExtensions([source], temp);
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.extensions.length, 1);
  const ext = loaded.extensions[0];
  let line; const statuses = new Map(); let footer;
  const ctx = { hasUI: true, model: { api: 'openai-codex-responses', provider: 'openai-codex', id: 'test' }, ui: {
    setWidget: (_key, lines) => { if (lines) line = lines.join(' '); },
    setStatus: (key, status) => { if (status) { line = status; statuses.set(key, status); } else statuses.delete(key); },
    setFooter: factory => { footer = factory?.({}, {}, { getExtensionStatuses: () => statuses }); },
    notify: () => {},
  } };
  const emit = async (type, event = {}) => {
    for (const fn of ext.handlers.get(type) ?? []) await fn({ type, ...event }, ctx);
  };
  const command = ext.commands.get('throughput');
  assert.ok(command);
  let seq = 0;
  const raw = async (type, data, t) => {
    clock = t;
    await emit('provider_stream_event', { api: ctx.model.api, provider: ctx.model.provider, model: 'test', data: { type, sequence_number: seq++, ...data } });
  };
  const message = { role: 'assistant', api: ctx.model.api, provider: ctx.model.provider, model: 'test', content: [], usage: { output: 0 } };
  await emit('session_start');
  // Real WS order: before_provider_request -> raw created -> message_start.
  await emit('before_provider_request');
  await raw('response.created', { response: { id: 'r' } }, 100);
  await emit('message_start', { message });
  assert.match(line, /momentum - TPS ● cumulative - TPS ● cache hit - ● session input 0/);
  await raw('response.output_item.added', { item: { id: 'm', type: 'message' } }, 1000);
  await raw('response.output_text.delta', { item_id: 'm', content_index: 0, delta: 'abcd' }, 2000);
  await raw('response.output_text.delta', { item_id: 'm', content_index: 0, delta: 'efgh' }, 3000);
  assert.match(line, /momentum ~1.0/);
  const during = line;
  clock = 99000;
  await command.handler('status', ctx);
  assert.match(line, /momentum ~1.0/, 'idle mode toggle preserves live speed');
  await command.handler('widget', ctx);
  assert.equal(line, during, 'render clock does not change spans/means');
  await raw('response.output_text.done', { item_id: 'm', content_index: 0, text: 'abcdefgh' }, 100000);
  await raw('response.output_item.done', { item: { id: 'm', type: 'message', content: [{ type: 'output_text', text: 'abcdefgh' }] } }, 101000);
  await raw('response.completed', { response: { id: 'r', status: 'completed', usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 0 }, output_tokens: 110, output_tokens_details: { reasoning_tokens: 100 } } } }, 102000);
  const finalMessage = { ...message, stopReason: 'stop', content: [{ type: 'text', text: 'abcdefgh' }], usage: { output: 110, reasoning: 100 } };
  await emit('message_end', { message: finalMessage });
  assert.match(line, /cumulative 10.0 TPS/);
  assert.doesNotMatch(line, /TTFT|stream|reasoning|response|total|output tok/);
  const finalLine = line;
  await emit('message_end', { message: finalMessage });
  assert.equal(line, finalLine, 'duplicate message_end cannot double-count totals');
  clock = 200000;
  await emit('before_provider_request');
  assert.match(line, /cumulative 10.0 TPS/);
  seq = 0;
  await raw('response.created', { response: { id: 'next' } }, 210000);
  await emit('message_start', { message });
  assert.match(line, /momentum ~5.0 TPS ● cumulative 10.0 TPS/);
  await command.handler('reset', ctx);
  assert.match(line, /momentum - TPS ● cumulative - TPS/);
  await emit('session_shutdown');

  // Exercise the real installed Codex SSE parser, not only synthetic Pi
  // lifecycle events. Its mock fetch is local, with a generated dummy JWT.
  const { stream } = await import(pathToFileURL(join(piRoot, 'node_modules/@earendil-works/pi-ai/dist/api/openai-codex-responses.js')).href);
  const model = { api: 'openai-codex-responses', provider: 'openai-codex', id: 'gpt-6.1-sol', name: 'offline fixture',
    baseUrl: 'https://chatgpt.com/backend-api', reasoning: true, input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 272000, maxTokens: 1000 };
  ctx.model = model; clock = 0;
  await command.handler('status', ctx);
  await emit('session_start');
  const rawFrames = [
    { type: 'response.created', response: { id: 'native_fixture' } },
    { type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning', id: 'thinking_fixture', summary: [] } },
    { type: 'response.reasoning_summary_text.delta', item_id: 'thinking_fixture', output_index: 0, summary_index: 0, delta: 'A fixture summary' },
    { type: 'response.output_item.done', output_index: 0, item: { type: 'reasoning', id: 'thinking_fixture', summary: [] } },
    { type: 'response.output_item.added', output_index: 1, item: { type: 'message', role: 'assistant', id: 'message_fixture', content: [] } },
    { type: 'response.content_part.added', item_id: 'message_fixture', output_index: 1, content_index: 0, part: { type: 'output_text', text: '' } },
    { type: 'response.output_text.delta', item_id: 'message_fixture', output_index: 1, content_index: 0, delta: 'Hello ' },
    { type: 'response.output_text.delta', item_id: 'message_fixture', output_index: 1, content_index: 0, delta: 'world' },
    { type: 'response.output_text.done', item_id: 'message_fixture', output_index: 1, content_index: 0, text: 'Hello world' },
    { type: 'response.output_item.done', output_index: 1, item: { type: 'message', role: 'assistant', id: 'message_fixture', content: [{ type: 'output_text', text: 'Hello world' }] } },
    { type: 'response.completed', response: { id: 'native_fixture', status: 'completed', model: model.id,
      usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 0 }, output_tokens: 320, output_tokens_details: { reasoning_tokens: 300 } } } },
  ].map((event, sequence_number) => ({ ...event, sequence_number }));
  const body = rawFrames.map(event => `data: ${JSON.stringify(event)}\n\n`).join('');
  const dummyJWT = ['{}', JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'offline-fixture' } }), 'dummy']
    .map(part => Buffer.from(part).toString('base64url')).join('.');
  let fetchCalls = 0; let deltas = 0;
  const response = stream(model, { messages: [{ role: 'user', content: [{ type: 'text', text: 'offline fixture' }], timestamp: 0 }] }, {
    apiKey: dummyJWT, transport: 'sse', maxRetries: 0,
    fetch: async () => { fetchCalls++; return new Response(body, { headers: { 'content-type': 'text/event-stream' } }); },
    onPayload: async () => { await emit('before_provider_request'); },
    onProviderStreamEvent: async data => {
      if (data.type === 'response.output_text.delta') clock = ++deltas * 1000;
      else clock++;
      await emit('provider_stream_event', { api: model.api, provider: model.provider, model: model.id, data });
    },
  });
  for await (const event of response) {
    if (event.type === 'start') await emit('message_start', { message: event.partial });
    else if (['done', 'error'].includes(event.type)) await emit('message_end', { message: await response.result() });
    else await emit('message_update', { message: event.partial, assistantMessageEvent: event });
  }
  assert.equal(fetchCalls, 1, 'one local mock HTTP request');
  assert.match(line, /cumulative 20.0 TPS/, 'actual native parser subtracts 300 reasoning tokens');
  assert.match(line, /cache hit 0.0% ● session input 100/);
  assert.doesNotMatch(line, /TTFT|stream|reasoning|response|total|output tok/);
  const uiSource = process.env.STATUSLINE_UI_SOURCE ?? join(repo, 'patches/pi-live-throughput/statusline-ui.ts');
  const bridgePath = join(temp, 'footer-bridge.ts');
  writeFileSync(bridgePath, `import { applyStatusLineUi } from ${JSON.stringify(uiSource)};
export default function(pi) { pi.on("session_start", (_e, ctx) => applyStatusLineUi(ctx, {placement:"footer"}, ["📁 harness-space ● GPT-6.1 Sol 272k medium 18k"])); }`);
  const uiLoad = await loadExtensions([bridgePath], temp);
  assert.deepEqual(uiLoad.errors, []);
  for (const fn of uiLoad.extensions[0].handlers.get('session_start')) await fn({type:'session_start'}, ctx);
  const wide = footer.render(220).join(' ');
  assert.match(wide, /GPT-6.1 Sol 272k medium 18k ● momentum/);
  assert.match(wide, /cumulative 20.0 TPS ● cache hit 0.0% ● session input 100/);
  statuses.set('throughput', 'momentum ~50.1 TPS ● cumulative 49.2 TPS ● cache hit 98.6% ● session input 120.2k');
  assert.match(footer.render(220).join(' '), /momentum ~50.1 TPS/, 'footer reads status dynamically without rerunning command');
  const narrow = footer.render(60);
  assert.ok(narrow.length > 1, 'narrow pane wraps between fields');
  assert.match(narrow.join(' '), /session input 120.2k/, 'last field is not silently truncated');
  assert.match(narrow.join(' '), /cache hit 98.6%/);
  statuses.delete('throughput');
  assert.equal(footer.render(220).length, 1, 'off removes extra fields');
  await emit('session_shutdown');

  // Apply twice to a private fixture. Refuse unknown upstream or modified
  // metrics before changing either file; never run a general pi update.
  const fixtureDir = join(temp, 'package/src'); mkdirSync(fixtureDir, { recursive: true });
  const target = join(fixtureDir, 'index.ts');
  const originalPath = process.env.THROUGHPUT_ORIGINAL ?? (installed + '.pi-harness-original');
  const original = readFileSync(originalPath);
  writeFileSync(target, original);
  const apply = () => spawnSync(process.execPath, [patch, `--target=${target}`], { encoding: 'utf8' });
  let result = apply(); assert.equal(result.status, 0, result.stderr);
  const patched = readFileSync(target, 'utf8');
  result = apply(); assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(target, 'utf8'), patched);
  writeFileSync(target, patched + '\n// unknown local edit\n');
  const edited = readFileSync(target, 'utf8');
  result = apply(); assert.notEqual(result.status, 0);
  assert.equal(readFileSync(target, 'utf8'), edited);
  writeFileSync(target, original);
  const metrics = join(fixtureDir, 'codex-throughput.ts');
  writeFileSync(metrics, '// local edit');
  result = apply(); assert.notEqual(result.status, 0);
  assert.deepEqual(readFileSync(target), original, 'no partial write on drift');
  assert.equal(readFileSync(metrics, 'utf8'), '// local edit');
  const statuslinePatch = join(repo, 'patches/fix-pi-statusline-throughput.mjs');
  const uiOriginal = process.env.STATUSLINE_ORIGINAL ?? join(agentDir, 'npm/node_modules/pi-statusline/src/ui.ts.pi-harness-original');
  const uiTarget = join(fixtureDir, 'ui.ts');
  writeFileSync(uiTarget, readFileSync(uiOriginal));
  const patchUI = () => spawnSync(process.execPath, [statuslinePatch, `--target=${uiTarget}`], { encoding: 'utf8' });
  result = patchUI(); assert.equal(result.status, 0, result.stderr);
  const uiPatched = readFileSync(uiTarget, 'utf8');
  result = patchUI(); assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(uiTarget, 'utf8'), uiPatched);
  writeFileSync(uiTarget, uiPatched + '\n// unknown local change\n');
  const uiEdited = readFileSync(uiTarget, 'utf8');
  result = patchUI(); assert.notEqual(result.status, 0);
  assert.equal(readFileSync(uiTarget, 'utf8'), uiEdited);
  console.log('PASS: actual Pi loader + Codex SSE parser, compact dynamic footer/wrapping, widget/status, WS-before-message ordering, native final usage, idle/next-response current, reset, idempotent/drift-safe overlay; zero model calls');
} finally {
  if (clockDescriptor) Object.defineProperty(performance, 'now', clockDescriptor);
  else delete performance.now;
  globalThis.fetch = savedFetch;
  rmSync(temp, { recursive: true, force: true });
}

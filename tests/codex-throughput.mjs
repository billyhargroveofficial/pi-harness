// Offline mathematical/structural tests. Synthetic schedules are NOT evidence
// about network delivery timing. No inference, credentials, or session files.
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { CodexMeasurement, CodexThroughput, OutputWindow, POLICY, SessionInput, NativeAverage, NativeLedger, NATIVE_ENTRY, NATIVE_METRIC, hash, formatRate } from '../patches/pi-live-throughput/codex-throughput.ts';
import { resolveReferenceTokenizer } from '../patches/pi-live-throughput/reference-tokenizer.ts';
let checks = 0;
function test(name, run) { try { run(); checks++; } catch (e) { e.message = `${name}: ${e.message}`; throw e; } }
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);
const ref = resolveReferenceTokenizer(); assert.equal(typeof ref, 'function', 'TPS_TOKENIZER_DIR must contain reference runtime');
const runtimeDir = process.env.TPS_TOKENIZER_DIR ?? join(process.env.PI_CODING_AGENT_DIR ?? process.env.PI_AGENT_DIR ?? join(homedir(), '.pi/agent'), 'tps-runtime');
const require = createRequire(join(resolve(runtimeDir), 'package.json'));
const { encode } = require('gpt-tokenizer/encoding/o200k_base');
const oracle = text => encode(text, { allowedSpecial: new Set(), disallowedSpecial: new Set() }).length;
const model = { id: 'test', api: 'openai-codex-responses', provider: 'openai-codex' };
const assistant = (text = '', id = 'r', output = 140) => ({ role: 'assistant', api: model.api, provider: model.provider, model: model.id, responseId: id, stopReason: 'stop', content: [{ type: 'text', text }], usage: { input: 100, cacheRead: 900, cacheWrite: 0, output } });
function replay({ target, request = 0, times = [1000, 1500, 2000, 2500], deltas = times.map((_, i) => `word${i} alpha beta gamma `), output = 140, terminal = 2700, terminalType = 'response.completed', status = 'completed', id = 'r', details, controls = false } = {}) {
 const m = target ?? new CodexMeasurement('test'); m.requestTime = request; let seq = 0;
 const emit = (type, data, t) => m.provider({ type, sequence_number: seq++, ...data }, t);
 if (controls) emit('rate_limits.updated', { rate_limits: [] }, request + 10);
 emit('response.created', { response: { id } }, request + 100);
 emit('response.output_item.added', { item: { id: 'm', type: 'message' } }, request + 200);
 let text = '';
 for (let i = 0; i < times.length; i++) { text += deltas[i]; emit('response.output_text.delta', { item_id: 'm', content_index: 0, delta: deltas[i] }, times[i]); m.checkpoint(times[i]); }
 emit('response.output_text.done', { item_id: 'm', content_index: 0, text }, times.at(-1) + 1);
 emit('response.output_item.done', { item: { id: 'm', type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] } }, times.at(-1) + 2);
 const usage = output === undefined ? {} : { output_tokens: output };
 // Intentionally omit reasoning metadata unless explicitly provided.
 if (details) usage.output_tokens_details = details;
 Object.assign(usage, { input_tokens: 1000, input_tokens_details: { cached_tokens: 900 } });
 emit(terminalType, { response: { id, status, usage } }, terminal);
 m.freeze(terminal + 50);
 return { m, text, emit, message: assistant(text, id, output) };
}
function store(origin = 'own') {
 const entries = []; let serial = 0;
 const manager = { getSessionId: () => origin, getEntries: () => entries.slice(), getEntry: id => entries.find(e => e.id === id) };
 const append = (type, data) => entries.push({ id: `e${serial++}`, type: 'custom', customType: type, data: structuredClone(data) });
 const saved = (message, id = `m${serial++}`) => { entries.push({ type: 'message', id, message }); return id; };
 return { entries, manager, append, saved };
}
function controller(resolver) { const d = new CodexThroughput(resolver); const s = store(); d.bindLedger(s.manager, s.append); d.select(model); return { d, ...s }; }
function completedController({ output = 140, options = {}, resolver } = {}) {
 const s = controller(resolver); s.d.prepare(model, 0);
 const f = replay({ target: s.d.measurement, output, ...options });
 s.d.end(f.message, 2800); const entryId = s.saved(f.message); s.d.commitSaved(entryId, s.manager); return { ...s, ...f, entryId };
}

// Reference prefix tokenizer, chunk boundaries and resource safety.
for (const text of ['English punctuation and code: const x = 42;', 'Русский текст, 世界、中文。', '😀🧑‍🚀💖', '<|endoftext|><|im_start|>ordinary', '{"name":"test","args":[1,2,3]}']) {
 test('reference encoder ordinary multilingual text', () => assert.equal(ref(text), oracle(text)));
 test('prefix chunk invariance including surrogate split', () => {
  const w = new OutputWindow();
  for (let i = 0; i < text.length; i++) w.append('p', text[i]);
  w.checkpoint(0); assert.equal(w.tokens, oracle(text));
  assert.equal(w.parts.get('p').text, text);
 });
}
test('full accumulated prefix, NOT sum of independent encodings', () => {
 const w = new OutputWindow(); w.append('a', 'hel'); w.checkpoint(0); w.append('a', 'lo'); w.checkpoint(1000);
 assert.equal(w.tokens, oracle('hello')); assert.notEqual(w.tokens, oracle('hel') + oracle('lo'));
});
test('unchanged parts cached independently', () => {
 let calls = 0; const w = new OutputWindow(() => text => { calls++; return oracle(text); });
 w.append('text', 'hello'); w.append('tool', '{"a":'); w.checkpoint(0); assert.equal(calls, 2);
 w.append('tool', '1}'); w.checkpoint(200); assert.equal(calls, 3); w.checkpoint(400); assert.equal(calls, 3);
 assert.equal(w.tokens, oracle('hello') + oracle('{"a":1}'));
});
test('surrogate split is repaired by full-prefix encode', () => {
 const w = new OutputWindow(); w.append('p', '\ud83d'); w.checkpoint(0); w.append('p', '\ude00'); w.checkpoint(1000);
 assert.equal(w.tokens, oracle('😀')); assert.equal(w.parts.get('p').text.length, 2);
});
test('missing/runtime-throw LIVE is unknown, not chars/4 fallback', () => {
 for (const resolver of [() => undefined, () => { throw Error('missing'); }]) { const w = new OutputWindow(resolver); w.append('p', 'test'); assert.equal(w.current(1000), undefined); assert.equal(w.parts.size, 0); }
 assert.equal(resolveReferenceTokenizer({ dir: '/tmp/pi-tps-definitely-missing' }), undefined);
});
test('explicit injected counts rejected if malformed', () => {
 for (const n of [NaN, Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) { const w = new OutputWindow(() => () => n); w.append('a', 'x'); w.checkpoint(0); assert.equal(w.invalid, true); }
});
test('256Ki total limit, no per-part loophole, clears all buffers', () => {
 const w = new OutputWindow(() => text => text.length); w.append('a', 'x'.repeat(POLICY.maxUnits - 1)); w.append('b', 'x');
 assert.equal(w.invalid, false); w.append('b', 'y'); assert.equal(w.invalid, true); assert.equal(w.parts.size, 0); assert.equal(w.units, 0); assert.equal(w.current(1000), undefined);
});

// Independent window mathematics; numeric injected prefixes avoid BPE-dependent
// expectations in the time oracle. No minChars/buckets/caps/EMA/burst censorship.
const numeric = () => new OutputWindow(() => text => text.length);
function point(w, t, text) { w.append('p', text); return w.checkpoint(t); }
test('first atomic checkpoint is an untimed baseline', () => {
 const w = numeric(); point(w, 0, 'x'.repeat(100)); point(w, 49, 'x'.repeat(20)); point(w, 1000, 'x'.repeat(30));
 // Deferred second chunk counts in numerator, never moves the first baseline.
 assert.equal(w.estimatedCurrent, 50); assert.equal(w.samples[0].t, 0); assert.equal(w.samples[0].tokens, 100);
});
test('999ms warmup, exactly 1000ms known, no bucket minimum', () => {
 const w = numeric(); point(w, 0, 'a'); point(w, 999, 'b'); assert.equal(w.estimatedCurrent, undefined); w.checkpoint(1000, true); assert.equal(w.estimatedCurrent, 1);
});
test('one token/very slow positive rates not censored', () => { const w = numeric(); point(w, 0, 'x'); point(w, 100000, 'x'); assert.equal(w.estimatedCurrent, 0.01); assert.equal(formatRate(w.estimatedCurrent), '~0.0'); });
test('literal 222919.7 TPS and dominant bursts accepted after warmup', () => {
 const w = numeric(); point(w, 0, 'x'); point(w, 1000, 'x'.repeat(222919)); close(w.estimatedCurrent, 222919); assert.equal(formatRate(222919.7), '~222919.7');
});
test('no microsecond/subms or same-time first volume division', () => {
 for (const end of [0, 0.0001, 0.0448592, 999]) { const w = numeric(); point(w, 0, 'x'); point(w, end, 'x'.repeat(99999)); assert.equal(w.estimatedCurrent, undefined); }
});
test('active silence advances denominator and decays to explicit zero', () => {
 const w = numeric(); point(w, 0, 'a'); point(w, 1000, 'b'.repeat(100)); assert.equal(w.estimatedCurrent, 100);
 w.checkpoint(2000); assert.equal(w.estimatedCurrent, 50); w.checkpoint(4000); assert.equal(w.estimatedCurrent, 0);
});
test('genuinely negative signed BPE prefix differences are UNKNOWN, not clamp', () => {
 const w = new OutputWindow(() => text => text === 'a' ? 2 : text === 'ab' ? 1 : 3);
 point(w, 0, 'a'); point(w, 1000, 'b'); assert.equal(w.tokens, 1); assert.equal(w.estimatedCurrent, undefined); assert.equal(w.reason, 'negative-prefix-difference');
 point(w, 2000, 'c'); assert.equal(w.estimatedCurrent, 0.5, 'signed intermediate correction belongs in the positive net difference'); w.checkpoint(5000); assert.equal(w.estimatedCurrent, 0);
});
test('negative real reference prefix recovers via net signed difference', () => {
 const pair = [' internatio', 'n']; assert.ok(oracle(pair[0] + pair[1]) < oracle(pair[0]));
 const w = new OutputWindow(); point(w, 0, pair[0]); point(w, 1000, pair[1]); assert.equal(w.reason, 'negative-prefix-difference');
 point(w, 2000, ' a'.repeat(20)); assert.equal(w.estimatedCurrent, 9.5);
});
test('clock rollback/nonfinite rejected; unchanged cache never hides rollback', () => {
 for (const t of [NaN, Infinity, -1]) { const w = numeric(); w.append('p', 'x'); w.checkpoint(t); assert.equal(w.invalid, true); }
 const w = numeric(); point(w, 100, 'x'); w.checkpoint(99); assert.equal(w.invalid, true);
});
test('bounded observation history under callback flood', () => { const w = numeric(); for (let i = 0; i < 30000; i++) point(w, i, 'x'); assert.ok(w.samples.length <= 17); });

// Raw Codex stream, terminal totals, structural safeguards.
const valid = replay();
test('reference LIVE oracle and terminal tail are independent of native total', () => {
 const expected = (oracle(valid.text) - oracle('word0 alpha beta gamma ')) / 1.7;
 close(valid.m.current(999999), expected); assert.equal(valid.m.finish(valid.message), true);
 assert.equal(valid.m.nativeTokens, 140); assert.equal(valid.m.observation(valid.message).nativeTokens, 140); assert.equal(valid.m.observation(valid.message).elapsedMs, 2700);
 for (const output of [0, 1000000]) { const f = replay({ output }); close(f.m.current(900000), expected); assert.equal(f.m.observation(f.message).nativeTokens, output); }
});
test('hidden reasoning INCLUDED, absent metadata valid, inconsistent details not subtracted', () => {
 for (const details of [undefined, { reasoning_tokens: 128 }, { reasoning_tokens: 500 }]) { const f = replay({ details }); assert.equal(f.m.observation(f.message).nativeTokens, 140); }
});
test('failed/incomplete/error explicit usage counts despite LIVE ineligibility', () => {
 for (const terminalType of ['response.failed', 'response.incomplete', 'error']) { const f = replay({ terminalType, status: 'failed' }); f.message.stopReason = 'aborted'; assert.equal(f.m.finish(f.message), false); assert.equal(f.m.observation(f.message).nativeTokens, 140); }
});
test('missing raw output is UNKNOWN, never normalized zero', () => {
 const m = new CodexMeasurement('test'); m.requestTime = 0;
 m.provider({ type: 'response.created', response: { id: 'r' } }, 0); m.provider({ type: 'response.completed', response: { id: 'r', status: 'completed', usage: {} } }, 1000); m.freeze(1000);
 assert.equal(m.nativeTokens, undefined); assert.equal(m.observation(assistant('', 'r', 0)), undefined);
});
test('TTFT, reasoning, terminal tail included only in native operation time', () => {
 const f = replay({ request: 0, times: [10000, 10500, 11000, 11500], terminal: 20000 });
 assert.equal(f.m.observation(f.message).elapsedMs, 20000); assert.ok(f.m.current(20000) >= 0);
});
test('short/one-shot and same-time output still has native AVG', () => {
 for (const times of [[1000], [1000, 1000, 1000]]) { const f = replay({ times, terminal: 1100 }); assert.equal(f.m.finish(f.message), false); assert.equal(f.m.observation(f.message).nativeTokens, 140); }
});
test('native succeeds with missing reference runtime and unsupported multimodal', () => {
 const m = new CodexMeasurement('test', () => undefined); const f = replay({ target: m }); assert.equal(m.finish(f.message), false); assert.equal(m.observation(f.message).nativeTokens, 140);
 const n = new CodexMeasurement('test'); n.requestTime = 0;
 n.provider({ type: 'response.created', response: { id: 'r' } }, 0); n.provider({ type: 'response.output_item.added', item: { id: 'image', type: 'image_generation_call' } }, 1);
 n.provider({ type: 'response.completed', response: { id: 'r', status: 'completed', usage: { output_tokens: 100 } } }, 1000); n.freeze(1000);
 assert.equal(n.current(1000), undefined); assert.equal(n.observation(assistant('', 'r', 100)).nativeTokens, 100);
});
test('native succeeds beyond LIVE buffer resource limit', () => {
 const f = replay({ deltas: ['x', 'x'.repeat(POLICY.maxUnits), 'x', 'x'] }); assert.equal(f.m.window.parts.size, 0); assert.equal(f.m.current(2700), undefined); assert.equal(f.m.observation(f.message).nativeTokens, 140);
});
test('pre-created genuine control/metadata accepted, sequence preserved', () => { const f = replay({ controls: true }); assert.equal(f.m.invalid, false); assert.equal(f.m.observation(f.message).nativeTokens, 140); });
test('pre-created in-progress identity must match created', () => {
 for (const id of ['r', 'wrong']) { const m = new CodexMeasurement('test'); m.provider({ type: 'response.in_progress', sequence_number: 0, response: { id } }, 0); m.provider({ type: 'response.created', sequence_number: 1, response: { id: 'r' } }, 1); assert.equal(m.invalid, id !== 'r'); }
});
test('malformed content-before-created poisons native correlation too', () => { const m = new CodexMeasurement('test'); m.provider({ type: 'response.output_text.delta', item_id: 'm', content_index: 0, delta: 'x' }, 0); assert.equal(m.invalid, true); });
test('sequence gaps, duplicate sequence/created and foreign response IDs fail closed', () => {
 for (const bad of [{ type: 'response.in_progress', sequence_number: 3 }, { type: 'response.in_progress', sequence_number: 0 }, { type: 'response.created', response: { id: 'r' } }, { type: 'response.in_progress', response_id: 'other' }]) {
  const m = new CodexMeasurement('test'); m.requestTime = 0; m.provider({ type: 'response.created', sequence_number: 0, response: { id: 'r' } }, 1); m.provider(bad, 2); assert.equal(m.invalid, true);
 }
});
test('live done hash guards independent of trustworthy native usage', () => {
 const m = new CodexMeasurement('test'); m.requestTime = 0;
 m.provider({ type: 'response.created', response: { id: 'r' } }, 1); m.provider({ type: 'response.output_item.added', item: { id: 'm', type: 'message' } }, 2);
 m.provider({ type: 'response.output_text.delta', item_id: 'm', content_index: 0, delta: 'hello' }, 3); m.provider({ type: 'response.output_text.done', item_id: 'm', content_index: 0, text: 'lost' }, 4);
 m.provider({ type: 'response.completed', response: { id: 'r', status: 'completed', usage: { output_tokens: 140 } } }, 1000); m.freeze(1000);
 assert.equal(m.current(1000), undefined); assert.equal(m.observation(assistant()).nativeTokens, 140);
});
test('message-end freeze is immutable against late raw callbacks/attribution', () => {
 const f = replay(); const before = f.m.observation(f.message);
 f.m.provider({ type: 'response.completed', response: { id: 'wrong', usage: { output_tokens: 999999 } } }, 4000);
 f.m.attribute('other', model.api, 'other'); assert.deepEqual(f.m.observation(f.message), before); assert.equal(f.m.finish(f.message), true);
});
test('UTF16 hash remains stable when raw deltas actually split a surrogate pair', () => {
 const f = replay({ deltas: ['A\ud83d', '\ude00 B', ' alpha', ' beta'] }); assert.equal(f.m.finish(f.message), true); assert.equal(f.m.window.tokens, oracle(f.text));
});
test('pre-terminal and post-terminal control events do not fabricate native volume/tail', () => {
 const m = new CodexMeasurement('test'); m.requestTime = 0;
 m.provider({ type: 'response.created', sequence_number: 0, response: { id: 'r' } }, 0);
 m.provider({ type: 'response.completed', sequence_number: 1, response: { id: 'r', status: 'completed', usage: { output_tokens: 140 } } }, 1000);
 m.provider({ type: 'rate_limits.updated', sequence_number: 2 }, 2000); m.freeze(3000);
 assert.equal(m.observation(assistant()).elapsedMs, 1000); assert.equal(m.nativeTokens, 140);
});
test('actual provider/model attribution accepted initially, mismatches later rejected', () => {
 const m = new CodexMeasurement('selected'); m.attribute('openai-codex', model.api, 'routed'); assert.equal(m.model, 'routed'); assert.equal(m.invalid, false);
 m.attribute('openai-codex', model.api, 'other'); assert.equal(m.invalid, true);
});
test('tool input prefixes measured once; snapshots add no volume', () => {
 const m = new CodexMeasurement('test'); m.requestTime = 0; let seq = 0;
 const emit = (type, data, t) => m.provider({ type, sequence_number: seq++, ...data }, t);
 const tool = { id: 'f', type: 'function_call', call_id: 'call', name: 'fn' };
 emit('response.created', { response: { id: 'r' } }, 0); emit('response.output_item.added', { item: tool }, 1);
 let args = ''; const deltas = ['{"value":"seed', ' alpha', ' beta', ' gamma","n":1}'];
 for (let i = 0; i < deltas.length; i++) { const delta = deltas[i]; args += delta; emit('response.function_call_arguments.delta', { item_id: 'f', delta }, 1000 + i * 500); m.checkpoint(1000 + i * 500); }
 const total = m.window.tokens;
 emit('response.function_call_arguments.done', { item_id: 'f', arguments: args }, 2501); emit('response.output_item.done', { item: { ...tool, arguments: args } }, 2502);
 emit('response.completed', { response: { id: 'r', status: 'completed', usage: { output_tokens: 140 } } }, 2700); m.freeze(2700);
 const saved = { ...assistant(), content: [{type:'toolCall',id:'call|f',name:'fn',arguments:{n:1,value:'seed alpha beta gamma'}}], stopReason: 'toolUse' };
 assert.equal(m.window.tokens, total); assert.equal(total, oracle(args)); assert.equal(m.finish(saved), true);
 for (const changed of [{arguments:{n:1,value:'replaced'}},{id:'other|f'},{name:'otherFn'},{namespace:'other'}]) {
  const replacement = {...saved,content:[{...saved.content[0],...changed}]}; assert.equal(m.finish(replacement), false); assert.equal(m.observation(replacement).nativeTokens,140);
 }
 assert.equal(m.finish({...saved,content:[]}),false);
});
test('retry new native response without old usage marks operation UNKNOWN', () => {
 const m = new CodexMeasurement('test'); m.requestTime = 0;
 m.provider({ type: 'response.created', response: { id: 'old' } }, 1); m.provider({ type: 'response.created', sequence_number: 0, response: { id: 'new' } }, 500);
 m.provider({ type: 'response.completed', sequence_number: 1, response: { id: 'new', status: 'completed', usage: { output_tokens: 100 } } }, 1000); m.freeze(1000);
 assert.equal(m.retryUnknown, true); assert.equal(m.observation(assistant('', 'new', 100)), undefined);
});
test('retry with both known terminal usages sums tokens and full operation retry time', () => {
 const m = new CodexMeasurement('test'); m.requestTime = 0;
 m.provider({ type: 'response.created', sequence_number: 0, response: { id: 'old' } }, 1);
 m.provider({ type: 'response.failed', sequence_number: 1, response: { id: 'old', status: 'failed', usage: { output_tokens: 20 } } }, 100);
 m.provider({ type: 'response.created', sequence_number: 0, response: { id: 'new' } }, 500);
 m.provider({ type: 'response.completed', sequence_number: 1, response: { id: 'new', status: 'completed', usage: { output_tokens: 100 } } }, 1000); m.freeze(1000);
 const o = m.observation(assistant('', 'new', 100)); assert.equal(o.nativeTokens, 120); assert.equal(o.elapsedMs, 1000);
});
test('retry pre-created control has independent sequence and does not lose native coverage', () => {
 const m = new CodexMeasurement('test'); m.requestTime = 0;
 m.provider({ type: 'response.created', sequence_number: 0, response: { id: 'old' } }, 1);
 m.provider({ type: 'response.failed', sequence_number: 1, response: { id: 'old', status: 'failed', usage: { output_tokens: 20 } } }, 100);
 m.provider({ type: 'response.queued', sequence_number: 0, response: { id: 'new' } }, 500);
 m.provider({ type: 'response.created', sequence_number: 1, response: { id: 'new' } }, 501);
 m.provider({ type: 'response.completed', sequence_number: 2, response: { id: 'new', status: 'completed', usage: { output_tokens: 100 } } }, 1000); m.freeze(1000);
 assert.equal(m.invalid, false); assert.equal(m.observation(assistant('', 'new', 100)).nativeTokens, 120);
});
test('queued retry lacking created/terminal cannot count only the old attempt', () => {
 const m = new CodexMeasurement('test'); m.requestTime = 0;
 m.provider({ type: 'response.created', response: { id: 'old' } }, 1);
 m.provider({ type: 'response.failed', response: { id: 'old', status: 'failed', usage: { output_tokens: 20 } } }, 100);
 m.provider({ type: 'response.queued', response: { id: 'new' } }, 500); m.freeze(1000);
 assert.equal(m.observation({ ...assistant('', 'old', 20), stopReason: 'error' }), undefined);
});
test('native duration <=0 or malformed fails, short positive has no gate', () => {
 for (const terminal of [0, -1, NaN, Infinity, 0.0001]) {
  const m = new CodexMeasurement('test'); m.requestTime = 0; m.provider({ type: 'response.created', response: { id: 'r' } }, 0);
  m.provider({ type: 'response.completed', response: { id: 'r', status: 'completed', usage: { output_tokens: 140 } } }, terminal); m.freeze(terminal);
  assert.equal(m.observation(assistant()) !== undefined, terminal === 0.0001);
 }
});

// Independent native ratio-of-sums and durable coverage reconstruction.
const rec = (kind, operation, extras = {}, epoch = 'epoch', origin = 'own') => ({ type: 'custom', customType: NATIVE_ENTRY, data: { v: 1, metric: NATIVE_METRIC, kind, origin, epoch, ...(operation ? { operation } : {}), ...extras } });
const observation = (op, tokens, elapsed, extras = {}) => rec('observation', op, { responseHash: hash(op), nativeTokens: tokens, elapsedMs: elapsed, provider: 'openai-codex', api: model.api, model: 'test', ...extras });
const epoch = rec('epoch');
test('weighted native AVG 100/1s + 100/10s = 200/11, not 55', () => {
 const n = new NativeAverage(); n.restore([epoch, rec('start', 'a'), observation('a', 100, 1000), rec('start', 'b'), observation('b', 100, 10000)], 'own'); close(n.value, 200 / 11); assert.notEqual(n.value, 55);
});
test('explicit native zero is a measured zero, no magnitude/duration caps', () => {
 const n = new NativeAverage(); n.restore([epoch, rec('start', 'z'), observation('z', 0, 0.1)], 'own'); assert.equal(n.value, 0);
 n.restore([epoch, rec('start', 'z'), observation('z', 222920, 1000)], 'own'); assert.equal(n.value, 222920);
});
test('pending preserves completed AVG, reload unclosed start makes it UNKNOWN', () => {
 const n = new NativeAverage(), entries = [epoch, rec('start', 'a'), observation('a', 100, 1000), rec('start', 'pending')];
 n.restore(entries, 'own', new Set(['pending'])); assert.equal(n.value, 100); n.restore(entries, 'own'); assert.equal(n.value, undefined); assert.equal(n.unknown, true);
});
test('all own branches/models, foreign fork inheritance excluded', () => {
 const n = new NativeAverage(); const foreign = [rec('epoch', undefined, {}, 'foreign', 'parent'), rec('start', 'a', {}, 'foreign', 'parent')];
 n.restore([...foreign, epoch, rec('start', 'x'), observation('x', 100, 1000), rec('start', 'y'), observation('y', 300, 1000, { model: 'other' })], 'own'); assert.equal(n.value, 200);
});
test('dedup identical entries and response keys; conflicting duplicate UNKNOWN', () => {
 const entries = [epoch, rec('start', 'a'), observation('a', 100, 1000)]; const n = new NativeAverage();
 n.restore([...entries, ...entries], 'own'); assert.equal(n.value, 100); assert.equal(n.observations, 1);
 n.restore([...entries, rec('start', 'b'), observation('b', 100, 1000, { responseHash: hash('a') })], 'own'); assert.equal(n.observations, 1); assert.equal(n.value, 100);
 n.restore([...entries, observation('a', 200, 1000)], 'own'); assert.equal(n.value, undefined);
 n.restore([...entries, rec('start', 'b'), observation('b', 200, 1000, { responseHash: hash('a') })], 'own'); assert.equal(n.value, undefined);
});
test('unknown/missing-start and sum overflow fail closed', () => {
 const n = new NativeAverage();
 for (const entries of [[epoch, rec('start', 'a'), rec('unknown', 'a')], [epoch, observation('a', 1, 1000)], [epoch, rec('start', 'a'), observation('a', Number.MAX_SAFE_INTEGER, 1000), rec('start', 'b'), observation('b', 1, 1000)], [epoch, rec('start', 'a'), observation('a', 1, Number.MAX_SAFE_INTEGER), rec('start', 'b'), observation('b', 1, 1000)]]) { n.restore(entries, 'own'); assert.equal(n.value, undefined); }
});
test('malformed ledger records cannot disappear through missing origin/epoch', () => {
 const n = new NativeAverage();
 for (const data of [undefined, { kind: 'start' }, { v: 1, metric: NATIVE_METRIC, origin: 'own', kind: 'start' }]) {
  const broken = { type: 'custom', customType: NATIVE_ENTRY, data }; n.restore([epoch, rec('start', 'a'), observation('a', 100, 1000), broken], 'own'); assert.equal(n.value, undefined);
  n.restore([epoch, broken, rec('epoch', undefined, {}, 'fresh')], 'own'); assert.equal(n.unknown, false);
 }
});
test('replayed epoch markers cannot reverse reset or hide corrupt coverage', () => {
 const n = new NativeAverage(); const first = [epoch, rec('start','a'), observation('a',100,1000)];
 const fresh = rec('epoch', undefined, {}, 'fresh');
 const second = [fresh, rec('start','b',{},'fresh'), {...observation('b',300,1000),data:{...observation('b',300,1000).data,epoch:'fresh'}}];
 n.restore([...first,...second,structuredClone(epoch)],'own'); assert.equal(n.epoch,'fresh'); assert.equal(n.value,300);
 const broken = {type:'custom',customType:NATIVE_ENTRY,data:{kind:'unknown'}};
 n.restore([...first,broken,structuredClone(epoch)],'own'); assert.equal(n.value,undefined); assert.equal(n.unknown,true);
});
test('new explicit epoch removes prior unknown, never revives old historical durations', () => {
 const n = new NativeAverage(); n.restore([epoch, rec('start', 'crash'), rec('epoch', undefined, {}, 'new')], 'own'); assert.equal(n.unknown, false); assert.equal(n.value, undefined); assert.equal(n.epoch, 'new');
});
test('no manager/temporary UI mock is UNKNOWN without throwing', () => { const l = new NativeLedger(); l.bind(undefined, () => {}); assert.equal(l.begin(), undefined); l.reset(); assert.equal(l.value, undefined); l.bind({ getEntries: () => [] }, () => {}); assert.equal(l.value, undefined); });
test('durable start then native end, pending token/time never enters old AVG', () => {
 const s = store(), l = new NativeLedger(); l.bind(s.manager, s.append); const first = l.begin(); l.end(first, { responseHash: hash('r'), provider: model.provider, api: model.api, model: 'test', nativeTokens: 100, elapsedMs: 1000 });
 const pending = l.begin(); assert.equal(l.value, 100); assert.equal(l.average.elapsedMs, 1000); l.end(pending); assert.equal(l.value, undefined);
});
test('append mutates memory then throws: stable key not retried/double billed', () => {
 const s = store(), l = new NativeLedger(); let calls = 0; l.bind(s.manager, (type, record) => { calls++; s.append(type, record); if (record.kind !== 'epoch') throw Error('disk failure'); });
 const op = l.begin(); l.end(op, { responseHash: hash('r'), provider: model.provider, api: model.api, model: 'test', nativeTokens: 100, elapsedMs: 1000 }); l.end(op);
 assert.equal(calls, 3); assert.equal(s.entries.filter(e => e.data.kind === 'start').length, 1); assert.equal(s.entries.filter(e => e.data.kind === 'unknown').length, 1); assert.equal(l.value, undefined);
});
test('privacy whitelist: records have no content/token IDs/payload/raw clocks', () => {
 const s = completedController(); const allowed = new Set(['v', 'metric', 'kind', 'origin', 'epoch', 'operation', 'responseHash', 'provider', 'api', 'model', 'nativeTokens', 'elapsedMs']);
 for (const entry of s.entries.filter(e => e.type === 'custom')) for (const k of Object.keys(entry.data)) assert.ok(allowed.has(k), k);
 assert.equal(JSON.stringify(s.entries.filter(e => e.type === 'custom')).includes(s.text), false);
});

// Controller commit boundaries, LAST fallback and reset isolation.
test('message_end freezes; commit final saved assistant, not early object', () => {
 const s = controller(); s.d.prepare(model, 0); const f = replay({ target: s.d.measurement }); s.d.end(f.message, 2800);
 assert.equal(s.d.ledger.value, undefined); assert.equal(s.d.heldRate, undefined);
 const replacement = { ...f.message, responseId: 'different' }; s.d.commitSaved(s.saved(replacement), s.manager);
 assert.equal(s.d.ledger.value, undefined); assert.equal(s.d.ledger.average.unknown, true); assert.equal(s.d.heldRate, undefined);
});
test('final replacement text invalidates LIVE only; valid native identity/usage survives', () => {
 const s = controller(); s.d.prepare(model, 0); const f = replay({ target: s.d.measurement }); s.d.end(f.message);
 s.d.commitSaved(s.saved({ ...f.message, content: [{ type: 'text', text: 'replacement' }] }), s.manager);
 assert.equal(s.d.heldRate, undefined); close(s.d.ledger.value, 140 / 2.7);
});
test('duplicate message/turn end cannot add duration/tokens or poison next op', () => {
 const s = completedController(); const value = s.d.ledger.value, total = s.d.ledger.average.nativeTokens;
 s.d.end(s.message); s.d.commitSaved(s.entryId, s.manager); assert.equal(s.d.ledger.average.nativeTokens, total);
 s.d.prepare(model, 10000); const f = replay({ target: s.d.measurement, request: 10000, times: [11000, 11500, 12000, 12500], terminal: 12700, id: 'next' }); s.d.end(f.message);
 s.d.commitSaved(s.entryId, s.manager); assert.equal(s.d.ledger.value, value); s.d.commitSaved(s.saved(f.message), s.manager); assert.equal(s.d.ledger.average.nativeTokens, 280);
});
test('exact adjacent hybrid format with one suffix and independent missing values', () => {
 const s = completedController(); assert.match(s.d.render('status', 999999), /^~\d+\.\d ~51\.9 TPS hit 90\.0% in 0 out 0$/);
 const empty = controller(); assert.equal(empty.d.render('status', 0), '- - TPS hit - in 0 out 0');
 const missing = completedController({ resolver: () => undefined }); assert.match(missing.d.render('widget', 999999), /^- ~51\.9 TPS/);
});
test('LAST stays idle and during new warmup, malformed current cannot poison it', () => {
 const s = completedController(); const held = s.d.heldRate; assert.equal(s.d.measurement.window.parts.size, 0);
 assert.equal(s.d.heldRate, s.d.measurement.current(999999)); s.d.prepare(model, 30000); assert.ok(s.d.render('status', 30000).startsWith(formatRate(held)));
 s.d.provider({ type: 'response.output_text.delta', delta: 123 }, 30001); assert.ok(s.d.render('status', 30001).startsWith(formatRate(held)));
 s.d.end(assistant()); s.d.closeUnknown(); assert.equal(s.d.heldRate, held);
});
test('native totals never change LIVE, and AVG never averages live checkpoints', () => {
 const low = completedController({ output: 1 }), high = completedController({ output: 1000000 }); close(low.d.heldRate, high.d.heldRate);
 assert.equal(low.d.ledger.average.nativeTokens, 1); assert.equal(high.d.ledger.average.nativeTokens, 1000000);
});
test('model change clears only LIVE, retains native AVG and frozen operation', () => {
 const s = completedController(); const avg = s.d.ledger.value; s.d.select({ ...model, id: 'different' }); assert.equal(s.d.heldRate, undefined); assert.equal(s.d.ledger.value, avg);
 s.d.select({ provider: 'other', api: 'other', id: 'other' }); assert.match(s.d.render('status', 10000), /^- - TPS/); s.d.select(model); assert.match(s.d.render('status', 10000), /^- ~51\.9 TPS/);
 s.d.prepare(model, 10000); const f = replay({ target: s.d.measurement, request: 10000, times: [11000], terminal: 12000, id: 'second' }); s.d.end(f.message);
 s.d.select({ ...model, id: 'different' }); s.d.commitSaved(s.saved(f.message), s.manager); assert.equal(s.d.ledger.average.nativeTokens, 280);
});
test('current-only reset preserves AVG/usage and excludes mixed prefix', () => {
 const s = completedController(); s.d.input.tokens = 1000; s.d.input.outputTokens = 100; const avg = s.d.ledger.value;
 s.d.reset(); assert.match(s.d.render('status', 10000), /^- ~51\.9 TPS.*in 1\.0k out 100$/); assert.equal(s.d.ledger.value, avg);
 s.d.prepare(model, 10000); s.d.reset(); const f = replay({ target: s.d.measurement, request: 10000, times: [11000], terminal: 12000, id: 'next' }); s.d.end(f.message); s.d.commitSaved(s.saved(f.message), s.manager);
 assert.equal(s.d.heldRate, undefined); assert.equal(s.d.ledger.average.nativeTokens, 280);
});
test('reset-avg starts durable new epoch, active operation cannot cross reset', () => {
 const s = completedController(); s.d.prepare(model, 10000); const oldEpoch = s.d.ledger.epoch; s.d.resetAverage();
 assert.notEqual(s.d.ledger.epoch, oldEpoch); assert.equal(s.d.ledger.value, undefined); assert.equal(s.d.ledger.average.unknown, false);
 s.d.end(assistant()); s.d.commitSaved(s.saved(assistant()), s.manager); assert.equal(s.d.ledger.average.observations, 0);
});
test('WS created before SDK message_start preserved', () => {
 const s = controller(); s.d.prepare(model, 0); const m = s.d.measurement; s.d.provider({ type: 'response.created', response: { id: 'r' } }, 100); s.d.start({ ...assistant(), responseId: undefined }); assert.equal(s.d.measurement, m);
});
test('direct message_start model/provider change cannot leak LAST', () => {
 const s = completedController(); s.d.start({ ...assistant('', 'new'), model: 'other' }); assert.equal(s.d.heldRate, undefined); assert.match(s.d.render('status', 10000), /^- ~51\.9 TPS/);
});
test('unexpected Codex virtual route without durable pre-request scope is UNKNOWN, not omitted', () => {
 const s = completedController(); s.d.prepare({ id: 'router', provider: 'virtual', api: 'virtual' }, 10000);
 s.d.provider({ type: 'response.created', response: { id: 'routed' } }, 10100, { provider: model.provider, api: model.api, model: model.id });
 s.d.provider({ type: 'response.completed', response: { id: 'routed', status: 'completed', usage: { output_tokens: 100 } } }, 11000, { provider: model.provider, api: model.api, model: model.id });
 s.d.end(assistant('', 'routed', 100)); s.d.commitSaved(s.saved(assistant('', 'routed', 100)), s.manager);
 assert.equal(s.d.ledger.average.unknown, true); assert.equal(s.d.ledger.value, undefined);
});
test('missing turn_end/shutdown closes durable UNKNOWN', () => {
 const s = controller(); s.d.prepare(model, 0); const f = replay({ target: s.d.measurement }); s.d.end(f.message); s.d.closeUnknown();
 assert.equal(s.d.ledger.average.unknown, true); assert.equal(s.d.ledger.value, undefined); assert.equal(s.entries.at(-1).data.kind, 'unknown');
});
test('new request detects unclosed previous operation rather than dropping it', () => {
 const s = controller(); s.d.prepare(model, 0); s.d.prepare(model, 1000); assert.equal(s.d.ledger.average.unknown, true);
});
test('resume measurement epoch restores sums, crash gap unknown, reset repairs', () => {
 const s = completedController(); const l = new NativeLedger(); l.bind(s.manager, s.append); close(l.value, 140 / 2.7);
 s.d.prepare(model, 10000); const reload = new NativeLedger(); reload.bind(s.manager, s.append); assert.equal(reload.value, undefined); assert.equal(reload.average.unknown, true); reload.reset(); assert.equal(reload.average.unknown, false);
});

// Preserve original native SessionInput accounting/integrity tests.
const input = new SessionInput();
const a = { role: 'assistant', provider: 'p', responseId: 'a', usage: { input: 100, cacheRead: 900, cacheWrite: 0, output: 229000 } };
const b = { role: 'assistant', provider: 'p', responseId: 'b', usage: { input: 200, cacheRead: 1700, cacheWrite: 100, output: 10 } };
test('native session in/out, cache hit and formatting preserved', () => { input.restore([{ type: 'message', message: a }, { type: 'compaction' }, { type: 'message', message: b }]); assert.equal(input.tokens, 3000); assert.equal(input.outputTokens, 229010); assert.equal(input.cacheHit, 85); assert.equal(input.fields(), 'hit 85.0% in 3.0k out 229.0k'); });
test('message object/response-ID and history entry-ID dedup', () => { input.add(a); input.add({ ...a }); assert.equal(input.tokens, 3000); input.restore([{ type: 'message', id: 'e', message: a }, { type: 'message', id: 'e', message: { ...a, responseId: undefined } }]); assert.equal(input.tokens, 1000); assert.match(input.fields(), /out 229k$/); });
test('all branches/precompaction plus auxiliary native usage included once in in/out only', () => { const u = { input: 10, cacheRead: 20, cacheWrite: 0, output: 5 }; input.restore([{ type: 'message', message: a }, { type: 'usage', id: 'warm', usage: u }, { type: 'usage', id: 'warm', usage: u }, { type: 'compaction', usage: u }, { type: 'branch_summary', usage: u }, { type: 'message', message: { role: 'toolResult', usage: u } }]); assert.equal(input.tokens, 1120); assert.equal(input.outputTokens, 229020); assert.equal(input.cacheHit, 90); });
test('missing output not fabricated zero; invalid usage does not poison seen-ID', () => { input.restore([]); input.add({ ...a, usage: { input: 100, cacheRead: 900, cacheWrite: 0 } }); assert.equal(input.tokens, 0); input.add({ ...a, usage: { input: NaN, cacheRead: 900, cacheWrite: 0, output: 229000 } }); input.add(a); assert.equal(input.tokens, 1000); });
test('input overflow fails closed, invalid latest clears hit', () => { input.restore([]); input.tokens = Number.MAX_SAFE_INTEGER; input.add(a); assert.equal(input.outputTokens, 0); input.restore([{ type: 'message', message: a }, { type: 'message', message: { role: 'assistant', usage: { input: -1 } } }]); assert.equal(input.cacheHit, undefined); assert.equal(input.tokens, 1000); });
test('rate formatting admits zero/slow/fast but rejects malformed', () => { for (const n of [NaN, Infinity, -1]) assert.equal(formatRate(n), '-'); assert.equal(formatRate(0), '~0.0'); assert.equal(formatRate(0.01), '~0.0'); assert.equal(formatRate(222919.7), '~222919.7'); assert.match(input.fields(120), /^hit - /); });

// Deterministic fuzz checks mathematical oracle, not merely "undefined is OK".
test('600 synthetic monotonic schedules match exact checkpoint ratio', () => {
 let seed = 17, measured = 0; const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
 for (let run = 0; run < 600; run++) {
  const w = numeric(); let t = 0; for (let i = 0; i < 30; i++) {
   t += 200 + rnd() * 800; point(w, t, 'x'.repeat(Math.floor(rnd() * 200)));
   if (w.estimatedCurrent !== undefined) { const base = w.samples[0]; close(w.estimatedCurrent, (w.tokens - base.tokens) * 1000 / (t - base.t)); measured++; }
  }
 }
 assert.ok(measured > 10000);
});

// 50k-character callback-flood benchmark. Report actual elapsed wall time and
// encode calls; there is no artificial delay inside a metrics callback.
let encodeCalls = 0;
const bench = new OutputWindow(() => text => { encodeCalls++; return oracle(text); });
const began = performance.now();
for (let i = 0; i < 50000; i++) { bench.append('p', 'a b c '[i % 6]); bench.checkpoint(i / 10); }
bench.checkpoint(5000, true);
const benchMs = performance.now() - began;
test('50k stream checkpoint work bounded, full-prefix result correct', () => { assert.ok(encodeCalls <= 27, String(encodeCalls)); assert.equal(bench.tokens, oracle(bench.parts.get('p').text)); assert.ok(bench.samples.length <= 17); });
console.log(`BENCH: 50,000 UTF16 units / 50,000 callbacks, ${encodeCalls} full-prefix encodes, ${benchMs.toFixed(1)}ms offline wall time`);

// Actual installed Pi loader and SessionManager, in memory only. Explicit
// synthetic clock drives integration fixtures, not a parser/delivery claim.
const globalRoot = spawnSync('npm',['root','-g'],{encoding:'utf8'}); assert.equal(globalRoot.status,0);
const piRoot = process.env.PI_CLI_ROOT ?? join(globalRoot.stdout.trim(), '@earendil-works/pi-coding-agent');
const { loadExtensions } = await import(pathToFileURL(join(piRoot, 'dist/core/extensions/loader.js')).href);
const { SessionManager } = await import(pathToFileURL(join(piRoot, 'dist/core/session-manager.js')).href);
const temp = mkdtempSync(join(tmpdir(), 'hybrid-tps-unit-'));
const savedFetch = globalThis.fetch; globalThis.fetch = () => { throw Error('Network disabled'); };
try {
 const bridge = join(temp, 'bridge.ts');
 const extensionSource = process.env.THROUGHPUT_SOURCE ?? resolve(dirname(fileURLToPath(import.meta.url)), '../patches/pi-live-throughput/index.ts');
 writeFileSync(bridge, `import {createThroughputExtension} from ${JSON.stringify(extensionSource)}; export default function(pi){globalThis.__hybridController=createThroughputExtension(pi,{clock:()=>globalThis.__hybridClock});}`);
 const loaded = await loadExtensions([bridge], temp); assert.deepEqual(loaded.errors, []); const ext = loaded.extensions[0], d = globalThis.__hybridController;
 let manager = SessionManager.inMemory(temp), line = ''; const status = new Map();
 loaded.runtime.appendEntry = (type, data) => manager.appendCustomEntry(type, data);
 const ctx = { hasUI: true, model, sessionManager: manager, ui: { setStatus: (key, text) => { if (text) { line = text; status.set(key, text); } else status.delete(key); }, setWidget: (_key, lines) => { if (lines) line = lines.join(' '); }, notify: () => {} } };
 const emit = async (type, event = {}, at = globalThis.__hybridClock) => { globalThis.__hybridClock = at; for (const handler of ext.handlers.get(type) ?? []) await handler({ type, ...event }, ctx); };
 const raw = async (data, at) => emit('provider_stream_event', { api: model.api, provider: model.provider, model: model.id, data }, at);
 globalThis.__hybridClock = 0; await emit('session_start');
 test('real loader initial epoch/missing hybrid format', () => { assert.equal(line, '- - TPS hit - in 0 out 0'); assert.equal(manager.getEntries().filter(e => e.customType === NATIVE_ENTRY).length, 1); });
 await emit('before_provider_request', {}, 0); await raw({ type: 'response.created', sequence_number: 0, response: { id: 'r' } }, 100); await emit('message_start', { message: { ...assistant(), responseId: undefined } }, 100);
 await raw({ type: 'response.output_item.added', sequence_number: 1, item: { id: 'm', type: 'message' } }, 200);
 let text = ''; let seq = 2; for (let i = 0; i < 4; i++) { const delta = `word${i} alpha `; text += delta; await raw({ type: 'response.output_text.delta', sequence_number: seq++, item_id: 'm', content_index: 0, delta }, 1000 + i * 500); }
 await raw({ type: 'response.output_text.done', sequence_number: seq++, item_id: 'm', content_index: 0, text }, 2501);
 await raw({ type: 'response.output_item.done', sequence_number: seq++, item: { id: 'm', type: 'message', content: [{ type: 'output_text', text }] } }, 2502);
 await raw({ type: 'response.completed', sequence_number: seq++, response: { id: 'r', status: 'completed', usage: { output_tokens: 140 } } }, 2700);
 const final = assistant(text); await emit('message_end', { message: final }, 2800);
 test('real extension freezes before saved assistant and keeps AVG uncommitted', () => assert.equal(d.ledger.value, undefined));
 // Model the replacement-handler boundary: only persisted final object counts.
 const entryId = manager.appendMessage(final); await emit('turn_end', { messageEntryId: entryId }, 3000);
 test('real saved assistant/SessionManager commit counts native exactly once', () => { close(d.ledger.value, 140 / 2.7); assert.match(line, /^~\d+\.\d ~51\.9 TPS.*in 1\.0k out 140$/); });
 await emit('turn_end', { messageEntryId: entryId }, 3100); test('real turn duplicate idempotent', () => assert.equal(d.ledger.average.nativeTokens, 140));
 const command = ext.commands.get('throughput'); await command.handler('reset', ctx); test('real reset preserves native AVG and session usage', () => assert.match(line, /^- ~51\.9 TPS.*in 1\.0k out 140$/));
 await command.handler('widget', ctx); await command.handler('off', ctx); test('off/status widget behavior preserved', () => assert.equal(status.has('throughput'), false)); await command.handler('status', ctx);
 await emit('before_provider_request', {}, 4000); test('real pending AVG does not dilute old totals', () => close(d.ledger.value, 140 / 2.7));
 await emit('agent_before_settle', {}, 4500); test('abort path without turn_end writes unknown', () => { assert.equal(d.ledger.value, undefined); assert.equal(manager.getEntries().at(-1).data.kind, 'unknown'); });
 await command.handler('reset-avg', ctx); test('reset-avg durable epoch, unknown cleared without usage loss', () => { assert.equal(d.ledger.average.unknown, false); assert.match(line, /^- - TPS.*in 1\.0k out 140$/); });
 await emit('session_shutdown', {}, 5000);
 // Reload the same in-memory SessionManager; no timestamp fabrication.
 await emit('session_start', {}, 6000); test('reload epoch/usage retained', () => { assert.equal(d.ledger.average.unknown, false); assert.equal(d.input.outputTokens, 140); });
 await emit('session_shutdown', {}, 6000);
 const parentOrigin = manager.getSessionId(); manager.createBranchedSession(entryId);
 test('real in-memory fork changes own session identity', () => assert.notEqual(manager.getSessionId(), parentOrigin));
 await emit('session_start', {}, 6500);
 test('real fork-at-assistant excludes inherited parent starts and native ledger', () => { assert.equal(d.ledger.average.unknown, false); assert.equal(d.ledger.average.observations, 0); assert.equal(d.input.outputTokens, 140); });
 await command.handler('reset-all', ctx); test('reset-all writes epoch and preserves usage', () => { assert.equal(d.ledger.average.unknown, false); assert.equal(d.input.outputTokens, 140); assert.equal(manager.getEntries().at(-1).data.kind, 'epoch'); });
 await emit('session_shutdown', {}, 6500);
 // Temporary UI lacking durable runtime still works and says unknown.
 ctx.sessionManager = { getEntries: () => [] }; await emit('session_start', {}, 7000); test('real no-session-ID UI mock is graceful unknown', () => assert.match(line, /^- - TPS/)); await emit('session_shutdown', {}, 7000);
} finally {
 globalThis.fetch = savedFetch; delete globalThis.__hybridController; delete globalThis.__hybridClock; rmSync(temp, { recursive: true, force: true });
}
console.log(`PASS: ${checks} offline hybrid/reference/native-ledger/controller/real-loader checks + 600 mathematical schedule replays; zero inference`);

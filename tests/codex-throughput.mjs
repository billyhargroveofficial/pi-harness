// Offline native Codex replay. No credentials, fetch, inference, or private text.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CodexMeasurement, CodexThroughput, OutputWindow, OutputTotals, SessionInput } from '../patches/pi-live-throughput/codex-throughput.ts';

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const assistant = (text) => ({ role: 'assistant', api: 'openai-codex-responses', provider: 'openai-codex', model: 'test', stopReason: 'stop', content: [{ type: 'text', text }] });
function fixture({ deltaTimes = [10000, 11000, 12000], terminalAt = 20000, output = 140, reasoning = 128 } = {}) {
  const m = new CodexMeasurement('test'); m.requestTime = 0;
  let sequence = 0;
  const emit = (type, data, t) => m.provider({ type, sequence_number: sequence++, ...data }, t);
  emit('response.created', { response: { id: 'r' } }, 100);
  emit('response.output_item.added', { item: { id: 'reason', type: 'reasoning' } }, 150);
  emit('response.reasoning_summary_text.delta', { item_id: 'reason', delta: 'hidden summary is never visible output' }, 5000);
  emit('response.output_item.done', { item: { id: 'reason', type: 'reasoning' } }, 9000);
  emit('response.output_item.added', { item: { id: 'm', type: 'message' } }, 9500);
  let text = '';
  for (const t of deltaTimes) { text += 'abcd'; emit('response.output_text.delta', { item_id: 'm', content_index: 0, delta: 'abcd' }, t); }
  emit('response.output_text.done', { item_id: 'm', content_index: 0, text }, deltaTimes.at(-1));
  emit('response.output_item.done', { item: { id: 'm', type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] } }, deltaTimes.at(-1) + 100);
  emit('response.completed', { response: { id: 'r', status: 'completed', usage: { input_tokens: 100000, input_tokens_details: { cached_tokens: 0 }, output_tokens: output, output_tokens_details: { reasoning_tokens: reasoning } } } }, terminalAt);
  return { m, text };
}

const f = fixture();
assert.equal(f.m.finish(assistant(f.text)), true);
assert.equal(f.m.nativeTokens, 12, 'hidden reasoning subtracted');
assert.equal(f.m.window.spanMs, 2000, 'first-to-last delta, no TTFT or terminal tail');
assert.equal(f.m.window.first - f.m.requestTime, 10000, 'reasoning summary does not start visible TTFT');
assert.equal(f.m.nativeTokens / (f.m.window.spanMs / 1000), 6);
assert.equal(f.m.fullMs, 20000);
const slowTail = fixture({ terminalAt: 900000 });
assert.equal(slowTail.m.nativeTokens / slowTail.m.window.spanMs, f.m.nativeTokens / f.m.window.spanMs);
assert.equal(slowTail.m.window.estimatedCurrent, f.m.window.estimatedCurrent, 'terminal usage never becomes an output burst');
const oneRead = fixture({ deltaTimes: [10000, 10000, 10000] });
assert.equal(oneRead.m.finish(assistant(oneRead.text)), false, 'one coalesced timestamp has no measurable span');
assert.equal(oneRead.m.window.estimatedCurrent, undefined);
const missingReasoning = fixture({ reasoning: undefined });
// Remove the actual native reasoning count (default args would restore it).
missingReasoning.m.nativeTokens = undefined;
assert.equal(missingReasoning.m.finish(assistant(missingReasoning.text)), false);
const wrongId = fixture(); wrongId.m.provider({ type: 'response.in_progress', response_id: 'other' }, 21000);
assert.equal(wrongId.m.finish(assistant(wrongId.text)), false);
const wrongSequence = fixture(); wrongSequence.m.provider({ type: 'response.in_progress', sequence_number: 0 }, 21000);
assert.equal(wrongSequence.m.finish(assistant(wrongSequence.text)), false);
assert.equal(f.m.finish(assistant(f.text + 'lost delta')), false);
assert.equal(f.m.finish({ ...assistant(f.text), stopReason: 'aborted' }), false);

const w = new OutputWindow();
w.add(0, 40); w.add(1000, 40);
assert.equal(w.estimatedCurrent, 10);
assert.equal(w.estimatedCurrent, 10, 'idle rendering does not age window into zero');
w.add(11000, 40);
assert.equal(w.estimatedCurrent, 1, 'a real 10s pause within output counts on resumption');
const pools = new OutputTotals();
pools.add('a', 10, 1000); pools.add('a', 180, 3000); pools.add('b', 90, 1000);
assert.equal(pools.average('a'), 47.5, 'token/time weighted, not arithmetic mean of per-call TPS');
assert.equal(pools.average('b'), 90, 'different models do not mix');

const display = new CodexThroughput();
display.prepare({ id: 'test', api: 'openai-codex-responses', provider: 'openai-codex' }, 0);
display.provider({ type: 'response.created', response: { id: 'r' } }, 100);
const prepared = display.measurement;
display.start(assistant(''));
assert.equal(display.measurement, prepared, 'WS raw created before message_start is preserved');
display.measurement = f.m;
display.end(assistant(f.text));
assert.equal(display.totals.average('test'), 6);
const finalLine = display.render('status');
assert.match(finalLine, /momentum ~[\d.]+ TPS ● cumulative 6.0 TPS/);
display.prepare({ id: 'test', api: 'openai-codex-responses', provider: 'openai-codex' }, 30000);
assert.match(display.render('status'), /momentum ~[\d.]+ TPS ● cumulative 6.0 TPS/);
assert.doesNotMatch(display.render('status'), /momentum (?:~)?0(?:\.0)? /, 'next response waiting retains current');
display.reset();
assert.equal(display.totals.average('test'), undefined);
assert.equal(display.measurement.requestTime, 30000, 'reset does not invent suffix native usage');
display.sessionReset(); assert.equal(display.render('status'), undefined);

// Session input includes cached tokens and all stored branches, including
// pre-compaction entries. Usage is restored after reload; text is never read.
const sessionInput = new SessionInput();
const a = { role: 'assistant', responseId: 'old-a', usage: { input: 100, cacheRead: 900, cacheWrite: 0 } };
const b = { role: 'assistant', responseId: 'old-b', usage: { input: 200, cacheRead: 1700, cacheWrite: 100 } };
const entries = [{ type: 'message', message: a }, { type: 'compaction', summary: 'not read' }, { type: 'message', message: b }];
sessionInput.restore(entries);
assert.equal(sessionInput.tokens, 3000);
assert.equal(sessionInput.cacheHit, 85);
sessionInput.add(a); assert.equal(sessionInput.tokens, 3000, 'same object not counted twice');
sessionInput.add({ ...a }); assert.equal(sessionInput.tokens, 3000, 'same response ID not counted twice');
const c = { role: 'assistant', responseId: 'new-c', usage: { input: 260, cacheRead: 18176, cacheWrite: 0 } };
sessionInput.add(c);
assert.equal(sessionInput.tokens, 21436, 'sum of requests, not current context');
assert.match(sessionInput.fields(), /cache hit 98.6% ● session input 21.4k/);
sessionInput.restore([...entries, { type: 'message', message: c }]);
assert.equal(sessionInput.tokens, 21436, 'reload/compaction does not reset total');
sessionInput.restore([]); assert.equal(sessionInput.tokens, 0, 'new session is independent');

// Raw native function arguments use the same non-reasoning delivery metric;
// execution results are never in this response's window.
const tool = new CodexMeasurement('tool'); tool.requestTime = 0;
tool.provider({ type: 'response.created', response: { id: 'r' } }, 100);
tool.provider({ type: 'response.output_item.added', item: { type: 'function_call', id: 'f' } }, 200);
tool.provider({ type: 'response.function_call_arguments.delta', item_id: 'f', delta: '{"x":' }, 1000);
tool.provider({ type: 'response.function_call_arguments.delta', item_id: 'f', delta: '42}' }, 2000);
tool.provider({ type: 'response.output_item.done', item: { type: 'function_call', id: 'f', arguments: '{"x":42}' } }, 2050);
tool.provider({ type: 'response.completed', response: { id: 'r', status: 'completed', usage: { output_tokens: 55, output_tokens_details: { reasoning_tokens: 50 } } } }, 2100);
assert.equal(tool.finish({ stopReason: 'toolUse', content: [{ type: 'toolCall', name: 'f', arguments: { x: 42 } }] }), true);
assert.equal(tool.nativeTokens, 5);

// Replay optional saved benchmark directories using only sanitized event
// lengths/times, synthetic generated code and native usage. No raw logs needed.
let replayed = 0;
for (const base of process.argv.slice(2)) {
  const path = resolve(base);
  const s = JSON.parse(readFileSync(resolve(path, 'summary.json'), 'utf8'));
  const events = JSON.parse(readFileSync(resolve(path, 'events.json'), 'utf8'));
  const text = readFileSync(resolve(path, 'generated.ts'), 'utf8');
  const m = new CodexMeasurement(s.model_requested); m.requestTime = 0;
  const parts = new Map(); let cursor = 0;
  for (const e of events) {
    const d = { type: e.type, sequence_number: e.sequence_number ?? undefined };
    if (e.response_id_sha256) d.response_id = e.response_id_sha256;
    if (e.item_id_sha256) d.item_id = e.item_id_sha256;
    if (e.content_index !== null) d.content_index = e.content_index;
    if (e.type === 'response.created') d.response = { id: e.response_id_sha256 };
    if (e.type === 'response.output_item.added') d.item = { id: e.item_id_sha256, type: e.item_type };
    if (e.type === 'response.output_text.delta') {
      d.delta = text.slice(cursor, cursor + e.delta_utf16_chars); cursor += e.delta_utf16_chars;
      const key = `${d.item_id}:${d.content_index}`; parts.set(key, (parts.get(key) ?? '') + d.delta);
    }
    if (e.type === 'response.output_text.done') d.text = parts.get(`${d.item_id}:${d.content_index}`);
    if (e.type === 'response.output_item.done') {
      d.item = { id: e.item_id_sha256, type: e.item_type };
      if (e.item_type === 'message') d.item.content = [{ type: 'output_text', text: parts.get(`${d.item_id}:0`) }];
    }
    if (['response.completed', 'response.done'].includes(e.type)) d.response = { id: e.response_id_sha256, status: 'completed', usage: s.native_usage };
    m.provider(d, Number(BigInt(e.receive_ns)) / 1e6);
  }
  assert.equal(cursor, text.length);
  assert.equal(m.finish(assistant(text)), true, path);
  assert.ok(Math.abs(m.nativeTokens / (m.window.spanMs / 1000) - s.native_nonreasoning_over_visible_span_tps) < 1e-9);
  replayed++;
}
console.log(`PASS: reasoning subtraction, first/last delta, held current, weighted/model means, IDs/text/sequence/errors, WS ordering, tools; ${replayed} saved streams replayed`);

// Offline renderer tests. Requires an installed pi; does not start a model or terminal.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';

const root = process.env.PI_PACKAGE_ROOT ?? join(
  execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim(),
  '@earendil-works/pi-coding-agent',
);
const requirePi = createRequire(join(root, 'package.json'));
const { createJiti } = await import(pathToFileURL(requirePi.resolve('jiti')));
const jiti = createJiti(import.meta.url, { alias: {
  '@earendil-works/pi-coding-agent': join(root, 'dist/index.js'),
  '@earendil-works/pi-tui': requirePi.resolve('@earendil-works/pi-tui'),
} });
const host = await jiti.import('@earendil-works/pi-coding-agent');
const tui = await jiti.import('@earendil-works/pi-tui');
host.initTheme('dark');
const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const install = (await jiti.import(join(repo, 'agent/extensions/zzzz-compact-tools.ts'))).default;
const commands = new Map();
const api = { registerCommand: (name, def) => commands.set(name, def), on() {} };
install(api);
const ui = { requestRender() {} };
const secret = 'OUTPUT_SHOULD_BE_HIDDEN';
const result = { content: [{ type: 'text', text: secret }], isError: false };
const make = (name, args, def) => new host.ToolExecutionComponent(name, name, args, {}, def, ui, homedir());
let dot = '●';
const call = make('bash', { command: 'echo hello' }, {
  renderShell: 'self',
  renderCall: () => new tui.Text(`${dot} Bash(echo\nhello)`, 0, 0),
  renderResult: () => new tui.Text(`${secret}\nmore output`, 0, 0),
});
call.updateResult(result);
function assertCompact(component) {
  for (const width of [1, 2, 10, 30, 80, 200]) {
    const rows = component.render(width);
    assert.equal(rows.length, 1);
    assert.ok(tui.visibleWidth(rows[0]) <= width);
    assert.ok(!rows[0].includes(secret));
  }
}
assertCompact(call);
assert.ok(call.render(80)[0].includes('echo hello'));
const on = call.render(80)[0];
dot = ' '; call.invalidate();
const off = call.render(80)[0];
assert.equal(on.indexOf('Bash'), off.indexOf('Bash'), 'blink must not shift text');
assert.equal(tui.visibleWidth(on), tui.visibleWidth(off));
assert.ok(off.startsWith('  Bash'));
call.setExpanded(true);
assert.ok(call.render(80).join('\n').includes(secret));
call.setExpanded(false);
assertCompact(call);
assert.deepEqual(call.handleMouse({ y: 0, type: 'click', button: 'left' }), { handled: true });
assert.ok(call.render(80).join('\n').includes(secret));
call.setExpanded(false);
call.updateResult({ ...result, isError: true });
assert.ok(call.render(80)[0].endsWith('✗'));
const hidden = make('read', {}, {
  renderShell: 'self', renderCall: () => new tui.Text('', 0, 0),
  renderResult: () => new tui.Text('', 0, 0),
});
assert.deepEqual(hidden.render(80), []);
const fallback = make('mcp', { tool: 'some_tool', command: 'one\ntwo' }, undefined);
fallback.updateResult(result);
assertCompact(fallback);
const ctx = { ui: { notify() {} } };
await commands.get('compact-tools').handler('off', ctx);
assert.ok(call.render(80).join('\n').includes(secret));
await commands.get('compact-tools').handler('on', ctx);
assertCompact(call);
install(api);
assertCompact(call);
console.log('PASS: one row, hidden output, widths 1–200, expanded output, mouse, errors, groups, MCP fallback, command, reload, stable blink');

// Grouping is derived from actual sibling components, including restored sessions.
const msg = (text = '') => new host.AssistantMessageComponent({
  role: 'assistant', content: [
    ...(text ? [{ type: 'text', text }] : []),
    { type: 'toolCall', name: 'read', id: 'placeholder', arguments: {} },
  ], stopReason: 'toolUse',
}, true);
const readCall = (index, path = `/tmp/file-${index}.txt`) => {
  const component = new host.ToolExecutionComponent('read', `r${index}`, { path }, {}, {
    renderShell: 'self',
    renderCall: () => new tui.Text(`● Read(${path})`, 0, 0),
    renderResult: () => new tui.Text(secret, 0, 0),
  }, ui, homedir());
  component.updateResult(result);
  return component;
};
const transcript = new tui.Container();
transcript.addChild(msg('Промежуточный комментарий.'));
const reads = Array.from({ length: 5 }, (_, i) => readCall(i));
for (const [index, component] of reads.entries()) {
  transcript.addChild(component);
  if (index === 1) transcript.addChild(msg()); // invisible thinking/tool-only message
}
const originalChildren = [...transcript.children];
const grouped = transcript.render(100);
const headerIndex = grouped.findIndex(line => line.includes('Read(5 calls · tail 3)'));
assert.ok(headerIndex > 0);
assert.equal(grouped[headerIndex - 1], '', 'one blank line after commentary');
assert.ok(grouped[headerIndex - 2].includes('Промежуточный'));
assert.equal(grouped.filter(line => line.includes('Read(')).length, 1);
assert.equal(grouped.filter(line => line.includes('→')).length, 3);
assert.match(grouped.join('\n'), /⎿ → \/tmp\/file-2/);
assert.ok(!grouped.join('\n').includes('/tmp/file-0'));
assert.ok(!grouped.join('\n').includes(secret));
assert.deepEqual(transcript.children, originalChildren, 'render must not mutate the transcript tree');
for (const width of [1, 2, 10, 30, 80, 200]) {
  assert.ok(transcript.render(width).every(line => tui.visibleWidth(line) <= width));
}
reads[0].updateResult({ ...result, isError: true });
assert.match(transcript.render(100).join('\n'), /✗1/, 'errors outside the tail remain visible in the header');
const sixth = readCall(5, '/tmp/новый-🦊.txt'); transcript.addChild(sixth);
const next = transcript.render(100).join('\n');
assert.match(next, /Read\(6 calls · tail 3\)/);
assert.match(next, /новый-🦊/); assert.ok(!next.includes('file-2'));
const clickRows = transcript.render(100);
const y = clickRows.findIndex(line => line.includes('Read(6'));
assert.equal(transcript.handleMouse({ x: 0, y, originX: 0, originY: 0, width: 100, height: clickRows.length, type: 'click', button: 'left' }).handled, true);
assert.ok(transcript.render(100).join('\n').includes(secret), 'click expands the normal output');
for (const component of [...reads, sixth]) component.setExpanded(false);
assert.match(transcript.render(100).join('\n'), /tail 3/);
const spacerRows = new tui.Container();
spacerRows.addChild(msg('Комментарий.')); spacerRows.addChild(new tui.Spacer(1)); spacerRows.addChild(readCall(8));
const spaced = spacerRows.render(100);
const spacedHeader = spaced.findIndex(line => line.includes('Read('));
assert.equal(spaced[spacedHeader - 1], '');
assert.ok(spaced[spacedHeader - 2].trim(), 'do not double an existing spacer');
const broken = new tui.Container();
broken.addChild(readCall(10)); broken.addChild(readCall(11)); broken.addChild(msg('Разделитель.')); broken.addChild(readCall(12));
assert.equal(broken.render(100).filter(line => line.includes('Read(')).length, 2, 'visible commentary breaks aggregation');
const mixed = new tui.Container();
mixed.addChild(readCall(20)); mixed.addChild(make('bash', { command: 'echo middle' }, undefined)); mixed.addChild(readCall(21));
assert.equal(mixed.render(100).filter(line => line.includes('Read(')).length, 2, 'different tools break aggregation');
await commands.get('compact-tools').handler('off', ctx);
assert.ok(transcript.render(100).join('\n').includes(secret));
await commands.get('compact-tools').handler('on', ctx);
install(api); assert.match(transcript.render(100).join('\n'), /Read\(6 calls/, 'reload does not stack wrappers');
console.log('PASS: commentary spacer, sibling/replay groups, last-three tail, hidden assistant, mixed/visible boundaries, error count, narrow/wide Unicode, mouse expansion, off/on/reload');

const agentDir = process.env.PI_AGENT_DIR ?? join(homedir(), '.pi/agent');
const builtinsPath = join(agentDir, 'npm/node_modules/better-claude-code-ui/extension/tools/builtins.ts');
if (existsSync(builtinsPath)) {
  const { registerBuiltins } = await jiti.import(builtinsPath);
  const defs = new Map();
  registerBuiltins({ registerTool: (def) => defs.set(def.name, def), on() {} });
  for (const [name, args] of [
    ['bash', { command: 'python3 - <<EOF\nprint("hello")\nEOF' }],
    ['read', { path: '/tmp/compact-test.txt' }],
    ['write', { path: '/tmp/compact-test.txt', content: 'secret' }],
  ]) {
    const component = make(name, args, defs.get(name));
    component.markExecutionStarted();
    component.updateResult(result);
    assertCompact(component);
    component.setExpanded(true);
    assert.ok(component.render(80).length > 1);
    console.log(`PASS: actual better-claude-code-ui renderer: ${name}`);
  }
  const { registerGrouping, isGroupingEnabled } = await jiti.import(join(agentDir, 'npm/node_modules/better-claude-code-ui/extension/tools/grouping.ts'));
  const handlers = new Map();
  registerGrouping({ on(name, handler) { handlers.set(name, handler); } });
  await handlers.get('session_start')({}); await handlers.get('agent_start')({});
  try {
    const native = new tui.Container();
    native.addChild(msg('Native renderer.'));
    const nativeTools = [];
    for (const [index, name] of ['read', 'read', 'ls'].entries()) {
      const args = { path: `/tmp/native-${index}` };
      const id = `native-${index}`;
      const component = new host.ToolExecutionComponent(name, id, args, {}, defs.get(name), ui, homedir());
      await handlers.get('tool_execution_start')({ toolName: name, toolCallId: id, args });
      component.markExecutionStarted(); component.updateResult(result);
      await handlers.get('tool_execution_end')({ toolName: name, toolCallId: id, result, isError: false });
      native.addChild(component); nativeTools.push(component);
    }
    // ls is missing from the earlier tiny definition allowlist; it still proves
    // the cross-tool boundary against npm's mixed read/list collapsing.
    for (const component of nativeTools) component.invalidate();
    if (isGroupingEnabled()) assert.deepEqual(nativeTools[1].render(100), [], 'fixture must exercise a native hidden member');
    const text = native.render(100).join('\n');
    assert.match(text, /Read\(2 calls\)/);
    assert.match(text, /native-0/); assert.match(text, /native-1/); assert.match(text, /List\(/);
    const click = native.render(100); const yy = click.findIndex(line => line.includes('Read(2'));
    native.handleMouse({ x: 0, y: yy, originX: 0, originY: 0, width: 100, height: click.length, type: 'click', button: 'left' });
    assert.ok(nativeTools.every(component => component.expanded), 'click expands native mixed tool block together');
    console.log('PASS: actual native hidden members, mixed read/list group, no lost calls, compatible click expansion');
  } finally { await handlers.get('session_shutdown')({}); }
} else {
  console.log('SKIP: actual better-claude-code-ui renderer tests (package not installed)');
}

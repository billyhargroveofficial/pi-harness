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
if (process.env.COMPACT_LEGACY_FIXTURE) {
  (await jiti.import(process.env.COMPACT_LEGACY_FIXTURE)).default(api);
}
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

// No additional grouping: repeated tools stay individual, spacing stays visible.
const msg = text => new host.AssistantMessageComponent({
  role: 'assistant', content: [{ type: 'text', text }, { type: 'toolCall', id: 'call', name: 'read', arguments: {} }], stopReason: 'toolUse',
}, true);
const transcript = new tui.Container();
const assistant = msg('Промежуточный комментарий.');
transcript.addChild(assistant);
const reads = Array.from({ length: 5 }, (_, i) => {
  const path = `/tmp/file-${i}.txt`;
  const component = make('read', { path }, { renderShell: 'self', renderCall: () => new tui.Text(`● Read(${path})`, 0, 0), renderResult: () => new tui.Text(secret, 0, 0) });
  component.updateResult(result); transcript.addChild(component); return component;
});
const savedChildren = [...transcript.children];
const rows = transcript.render(100);
const firstTool = rows.findIndex(line => line.includes('Read('));
assert.equal(rows[firstTool - 1], ''); assert.ok(rows[firstTool - 2].includes('Промежуточный'));
assert.equal(rows.filter(line => line.includes('Read(')).length, 5);
for (let i = 0; i < 5; i++) assert.ok(rows.join('\n').includes(`file-${i}`));
assert.ok(!rows.join('\n').includes('tail 3'));
assert.ok(!rows.join('\n').includes(secret));
assert.deepEqual(transcript.children, savedChildren);
for (const width of [1, 2, 10, 30, 80, 200]) assert.ok(transcript.render(width).every(line => tui.visibleWidth(line) <= width));
const user = new host.UserMessageComponent('Юзер.');
user.render = () => ['Юзер.']; // template with no built-in padding
const userTranscript = new tui.Container(); userTranscript.addChild(user); userTranscript.addChild(reads[0]);
assert.equal(userTranscript.render(100)[1], '', 'separator after a user message');
const userAssistant = new tui.Container(); userAssistant.addChild(user); userAssistant.addChild(new tui.Text('Ответ.', 0, 0));
assert.deepEqual(userAssistant.render(100).map(line => line.trimEnd()), ['Юзер.', '', 'Ответ.']);
const existing = new tui.Container(); existing.addChild(user); existing.addChild(new tui.Spacer(1)); existing.addChild(reads[1]);
assert.equal(existing.render(100).length, 3, 'do not double an existing spacer');
const clicked = transcript.render(100);
const clickY = clicked.findIndex(line => line.includes('Read('));
assert.equal(transcript.handleMouse({ x: 0, y: clickY, originX: 0, originY: 0, width: 100, height: clicked.length, type: 'click', button: 'left' }).handled, true);
assert.ok(transcript.render(100).join('\n').includes(secret));
assert.ok(reads.slice(1).every(component => !component.expanded), 'only the clicked tool expands');
reads[0].setExpanded(false);
await commands.get('compact-tools').handler('off', ctx);
assert.deepEqual(userAssistant.render(100).map(line => line.trimEnd()), ['Юзер.', '', 'Ответ.'], 'spacing is independent of output expansion');
assert.ok(transcript.render(100).join('\n').includes(secret));
await commands.get('compact-tools').handler('on', ctx);
install(api);
assert.equal(transcript.render(100).filter(line => line.includes('Read(')).length, 5);
console.log('PASS: individual repeated tools, assistant/user separators, no duplicate padding, mouse offsets, off/on/reload, narrow widths');

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
} else {
  console.log('SKIP: actual better-claude-code-ui renderer tests (package not installed)');
}

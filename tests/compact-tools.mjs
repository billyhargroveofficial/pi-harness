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
const api = { registerCommand: (name, def) => commands.set(name, def) };
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

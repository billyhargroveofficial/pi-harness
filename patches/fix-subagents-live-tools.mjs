#!/usr/bin/env node
/** Reversible, context-checked upstream overlay; never replace the npm package. */
import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const targetArg = args.find(arg => arg.startsWith('--target='));
const agentDir = process.env.PI_CODING_AGENT_DIR ?? process.env.PI_AGENT_DIR ?? join(homedir(), '.pi/agent');
const target = resolve(targetArg?.slice('--target='.length) ?? join(agentDir, 'npm/node_modules/@tintinweb/pi-subagents'));
const patch = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fix-subagents-live-tools.patch'), 'utf8');
const manifest = join(target, 'package.json');
if (!existsSync(manifest)) throw new Error(`Package not installed: ${target}`);
const { name, version } = JSON.parse(readFileSync(manifest, 'utf8'));
if (name !== '@tintinweb/pi-subagents') throw new Error(`Wrong package: ${name}`);
const gitApply = (...flags) => {
  const result = spawnSync('git', ['apply', ...flags, '-'], { cwd: target, input: patch, encoding: 'utf8' });
  if (result.error) throw result.error;
  return result;
};
const applied = gitApply('--reverse', '--check').status === 0;
if (args.includes('--revert')) {
  if (!applied) throw new Error('Cannot revert: patched context is absent or has changed. No files modified.');
  const result = gitApply('--reverse');
  if (result.status !== 0) throw new Error(result.stderr);
  console.log(`subagents ${version}: live-tools overlay reverted`);
} else if (applied) {
  console.log(`subagents ${version}: live-tools overlay already applied`);
} else {
  // git checks EVERY hunk before writing. A changed upstream is never patched blindly.
  const check = gitApply('--check');
  if (check.status !== 0) {
    console.error(`subagents ${version}: overlay incompatible (tested on 0.19.0). No files modified.\n${check.stderr}\nReview upstream and run tests/subagents-live-tools.mjs before adapting/removing this overlay.`);
    process.exitCode = 1;
  } else if (args.includes('--check')) {
    console.log(`subagents ${version}: live-tools overlay compatible (dry run)`);
  } else {
    const result = gitApply();
    if (result.status !== 0) throw new Error(result.stderr);
    console.log(`subagents ${version}: live-tools overlay applied; /reload or restart pi`);
  }
}

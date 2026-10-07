#!/usr/bin/env node
// Add the throughput status to the existing pi-statusline footer.
import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = dirname(fileURLToPath(import.meta.url));
const agent = process.env.PI_CODING_AGENT_DIR ?? process.env.PI_AGENT_DIR ?? join(homedir(), '.pi/agent');
const pkg = join(agent, 'npm/node_modules/pi-statusline');
const explicit = process.argv.find(a => a.startsWith('--target='))?.slice(9);
const target = explicit ?? join(pkg, 'src/ui.ts');
if (!explicit && !existsSync(join(pkg, 'package.json'))) { console.log('skip: pi-statusline is not installed'); process.exit(0); }
const hash = x => createHash('sha256').update(x).digest('hex');
const originalHash = '449ba48cd34676b77ec1b3d8b07d4eecb67ae06551e04fb69f96e7404e495f5a';
const previousHashes = ['41040e31d55ef9581d264e2a29b8e4f4130459b8aac91648f12a607a22c548e0', '09b43fc9a5c56cf7a4b6bf765cc6498467aaa71d974471872436531a1e03b491'];
const next = readFileSync(join(root, 'pi-live-throughput/statusline-ui.ts'));
const source = readFileSync(target);
if (![originalHash, ...previousHashes, hash(next)].includes(hash(source))) throw new Error('pi-statusline ui.ts changed; no files written; review the overlay');
if (hash(source) === hash(next)) { console.log('already patched: compact throughput footer'); process.exit(0); }
if (!existsSync(`${target}.pi-harness-original`)) writeFileSync(`${target}.pi-harness-original`, source, { mode: 0o600 });
writeFileSync(`${target}.pi-harness-tmp`, next); renameSync(`${target}.pi-harness-tmp`, target);
console.log('patched: dynamic throughput footer and field wrapping');

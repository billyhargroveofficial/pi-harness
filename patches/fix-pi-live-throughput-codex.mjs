#!/usr/bin/env node
// Reviewed hybrid TPS overlay. No settings, transport, auth or statusline edits.
import { readFileSync, writeFileSync, existsSync, lstatSync, readdirSync, mkdirSync, mkdtempSync, renameSync, rmSync, rmdirSync, symlinkSync, realpathSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const self = fileURLToPath(import.meta.url);
const patchDir = dirname(realpathSync(self));
export const digest = data => createHash('sha256').update(data).digest('hex');
const originalHashes = ['0e2e684dedb9c6dce73aa12d3c8e6f3ce49a1634e2773468c5234253637e0cbf', '177b70be09ae6b4cab2069d89b22a4bae032d98aca89bbe900e579e9a87d3957'];
const previousIndex = ['a9afd53c9345c5daa97191da7960b71d4e76629d7ccbf1232b66d74441b91a1e', 'f9413b27398ea8874de3cc3465fe24c22c29672fd6d0b3d2386ac9225c78966f', 'b826cd964e6bfa98afd6443c3c19cd6493fcf49b7ed9acdc1de06faba3e05987', 'ad7b3e7b3e07d459f33a6d2a06eb0ef1a092fbf9027c88c4a3b8c8a945f6fcac', '4021f61cc6d6cc75ccc8d58118962d046ef7a066f37164586b6a3ca4c1959328', 'a5138eb008a8e433b6ac0d208120647cab6bb58294c521a9de4b0118df2e97a8'];
const previousMetrics = ['5e31bce740dd89ffb52b02860fa42ba65bf4dfcf04190a0a3b423f3d990a6c82', '25c81a1d4425c460121fc08f97f3e5dd81a768738d4a67753b05acf326339c8e', 'cf9a7e4936029762e734dad3231542c705baece6f58a169ea3e9c64588ec7b2c', '31b3c9d0dde01a2be1b34abed7ed36029e8ef680f5781ea4c431314296744db8', '8d8adf0b4dbab83c973b0465fe1dd856fca964fee5f3d8ef43bc6ff9e1acf1b8', '08101db14296751bf05b0dae5df3892d1188fcd5e6b537ed33492c601387b7aa'];
const previousPatch = ['19a026753bd7a2cef507e901b245631ed4cbbf94bdd9578152518d925e0e9b07', '9ec758ed7c2eb64abb06bebf38b858d69c9fc100de3e839e3580d658ab4a059d', '904a9f0de4244f12319d2ea1f1767f440950950a44ba26a01ccf4b2e04a70e35'];
const previousTokenizer = ['9fdef84a599e6d8cd3e4fa80baf508b60ff268197c0f382b02c1e4baaebcc7f7'];
const stat = path => { try { return lstatSync(path); } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; } };
function regular(path, root = dirname(path)) {
  const info = stat(path);
  if (info && !info.isFile()) throw new Error(`TPS guard: not a regular file: ${path}`);
  // Check the deployment tree, not OS aliases such as macOS /tmp -> /private/tmp.
  for (let parent = dirname(path); ; parent = dirname(parent)) {
    const entry = stat(parent);
    if (entry && (!entry.isDirectory() || entry.isSymbolicLink())) throw new Error(`TPS guard: unsafe parent: ${parent}`);
    if (parent === root || parent === dirname(parent)) break;
  }
  return info;
}

// Optional canonical helpers are independent guarded relative paths. They are
// reviewed helpers: only canonical bytes or an exact known predecessor hash.
export function buildPlan({ agentDir, target, payloadDir = join(patchDir, 'pi-live-throughput'), copies = false, patchFile = realpathSync(self), fresh = false }) {
  const names = readdirSync(payloadDir).filter(name => !['statusline-ui.ts','LICENSE','THIRD_PARTY.md'].includes(name));
  if (!names.includes('index.ts') || !names.includes('codex-throughput.ts') || !names.includes('reference-tokenizer.ts')) throw new Error('Incomplete TPS canonical manifest');
  const reviewedNames = ['index.ts','codex-throughput.ts','reference-tokenizer.ts'];
  if (names.some(name => !reviewedNames.includes(name))) throw new Error('Unsafe TPS helper relative path (not in reviewed manifest)');
  const canonical = names.map(name => {
    const source = join(payloadDir, name); regular(source);
    return { name, bytes: readFileSync(source) };
  }).sort((a,b) => (a.name === 'index.ts') - (b.name === 'index.ts') || a.name.localeCompare(b.name));
  const plan = [];
  const guardRoot = agentDir && resolve(target).startsWith(`${resolve(agentDir)}/`) ? resolve(agentDir) : dirname(target);
  const add = (path, bytes, allowed = []) => {
    const root = agentDir && resolve(path).startsWith(`${resolve(agentDir)}/`) ? resolve(agentDir) : guardRoot;
    const info = regular(path,root), old = info ? readFileSync(path) : undefined;
    const hash = digest(bytes);
    if (old && ![hash,...allowed].includes(digest(old))) throw new Error(`TPS guard: unreviewed local edits; nothing written: ${path}`);
    plan.push({path,root,bytes,old,mode:info?.mode ?? 0o644,changed:!old || digest(old)!==hash});
  };
  for (const {name,bytes} of canonical) {
    add(join(dirname(target),name),bytes,name==='index.ts'?[...originalHashes,...previousIndex]:name==='codex-throughput.ts'?previousMetrics:previousTokenizer);
  }
  const source = plan.find(item => item.path === target);
  if (!source?.old && !fresh) throw new Error(`TPS installed index is missing: ${target}`);
  if (source?.old && originalHashes.includes(digest(source.old)) && !stat(`${target}.pi-harness-original`)) add(`${target}.pi-harness-original`,source.old);
  if (copies) {
    if (!agentDir) throw new Error('Agent directory is required for canonical copies');
    for (const {name,bytes} of canonical) add(join(agentDir,'patches/pi-live-throughput',name),bytes,name==='index.ts'?[...originalHashes,...previousIndex]:name==='codex-throughput.ts'?previousMetrics:previousTokenizer);
    regular(patchFile);
    add(join(agentDir,'patches/fix-pi-live-throughput-codex.mjs'),readFileSync(patchFile),previousPatch);
  }
  if(fresh){
    const packageFile=join(dirname(dirname(target)),'package.json');
    if(stat(dirname(packageFile)))throw new Error('TPS guard: fresh installation requires an absent extension directory');
    add(packageFile,Buffer.from(JSON.stringify({name:'pi-live-throughput',version:'0.0.0',private:true,type:'module',pi:{extensions:['./src/index.ts']}},null,2)+'\n'));
  }
  const paths = plan.map(item=>resolve(item.path));
  if (new Set(paths).size!==paths.length) throw new Error('Overlapping TPS deployment paths');
  return plan;
}

export async function applyPlan(plan, { runtimeStage, runtimeTarget, verify, testEnv = process.env } = {}) {
  const id = randomUUID(), staged = [], madeDirs = [], written = [];
  let oldRuntime = false, newRuntime = false, rollbackFailed = false;
  const runtimeBackup = runtimeTarget && `${runtimeTarget}.rollback-${id}`;
  function ensureDir(path) {
    if (stat(path)) return;
    ensureDir(dirname(path)); mkdirSync(path); madeDirs.push(path);
  }
  function fault() {
    const count = written.length + Number(newRuntime);
    if (testEnv.PI_TPS_TEST_MODE === '1' && String(count) === testEnv.PI_TPS_TEST_FAIL_AFTER_WRITE) throw new Error(`TEST-only TPS write failure ${count}`);
  }
  try {
    // Recheck ALL guards before staging writes (the plan may be caller-held).
    for (const item of plan) {
      const info=regular(item.path,item.root),now=info?readFileSync(item.path):undefined;
      if (Boolean(now)!==Boolean(item.old) || (now && digest(now)!==digest(item.old))) throw new Error(`TPS preflight changed: ${item.path}`);
    }
    if (runtimeStage) {
      if (!runtimeTarget || !stat(runtimeStage)?.isDirectory() || stat(runtimeStage).isSymbolicLink()) throw new Error('Invalid staged TPS runtime');
      const stage=resolve(runtimeStage),target=resolve(runtimeTarget);
      if(stage===target || stage.startsWith(`${target}/`) || target.startsWith(`${stage}/`)
        || plan.some(item=>resolve(item.path)===target || resolve(item.path).startsWith(`${target}/`) || resolve(item.path).startsWith(`${stage}/`))) throw new Error('Overlapping TPS runtime paths');
      const root=plan.find(item=>target.startsWith(`${resolve(item.root)}/`))?.root ?? dirname(target);
      const info=stat(target); if(info && (!info.isDirectory() || info.isSymbolicLink())) throw new Error('Unsafe TPS runtime target');
      regular(join(target,'package.json'),root);
      regular(join(stage,'package.json'),dirname(stage));
    }
    // Prepare replacement AND rollback bytes on the same filesystem first.
    for (const item of plan.filter(item=>item.changed)) {
      ensureDir(dirname(item.path));
      const tmp=`${item.path}.tps-new-${id}`,backup=`${item.path}.tps-old-${id}`;
      staged.push({...item,tmp,backup});
      writeFileSync(tmp,item.bytes,{mode:item.mode & 0o777});
      if(item.old)writeFileSync(backup,item.old,{mode:item.mode & 0o777});
    }
    if(runtimeStage){
      if(stat(runtimeTarget)){renameSync(runtimeTarget,runtimeBackup);oldRuntime=true;}
      renameSync(runtimeStage,runtimeTarget);newRuntime=true;fault();
    }
    for(const item of staged){renameSync(item.tmp,item.path);written.push(item);fault();}
    for(const item of plan)if(digest(readFileSync(item.path))!==digest(item.bytes))throw new Error(`Installed TPS source mismatch: ${item.path}`);
    if(verify)await verify();
  } catch(error) {
    const rollbackErrors=[];
    for(const item of [...written].reverse())try{
      if(item.old)renameSync(item.backup,item.path);else rmSync(item.path,{force:true});
    }catch(failure){rollbackErrors.push(`${item.path}: ${failure.message}`);}
    try{
      if(newRuntime)rmSync(runtimeTarget,{recursive:true,force:true});
      if(oldRuntime)renameSync(runtimeBackup,runtimeTarget);
    }catch(failure){rollbackErrors.push(`runtime: ${failure.message}`);}
    if(rollbackErrors.length){rollbackFailed=true;throw new AggregateError([error,...rollbackErrors.map(message=>new Error(message))],`TPS rollback needs attention; snapshots retained (${id})`);}
    throw error;
  } finally {
    // Keep rollback snapshots only if a rollback itself failed.
    for(const item of staged){rmSync(item.tmp,{force:true});if(!rollbackFailed)rmSync(item.backup,{force:true});}
    for(const path of madeDirs.reverse())try{rmdirSync(path);}catch{}
  }
  if(oldRuntime)rmSync(runtimeBackup,{recursive:true,force:true});
  return written.length;
}

export async function verifyInstalled(agentDir, target) {
  const repo=dirname(patchDir),temp=realpathSync(mkdtempSync(join(tmpdir(),'pi-tps-installed-tests-')));
  const suites=['codex-throughput.mjs','codex-throughput-oracles.mjs','codex-throughput-extension.mjs','codex-throughput-native-session.mjs','codex-throughput-transport.mjs'];
  const env={...process.env,PI_CODING_AGENT_DIR:agentDir,TPS_TOKENIZER_DIR:join(agentDir,'tps-runtime'),
    THROUGHPUT_SOURCE:target,STATUSLINE_UI_SOURCE:join(repo,'patches/pi-live-throughput/statusline-ui.ts')};
  try{
    const {resolveReferenceTokenizer}=await import(pathToFileURL(join(patchDir,'pi-live-throughput/reference-tokenizer.ts')).href);
    if(!resolveReferenceTokenizer({dir:env.TPS_TOKENIZER_DIR}))throw new Error('Installed TPS runtime is missing or incompatible');
    // Native TS stripping cannot read node_modules directly. Every TS alias
    // points at installed bytes, while cwd also remaps the core loader bridge.
    mkdirSync(join(temp,'tests'));mkdirSync(join(temp,'patches/pi-live-throughput'),{recursive:true});
    const aliases=[];
    for(const name of ['index.ts','codex-throughput.ts','reference-tokenizer.ts']){
      const installed=join(dirname(target),name),alias=join(temp,'patches/pi-live-throughput',name);
      const bytes=readFileSync(installed);symlinkSync(installed,alias);aliases.push({installed,alias,bytes});
    }
    const checkAliases=()=>{for(const {installed,alias,bytes} of aliases){
      if(realpathSync(alias)!==realpathSync(installed) || digest(readFileSync(alias))!==digest(bytes)
        || digest(readFileSync(installed))!==digest(bytes))throw new Error(`Installed TPS alias/source mismatch: ${alias}`);
    }};
    // Fixture helpers are copied unchanged; transaction tests still use the
    // real canonical patch and git predecessor, not rewritten fixture imports.
    for(const name of suites)writeFileSync(join(temp,'tests',name),readFileSync(join(repo,'tests',name)));
    for(const name of ['fix-pi-live-throughput-codex.mjs','fix-pi-statusline-throughput.mjs'])symlinkSync(join(repo,'patches',name),join(temp,'patches',name));
    symlinkSync(join(repo,'patches/pi-live-throughput/statusline-ui.ts'),join(temp,'patches/pi-live-throughput/statusline-ui.ts'));
    symlinkSync(join(repo,'.git'),join(temp,'.git'));
    if(!env.PI_CLI_ROOT){
      const global=spawnSync('npm',['root','-g'],{encoding:'utf8',timeout:30000});
      if(global.status!==0)throw new Error('Cannot locate installed Pi loader');
      env.PI_CLI_ROOT=join(global.stdout.trim(),'@earendil-works/pi-coding-agent');
    }
    for(const name of suites){
      checkAliases();
      const result=spawnSync(process.execPath,['--preserve-symlinks',join(temp,'tests',name)],{cwd:temp,env,stdio:'inherit',timeout:120000});
      if(result.status!==0)throw new Error(`Installed TPS acceptance ${name} failed: ${result.error?.message??result.status}`);
      checkAliases();
    }
    const smoke=`import assert from 'node:assert/strict';import {loadExtensions} from ${JSON.stringify(pathToFileURL(join(env.PI_CLI_ROOT,'dist/core/extensions/loader.js')).href)};
      globalThis.fetch=()=>{throw new Error('Network forbidden in TPS deployment checks');};
      const result=await loadExtensions([${JSON.stringify(target)}],${JSON.stringify(temp)});assert.deepEqual(result.errors,[]);assert.ok(result.extensions[0]?.commands.has('throughput'));console.log('PASS: installed TPS source loads through actual Pi loader; zero inference');`;
    const load=spawnSync(process.execPath,['--input-type=module','-e',smoke],{cwd:temp,env,stdio:'inherit',timeout:30000});
    if(load.status!==0)throw new Error(`Installed Pi TPS loader check failed: ${load.error?.message??load.status}`);
    checkAliases();
  }finally{rmSync(temp,{recursive:true,force:true});}
}

async function main() {
  const args=process.argv.slice(2);
  const allowed=/^(--target=.+|--runtime-stage=.+|--preflight|--deploy|--verify)$/;
  if(args.some(arg=>!allowed.test(arg)))throw new Error('Unknown TPS patch argument');
  const explicit=args.find(arg=>arg.startsWith('--target='))?.slice(9);
  const agentDir=resolve(process.env.PI_CODING_AGENT_DIR??process.env.PI_AGENT_DIR??join(homedir(),'.pi/agent'));
  const packageDir=join(agentDir,'npm/node_modules/pi-live-throughput');
  const deploy=args.includes('--deploy');
  if(deploy&&explicit)throw new Error('Deploy uses agentDir, not --target');
  const fresh=deploy&&!stat(join(packageDir,'package.json'));
  if(!explicit&&!existsSync(join(packageDir,'package.json'))&&!deploy){console.log('skip: pi-live-throughput is not installed');return;}
  const target=explicit?resolve(explicit):join(packageDir,'src/index.ts');
  const plan=buildPlan({agentDir,target,copies:deploy,fresh});
  if(deploy){const runtime=join(agentDir,'tps-runtime'),info=stat(runtime);if(info&&(!info.isDirectory()||info.isSymbolicLink()))throw new Error('Unsafe TPS runtime target');regular(join(runtime,'package.json'),agentDir);}
  if(args.includes('--preflight')){console.log('PASS: complete TPS manifest preflight; no writes');return;}
  const runtimeStage=args.find(arg=>arg.startsWith('--runtime-stage='))?.slice('--runtime-stage='.length);
  if(runtimeStage&&!deploy)throw new Error('Runtime staging requires --deploy');
  if(deploy && (!runtimeStage || !args.includes('--verify')))throw new Error('TPS deployment requires staged runtime and complete installed acceptance');
  if(runtimeStage){
    const {resolveReferenceTokenizer}=await import(pathToFileURL(join(patchDir,'pi-live-throughput/reference-tokenizer.ts')).href);
    if(!resolveReferenceTokenizer({dir:runtimeStage}))throw new Error('Invalid staged TPS runtime pin/encoder');
  }
  const count=await applyPlan(plan,{runtimeStage,runtimeTarget:join(agentDir,'tps-runtime'),verify:args.includes('--verify')?()=>verifyInstalled(agentDir,target):undefined});
  console.log(count||runtimeStage?'patched: reference-BPE LIVE + observed stream session AVG':'already patched: observed stream TPS');
}
if(process.argv[1]&&existsSync(process.argv[1])&&realpathSync(process.argv[1])===realpathSync(self))await main();

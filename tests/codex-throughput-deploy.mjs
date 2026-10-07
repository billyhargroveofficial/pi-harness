// TEMP-only deployment/installer regression tests. Zero inference; no ~/.pi writes.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,mkdtempSync,rmSync,readdirSync,lstatSync,existsSync,copyFileSync,symlinkSync,renameSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {buildPlan,applyPlan,digest} from '../patches/fix-pi-live-throughput-codex.mjs';
import {resolveReferenceTokenizer} from '../patches/pi-live-throughput/reference-tokenizer.ts';
const repo=dirname(dirname(fileURLToPath(import.meta.url)));
const temp=mkdtempSync(join(tmpdir(),'pi-tps-deploy-tests-'));
const env={...process.env,npm_config_cache:join(temp,'npm-cache')};
let checks=0,id=0;
const put=(path,data)=>{mkdirSync(dirname(path),{recursive:true});writeFileSync(path,data);};
const run=(script,args=[],extra={})=>spawnSync('bash',[script,...args],{env:{...env,...extra},encoding:'utf8',timeout:180000});
const baseline=name=>{
 const result=spawnSync('git',['show',`ac30afa:patches/${name}`],{cwd:repo,encoding:null});assert.equal(result.status,0);return result.stdout;
};
const oldIndex=baseline('pi-live-throughput/index.ts'),oldMetrics=baseline('pi-live-throughput/codex-throughput.ts'),oldPatch=baseline('fix-pi-live-throughput-codex.mjs');
assert.equal(digest(oldIndex),'a5138eb008a8e433b6ac0d208120647cab6bb58294c521a9de4b0118df2e97a8');
assert.equal(digest(oldMetrics),'08101db14296751bf05b0dae5df3892d1188fcd5e6b537ed33492c601387b7aa');
function snapshot(root){
 const result={};
 function walk(path){for(const name of readdirSync(path).sort()){
  const full=join(path,name),stat=lstatSync(full),key=relative(root,full);
  if(stat.isDirectory()){result[key]={directory:true,mode:stat.mode};walk(full);}
  else result[key]={bytes:readFileSync(full).toString('base64'),mode:stat.mode};
 }}
 walk(root);return result;
}
function fixture(){
 const dir=join(temp,`fixture-${id++}`),agent=join(dir,'agent'),src=join(agent,'npm/node_modules/pi-live-throughput/src'),payload=join(dir,'canonical');
 mkdirSync(payload,{recursive:true});
 put(join(src,'index.ts'),oldIndex);put(join(src,'codex-throughput.ts'),oldMetrics);
 put(join(agent,'npm/node_modules/pi-live-throughput/package.json'),'{}');
 put(join(agent,'patches/pi-live-throughput/index.ts'),oldIndex);put(join(agent,'patches/pi-live-throughput/codex-throughput.ts'),oldMetrics);
 put(join(agent,'patches/fix-pi-live-throughput-codex.mjs'),oldPatch);
 put(join(agent,'preserve-me'),'machine-local unrelated bytes');
 put(join(payload,'index.ts'),Buffer.concat([oldIndex,Buffer.from('\n// reviewed next overlay fixture\n')]));
 put(join(payload,'codex-throughput.ts'),Buffer.concat([oldMetrics,Buffer.from('\n// reviewed next metrics fixture\n')]));
 put(join(payload,'reference-tokenizer.ts'),'export const reference = "o200k_base";\n');
 const options={agentDir:agent,target:join(src,'index.ts'),payloadDir:payload,copies:true};
 return {dir,agent,src,payload,options};
}
const acceptance=['codex-throughput.mjs','codex-throughput-oracles.mjs','codex-throughput-extension.mjs','codex-throughput-native-session.mjs','codex-throughput-transport.mjs'];
function verificationRepo(f,{fake=false,fail}={}){
 const root=join(f.dir,'repo');
 for(const name of ['install-tps-runtime.sh','deploy-tps-speedometer.sh','tps-runtime/package.json','tps-runtime/package-lock.json'])put(join(root,'assets',name),readFileSync(join(repo,'assets',name)));
 for(const name of ['fix-pi-live-throughput-codex.mjs','fix-pi-statusline-throughput.mjs'])put(join(root,'patches',name),readFileSync(join(repo,'patches',name)));
 for(const name of ['index.ts','codex-throughput.ts','reference-tokenizer.ts','statusline-ui.ts'])put(join(root,'patches/pi-live-throughput',name),readFileSync(join(repo,'patches/pi-live-throughput',name)));
 symlinkSync(join(repo,'.git'),join(root,'.git'));
 for(const name of acceptance)put(join(root,'tests',name),fake?`import assert from 'node:assert/strict';import {readFileSync,realpathSync} from 'node:fs';import {dirname,join} from 'node:path';import {CodexThroughput} from '../patches/pi-live-throughput/codex-throughput.ts';import {resolveReferenceTokenizer} from '../patches/pi-live-throughput/reference-tokenizer.ts';assert.equal(typeof CodexThroughput,'function');assert.equal(typeof resolveReferenceTokenizer(),'function');for(const file of ['index.ts','codex-throughput.ts','reference-tokenizer.ts']){const alias=join(process.cwd(),'patches/pi-live-throughput',file),installed=join(dirname(process.env.THROUGHPUT_SOURCE),file);assert.equal(realpathSync(alias),realpathSync(installed));assert.deepEqual(readFileSync(alias),readFileSync(installed));}console.log('ACCEPTANCE ${name}');${name===fail?"process.exit(73);":""}\n`:readFileSync(join(repo,'tests',name)));
 return root;
}
async function test(name,body){try{await body();checks++;}catch(error){error.message=`${name}: ${error.message}`;throw error;}}
try{
 await test('strict v4 predecessor, helper manifest, canonical copies, idempotence',async()=>{
  const f=fixture(),plan=buildPlan(f.options);assert.ok(plan.some(item=>item.path.endsWith('/reference-tokenizer.ts')));
  assert.ok(await applyPlan(plan)>0);
  for(const item of plan)assert.deepEqual(readFileSync(item.path),item.bytes);
  const snap=snapshot(f.agent);assert.equal(await applyPlan(buildPlan(f.options)),0);assert.deepEqual(snapshot(f.agent),snap);
 });
 await test('c6faee7 hybrid predecessors migrate as a complete guarded set',async()=>{
  const f=fixture();
  for(const name of ['index.ts','codex-throughput.ts','reference-tokenizer.ts']){
   const r=spawnSync('git',['show',`c6faee7:patches/pi-live-throughput/${name}`],{cwd:repo});assert.equal(r.status,0);
   put(join(f.src,name),r.stdout);put(join(f.agent,'patches/pi-live-throughput',name),r.stdout);
  }
  const patch=spawnSync('git',['show','c6faee7:patches/fix-pi-live-throughput-codex.mjs'],{cwd:repo});assert.equal(patch.status,0);put(join(f.agent,'patches/fix-pi-live-throughput-codex.mjs'),patch.stdout);
  const plan=buildPlan({...f.options,payloadDir:join(repo,'patches/pi-live-throughput')});assert.ok(await applyPlan(plan)>0);assert.equal(await applyPlan(buildPlan({...f.options,payloadDir:join(repo,'patches/pi-live-throughput')})),0);
 });
 for(const number of [2,3])await test(`write ${number} failure rolls back whole overlay + copies`,async()=>{
  const f=fixture(),snap=snapshot(f.agent);
  await assert.rejects(applyPlan(buildPlan(f.options),{testEnv:{PI_TPS_TEST_MODE:'1',PI_TPS_TEST_FAIL_AFTER_WRITE:String(number)}}),/TEST-only/);
  assert.deepEqual(snapshot(f.agent),snap);
 });
 for(const number of [1,2,3])await test(`write ${number} failure rolls back runtime + whole overlay`,async()=>{
  const f=fixture(),runtime=join(f.agent,'tps-runtime'),stage=join(f.dir,'stage');
  put(join(runtime,'package.json'),'old runtime manifest');put(join(runtime,'old-data'),'old runtime');
  put(join(stage,'package.json'),'new runtime manifest');put(join(stage,'new-data'),'new runtime');
  const snap=snapshot(f.agent);
  await assert.rejects(applyPlan(buildPlan(f.options),{runtimeStage:stage,runtimeTarget:runtime,testEnv:{PI_TPS_TEST_MODE:'1',PI_TPS_TEST_FAIL_AFTER_WRITE:String(number)}}),/TEST-only/);
  assert.deepEqual(snapshot(f.agent),snap);assert.ok(!existsSync(stage));
  assert.ok(!readdirSync(f.agent).some(name=>name.includes('rollback-')));
 });
 await test('verification failure restores all sources, copies and runtime',async()=>{
  const f=fixture(),runtime=join(f.agent,'tps-runtime'),stage=join(f.dir,'stage');
  put(join(runtime,'old'),'retain');put(join(stage,'new'),'staged');const snap=snapshot(f.agent);
  await assert.rejects(applyPlan(buildPlan(f.options),{runtimeStage:stage,runtimeTarget:runtime,verify:()=>{throw new Error('postcheck failure');}}),/postcheck failure/);
  assert.deepEqual(snapshot(f.agent),snap);
 });
 for(const rel of ['npm/node_modules/pi-live-throughput/src/index.ts','npm/node_modules/pi-live-throughput/src/codex-throughput.ts','npm/node_modules/pi-live-throughput/src/reference-tokenizer.ts','patches/pi-live-throughput/reference-tokenizer.ts','patches/pi-live-throughput/index.ts','patches/fix-pi-live-throughput-codex.mjs'])await test(`preflight refuses unknown edits: ${rel}`,()=>{
  const f=fixture();put(join(f.agent,rel),'unknown local edit');const snap=snapshot(f.agent);
  assert.throws(()=>buildPlan(f.options),/unreviewed local edits/);assert.deepEqual(snapshot(f.agent),snap);
 });
 for(const name of ['not-approved.mjs','unreviewed-helper.ts'])await test(`invalid helper relative path refuses complete manifest: ${name}`,()=>{
  const f=fixture();put(join(f.payload,name),'');const snap=snapshot(f.agent);
  assert.throws(()=>buildPlan(f.options),/Unsafe TPS helper relative path/);assert.deepEqual(snapshot(f.agent),snap);
 });
 await test('guard rejects helper symlink without changing referent',()=>{
  const f=fixture(),foreign=join(f.dir,'foreign');put(foreign,'unknown');symlinkSync(foreign,join(f.src,'reference-tokenizer.ts'));
  assert.throws(()=>buildPlan(f.options),/not a regular file/);assert.equal(readFileSync(foreign,'utf8'),'unknown');
 });
 await test('plan rechecks entire set before any staging write',async()=>{
  const f=fixture(),plan=buildPlan(f.options);put(join(f.src,'index.ts'),'changed after preflight');const snap=snapshot(f.agent);
  await assert.rejects(applyPlan(plan),/preflight changed/);assert.deepEqual(snapshot(f.agent),snap);
 });
 await test('fault env alone does not activate TEST hook',async()=>{
  const f=fixture();assert.ok(await applyPlan(buildPlan(f.options),{testEnv:{PI_TPS_TEST_FAIL_AFTER_WRITE:'2'}})>0);
 });
 await test('display-only script refuses edits before npm/runtime writes',()=>{
  const f=fixture(),bin=join(f.dir,'bin'),marker=join(f.dir,'npm-ran');
  put(join(f.src,'index.ts'),'unknown local edit');const snap=snapshot(f.agent);
  put(join(bin,'npm'),`#!/bin/sh\ntouch '${marker}'\nexit 91\n`);
  assert.equal(spawnSync('chmod',['700',join(bin,'npm')]).status,0);
  const result=run(join(repo,'assets/deploy-tps-speedometer.sh'),[],{PI_CODING_AGENT_DIR:f.agent,PATH:`${bin}:${env.PATH}`});
  assert.notEqual(result.status,0);assert.match(result.stderr,/unreviewed/);assert.ok(!existsSync(marker));assert.deepEqual(snapshot(f.agent),snap);
 });
 await test('real npm ci stages pinned encoder without replacing live runtime',()=>{
  const agent=join(temp,'runtime-agent'),stage=join(temp,'pinned-runtime');put(join(agent,'tps-runtime/old'),'retain');const snap=snapshot(agent);
  const result=run(join(repo,'assets/install-tps-runtime.sh'),['--stage',stage],{PI_CODING_AGENT_DIR:agent});
  assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/PASS: pinned pure o200k_base/);
  assert.equal(JSON.parse(readFileSync(join(stage,'node_modules/gpt-tokenizer/package.json'))).version,'4.0.0');
  assert.deepEqual(readFileSync(join(stage,'package-lock.json')),readFileSync(join(repo,'assets/tps-runtime/package-lock.json')));
  assert.equal(typeof resolveReferenceTokenizer({dir:stage}),'function');assert.deepEqual(snapshot(agent),snap);
 });
 await test('npm failure retains old runtime and cleans staged files',()=>{
  const agent=join(temp,'runtime-agent'),snap=snapshot(agent),bin=join(temp,'fail-bin'),stage=join(temp,'failed-runtime-stage');
  put(join(bin,'npm'),'#!/bin/sh\nexit 23\n');
  const chmod=spawnSync('chmod',['700',join(bin,'npm')]);assert.equal(chmod.status,0);
  const result=run(join(repo,'assets/install-tps-runtime.sh'),['--stage',stage],{PI_CODING_AGENT_DIR:agent,PATH:`${bin}:${env.PATH}`});
  assert.notEqual(result.status,0);assert.deepEqual(snapshot(agent),snap);assert.ok(!existsSync(stage));
 });
 await test('corrupt pin/lock rejected before stage creation',()=>{
  const copy=join(temp,'bad-lock-repo'),agent=join(temp,'bad-lock-agent');
  put(join(copy,'assets/install-tps-runtime.sh'),readFileSync(join(repo,'assets/install-tps-runtime.sh')));
  put(join(copy,'assets/tps-runtime/package.json'),readFileSync(join(repo,'assets/tps-runtime/package.json')));
  const lock=JSON.parse(readFileSync(join(repo,'assets/tps-runtime/package-lock.json')));lock.packages['node_modules/gpt-tokenizer'].integrity='unreviewed';
  put(join(copy,'assets/tps-runtime/package-lock.json'),JSON.stringify(lock));
  const stage=join(temp,'bad-lock-stage'),result=run(join(copy,'assets/install-tps-runtime.sh'),['--stage',stage],{PI_CODING_AGENT_DIR:agent});assert.notEqual(result.status,0);assert.ok(!existsSync(agent));assert.ok(!existsSync(stage));
 });
 function syntheticRuntime(root){
  put(join(root,'package.json'),readFileSync(join(repo,'assets/tps-runtime/package.json')));
  const pkg=join(root,'node_modules/gpt-tokenizer');
  put(join(pkg,'package.json'),JSON.stringify({name:'gpt-tokenizer',version:'4.0.0',exports:{'./package.json':'./package.json','./encoding/o200k_base':'./encoder.cjs'}}));
  put(join(pkg,'encoder.cjs'),'exports.encode=text=>Array.from(text);');return pkg;
 }
 await test('missing/empty dedicated runtime cannot climb parent node_modules',()=>{
  const root=join(temp,'parent-fallback'),parent=syntheticRuntime(root),runtime=join(root,'missing-runtime');
  assert.ok(createRequire(join(runtime,'package.json')).resolve('gpt-tokenizer/encoding/o200k_base').startsWith(realpathSync(parent)));
  assert.equal(resolveReferenceTokenizer({dir:runtime}),undefined);
  mkdirSync(runtime);assert.equal(resolveReferenceTokenizer({dir:runtime}),undefined);
  put(join(runtime,'package.json'),readFileSync(join(repo,'assets/tps-runtime/package.json')));assert.equal(resolveReferenceTokenizer({dir:runtime}),undefined);
 });
 for(const bad of ['runtime-pin','runtime-private','package-version','package-dependency'])await test(`incompatible ${bad} fails closed`,()=>{
  const root=join(temp,bad),pkg=syntheticRuntime(root),path=join(bad.startsWith('runtime')?root:pkg,'package.json'),manifest=JSON.parse(readFileSync(path));
  if(bad==='runtime-pin')manifest.dependencies['gpt-tokenizer']='^4.0.0';
  if(bad==='runtime-private')manifest.private=false;
  if(bad==='package-version')manifest.version='3.4.0';
  if(bad==='package-dependency')manifest.dependencies={unexpected:'1.0.0'};
  put(path,JSON.stringify(manifest));assert.equal(resolveReferenceTokenizer({dir:root}),undefined);
 });
 for(const kind of ['root','node_modules','package','encoder-parent','manifest'])await test(`runtime ${kind} symlink escape rejected`,()=>{
  const root=join(temp,`escape-${kind}`),foreign=join(temp,`foreign-${kind}`),pkg=syntheticRuntime(root);
  if(kind==='root'){renameSync(root,foreign);symlinkSync(foreign,root,'dir');}
  if(kind==='node_modules'){renameSync(join(root,'node_modules'),foreign);symlinkSync(foreign,join(root,'node_modules'),'dir');}
  if(kind==='package'){renameSync(pkg,foreign);symlinkSync(foreign,pkg,'dir');}
  if(kind==='encoder-parent'){
   put(join(foreign,'encoder.cjs'),'exports.encode=text=>Array.from(text);');symlinkSync(foreign,join(pkg,'escaped'),'dir');
   const manifest=JSON.parse(readFileSync(join(pkg,'package.json')));manifest.exports['./encoding/o200k_base']='./escaped/encoder.cjs';put(join(pkg,'package.json'),JSON.stringify(manifest));
  }
  if(kind==='manifest'){copyFileSync(join(pkg,'package.json'),foreign);rmSync(join(pkg,'package.json'));symlinkSync(foreign,join(pkg,'package.json'));}
  assert.equal(resolveReferenceTokenizer({dir:root}),undefined);
 });
 await test('transaction rejects overlapping runtime and code paths before writes',async()=>{
  const f=fixture(),runtime=join(f.agent,'tps-runtime'),stage=join(runtime,'stage');put(join(stage,'package.json'),'staged');const snap=snapshot(f.agent);
  await assert.rejects(applyPlan(buildPlan(f.options),{runtimeStage:stage,runtimeTarget:runtime}),/Overlapping TPS runtime paths/);assert.deepEqual(snapshot(f.agent),snap);
 });
 await test('unsafe runtime stage/target parents rejected before any code write',async()=>{
  const f=fixture(),foreign=join(f.dir,'foreign-runtime'),stage=join(f.dir,'stage');put(join(stage,'package.json'),'staged');mkdirSync(foreign);symlinkSync(foreign,join(f.agent,'runtime-link'),'dir');
  await assert.rejects(applyPlan(buildPlan(f.options),{runtimeStage:stage,runtimeTarget:join(f.agent,'runtime-link/runtime')}),/unsafe parent/);
  assert.equal(readFileSync(join(f.src,'index.ts')).toString(),oldIndex.toString());assert.deepEqual(readdirSync(foreign),[]);
 });
 await test('real display-only deploy runs ALL current installed acceptance + actual Pi loader',()=>{
  const f=fixture(),fixtureRepo=verificationRepo(f);
  const result=run(join(fixtureRepo,'assets/deploy-tps-speedometer.sh'),[],{PI_CODING_AGENT_DIR:f.agent});
  assert.equal(result.status,0,`${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout,/installed TPS source loads through actual Pi loader/);
  for(const label of ['independent-oracles','extension-footer-guards','stream-session','native-transport'])assert.match(result.stdout,new RegExp(label));
  for(const name of ['index.ts','codex-throughput.ts','reference-tokenizer.ts']){
   assert.deepEqual(readFileSync(join(f.src,name)),readFileSync(join(fixtureRepo,'patches/pi-live-throughput',name)));
   assert.deepEqual(readFileSync(join(f.agent,'patches/pi-live-throughput',name)),readFileSync(join(fixtureRepo,'patches/pi-live-throughput',name)));
  }
  assert.equal(readFileSync(join(f.agent,'preserve-me'),'utf8'),'machine-local unrelated bytes');
  assert.ok(!existsSync(join(f.agent,'patches/fix-pi-statusline-throughput.mjs')));
  assert.ok(!existsSync(join(f.agent,'patches/pi-live-throughput/statusline-ui.ts')));
  assert.ok(!readdirSync(f.agent).some(name=>name.startsWith('.tps-deploy')||name.includes('rollback-')));
  const repeated=run(join(fixtureRepo,'assets/deploy-tps-speedometer.sh'),[],{PI_CODING_AGENT_DIR:f.agent});assert.equal(repeated.status,0,`${repeated.stdout}\n${repeated.stderr}`);
 });
 for(const fail of acceptance)await test(`${fail} subprocess failure restores runtime + all canonical/installed bytes`,()=>{
  const f=fixture(),fixtureRepo=verificationRepo(f,{fake:true,fail});put(join(f.agent,'tps-runtime/old'),'retain old runtime');const snap=snapshot(f.agent);
  const result=run(join(fixtureRepo,'assets/deploy-tps-speedometer.sh'),[],{PI_CODING_AGENT_DIR:f.agent});
  assert.notEqual(result.status,0);assert.match(result.stdout,new RegExp(`ACCEPTANCE ${fail.replaceAll('.','\\.')}`));assert.match(result.stderr,/Installed TPS acceptance .* failed: 73/);
  assert.deepEqual(snapshot(f.agent),snap);
 });
 await test('final actual-loader subprocess failure rolls back after all acceptance suites',()=>{
  const f=fixture(),fixtureRepo=verificationRepo(f,{fake:true});put(join(f.agent,'tps-runtime/old'),'retain');const snap=snapshot(f.agent);
  const result=run(join(fixtureRepo,'assets/deploy-tps-speedometer.sh'),[],{PI_CODING_AGENT_DIR:f.agent,PI_CLI_ROOT:join(f.dir,'absent-pi-root')});
  assert.notEqual(result.status,0);for(const name of acceptance)assert.ok(result.stdout.includes(`ACCEPTANCE ${name}`));assert.match(result.stderr,/Installed Pi TPS loader check failed/);assert.deepEqual(snapshot(f.agent),snap);
 });
 await test('failure immediately after staged runtime swap leaves no staged or rollback artifacts',()=>{
  const f=fixture(),fixtureRepo=verificationRepo(f,{fake:true});put(join(f.agent,'tps-runtime/old'),'retain');const snap=snapshot(f.agent);
  const result=run(join(fixtureRepo,'assets/deploy-tps-speedometer.sh'),[],{PI_CODING_AGENT_DIR:f.agent,PI_TPS_TEST_MODE:'1',PI_TPS_TEST_FAIL_AFTER_WRITE:'1'});
  assert.notEqual(result.status,0);assert.match(result.stderr,/TEST-only TPS write failure 1/);assert.deepEqual(snapshot(f.agent),snap);
 });
 await test('first install through default installer stages + verifies entire TPS feature',()=>{
  const f=fixture(),fixtureRepo=verificationRepo(f);rmSync(join(f.agent,'npm'),{recursive:true});rmSync(join(f.agent,'patches'),{recursive:true});
  const result=run(join(fixtureRepo,'assets/install-tps-runtime.sh'),[],{PI_CODING_AGENT_DIR:f.agent});assert.equal(result.status,0,`${result.stdout}\n${result.stderr}`);
  for(const label of ['independent-oracles','extension-footer-guards','stream-session','native-transport'])assert.ok(result.stdout.includes(label));
  assert.match(result.stdout,/offline stream\/reference\/stream-ledger\/controller\/real-loader/);
  assert.equal(typeof resolveReferenceTokenizer({dir:join(f.agent,'tps-runtime')}),'function');
  assert.equal(JSON.parse(readFileSync(join(f.agent,'npm/node_modules/pi-live-throughput/package.json'))).pi.extensions[0],'./src/index.ts');
  assert.ok(!readdirSync(f.agent).some(name=>name.startsWith('.tps-deploy')||name.includes('rollback-')));
 });
 await test('first-install later acceptance failure removes entire new feature',()=>{
  const f=fixture(),fixtureRepo=verificationRepo(f,{fake:true,fail:acceptance.at(-1)});rmSync(join(f.agent,'npm'),{recursive:true});rmSync(join(f.agent,'patches'),{recursive:true});const snap=snapshot(f.agent);
  const result=run(join(fixtureRepo,'assets/install-tps-runtime.sh'),[],{PI_CODING_AGENT_DIR:f.agent});assert.notEqual(result.status,0);assert.deepEqual(snapshot(f.agent),snap);
 });
 await test('install/update preserve runtime until unified overlay transaction',()=>{
  for(const file of ['install.sh','update.sh']){
   const text=readFileSync(join(repo,file),'utf8');assert.ok(!text.includes('assets/install-tps-runtime.sh'));
   assert.ok(text.indexOf('assets/deploy-tps-speedometer.sh')>text.indexOf(file==='install.sh'?'  pi install "npm:':'pi update "$@"'));
   assert.ok(text.includes('!= fix-pi-live-throughput-codex.mjs'));
  }
  const script=readFileSync(join(repo,'assets/deploy-tps-speedometer.sh'),'utf8');
  assert.doesNotMatch(script.split('\n').filter(line=>!line.startsWith('#')).join('\n'),/codex-only\.py|statusline\.py|settings\.json|auth\.json/);
  assert.ok(readFileSync(join(repo,'assets/install-tps-runtime.sh'),'utf8').includes('exec bash "$REPO_DIR/assets/deploy-tps-speedometer.sh"'));
 });
 console.log(`PASS: ${checks} TEMP-only runtime/deployment checks, full installed acceptance, runtime/code/canonical rollback, strict helpers/runtime guards and pinned staging; zero inference`);
}finally{rmSync(temp,{recursive:true,force:true});}

// Independent hybrid UI/real-loader acceptance + TEMP-only transactional guards.
// No HOME deployment, settings/theme changes, auth/session reads or inference.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,readdirSync,statSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname,relative} from 'node:path';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {Suite,harness,operation,model,repo,piRoot,installed,close} from './codex-throughput-oracles.mjs';
import {buildPlan,applyPlan} from '../patches/fix-pi-live-throughput-codex.mjs';
const suite=new Suite('extension-footer-guards');
const temp=mkdtempSync(join(tmpdir(),'tps-extension-acceptance-'));
const oldFetch=globalThis.fetch;globalThis.fetch=()=>{throw Error('Network forbidden');};
const put=(path,bytes)=>{mkdirSync(dirname(path),{recursive:true});writeFileSync(path,bytes);};
const baseline=name=>{const r=spawnSync('git',['show',`ac30afa:${name}`],{cwd:repo});assert.equal(r.status,0,r.stderr.toString());return r.stdout;};
const require=createRequire(join(piRoot,'dist/index.js'));
const {visibleWidth}=await import(pathToFileURL(require.resolve('@earendil-works/pi-tui')).href);
const clean=s=>s.replace(/\x1b\[[0-9;]*m/g,'');
let serial=0;
function deployment(){
 const root=join(temp,`deploy-${serial++}`),agent=join(root,'agent'),target=join(agent,'npm/node_modules/pi-live-throughput/src/index.ts');
 put(target,baseline('patches/pi-live-throughput/index.ts'));put(join(dirname(target),'codex-throughput.ts'),baseline('patches/pi-live-throughput/codex-throughput.ts'));
 put(join(agent,'patches/pi-live-throughput/index.ts'),baseline('patches/pi-live-throughput/index.ts'));
 put(join(agent,'patches/pi-live-throughput/codex-throughput.ts'),baseline('patches/pi-live-throughput/codex-throughput.ts'));
 put(join(agent,'patches/fix-pi-live-throughput-codex.mjs'),baseline('patches/fix-pi-live-throughput-codex.mjs'));
 put(join(agent,'unrelated'),'preserved unrelated bytes');
 return {root,agent,target,options:{agentDir:agent,target,copies:true}};
}
function snapshot(root){const out={};const walk=path=>{for(const name of readdirSync(path).sort()){const p=join(path,name),s=statSync(p),key=relative(root,p);out[key]=s.isDirectory()?{dir:true,mode:s.mode}:{bytes:readFileSync(p).toString('base64'),mode:s.mode};if(s.isDirectory())walk(p);}};walk(root);return out;}
async function fixture(fn,options){const h=await harness(options);try{await fn(h);}finally{await h.dispose();}}
try{
 const footerBridge=join(temp,'footer-fixture.ts');const uiSource=process.env.STATUSLINE_UI_SOURCE??join(repo,'patches/pi-live-throughput/statusline-ui.ts');
 put(footerBridge,`import {applyStatusLineUi} from ${JSON.stringify(uiSource)};export default function(pi){pi.on('session_start',(_event,ctx)=>applyStatusLineUi(ctx,{placement:'footer'},['📁 harness-space ● GPT-6.1 Sol 272k high 18k · named']));}`);
 await suite.test('actual loader/footer exact adjacent LIVE/stream AVG once, middle dots and gray',()=>fixture(async h=>{
  const op=await operation(h,{id:'footer',duration:11000,output:455,texts:[' seed',' a'.repeat(294),' a'.repeat(161)],times:[1000,6000,11000]});await op.save();
  const lines=h.footer.render(220);const text=clean(lines.join(' '));
  assert.match(text,/harness-space · GPT-6\.1 Sol.* · ~32\.2 ~45\.5 TPS hit 90\.0% in 1\.0k out 455/);
  assert.equal((text.match(/TPS/g)??[]).length,1);assert.doesNotMatch(text,/●|CURRENT|AVG|cumulative|momentum/);
  assert.match(lines.join(''),/\x1b\[38;5;8m/);
 },{extraPaths:[footerBridge]}));
 await suite.test('footer widths 1–220: bounded, both complete numeric words in correct order from width5',()=>fixture(async h=>{
  h.statuses.set('throughput','~32.2 ~45.5 TPS hit 90.9% in 28.00M out 229k');
  for(let width=1;width<=220;width++){
   const rendered=h.footer.render(width),text=clean(rendered.join(' '));
   assert.ok(rendered.every(line=>visibleWidth(line)<=width),`width ${width}`);
   if(width>=5){assert.ok(text.includes('~32.2'),`LIVE lost at width ${width}: ${text}`);assert.ok(text.includes('~45.5'),`AVG lost at width ${width}: ${text}`);assert.ok(text.indexOf('~32.2')<text.indexOf('~45.5'),`numbers swapped at width ${width}`);}
   if(width>=6)for(const field of ['TPS','hit','90.9%','in','28.00M','out','229k'])assert.ok(text.split(' ').includes(field),`field ${field} lost at ${width}`);
   assert.doesNotMatch(text,/●/);
  }
 },{extraPaths:[footerBridge]}));
 await suite.test('missing hybrid - - TPS footer + status/widget/off/on controls',()=>fixture(async h=>{
  assert.equal(h.line,'- - TPS hit - in 0 out 0');assert.match(clean(h.footer.render(220).join(' ')),/- - TPS hit - in 0 out 0/);
  await h.command('widget');assert.equal(h.statuses.has('throughput'),false);assert.deepEqual(h.widgets.get('throughput'),['- - TPS hit - in 0 out 0']);
  await h.command('off');assert.equal(h.widgets.has('throughput'),false);assert.doesNotMatch(clean(h.footer.render(220).join(' ')),/TPS/);
  await h.command('on');assert.equal(h.widgets.has('throughput'),true);await h.command('status');assert.equal(h.widgets.has('throughput'),false);assert.equal(h.statuses.has('throughput'),true);
 },{extraPaths:[footerBridge]}));
 await suite.test('actual AgentSession replacement + saved-entry resolver + turn_end boundary',()=>fixture(async h=>{
  const {AgentSession}=await installed('dist/core/agent-session.js');
  const op=await operation(h,{id:'real-boundary',output:320});
  const replacement={path:'replacement-fixture',handlers:new Map([['message_end',[event=>({message:{...event.message,content:[{type:'text',text:'final replacement fixture'}]}})]]])};h.runner.extensions.push(replacement);
  // Exercise installed AgentSession methods, NOT inference/agent.prompt. Only
  // unrelated context projection/continuation is stubbed; identity resolution,
  // replacement and real runner dispatch are unmodified production methods.
  const session=Object.create(AgentSession.prototype);
  Object.assign(session,{_extensionRunner:h.runner,sessionManager:h.manager,_entryIdsByMessage:new WeakMap(),_boundaryDispatchedMessages:new WeakSet(),_turnIndex:0,agent:{state:{messages:[op.message]}}});
  session._buildBoundaryContext=()=>({canContinue:false,entries:[],messages:[]});session._commitBoundaryDrafts=drafts=>assert.deepEqual(drafts,[]);
  await session._emitExtensionEvent({type:'message_end',message:op.message});assert.equal(h.d.ledger.value,undefined);
  assert.equal(op.message.content[0].text,'final replacement fixture');const id=h.manager.appendMessage(op.message);
  await session._emitExtensionEvent({type:'turn_end',message:op.message,toolResults:[]});
  assert.equal(h.manager.getEntry(id).message,op.message);assert.equal(h.d.ledger.value,undefined);assert.equal(h.d.ledger.average.unknown,true);assert.equal(h.d.heldRate,undefined);
 }));
 await suite.test('LAST held during idle/new warmup; malformed active stream cannot overwrite',()=>fixture(async h=>{
  await (await operation(h,{id:'last',duration:3000,texts:[' seed',' a'.repeat(100)],times:[1000,2000]})).save();const before=h.line;
  await h.emit('session_tree',{},100000);assert.equal(h.line,before);
  await h.emit('before_provider_request',{},100000);assert.equal(h.line,before);
  await h.raw({type:'response.output_text.delta',item_id:'missing',content_index:0,delta:'malformed'},100001);assert.equal(h.line,before);
  await h.command('reset');assert.match(h.line,/^- ~100\.0 TPS/);
 }));
 await suite.test('real UI timer advances active silence to 0.0, adds no fake volume or AVG duration',()=>fixture(async h=>{
  await h.emit('before_provider_request',{},0);await h.raw({type:'response.created',response:{id:'silence'}},0);await h.raw({type:'response.output_item.added',item:{id:'m',type:'message'}},0);
  await h.raw({type:'response.output_text.delta',item_id:'m',content_index:0,delta:' seed'},1000);await h.raw({type:'response.output_text.delta',item_id:'m',content_index:0,delta:' a'.repeat(100)},2000);
  assert.match(h.line,/^~100\.0 - TPS/);const volume=h.d.measurement.window.tokens;
  h.state.clock=3000;await new Promise(resolve=>setTimeout(resolve,230));assert.match(h.line,/^~50\.0 - TPS/);
  h.state.clock=6000;await new Promise(resolve=>setTimeout(resolve,230));assert.match(h.line,/^~0\.0 - TPS/);assert.equal(h.d.measurement.window.tokens,volume);assert.equal(h.d.ledger.average.elapsedMs,0);
 }));
 await suite.test('strict ac30afa v4 migration, canonical helpers/copies + idempotence',async()=>{
  const f=deployment();const plan=buildPlan(f.options);assert.ok(await applyPlan(plan)>0);
  for(const p of plan)assert.deepEqual(readFileSync(p.path),p.bytes);const snap=snapshot(f.agent);
  assert.equal(await applyPlan(buildPlan(f.options)),0);assert.deepEqual(snapshot(f.agent),snap);
  assert.equal(readFileSync(join(f.agent,'unrelated'),'utf8'),'preserved unrelated bytes');
 });
 for(const index of [2,3])await suite.test(`failure between write${index} and next rolls back ALL helpers/canonical copies + runtime`,async()=>{
  const f=deployment(),stage=join(f.root,'runtime-stage'),target=join(f.agent,'tps-runtime');put(join(target,'package.json'),'old runtime');put(join(target,'old'),'retain');put(join(stage,'package.json'),'new runtime');put(join(stage,'new'),'replace');
  const snap=snapshot(f.agent);await assert.rejects(applyPlan(buildPlan(f.options),{runtimeStage:stage,runtimeTarget:target,testEnv:{PI_TPS_TEST_MODE:'1',PI_TPS_TEST_FAIL_AFTER_WRITE:String(index)}}),/TEST-only/);
  assert.deepEqual(snapshot(f.agent),snap);assert.ok(!existsSync(stage));
 });
 await suite.test('verification failure rolls back transaction, no loader-visible mixed helpers',async()=>{
  const f=deployment(),snap=snapshot(f.agent);await assert.rejects(applyPlan(buildPlan(f.options),{verify:()=>{throw Error('independent postcheck failure');}}),/postcheck failure/);assert.deepEqual(snapshot(f.agent),snap);
 });
 for(const name of ['index.ts','codex-throughput.ts','reference-tokenizer.ts'])await suite.test(`unknown ${name} protected before ANY writes`,()=>{
  const f=deployment();put(join(dirname(f.target),name),'unreviewed independent local edit');const snap=snapshot(f.agent);assert.throws(()=>buildPlan(f.options),/unreviewed/);assert.deepEqual(snapshot(f.agent),snap);
 });
 await suite.test('stale held plan cannot write over intervening local helper edit',async()=>{
  const f=deployment(),plan=buildPlan(f.options);put(join(dirname(f.target),'reference-tokenizer.ts'),'concurrent local helper');const snap=snapshot(f.agent);
  await assert.rejects(applyPlan(plan),/preflight changed/);assert.deepEqual(snapshot(f.agent),snap);
 });
 await suite.test('statusline canonical idempotence/unknown edit protected, entirely TEMP',()=>{
  const target=join(temp,'ui.ts');put(target,readFileSync(uiSource));const patch=join(repo,'patches/fix-pi-statusline-throughput.mjs');
  const run=()=>spawnSync(process.execPath,[patch,`--target=${target}`],{encoding:'utf8',env:{...process.env,PI_CODING_AGENT_DIR:join(temp,'unused-agent')}});
  const before=readFileSync(target);assert.equal(run().status,0);assert.deepEqual(readFileSync(target),before);
  put(target,Buffer.concat([before,Buffer.from('\n// unreviewed local footer edit')]));const edited=readFileSync(target);const result=run();assert.notEqual(result.status,0);assert.match(result.stderr,/no files written/);assert.deepEqual(readFileSync(target),edited);
 });
}finally{globalThis.fetch=oldFetch;rmSync(temp,{recursive:true,force:true});}
suite.finish();

// Actual installed Pi loader/ExtensionRunner + SessionManager, synthetic
// operations only. Disk sessions created HERE live exclusively under /tmp.
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Suite,harness,operation,model,close,count,assistant,record,entry,nativeFixture,installed} from './codex-throughput-oracles.mjs';
import {NativeAverage,NATIVE_ENTRY,hash} from '../patches/pi-live-throughput/codex-throughput.ts';
const suite=new Suite('native-session');
const savedFetch=globalThis.fetch;globalThis.fetch=()=>{throw Error('Network forbidden');};
async function fixture(fn,options){const h=await harness(options);try{await fn(h);}finally{await h.dispose();}}
try{
 await suite.test('exact hybrid: ~32.2 ~45.5 TPS, raw native totals never rescale LIVE',()=>fixture(async h=>{
  const texts=[' seed',' a'.repeat(161)];assert.equal(count(texts.join(''))-count(texts[0]),161);
  const op=await operation(h,{id:'exact',duration:10000,output:455,texts,times:[5000,10000]});
  await h.runner.emitMessageEnd({type:'message_end',message:op.message});
  assert.equal(h.d.ledger.value,undefined,'message_end must NOT commit before final saved assistant');
  await op.save();assert.equal(h.line,'~32.2 ~45.5 TPS hit 90.0% in 1.0k out 455');
  const held=h.d.heldRate;
  const op2=await operation(h,{id:'native-changed',start:20000,duration:10000,output:100000,texts,times:[5000,10000]});await op2.save();
  close(h.d.heldRate,held);close(h.d.ledger.value,100455/20);
 }));
 await suite.test('weighted AVG 100/1s+100/10s=200/11; external idle excluded; pending stays completed AVG',()=>fixture(async h=>{
  await (await operation(h,{id:'one',output:100,duration:1000})).save();
  await h.emit('before_provider_request',{},999000);assert.equal(h.line,'- ~100.0 TPS hit 90.0% in 1.0k out 100');
  // Complete that pending operation, no second pre-request boundary.
  await h.raw({type:'response.created',response:{id:'two'}},999001);
  await h.emit('message_start',{message:{...assistant('two'),responseId:undefined}},999001);
  await h.raw({type:'response.completed',response:{id:'two',status:'completed',usage:{output_tokens:100}}},1009000);
  await h.save(assistant('two'));close(h.d.ledger.value,200/11);assert.equal(h.d.ledger.average.elapsedMs,11000);assert.notEqual(h.d.ledger.value,55);
 }));
 for(const details of [{reasoning_tokens:300},undefined])await suite.test(`output320 counts all native reasoning; details ${details?'present':'missing'} valid`,()=>fixture(async h=>{
  await (await operation(h,{id:'reasoning',duration:1000,output:320,usageDetails:details,texts:['hi'],times:[500]})).save();
  close(h.d.ledger.value,320);assert.equal(h.line,'- ~320.0 TPS hit 90.0% in 1.0k out 320');
 }));
 for(const [name,output,duration,expected] of [['explicit zero',0,1000,0],['huge native',2229197,1,2229197000],['slow native',1,1e9,1e-6]])await suite.test(`${name}: no magnitude or positive-duration censor`,()=>fixture(async h=>{
  await (await operation(h,{id:name,output,duration})).save();close(h.d.ledger.value,expected);assert.equal(h.d.ledger.average.unknown,false);
 }));
 await suite.test('missing raw output becomes UNKNOWN despite normalized output=0',()=>fixture(async h=>{
  await (await operation(h,{id:'missing',output:null})).save();assert.equal(h.d.ledger.value,undefined);assert.equal(h.d.ledger.average.unknown,true);
 }));
 for(const options of [{missingTokenizer:true},{unsupported:true},{texts:['a','b'.repeat(256*1024)],times:[200,1000]}])await suite.test(`LIVE excluded cannot exclude native AVG: ${Object.keys(options).join('/')}`,()=>fixture(async h=>{
  await (await operation(h,{id:'excluded',output:320,...options})).save();close(h.d.ledger.value,320);assert.match(h.line,/^- ~320\.0 TPS/);
  assert.equal(h.d.measurement.window.parts.size,0);
 },options));
 for(const terminalType of ['response.failed','response.incomplete','error'])await suite.test(`trustworthy terminal ${terminalType} survives failed assistant default usage`,()=>fixture(async h=>{
  const op=await operation(h,{id:terminalType,output:320,terminalType});op.message.usage.output=0;
  await op.save();close(h.d.ledger.value,320);assert.equal(h.d.ledger.average.unknown,false);
 }));
 await suite.test('final saved replacement: native identity survives replaced text, LIVE does not',()=>fixture(async h=>{
  const op=await operation(h,{id:'replace',duration:3000,texts:[' seed',' a'.repeat(100)],times:[1000,2000]});
  const saved=await op.save({replacement:m=>({...m,content:[{type:'text',text:'offline replacement'}]})});
  assert.equal(h.manager.getEntry(saved.id).message.content[0].text,'offline replacement');close(h.d.ledger.value,100/3);assert.match(h.line,/^- ~33\.3 TPS/);assert.equal(h.d.heldRate,undefined);
 }));
 await suite.test('final saved replacement output or ID mismatch is durable UNKNOWN',()=>fixture(async h=>{
  const op=await operation(h,{id:'replace-id'});await op.save({replacement:m=>({...m,responseId:'foreign'})});
  assert.equal(h.d.ledger.value,undefined);assert.equal(h.manager.getEntries().at(-1).data.kind,'unknown');
 }));
 await suite.test('duplicate message_end and real turn_end boundary remain idempotent',()=>fixture(async h=>{
  const op=await operation(h,{id:'duplicate'});const saved=await op.save();
  await h.runner.emitMessageEnd({type:'message_end',message:saved.message});
  for(let i=0;i<3;i++)await h.runner.emitBoundary({type:'turn_end',messageEntryId:saved.id,message:saved.message},()=>({canContinue:false,entries:[],messages:[]}));
  assert.equal(h.d.ledger.average.nativeTokens,100);assert.equal(h.d.ledger.average.elapsedMs,1000);
  assert.equal(h.manager.getEntries().filter(e=>e.customType===NATIVE_ENTRY&&e.data.kind==='observation').length,1);
 }));
 await suite.test('late duplicate previous message_end cannot freeze or poison a newer operation',()=>fixture(async h=>{
  const old=await (await operation(h,{id:'previous'})).save();
  await h.emit('before_provider_request',{},10000);
  await h.raw({type:'response.created',response:{id:'current'}},10001);
  await h.emit('message_start',{message:{...assistant('current'),responseId:undefined}},10001);
  await h.runner.emitMessageEnd({type:'message_end',message:old.message});
  await h.raw({type:'response.completed',response:{id:'current',status:'completed',usage:{output_tokens:100}}},11000);
  await h.save(assistant('current'));
  close(h.d.ledger.value,100);assert.equal(h.d.ledger.average.observations,2);assert.equal(h.d.ledger.average.nativeTokens,200);assert.equal(h.d.ledger.average.elapsedMs,2000);
 }));
 await suite.test('late previous saved entry with a new entry ID cannot commit a newer frozen operation',()=>fixture(async h=>{
  const old=await (await operation(h,{id:'previous-entry'})).save();
  const fresh=await operation(h,{id:'fresh-entry',start:10000,output:200,duration:2000});
  await h.runner.emitMessageEnd({type:'message_end',message:fresh.message});
  const duplicateId=h.manager.appendMessage(structuredClone(old.message));
  await h.emit('turn_end',{messageEntryId:duplicateId,message:old.message});
  close(h.d.ledger.value,100);assert.equal(h.d.ledger.average.observations,1);
  await fresh.save();close(h.d.ledger.value,100);assert.equal(h.d.ledger.average.observations,2);assert.equal(h.d.ledger.average.nativeTokens,300);
 }));
 await suite.test('CURRENT reset during active operation preserves native/usage and prevents prefix splice',()=>fixture(async h=>{
  await (await operation(h,{id:'first'})).save();const epoch=h.d.ledger.epoch;
  const op=await operation(h,{id:'second',start:10000,duration:3000,texts:[' seed',' a'.repeat(10)],times:[1000,2000],early:()=>h.command('reset')});await op.save();
  assert.equal(h.d.ledger.epoch,epoch);assert.equal(h.d.ledger.average.nativeTokens,200);assert.equal(h.d.heldRate,undefined);assert.equal(h.d.input.outputTokens,200);
 }));
 for(const command of ['reset-avg','reset-all'])await suite.test(`${command} durable epoch excludes old active operation`,()=>fixture(async h=>{
  await (await operation(h,{id:'old'})).save();await h.emit('before_provider_request',{},10000);const oldEpoch=h.d.ledger.epoch;
  await h.command(command);assert.notEqual(h.d.ledger.epoch,oldEpoch);assert.equal(h.d.input.outputTokens,100);assert.equal(h.d.ledger.average.unknown,false);
  await h.raw({type:'response.created',response:{id:'old-inflight'}},10001);await h.raw({type:'response.completed',response:{id:'old-inflight',status:'completed',usage:{output_tokens:400}}},11000);
  // SDK message_start happened BEFORE reset; a late end may not create a new operation.
  await h.save(assistant('old-inflight','',400));assert.equal(h.d.ledger.average.observations,0);
  await (await operation(h,{id:'fresh',start:20000,output:300,duration:2000})).save();close(h.d.ledger.value,150);
 }));
 for(const command of ['reset-avg','reset-all'])await suite.test(`${command} before deferred WS message_start excludes the pre-reset request`,()=>fixture(async h=>{
  await h.emit('before_provider_request',{},0);
  await h.raw({type:'response.created',response:{id:'pre-reset'}},100);
  await h.command(command);const epoch=h.d.ledger.epoch;
  // Native WS can deliver created BEFORE the SDK emits message_start. The
  // delayed start belongs to the discarded old operation, not the new epoch.
  await h.emit('message_start',{message:{...assistant('pre-reset'),responseId:undefined}},100);
  await h.raw({type:'response.completed',response:{id:'pre-reset',status:'completed',usage:{output_tokens:100}}},1000);
  await h.save(assistant('pre-reset'));
  assert.equal(h.d.ledger.epoch,epoch);assert.equal(h.d.ledger.average.unknown,false);assert.equal(h.d.ledger.average.observations,0);
  await (await operation(h,{id:'fresh-epoch',start:10000,output:200,duration:2000})).save();close(h.d.ledger.value,100);
 }));
 await suite.test('generic provider - - TPS; model change clears LIVE only and AVG retains own models',()=>fixture(async h=>{
  await (await operation(h,{id:'a'})).save();h.model={...model,id:'gpt-6-sol'};await h.emit('model_select');assert.match(h.line,/^- ~100\.0 TPS/);
  await (await operation(h,{id:'b',start:10000,output:300})).save();close(h.d.ledger.value,200);
  h.model={id:'generic',api:'openai-completions',provider:'other'};await h.emit('model_select');assert.match(h.line,/^- - TPS/);
  h.model=model;await h.emit('model_select');assert.match(h.line,/^- ~200\.0 TPS/);
 }));
 await suite.test('actual routed Codex attribution is durable, not selected model',()=>fixture(async h=>{
  const actual={...model,id:'gpt-6-astra',provider:'routed-codex'};
  await (await operation(h,{id:'routed',actual})).save();const r=h.manager.getEntries().find(e=>e.customType===NATIVE_ENTRY&&e.data.kind==='observation').data;
  assert.equal(r.model,actual.id);assert.equal(r.provider,actual.provider);close(h.d.ledger.value,100);
 }));
 await suite.test('unexpected generic-to-Codex virtual route unknown, not silently omitted',()=>fixture(async h=>{
  await (await operation(h,{id:'prior'})).save();h.model={id:'router',api:'virtual',provider:'virtual'};
  await (await operation(h,{id:'actual',start:10000,actual:model})).save();assert.equal(h.d.ledger.average.unknown,true);
 }));
 await suite.test('reload + real tree/compaction retain all own branches; auxiliary usage not AVG',()=>fixture(async h=>{
  const one=await (await operation(h,{id:'branch-a'})).save();h.manager.branch(one.id);
  await (await operation(h,{id:'branch-b',start:10000,output:300,duration:10000})).save();
  h.manager.branch(one.id);await h.emit('session_tree');close(h.d.ledger.value,400/11);
  h.manager.appendCompaction('offline summary',one.id,4000,{},false,{input:10,cacheRead:20,cacheWrite:0,output:9});await h.emit('session_compact');
  close(h.d.ledger.value,400/11);assert.equal(h.d.input.outputTokens,409);
  await h.emit('session_shutdown');await h.emit('session_start');close(h.d.ledger.value,400/11);
 }));
 await suite.test('fork at saved assistant excludes inherited ledger own-origin',()=>fixture(async h=>{
  const first=await (await operation(h,{id:'parent'})).save();const origin=h.manager.getSessionId();
  h.manager.createBranchedSession(first.id);assert.notEqual(h.manager.getSessionId(),origin);
  await h.emit('session_shutdown');await h.emit('session_start');assert.equal(h.d.ledger.value,undefined);assert.equal(h.d.ledger.average.unknown,false);assert.equal(h.d.input.outputTokens,100);
  await (await operation(h,{id:'child-own',start:10000,output:300})).save();close(h.d.ledger.value,300);
 }));
 await suite.test('crash-start reload UNKNOWN; legacy usage starts new explicit epoch',async()=>{
  const {SessionManager}=await installed('dist/core/session-manager.js');const temp=mkdtempSync(join(tmpdir(),'tps-native-disk-'));
  try{
   const manager=SessionManager.create(temp,join(temp,'sessions'));manager.appendMessage(assistant('legacy','offline historical fixture',500));
   let h=await harness({manager});assert.equal(h.d.ledger.value,undefined);assert.equal(h.d.input.outputTokens,500);assert.equal(h.d.ledger.average.unknown,false);
   await (await operation(h,{id:'measured'})).save();await h.emit('before_provider_request',{},10000);
   // Reload disk before shutdown: imitates process death, not a graceful close.
   const loaded=SessionManager.open(manager.getSessionFile(),join(temp,'sessions'));await h.dispose();h=await harness({manager:loaded});
   assert.equal(h.d.ledger.value,undefined);assert.equal(h.d.ledger.average.unknown,true);
   await h.command('reset-avg');await (await operation(h,{id:'after-reset',start:20000,output:200,duration:2000})).save();close(h.d.ledger.value,100);
   const allowed=new Set(['v','metric','kind','origin','epoch','operation','responseHash','provider','api','model','nativeTokens','elapsedMs']);
   for(const e of h.manager.getEntries().filter(e=>e.customType===NATIVE_ENTRY))for(const k of Object.keys(e.data))assert.ok(allowed.has(k),k);
   const persisted=readFileSync(h.manager.getSessionFile(),'utf8').split('\n').filter(Boolean).map(JSON.parse).filter(e=>e.customType===NATIVE_ENTRY);
   assert.ok(!JSON.stringify(persisted).includes('offline historical fixture'));await h.dispose();
  }finally{rmSync(temp,{recursive:true,force:true});}
 });
 await suite.test('shutdown/abort without turn_end closes UNKNOWN instead of dropping start',()=>fixture(async h=>{
  await h.emit('before_provider_request',{},0);await h.emit('agent_before_settle',{},1000);assert.equal(h.d.ledger.average.unknown,true);assert.equal(h.manager.getEntries().at(-1).data.kind,'unknown');
 }));
 await suite.test('append exception AFTER memory append never duplicate-bills; coverage fails closed',()=>fixture(async h=>{
  let attempts=0;h.failAppend=data=>{if(data.kind==='observation'){attempts++;return true;}return false;};
  const op=await operation(h,{id:'disk-failed'});const saved=await op.save();await h.emit('turn_end',{messageEntryId:saved.id});
  assert.equal(attempts,1);assert.equal(h.manager.getEntries().filter(e=>e.customType===NATIVE_ENTRY&&e.data.kind==='observation').length,1);assert.equal(h.d.ledger.value,undefined);
 }));
 await suite.test('duplicate/conflicting real custom entries and response keys fail closed',()=>fixture(async h=>{
  await (await operation(h,{id:'once'})).save();const r=h.manager.getEntries().find(e=>e.customType===NATIVE_ENTRY&&e.data.kind==='observation').data;
  h.manager.appendCustomEntry(NATIVE_ENTRY,structuredClone(r));await h.emit('session_shutdown');await h.emit('session_start');close(h.d.ledger.value,100);
  h.manager.appendCustomEntry(NATIVE_ENTRY,{...r,nativeTokens:200});await h.emit('session_shutdown');await h.emit('session_start');assert.equal(h.d.ledger.value,undefined);assert.equal(h.d.ledger.average.unknown,true);
 }));
 await suite.test('sum overflow and response-hash conflicting operation cannot quietly filter',()=>{
  const origin='own',epoch='new';const start=op=>entry(record(origin,epoch,'start',op));const obs=(op,t,ms,extra={})=>entry(record(origin,epoch,'observation',op,{...nativeFixture(t,ms),...extra}));
  const a=new NativeAverage();const first=[entry(record(origin,epoch,'epoch')),start('a'),obs('a',Number.MAX_SAFE_INTEGER,1000),start('b'),obs('b',1,1000)];a.restore(first,origin);assert.equal(a.value,undefined);
  a.restore([entry(record(origin,epoch,'epoch')),start('a'),obs('a',100,1000),start('b'),obs('b',200,1000,{responseHash:hash('100/1000')})],origin);assert.equal(a.value,undefined);
 });
}finally{globalThis.fetch=savedFetch;}
suite.finish();

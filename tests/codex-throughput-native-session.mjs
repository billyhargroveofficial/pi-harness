// Historical filename retained by deployment; AVG is now observed STREAM TPS.
// Real installed loader/ExtensionRunner/SessionManager; fixtures only, no inference.
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Suite,harness,operation,model,close,count,assistant,record,entry,streamFixture,installed} from './codex-throughput-oracles.mjs';
import {StreamAverage,STREAM_ENTRY,hash} from '../patches/pi-live-throughput/codex-throughput.ts';
const suite=new Suite('stream-session');
const savedFetch=globalThis.fetch;globalThis.fetch=()=>{throw Error('Network forbidden');};
async function fixture(fn,options){const h=await harness(options);try{await fn(h);}finally{await h.dispose();}}
const measured=(h,options={})=>operation(h,{duration:1200,texts:[' seed',' a'.repeat(100)],times:[100,1100],...options});
try{
 await suite.test('exact ~32.2 ~45.5 TPS: rolling LIVE versus whole-stream AVG',()=>fixture(async h=>{
  const op=await operation(h,{id:'exact',duration:11000,output:999999,texts:[' seed',' a'.repeat(294),' a'.repeat(161)],times:[1000,6000,11000]});
  await h.runner.emitMessageEnd({type:'message_end',message:op.message});assert.equal(h.d.ledger.value,undefined);
  await op.save();assert.equal(h.line,'~32.2 ~45.5 TPS hit 90.0% in 1.0k out 1000.0k');
  assert.equal(h.d.ledger.average.tokens,455);assert.equal(h.d.ledger.average.elapsedMs,10000);
 }));
 await suite.test('TTFT, terminal tail, user/tool idle excluded; weighted ratio of sums',()=>fixture(async h=>{
  await (await measured(h,{id:'one',duration:20000,times:[10000,11000]})).save();close(h.d.ledger.value,100);
  await h.emit('before_provider_request',{},999000);close(h.d.ledger.value,100);assert.equal(h.d.ledger.average.elapsedMs,1000);
  // Complete the pending request with a 10s visible interval, NOT its 20s total.
  await h.raw({type:'response.created',response:{id:'two'}},1000000);
  await h.emit('message_start',{message:{...assistant('two'),responseId:undefined}},1000000);
  await h.raw({type:'response.output_item.added',item:{id:'m',type:'message'}},1000000);
  await h.raw({type:'response.output_text.delta',item_id:'m',content_index:0,delta:' seed'},1000000);
  await h.raw({type:'response.output_text.delta',item_id:'m',content_index:0,delta:' a'.repeat(100)},1010000);
  const text=' seed'+' a'.repeat(100);
  await h.raw({type:'response.output_text.done',item_id:'m',content_index:0,text},1019000);
  await h.raw({type:'response.output_item.done',item:{id:'m',type:'message',content:[{type:'output_text',text}]}},1019000);
  await h.raw({type:'response.completed',response:{id:'two',status:'completed',usage:{output_tokens:100}}},1019000);
  await h.save(assistant('two',text));close(h.d.ledger.value,200/11);assert.equal(h.d.ledger.average.elapsedMs,11000);assert.notEqual(h.d.ledger.value,55);
 }));
 for(const output of [null,0,320,1000000])await suite.test(`native output ${output} does not calibrate either TPS`,()=>fixture(async h=>{
  await (await measured(h,{output,usageDetails:{reasoning_tokens:300}})).save();close(h.d.ledger.value,100);assert.equal(h.d.ledger.average.tokens,100);assert.equal(h.d.input.outputTokens,output??0);
 }));
 await suite.test('first large atomic chunk removed consistently, not counted over short suffix time',()=>fixture(async h=>{
  const first=' a'.repeat(1000),second=' b'.repeat(50);
  await (await measured(h,{texts:[first,second],times:[10000,12000],duration:25000})).save();
  const tokens=count(first+second)-count(first);assert.equal(h.d.ledger.average.tokens,tokens);close(h.d.ledger.value,tokens/2);assert.equal(h.d.ledger.average.elapsedMs,2000);
 }));
 for(const [texts,times] of [[[],[]],[['hi'],[500]],[[' seed',' a'.repeat(100)],[500,500]],[[' seed',' a'.repeat(100)],[500,999]]])await suite.test('untimed/empty/sub-resolution response leaves measured AVG unchanged',()=>fixture(async h=>{
  await (await measured(h,{id:'timed'})).save();await (await operation(h,{id:'untimed',start:10000,duration:20000,texts,times})).save();
  close(h.d.ledger.value,100);assert.equal(h.d.ledger.average.observations,1);assert.equal(h.d.ledger.average.unknown,false);assert.equal(h.manager.getEntries().at(-1).data.kind,'unmeasured');
 }));
 await suite.test('reasoning-only response does not claim a text speed',()=>fixture(async h=>{
  await (await operation(h,{output:320,usageDetails:{reasoning_tokens:320}})).save();assert.equal(h.d.ledger.value,undefined);assert.equal(h.d.ledger.average.unknown,false);assert.equal(h.d.input.outputTokens,320);
 }));
 for(const options of [{missingTokenizer:true},{unsupported:true},{texts:['a','b'.repeat(256*1024)],times:[100,1100]}])await suite.test(`unobservable stream fails closed: ${Object.keys(options)}`,()=>fixture(async h=>{
  await (await measured(h,options)).save();assert.equal(h.d.ledger.value,undefined);assert.equal(h.d.ledger.average.unknown,true);assert.equal(h.d.measurement.window.parts.size,0);assert.equal(h.d.input.outputTokens,100);
 },options));
 for(const terminalType of ['response.failed','response.incomplete','error'])await suite.test(`unvalidated terminal ${terminalType} cannot commit successful-stream AVG`,()=>fixture(async h=>{
  await (await measured(h,{terminalType})).save();assert.equal(h.d.ledger.value,undefined);assert.equal(h.d.ledger.average.unknown,true);
 }));
 for(const replacement of [m=>({...m,content:[{type:'text',text:'replacement'}]}),m=>({...m,responseId:'other'})])await suite.test('actual final saved replacement invalidates measured stream, not native accounting',()=>fixture(async h=>{
  const op=await measured(h);await op.save({replacement});assert.equal(h.d.ledger.value,undefined);assert.equal(h.d.ledger.average.unknown,true);assert.equal(h.d.input.outputTokens,100);assert.equal(h.d.heldRate,undefined);
 }));
 await suite.test('duplicate end/turn boundaries idempotent',()=>fixture(async h=>{
  const op=await measured(h);const saved=await op.save();await h.runner.emitMessageEnd({type:'message_end',message:saved.message});
  for(let i=0;i<3;i++)await h.runner.emitBoundary({type:'turn_end',messageEntryId:saved.id,message:saved.message},()=>({canContinue:false,entries:[],messages:[]}));
  assert.equal(h.d.ledger.average.tokens,100);assert.equal(h.d.ledger.average.elapsedMs,1000);assert.equal(h.manager.getEntries().filter(e=>e.customType===STREAM_ENTRY&&e.data.kind==='observation').length,1);
 }));
 await suite.test('late previous message_end and saved entry cannot freeze or commit newer request',()=>fixture(async h=>{
  const old=await (await measured(h,{id:'old'})).save();const fresh=await measured(h,{id:'fresh',start:10000,texts:[' seed',' a'.repeat(200)]});
  await h.runner.emitMessageEnd({type:'message_end',message:old.message});await h.runner.emitMessageEnd({type:'message_end',message:fresh.message});
  const duplicate=h.manager.appendMessage(structuredClone(old.message));await h.emit('turn_end',{messageEntryId:duplicate});close(h.d.ledger.value,100);
  await fresh.save();close(h.d.ledger.value,150);assert.equal(h.d.ledger.average.observations,2);
 }));
 await suite.test('LIVE-only reset during response cannot destroy independent AVG prefix',()=>fixture(async h=>{
  await (await measured(h,{id:'first'})).save();const epoch=h.d.ledger.epoch;
  const op=await measured(h,{id:'second',start:10000,texts:[' seed',' a'.repeat(200)],early:()=>h.command('reset')});await op.save();
  assert.equal(h.d.ledger.epoch,epoch);assert.equal(h.d.heldRate,undefined);close(h.d.ledger.value,150);assert.equal(h.d.input.outputTokens,200);
 }));
 for(const command of ['reset-avg','reset-all'])await suite.test(`${command} before deferred WS SDK start discards old request`,()=>fixture(async h=>{
  await (await measured(h,{id:'old'})).save();await h.emit('before_provider_request',{},10000);await h.raw({type:'response.created',response:{id:'inflight'}},10001);const oldEpoch=h.d.ledger.epoch;
  await h.command(command);assert.notEqual(h.d.ledger.epoch,oldEpoch);await h.emit('message_start',{message:{...assistant('inflight'),responseId:undefined}},10001);
  await h.raw({type:'response.completed',response:{id:'inflight',status:'completed',usage:{output_tokens:400}}},11000);await h.save(assistant('inflight','',400));assert.equal(h.d.ledger.average.observations,0);assert.equal(h.d.ledger.average.unknown,false);
  await (await measured(h,{id:'fresh',start:20000,texts:[' seed',' a'.repeat(300)]})).save();close(h.d.ledger.value,300);
 }));
 await suite.test('generic provider - -; model changes retain measured own-session AVG',()=>fixture(async h=>{
  await (await measured(h,{id:'a'})).save();h.model={...model,id:'other-codex'};await h.emit('model_select');assert.match(h.line,/^- ~100\.0 TPS/);
  await (await measured(h,{id:'b',start:10000,texts:[' seed',' a'.repeat(300)]})).save();close(h.d.ledger.value,200);
  h.model={id:'generic',api:'other',provider:'other'};await h.emit('model_select');assert.match(h.line,/^- - TPS/);h.model=model;await h.emit('model_select');assert.match(h.line,/^- ~200\.0 TPS/);
 }));
 await suite.test('actual routed Codex attribution persisted',()=>fixture(async h=>{
  const actual={...model,id:'actual-model',provider:'routed-codex'};await (await measured(h,{actual})).save();const r=h.manager.getEntries().find(e=>e.customType===STREAM_ENTRY&&e.data.kind==='observation').data;assert.equal(r.model,actual.id);assert.equal(r.provider,actual.provider);close(h.d.ledger.value,100);
 }));
 await suite.test('generic virtual route has observable content timing without native request timing',()=>fixture(async h=>{
  h.model={id:'router',api:'virtual',provider:'virtual'};await (await measured(h,{actual:model})).save();close(h.d.ledger.value,100);assert.equal(h.d.ledger.average.unknown,false);
 }));
 await suite.test('reload tree compaction retain own measured branches; auxiliary native usage not TPS',()=>fixture(async h=>{
  const one=await (await measured(h,{id:'a'})).save();h.manager.branch(one.id);await (await measured(h,{id:'b',start:10000,texts:[' seed',' a'.repeat(300)],times:[1000,11000],duration:12000})).save();
  h.manager.branch(one.id);await h.emit('session_tree');close(h.d.ledger.value,400/11);
  h.manager.appendCompaction('offline summary',one.id,4000,{},false,{input:10,cacheRead:20,cacheWrite:0,output:9});await h.emit('session_compact');close(h.d.ledger.value,400/11);assert.equal(h.d.input.outputTokens,209);
  await h.emit('session_shutdown');await h.emit('session_start');close(h.d.ledger.value,400/11);
 }));
 await suite.test('fork at saved assistant excludes inherited parent stream measurements',()=>fixture(async h=>{
  const op=await (await measured(h,{id:'parent'})).save();const origin=h.manager.getSessionId();h.manager.createBranchedSession(op.id);assert.notEqual(h.manager.getSessionId(),origin);
  await h.emit('session_shutdown');await h.emit('session_start');assert.equal(h.d.ledger.value,undefined);assert.equal(h.d.ledger.average.unknown,false);assert.equal(h.d.input.outputTokens,100);
  await (await measured(h,{id:'child',start:10000,texts:[' seed',' a'.repeat(300)]})).save();close(h.d.ledger.value,300);
 }));
 await suite.test('real legacy native records ignored and preserved on disk; crash unknown; reset recovers',async()=>{
  const {SessionManager}=await installed('dist/core/session-manager.js');const temp=mkdtempSync(join(tmpdir(),'tps-stream-disk-'));
  try{
   const manager=SessionManager.create(temp,join(temp,'sessions'));manager.appendMessage(assistant('legacy','historical fixture',500));
   const origin=manager.getSessionId();manager.appendCustomEntry('pi-harness:codex-native-throughput',{v:1,metric:'native-provider-operation',kind:'epoch',origin,epoch:'old'});
   let h=await harness({manager});assert.notEqual(h.d.ledger.epoch,'old');assert.equal(h.d.ledger.value,undefined);assert.equal(h.d.input.outputTokens,500);
   await (await measured(h)).save();await h.emit('before_provider_request',{},10000);const reloaded=SessionManager.open(manager.getSessionFile(),join(temp,'sessions'));await h.dispose();h=await harness({manager:reloaded});assert.equal(h.d.ledger.average.unknown,true);
   await h.command('reset-avg');await (await measured(h,{id:'fresh',start:20000})).save();close(h.d.ledger.value,100);
   const allowed=new Set(['v','metric','kind','origin','epoch','operation','responseHash','provider','api','model','tokens','elapsedMs']);
   const persisted=readFileSync(h.manager.getSessionFile(),'utf8').split('\n').filter(Boolean).map(JSON.parse);assert.ok(persisted.some(e=>e.customType==='pi-harness:codex-native-throughput'));
   for(const e of persisted.filter(e=>e.customType===STREAM_ENTRY))for(const k of Object.keys(e.data))assert.ok(allowed.has(k),k);
   assert.ok(!JSON.stringify(persisted.filter(e=>e.customType===STREAM_ENTRY)).includes('historical fixture'));await h.dispose();
  }finally{rmSync(temp,{recursive:true,force:true});}
 });
 await suite.test('shutdown/abort without final saved boundary closes UNKNOWN',()=>fixture(async h=>{await h.emit('before_provider_request',{},0);await h.emit('agent_before_settle',{},1000);assert.equal(h.d.ledger.average.unknown,true);}));
 await suite.test('append after-memory exception never duplicate bills',()=>fixture(async h=>{
  let n=0;h.failAppend=data=>{if(data.kind==='observation'){n++;return true;}return false;};const op=await measured(h);const saved=await op.save();await h.emit('turn_end',{messageEntryId:saved.id});assert.equal(n,1);assert.equal(h.d.ledger.value,undefined);
 }));
 await suite.test('real duplicate/conflicting records fail closed',()=>fixture(async h=>{
  await (await measured(h)).save();const r=h.manager.getEntries().find(e=>e.customType===STREAM_ENTRY&&e.data.kind==='observation').data;h.manager.appendCustomEntry(STREAM_ENTRY,structuredClone(r));await h.emit('session_shutdown');await h.emit('session_start');close(h.d.ledger.value,100);
  h.manager.appendCustomEntry(STREAM_ENTRY,{...r,tokens:200});await h.emit('session_shutdown');await h.emit('session_start');assert.equal(h.d.ledger.value,undefined);
 }));
 await suite.test('pure ledger overflow and response conflict cannot silently filter',()=>{
  const origin='own',epoch='new',start=op=>entry(record(origin,epoch,'start',op)),obs=(op,t,ms,extra={})=>entry(record(origin,epoch,'observation',op,{...streamFixture(t,ms),...extra}));const a=new StreamAverage();
  a.restore([entry(record(origin,epoch,'epoch')),start('a'),obs('a',Number.MAX_SAFE_INTEGER,1000),start('b'),obs('b',1,1000)],origin);assert.equal(a.value,undefined);
  a.restore([entry(record(origin,epoch,'epoch')),start('a'),obs('a',100,1000),start('b'),obs('b',200,1000,{responseHash:hash('100/1000')})],origin);assert.equal(a.value,undefined);
 });
 await suite.test('tool input stream: canonical saved arguments/identity checked, native out preserved',()=>fixture(async h=>{
  await h.emit('before_provider_request',{},0);await h.raw({type:'response.created',response:{id:'tool'}},0);
  const tool={id:'f',type:'function_call',call_id:'call',name:'fn'};await h.raw({type:'response.output_item.added',item:tool},0);
  const chunks=['{"value":"seed',' a'.repeat(50),'"}'];let args='';for(let i=0;i<chunks.length;i++){args+=chunks[i];await h.raw({type:'response.function_call_arguments.delta',item_id:'f',delta:chunks[i]},1000+i*1000);}
  await h.raw({type:'response.function_call_arguments.done',item_id:'f',arguments:args},4000);await h.raw({type:'response.output_item.done',item:{...tool,arguments:args}},4000);
  await h.raw({type:'response.completed',response:{id:'tool',status:'completed',usage:{output_tokens:999}}},5000);
  const message={...assistant('tool','',999),content:[{type:'toolCall',id:'call|f',name:'fn',arguments:JSON.parse(args)}],stopReason:'toolUse'};await h.save(message);
  close(h.d.ledger.value,(count(args)-count(chunks[0]))/2);assert.equal(h.d.input.outputTokens,999);
  for(const changed of [{arguments:{value:'replaced'}},{id:'other|f'},{name:'other'},{namespace:'other'}])assert.equal(h.d.measurement.streamObservation({...message,content:[{...message.content[0],...changed}]}),undefined);
 }));
}finally{globalThis.fetch=savedFetch;}
suite.finish();

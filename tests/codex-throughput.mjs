// Offline observed-stream mathematics, identity, durable coverage and native
// usage preservation. No inference, credentials or private sessions.
import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {OutputWindow,CodexMeasurement,CodexThroughput,StreamAverage,StreamLedger,SessionInput,STREAM_ENTRY,STREAM_METRIC,POLICY,hash,formatRate} from '../patches/pi-live-throughput/codex-throughput.ts';
import {resolveReferenceTokenizer} from '../patches/pi-live-throughput/reference-tokenizer.ts';
import {count,model,assistant,close,harness,operation} from './codex-throughput-oracles.mjs';
let checks=0;
const test=(name,fn)=>{try{fn();checks++;}catch(e){e.message=`${name}: ${e.message}`;throw e;}};
const ref=resolveReferenceTokenizer();assert.equal(typeof ref,'function');
const numeric=()=>new OutputWindow(()=>text=>text.length);
const point=(w,t,text)=>{w.append('p',text);return w.checkpoint(t);};
function store(origin='own'){
 const entries=[];let serial=0;
 const manager={getSessionId:()=>origin,getEntries:()=>entries.slice(),getEntry:id=>entries.find(e=>e.id===id)};
 const append=(type,data)=>entries.push({id:`e${serial++}`,type:'custom',customType:type,data:structuredClone(data)});
 const saved=(message)=>{const id=`m${serial++}`;entries.push({type:'message',id,message});return id;};
 return {entries,manager,append,saved};
}
function controller(resolver){const s=store(),d=new CodexThroughput(resolver);d.bindLedger(s.manager,s.append);d.select(model);return {...s,d};}
function replay({target,id='r',request=0,times=[1000,1500,2000,2500],texts=times.map((_,i)=>`word${i} alpha beta gamma `),terminal=2700,output=140,terminalType='response.completed'}={}){
 const m=target??new CodexMeasurement(model.id);m.requestTime=request;let seq=0;
 const emit=(type,data,t)=>m.provider({type,sequence_number:seq++,...data},t);
 emit('response.created',{response:{id}},request+10);
 emit('response.output_item.added',{item:{id:'m',type:'message',role:'assistant'}},request+20);
 let text='';for(let i=0;i<texts.length;i++){text+=texts[i];emit('response.output_text.delta',{item_id:'m',content_index:0,delta:texts[i]},times[i]);m.checkpoint(times[i]);}
 emit('response.output_text.done',{item_id:'m',content_index:0,text},terminal);
 emit('response.output_item.done',{item:{id:'m',type:'message',role:'assistant',content:[{type:'output_text',text}]}},terminal);
 emit(terminalType,{response:{id,status:terminalType==='response.completed'?'completed':'failed',usage:output===null?{}:{output_tokens:output}}},terminal);
 m.freeze(terminal+100);
 const message=assistant(id,text,output??0);if(terminalType!=='response.completed')message.stopReason='error';
 return {m,text,message,emit};
}
function complete(options={}){const s=controller(options.resolver);s.d.prepare(model,options.request??0);const f=replay({...options,target:s.d.measurement});s.d.end(f.message);const id=s.saved(f.message);s.d.commitSaved(id,s.manager);return {...s,...f,id};}
const streamRate=f=>(count(f.text)-count('word0 alpha beta gamma '))/1.5;
for(const text of ['English const x=42;','Русский текст 世界 中文','😀🧑‍🚀','<|endoftext|><|im_start|>','{"name":"test","args":[1,2]}']){
 test('ordinary multilingual reference BPE',()=>assert.equal(ref(text),count(text)));
 test('chunk invariant full prefix incl surrogate halves',()=>{const w=new OutputWindow();for(const c of text.split(''))w.append('p',c);w.checkpoint(0);assert.equal(w.tokens,count(text));});
}
test('prefix not independent chunk token sums',()=>{const w=new OutputWindow();point(w,0,'hel');point(w,1000,'lo');assert.equal(w.tokens,count('hello'));assert.notEqual(w.tokens,count('hel')+count('lo'));});
test('unchanged parts cached',()=>{let n=0;const w=new OutputWindow(()=>s=>{n++;return count(s);});w.append('a','hello');w.append('b','{"a":');w.checkpoint(0);w.append('b','1}');w.checkpoint(200);w.checkpoint(400);assert.equal(n,3);});
for(const resolver of [()=>undefined,()=>{throw Error('missing');}])test('missing tokenizer fails closed',()=>{const w=new OutputWindow(resolver);point(w,0,'x');assert.equal(w.invalid,true);assert.equal(w.current(1000),undefined);});
for(const n of [NaN,Infinity,-1,1.5,Number.MAX_SAFE_INTEGER+1])test('invalid token counts fail closed',()=>{const w=new OutputWindow(()=>()=>n);point(w,0,'x');assert.equal(w.invalid,true);});
test('global 256Ki buffer limit clears RAM',()=>{const w=numeric();w.append('a','x'.repeat(POLICY.maxUnits));w.append('b','x');assert.equal(w.invalid,true);assert.equal(w.parts.size,0);assert.equal(w.units,0);});
test('LIVE first atomic checkpoint is fixed',()=>{const w=numeric();point(w,0,'x'.repeat(100));point(w,49,'x'.repeat(20));point(w,1000,'x'.repeat(30));assert.equal(w.estimatedCurrent,50);assert.equal(w.samples[0].tokens,100);});
test('LIVE exact 1s warmup resolution',()=>{const w=numeric();point(w,0,'a');point(w,999,'b');assert.equal(w.estimatedCurrent,undefined);w.checkpoint(1000,true);assert.equal(w.estimatedCurrent,1);});
for(const [amount,end,expected] of [[1,100000,.01],[222919,1000,222919],[0,1000,0]])test('LIVE no magnitude caps',()=>{const w=numeric();point(w,0,'x');point(w,end,'x'.repeat(amount));assert.equal(w.estimatedCurrent,expected);});
for(const t of [0,.0001,999])test('LIVE cannot time same-callback/short bursts',()=>{const w=numeric();point(w,0,'x');point(w,t,'x'.repeat(100));assert.equal(w.estimatedCurrent,undefined);});
test('active silence decays LIVE to real zero',()=>{const w=numeric();point(w,0,'x');point(w,1000,'x'.repeat(100));w.checkpoint(2000);assert.equal(w.estimatedCurrent,50);w.checkpoint(4000);assert.equal(w.estimatedCurrent,0);});
test('signed BPE corrections recover net positive LIVE',()=>{const w=new OutputWindow();point(w,0,' internatio');point(w,1000,'n');assert.equal(w.reason,'negative-prefix-difference');point(w,2000,' a'.repeat(20));assert.equal(w.estimatedCurrent,9.5);});
for(const t of [NaN,Infinity,-1,99])test('invalid/rollback clocks rejected',()=>{const w=numeric();point(w,100,'x');w.checkpoint(t);assert.equal(w.invalid,true);});
test('LIVE history bounded',()=>{const w=numeric();for(let i=0;i<30000;i++)point(w,i,'x');assert.ok(w.samples.length<=17);});
// AVG has its OWN full-response baseline, independent of LIVE rolling samples.
test('AVG removes first atomic chunk AND its untimed prehistory',()=>{const w=numeric();w.append('p','x'.repeat(100));w.content(10000);w.append('p','x'.repeat(50));w.content(12000);w.checkpoint(25000,true);assert.deepEqual(w.streamInterval(),{tokens:50,elapsedMs:2000});});
test('AVG last content time independent of encode cadence/terminal/timers',()=>{const w=numeric();w.append('p','x');w.content(1000);w.append('p','x'.repeat(10));w.content(2000);w.checkpoint(2000);w.append('p','x'.repeat(5));w.content(2100);w.checkpoint(6000,true);assert.deepEqual(w.streamInterval(),{tokens:15,elapsedMs:1100});});
test('same-time bursts retain first prefix but are unmeasured',()=>{const w=numeric();w.append('p','x');w.content(1000);w.append('p','x'.repeat(100));w.content(1000);w.checkpoint(20000,true);assert.equal(w.streamInterval(),'unmeasured');assert.equal(w.firstContent.tokens,1);});
test('empty output unmeasured, never zero throughput',()=>{const w=numeric();assert.equal(w.streamInterval(),'unmeasured');});
test('measured zero prefix difference is zero',()=>{const w=new OutputWindow(()=>()=>1);w.append('p','a');w.content(0);w.append('p','b');w.content(1000);w.checkpoint(1000,true);assert.deepEqual(w.streamInterval(),{tokens:0,elapsedMs:1000});});
test('whole response AVG independent of rolling LIVE history pruning',()=>{const w=numeric();for(let i=0;i<=20;i++){w.append('p','x'.repeat(i?10:1));w.content(i*1000);w.checkpoint(i*1000);}assert.ok(w.samples[0].t>0);assert.deepEqual(w.streamInterval(),{tokens:200,elapsedMs:20000});});
test('signed correction contributes to final AVG difference',()=>{const w=new OutputWindow();w.append('p',' internatio');w.content(0);w.append('p','n');w.content(1000);w.checkpoint(1000);w.append('p',' a'.repeat(20));w.content(2000);w.checkpoint(2000,true);assert.deepEqual(w.streamInterval(),{tokens:19,elapsedMs:2000});});
const f=replay();
test('AVG matches manual first-last content oracle; LIVE terminal tail unchanged',()=>{close(f.m.streamObservation(f.message).tokens,(count(f.text)-count('word0 alpha beta gamma ')));assert.equal(f.m.streamObservation(f.message).elapsedMs,1500);close(f.m.current(0),(count(f.text)-count('word0 alpha beta gamma '))/1.7);});
for(const output of [null,0,1,1000000])test('native volume cannot change either TPS',()=>{const g=replay({output});assert.equal(g.m.finish(g.message),true);assert.deepEqual(g.m.streamObservation(g.message),f.m.streamObservation(f.message));close(g.m.current(0),f.m.current(0));});
test('TTFT and terminal tail excluded from stream AVG',()=>{const g=replay({times:[10000,10500,11000,11500],terminal:50000});assert.equal(g.m.streamObservation(g.message).elapsedMs,1500);close(g.m.streamObservation(g.message).tokens,f.m.streamObservation(f.message).tokens);});
for(const times of [[1000],[1000,1000,1000],[1000,1100]])test('untimed/short streams do not invent TPS',()=>{const g=replay({times,terminal:15000});assert.equal(g.m.streamObservation(g.message),'unmeasured');});
for(const type of ['response.failed','response.incomplete','error'])test('failed final output cannot become validated stream AVG',()=>assert.equal(replay({terminalType:type}).m.streamObservation(assistant('r')),undefined));
test('missing reference runtime excludes both TPS but preserves native usage',()=>{const g=replay({target:new CodexMeasurement(model.id,()=>undefined)});assert.equal(g.m.streamObservation(g.message),undefined);assert.equal(g.m.observation(g.message).nativeTokens,140);});
test('oversize stream fails closed',()=>{const g=replay({texts:['a','x'.repeat(POLICY.maxUnits),'a','a']});assert.equal(g.m.streamObservation(g.message),undefined);assert.equal(g.m.window.parts.size,0);});
for(const bad of [{type:'response.in_progress',sequence_number:3},{type:'response.created',response:{id:'r'}},{type:'response.in_progress',response_id:'other'}])test('identity/sequence errors fail closed',()=>{const m=new CodexMeasurement(model.id);m.provider({type:'response.created',sequence_number:0,response:{id:'r'}},0);m.provider(bad,1);assert.equal(m.invalid,true);});
test('late raw callbacks cannot mutate frozen values',()=>{const g=replay();const before=g.m.streamObservation(g.message);g.m.provider({type:'response.completed',response:{id:'other'}},90000);assert.deepEqual(g.m.streamObservation(g.message),before);});
test('surrogate halves validate stable UTF16 hash',()=>{const g=replay({texts:['A\ud83d','\ude00 B',' alpha',' beta']});assert.equal(g.m.finish(g.message),true);assert.equal(g.m.window.tokens,count(g.text));});
test('saved text replacement invalidates stream AVG',()=>{const g=replay();assert.equal(g.m.streamObservation({...g.message,content:[{type:'text',text:'replacement'}]}),undefined);});
// Ratio of SUMS, independent of per-answer/rolling instantaneous TPS.
const rec=(kind,op,extra={},epoch='epoch',origin='own')=>({type:'custom',customType:STREAM_ENTRY,data:{v:1,metric:STREAM_METRIC,kind,origin,epoch,...(op?{operation:op}:{}),...extra}});
const obs=(op,tokens,ms,extra={})=>rec('observation',op,{responseHash:hash(op),provider:model.provider,api:model.api,model:model.id,tokens,elapsedMs:ms,...extra});
const epoch=rec('epoch');
test('weighted AVG 100/1s +100/10s =200/11, not55',()=>{const a=new StreamAverage();a.restore([epoch,rec('start','a'),obs('a',100,1000),rec('start','b'),obs('b',100,10000)],'own');close(a.value,200/11);assert.notEqual(a.value,55);});
test('unmeasured contributes neither time nor tokens',()=>{const a=new StreamAverage();a.restore([epoch,rec('start','a'),obs('a',100,1000),rec('start','b'),rec('unmeasured','b')],'own');assert.equal(a.value,100);assert.equal(a.unknown,false);assert.equal(a.observations,1);});
test('zero measured volume is zero, not unmeasured',()=>{const a=new StreamAverage();a.restore([epoch,rec('start','a'),obs('a',0,1000)],'own');assert.equal(a.value,0);});
test('pending preserves prior AVG; crash unclosed start unknown',()=>{const a=new StreamAverage(),e=[epoch,rec('start','a'),obs('a',100,1000),rec('start','p')];a.restore(e,'own',new Set(['p']));assert.equal(a.value,100);a.restore(e,'own');assert.equal(a.value,undefined);});
test('own branches/models summed; inherited foreign excluded',()=>{const a=new StreamAverage();a.restore([rec('epoch',undefined,{},'parent','foreign'),epoch,rec('start','a'),obs('a',100,1000),rec('start','b'),obs('b',300,1000,{model:'other'})],'own');assert.equal(a.value,200);});
test('duplicate response and entries idempotent; conflicts unknown',()=>{const a=new StreamAverage(),e=[epoch,rec('start','a'),obs('a',100,1000)];a.restore([...e,...e],'own');assert.equal(a.value,100);assert.equal(a.observations,1);a.restore([...e,obs('a',200,1000)],'own');assert.equal(a.value,undefined);});
for(const e of [[epoch,obs('a',1,1000)],[epoch,rec('start','a'),rec('unknown','a')],[epoch,rec('start','a'),obs('a',Number.MAX_SAFE_INTEGER,1000),rec('start','b'),obs('b',1,1000)]])test('missing coverage and overflow fail closed',()=>{const a=new StreamAverage();a.restore(e,'own');assert.equal(a.value,undefined);});
test('malformed record cannot disappear; new epoch clears prior unknown',()=>{const a=new StreamAverage(),broken={type:'custom',customType:STREAM_ENTRY,data:{kind:'start'}};a.restore([epoch,broken],'own');assert.equal(a.unknown,true);a.restore([epoch,broken,rec('epoch',undefined,{},'fresh')],'own');assert.equal(a.unknown,false);});
test('replayed epoch cannot reverse reset or hide unknown',()=>{const a=new StreamAverage(),fresh=rec('epoch',undefined,{},'fresh');a.restore([epoch,rec('start','a'),obs('a',100,1000),fresh,rec('start','b',{},'fresh'),rec('observation','b',{...obs('b',300,1000).data,epoch:'fresh'},'fresh'),structuredClone(epoch)],'own');assert.equal(a.epoch,'fresh');assert.equal(a.value,300);});
test('legacy native metric is ignored, never remapped',()=>{const s=store();s.append('pi-harness:codex-native-throughput',{v:1,metric:'native-provider-operation',kind:'epoch',origin:'own',epoch:'old'});const l=new StreamLedger();l.bind(s.manager,s.append);assert.notEqual(l.epoch,'old');assert.equal(l.value,undefined);assert.equal(s.entries.at(-1).customType,STREAM_ENTRY);});
test('missing durable manager does not throw',()=>{const l=new StreamLedger();l.bind(undefined,()=>{});assert.equal(l.begin(),undefined);l.reset();assert.equal(l.value,undefined);});
test('memory append then disk exception never duplicates',()=>{const s=store(),l=new StreamLedger();let n=0;l.bind(s.manager,(t,r)=>{n++;s.append(t,r);if(r.kind!=='epoch')throw Error('disk');});const op=l.begin();l.end(op);l.end(op);assert.equal(n,3);assert.equal(l.value,undefined);});
// Controller lifecycle including LIVE-only reset independent of ongoing AVG.
test('commit only final saved assistant, not message_end',()=>{const s=controller();s.d.prepare(model,0);const g=replay({target:s.d.measurement});s.d.end(g.message);assert.equal(s.d.ledger.value,undefined);s.d.commitSaved(s.saved(g.message),s.manager);close(s.d.ledger.value,streamRate(g));});
test('saved replacement poisons coverage rather than averaging different text',()=>{const s=controller();s.d.prepare(model,0);const g=replay({target:s.d.measurement});s.d.end(g.message);s.d.commitSaved(s.saved({...g.message,content:[{type:'text',text:'changed'}]}),s.manager);assert.equal(s.d.ledger.value,undefined);assert.equal(s.d.ledger.average.unknown,true);});
test('exact adjacent two-number format; native in/out independent',()=>{const s=complete();assert.equal(s.d.render('status',0),`${formatRate(s.d.heldRate)} ${formatRate(streamRate(s))} TPS hit - in 0 out 0`);assert.equal(controller().d.render('status',0),'- - TPS hit - in 0 out 0');});
test('native total never rescales either counter',()=>{const a=complete({output:1}),b=complete({output:1000000});close(a.d.heldRate,b.d.heldRate);close(a.d.ledger.value,b.d.ledger.value);assert.equal(a.d.ledger.average.tokens,b.d.ledger.average.tokens);});
test('LAST stays idle and during new warmup',()=>{const s=complete(),held=s.d.heldRate;s.d.prepare(model,30000);assert.ok(s.d.render('status',30000).startsWith(formatRate(held)));assert.equal(s.d.measurement.current(30000),undefined);});
test('duplicate end/commit idempotent',()=>{const s=complete(),tokens=s.d.ledger.average.tokens;s.d.end(s.message);s.d.commitSaved(s.id,s.manager);assert.equal(s.d.ledger.average.tokens,tokens);});
test('model switch clears LIVE not AVG',()=>{const s=complete(),avg=s.d.ledger.value;s.d.select({...model,id:'other'});assert.equal(s.d.heldRate,undefined);assert.equal(s.d.ledger.value,avg);s.d.select({provider:'generic',api:'generic',id:'generic'});assert.match(s.d.render('status',0),/^- - TPS/);});
test('reset LIVE mid-stream preserves stream AVG content/time',()=>{const s=controller();s.d.prepare(model,0);s.d.reset();const g=replay({target:s.d.measurement});s.d.end(g.message);s.d.commitSaved(s.saved(g.message),s.manager);assert.equal(s.d.heldRate,undefined);close(s.d.ledger.value,streamRate(g));});
test('AVG reset discards inflight before deferred SDK start',()=>{const s=controller();s.d.prepare(model,0);s.d.provider({type:'response.created',response:{id:'r'}},10);s.d.resetAverage();s.d.start(assistant('r'));s.d.end(assistant('r'));s.d.commitSaved(s.saved(assistant('r')),s.manager);assert.equal(s.d.ledger.average.observations,0);assert.equal(s.d.ledger.average.unknown,false);});
test('missing saved turn boundary makes coverage unknown',()=>{const s=controller();s.d.prepare(model,0);replay({target:s.d.measurement});s.d.closeUnknown();assert.equal(s.d.ledger.average.unknown,true);});
test('reload restores measured sums, unclosed crash unknown',()=>{const s=complete(),l=new StreamLedger();l.bind(s.manager,s.append);close(l.value,s.d.ledger.value);s.d.prepare(model,10000);const crashed=new StreamLedger();crashed.bind(s.manager,s.append);assert.equal(crashed.value,undefined);crashed.reset();assert.equal(crashed.average.unknown,false);});
test('persisted records privacy whitelist',()=>{const s=complete(),allowed=new Set(['v','metric','kind','origin','epoch','operation','responseHash','provider','api','model','tokens','elapsedMs']);for(const e of s.entries.filter(e=>e.type==='custom'))for(const k of Object.keys(e.data))assert.ok(allowed.has(k),k);assert.equal(JSON.stringify(s.entries).includes(s.text),true);assert.equal(JSON.stringify(s.entries.filter(e=>e.type==='custom')).includes(s.text),false);});
// Native in/out are NOT changed by replacement of AVG.
const a={role:'assistant',provider:'p',responseId:'a',usage:{input:100,cacheRead:900,cacheWrite:0,output:229000}},b={...a,responseId:'b',usage:{input:200,cacheRead:1700,cacheWrite:100,output:10}};
test('native in/out cache hit unchanged',()=>{const i=new SessionInput();i.restore([{type:'message',message:a},{type:'message',message:b}]);assert.equal(i.fields(),'hit 85.0% in 3.0k out 229.0k');});
test('native reasoning stays within usage.output, never multiplied',()=>{const i=new SessionInput();i.add({...a,usage:{...a.usage,output:320,reasoning:300}});assert.equal(i.outputTokens,320);});
test('native usage ID/entry dedup',()=>{const i=new SessionInput();i.add(a);i.add({...a});assert.equal(i.outputTokens,229000);i.restore([{type:'message',id:'x',message:a},{type:'message',id:'x',message:b}]);assert.equal(i.outputTokens,229000);});
test('missing output not fabricated, later valid usage accepted',()=>{const i=new SessionInput();i.add({...a,usage:{input:100,cacheRead:900,cacheWrite:0}});assert.equal(i.tokens,0);i.add(a);assert.equal(i.tokens,1000);});
test('auxiliary costs only native in/out',()=>{const i=new SessionInput(),u={input:10,cacheRead:20,cacheWrite:0,output:5};i.restore([{type:'message',message:a},{type:'usage',usage:u},{type:'compaction',usage:u},{type:'branch_summary',usage:u},{type:'message',message:{role:'toolResult',usage:u}}]);assert.equal(i.outputTokens,229020);assert.equal(i.tokens,1120);});
test('format no magnitude censorship',()=>{for(const n of [NaN,Infinity,-1])assert.equal(formatRate(n),'-');assert.equal(formatRate(0),'~0.0');assert.equal(formatRate(222919.7),'~222919.7');});
test('600 exact monotonic window schedules',()=>{let seed=17,n=0;const rand=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/2**32;};for(let run=0;run<600;run++){const w=numeric();let t=0;for(let i=0;i<30;i++){t+=200+rand()*800;point(w,t,'x'.repeat(Math.floor(rand()*200)));if(w.estimatedCurrent!==undefined){const base=w.samples[0];close(w.estimatedCurrent,(w.tokens-base.tokens)*1000/(t-base.t));n++;}}}assert.ok(n>10000);});
let calls=0;const w=new OutputWindow(()=>s=>{calls++;return count(s);});const started=performance.now();for(let i=0;i<50000;i++){w.append('p','a b c '[i%6]);w.checkpoint(i/10);}w.checkpoint(5000,true);test('50k callbacks bounded encoding',()=>{assert.ok(calls<=27);assert.equal(w.tokens,count(w.parts.get('p').text));});console.log(`BENCH: 50k callbacks, ${calls} encodes, ${(performance.now()-started).toFixed(1)}ms`);
// Real installed loader/SessionManager/runner, synthetic operations only.
const savedFetch=globalThis.fetch;globalThis.fetch=()=>{throw Error('Network forbidden');};
try{
 const h=await harness();try{
  const g=await operation(h,{duration:15000,output:1000000,texts:[' seed',' a'.repeat(100)],times:[10000,12000]});await g.save();
  test('actual loader stream AVG and native out independent',()=>{close(h.d.ledger.value,50);assert.match(h.line,/ ~50\.0 TPS.*out 1\.00M$/);});
  await h.command('reset');test('actual command LIVE reset preserves AVG',()=>assert.match(h.line,/^- ~50\.0 TPS/));
  await h.command('reset-avg');test('actual command AVG reset starts empty epoch',()=>{assert.equal(h.d.ledger.value,undefined);assert.equal(h.d.input.outputTokens,1000000);});
 }finally{await h.dispose();}
}finally{globalThis.fetch=savedFetch;}
console.log(`PASS: ${checks} offline stream/reference/stream-ledger/controller/real-loader checks + 600 mathematical schedule replays; zero inference`);

// Real installed subscription SSE parser and native WebSocket queue. All fetches
// and sockets are fixtures. Delivery driver (NOT metrics hooks) sets test clocks.
import assert from 'node:assert/strict';
import {setTimeout as delay, setImmediate as nextTask} from 'node:timers/promises';
import {Suite,harness,model,count,close,installed} from './codex-throughput-oracles.mjs';
const suite=new Suite('native-transport');
const {stream,closeOpenAICodexWebSocketSessions,getOpenAICodexWebSocketDebugStats}=await installed('node_modules/@earendil-works/pi-ai/dist/api/openai-codex-responses.js');
const jwt=['{}',JSON.stringify({'https://api.openai.com/auth':{chatgpt_account_id:'OFFLINE-SYNTHETIC'}}),'dummy'].map(s=>Buffer.from(s).toString('base64url')).join('.');
const user={role:'user',content:[{type:'text',text:'offline fixture only'}],timestamp:0};
const oldFetch=globalThis.fetch,oldSocket=globalThis.WebSocket;
globalThis.fetch=()=>{throw Error('Network forbidden in transport tests');};
function deferred(){let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};}
function frames({id='response',output=320,details={reasoning_tokens:300},terminal='response.completed',texts=[' seed',' alpha',' beta',' gamma'],controls=true}={}){
 const list=[];const add=(t,data)=>list.push({t,data});
 if(controls)add(10,{type:'rate_limits.updated',rate_limits:[]});
 add(100,{type:'response.created',response:{id}});
 add(200,{type:'response.output_item.added',output_index:0,item:{type:'reasoning',id:'reasoning',summary:[]}});
 add(210,{type:'response.reasoning_summary_text.delta',item_id:'reasoning',output_index:0,summary_index:0,delta:'OFFLINE invisible reasoning'});
 add(220,{type:'response.output_item.done',output_index:0,item:{type:'reasoning',id:'reasoning',summary:[]}});
 add(300,{type:'response.output_item.added',output_index:1,item:{type:'message',role:'assistant',id:'message',content:[]}});
 add(310,{type:'response.content_part.added',output_index:1,item_id:'message',content_index:0,part:{type:'output_text',text:''}});
 for(let i=0;i<texts.length;i++)add(1000+i*500,{type:'response.output_text.delta',output_index:1,item_id:'message',content_index:0,delta:texts[i]});
 const end=Math.max(3000,1000+(texts.length-1)*500);const text=texts.join('');
 add(end-2,{type:'response.output_text.done',output_index:1,item_id:'message',content_index:0,text});
 add(end-1,{type:'response.output_item.done',output_index:1,item:{type:'message',role:'assistant',id:'message',content:[{type:'output_text',text}]}});
 const usage={input_tokens:1000,input_tokens_details:{cached_tokens:900}};
 if(output!==null)usage.output_tokens=output;if(details!==undefined)usage.output_tokens_details=details;
 add(end,{type:terminal,response:{id,model:model.id,status:terminal==='response.completed'?'completed':terminal==='response.incomplete'?'incomplete':'failed',usage,error:{code:'offline_failure',message:'OFFLINE fixture failure'}}});
 list.forEach((frame,i)=>frame.data.sequence_number=i);return {list,text,texts,end};
}
const frameBytes=data=>new TextEncoder().encode(`data: ${JSON.stringify(data)}\n\n`);
class MockSocket extends EventTarget {
 static scripts=[];static sent=[];static connections=0;
 constructor(){super();this.readyState=0;MockSocket.connections++;queueMicrotask(()=>{this.readyState=1;this.dispatchEvent(new Event('open'));});}
 send(raw){MockSocket.sent.push(JSON.parse(raw));const script=MockSocket.scripts.shift();assert.ok(script,'unexpected native WS request');setImmediate(()=>script(this));}
 deliver(data){const event=new Event('message');Object.defineProperty(event,'data',{value:typeof data==='string'?data:JSON.stringify(data)});this.dispatchEvent(event);}
 close(code=1000,reason='fixture closed'){if(this.readyState===3)return;this.readyState=3;const e=new Event('close');Object.assign(e,{code,reason,wasClean:code===1000});this.dispatchEvent(e);}
}
globalThis.WebSocket=MockSocket;
async function run(h,f,{transport='sse',buffered=false,sessionId,context={messages:[user]},scheduledReal=false,slowNeighbor=false,base=0,missingEnd=false}={}){
 const seen=[];let fetches=0;let startedAt;let pending;let controller;let driver;let driverError;let streamDone=false;
 if(slowNeighbor)h.runner.extensions.push({path:'offline-slow-neighbor',handlers:new Map([['provider_stream_event',[async()=>delay(5)]]])});
 async function deliver(push){
  try{
   for(const frame of f.list){
    if(streamDone)break;
    if(scheduledReal)await delay(Math.max(0,base+frame.t-h.state.clockNow()));
    else {await nextTask();h.state.clock=base+frame.t;}
    pending=deferred();push(frame.data);
    await pending.promise;
   }
   controller?.close();
  }catch(error){driverError=error;controller?.error(error);}
 }
 if(transport!=='sse')MockSocket.scripts.push(socket=>{
  if(buffered){h.state.clock=base+f.end;for(const frame of f.list)socket.deliver(frame.data);}
  else driver=deliver(data=>socket.deliver(data));
 });
 const response=stream(model,context,{apiKey:jwt,transport,maxRetries:0,sessionId,timeoutMs:30000,
  fetch:async()=>{
   fetches++;
   if(buffered){h.state.clock=base+f.end;return new Response(f.list.map(({data})=>`data: ${JSON.stringify(data)}\n\n`).join(''),{headers:{'content-type':'text/event-stream'}});}
   const body=new ReadableStream({start(c){controller=c;driver=deliver(data=>c.enqueue(frameBytes(data)));}});
   return new Response(body,{headers:{'content-type':'text/event-stream'}});
  },
  onPayload:async()=>{h.state.clock=base;startedAt=h.state.clockNow?.()??h.state.clock;await h.emit('before_provider_request');},
  onProviderStreamEvent:async data=>{
   // Clock ONLY read, never advanced here. Awaited neighbor backpressure is real.
   seen.push({data,t:h.state.clockNow?.()??h.state.clock});
   await h.raw(data);pending?.resolve();
  },
 });
 let message,partial,save;
 try{
  for await(const event of response){
   if(event.type==='start'){partial=event.partial;await h.emit('message_start',{message:partial});}
   else if(event.type==='done'||event.type==='error'){message=await response.result();
    if(missingEnd)await h.runner.emitMessageEnd({type:'message_end',message});else save=await h.save(message);
   }else await h.emit('message_update',{message:event.partial,assistantMessageEvent:event});
  }
 }finally{streamDone=true;pending?.resolve();}
 if(driver)await driver;if(driverError)throw driverError;
 assert.equal(fetches,transport==='sse'?1:0,'native WS must not call SSE fallback');
 return {message,partial,save,seen,startedAt};
}
async function fixture(fn,options){const h=await harness(options);try{await fn(h);}finally{closeOpenAICodexWebSocketSessions();await h.dispose();}}
try{
 for(const transport of ['sse','websocket'])await suite.test(`${transport}: whole-body queued burst does NOT fabricate timed LIVE; native includes TTFT`,()=>fixture(async h=>{
  const f=frames();const result=await run(h,f,{transport,buffered:true});assert.equal(result.message.stopReason,'stop');
  assert.match(h.line,/^- - TPS/);assert.equal(h.d.heldRate,undefined);assert.equal(h.d.ledger.value,undefined);
  assert.equal(new Set(result.seen.map(s=>s.t)).size,1);assert.equal(h.d.ledger.average.elapsedMs,0);assert.equal(h.d.ledger.average.unknown,false);
 }));
 for(const transport of ['sse','websocket'])await suite.test(`${transport}: scheduled external fixture clocks + native parser exact reference count`,()=>fixture(async h=>{
  const f=frames();const result=await run(h,f,{transport});assert.equal(result.message.stopReason,'stop');
  close(h.d.heldRate,(count(f.text)-count(f.texts[0]))/2);close(h.d.ledger.value,(count(f.text)-count(f.texts[0]))/1.5);
  assert.equal(h.d.measurement.window.tokens,count(f.text));assert.equal(result.seen.length,f.list.length);assert.equal(h.d.measurement.invalid,false);
  assert.equal(h.line,`~${((count(f.text)-count(f.texts[0]))/2).toFixed(1)} ~${((count(f.text)-count(f.texts[0]))/1.5).toFixed(1)} TPS hit 90.0% in 1.0k out 320`);
 }));
 for(const transport of ['sse','websocket'])await suite.test(`${transport}: terminal failure with trustworthy raw usage counts despite SDK normalized zeros`,()=>fixture(async h=>{
  const f=frames({terminal:'response.failed'});const result=await run(h,f,{transport});assert.equal(result.message.stopReason,'error');assert.equal(h.d.ledger.value,undefined);assert.equal(h.d.ledger.average.gaps,1);assert.equal(h.d.ledger.average.unknown,false);
 }));
 await suite.test('SSE: missing native total does not invalidate observed stream AVG',()=>fixture(async h=>{
  const f=frames({output:null});const result=await run(h,f,{});assert.equal(result.message.usage.output,0);close(h.d.ledger.value,(count(f.text)-count(f.texts[0]))/1.5);assert.equal(h.d.ledger.average.unknown,false);
 }));
 await suite.test('SSE: true surrogate halves + multilingual/special-looking prefixes ordinary BPE',()=>fixture(async h=>{
  const texts=['<|endoftext|> Русский 中文 \ud83d','\ude00',' 世界',' code'];const f=frames({texts});const result=await run(h,f);
  assert.equal(result.message.content.find(p=>p.type==='text').text,texts.join(''));assert.equal(h.d.measurement.window.tokens,count(texts.join('')));close(h.d.ledger.value,(count(f.text)-count(f.texts[0]))/1.5);
 }));
 await suite.test('SSE: chunk-invariant full prefix, native total changes neither TPS',async()=>{
  let held;for(const output of [1,1000000])await fixture(async h=>{
   const f=frames({output});await run(h,f);if(held===undefined)held=h.d.heldRate;else close(h.d.heldRate,held);close(h.d.ledger.value,(count(f.text)-count(f.texts[0]))/1.5);
  });
 });
 await suite.test('SSE: genuine pre-created response.in_progress identity accepted',()=>fixture(async h=>{
  const f=frames();f.list[0].data={type:'response.in_progress',sequence_number:0,response:{id:'response'}};await run(h,f);assert.equal(h.d.measurement.invalid,false);close(h.d.ledger.value,(count(f.text)-count(f.texts[0]))/1.5);
 }));
 await suite.test('SSE: buffered malformed content-before-created poisons coverage, not held LAST',()=>fixture(async h=>{
  await run(h,frames({id:'good'}));const held=h.d.heldRate;
  const f=frames({id:'bad'});f.list.unshift({t:50,data:{type:'response.output_text.delta',item_id:'no-item',content_index:0,delta:'bad'}});f.list.forEach((frame,i)=>frame.data.sequence_number=i);
  await run(h,f,{buffered:true,base:10000});assert.equal(h.d.ledger.average.gaps,1);assert.equal(h.d.ledger.average.unknown,false);close(h.d.heldRate,held);close(h.d.ledger.value,(count(frames().text)-count(frames().texts[0]))/1.5);
 }));
 await suite.test('real scheduled ReadableStream + slow ExtensionRunner neighbor, no clock mutation in hooks',async()=>{
  const epoch=performance.now();const clock=()=>performance.now()-epoch;
  await fixture(async h=>{
   // Actual wall-time fixture (~1.6s), distinct from deterministic schedules.
   const f=frames({texts:[' seed',' alpha',' beta']});
   const times=[0,5,10,15,20,25,30,100,700,1200,1500,1501,1600];assert.equal(times.length,f.list.length);f.list.forEach((x,i)=>x.t=times[i]);f.end=1600;
   const result=await run(h,f,{scheduledReal:true,slowNeighbor:true});
   const deltas=result.seen.filter(x=>x.data.type==='response.output_text.delta');
   close(h.d.ledger.average.tokens,count(f.text)-count(f.texts[0]));assert.ok(h.d.ledger.average.elapsedMs>=1000&&h.d.ledger.average.elapsedMs<5000);
   // Adjacent extension readings can differ slightly. AVG follows first→last
   // actual content callback, NOT request start→terminal callback.
   assert.ok(Math.abs(h.d.ledger.average.elapsedMs-(deltas.at(-1).t-deltas[0].t))<20);
   assert.equal(h.d.measurement.window.tokens,count(f.text));assert.ok(h.d.heldRate>0);assert.ok(h.d.heldRate<20);
  },{clock});
 });
 for(const known of [false,true])await suite.test(`native WS retry queue prior terminal usage ${known?'known sum120':'missing UNKNOWN'}`,()=>fixture(async h=>{
  const id=known?'known-retry':'unknown-retry';const prior=[
   {t:100,data:{type:'response.created',sequence_number:0,response:{id:'old'}}},
   {t:200,data:{type:'response.failed',sequence_number:1,response:{id:'old',status:'failed',...(known?{usage:{output_tokens:20}}:{}),error:{code:'previous_response_not_found',message:'OFFLINE retry fixture'}}}},
  ];
  // Actual native provider retry is performed by its processWebSocketStream loop,
  // not by a manually injected second before_provider_request.
  let pending;let driverError;const drivers=[];const seen=[];
  const script=list=>socket=>{const driver=(async()=>{for(const frame of list){await nextTask();h.state.clock=frame.t;pending=deferred();socket.deliver(frame.data);await pending.promise;}})().catch(error=>driverError=error);drivers.push(driver);};
  MockSocket.scripts.push(script(prior),script([
   {t:500,data:{type:'response.queued',sequence_number:0,response:{id:'new'}}},
   {t:501,data:{type:'response.created',sequence_number:1,response:{id:'new'}}},
   {t:1000,data:{type:'response.completed',sequence_number:2,response:{id:'new',status:'completed',usage:{output_tokens:100}}}},
  ]));
  const response=stream(model,{messages:[user]},{apiKey:jwt,transport:'websocket',sessionId:id,maxRetries:0,fetch:()=>{throw Error('No fallback allowed');},onPayload:async()=>h.emit('before_provider_request',{},0),onProviderStreamEvent:async data=>{seen.push(data.type);await h.raw(data);pending.resolve();}});
  for await(const event of response){if(event.type==='start')await h.emit('message_start',{message:event.partial});else if(['done','error'].includes(event.type))await h.save(await response.result());}
  await Promise.all(drivers);if(driverError)throw driverError;
  assert.equal(seen.filter(x=>x==='response.created').length,2);assert.equal(h.d.measurement.invalid,false);
  assert.equal(h.d.ledger.value,undefined);assert.equal(h.d.ledger.average.unknown,false);assert.equal(h.manager.getEntries().at(-1).data.kind,'unmeasured');
 }));
 await suite.test('native WS cached connection + real previous_response_id continuation stays separate operations',()=>fixture(async h=>{
  const sessionId='offline-cached-native';const initial=MockSocket.connections;const sent=MockSocket.sent.length;
  const first=await run(h,frames({id:'cache-one',output:100}),{transport:'websocket-cached',sessionId});
  const secondUser={role:'user',content:[{type:'text',text:'second fixture turn'}],timestamp:1};
  await run(h,frames({id:'cache-two',output:200}),{transport:'websocket-cached',sessionId,base:10000,context:{messages:[user,first.message,secondUser]}});
  assert.equal(MockSocket.connections-initial,1);assert.equal(MockSocket.sent[sent+1].previous_response_id,'cache-one');
  close(h.d.ledger.value,(count(frames().text)-count(frames().texts[0]))/1.5);assert.equal(h.d.ledger.average.elapsedMs,3000);
  assert.equal(getOpenAICodexWebSocketDebugStats(sessionId).connectionsReused,1);
 }));
 await suite.test('native WS connection close after completion does not duplicate saved native observation',()=>fixture(async h=>{
  const result=await run(h,frames(),{transport:'websocket'});assert.equal(result.message.stopReason,'stop');
  const records=h.manager.getEntries().filter(e=>e.customType==='pi-harness:codex-stream-throughput'&&e.data.kind==='observation');assert.equal(records.length,1);close(h.d.ledger.value,(count(frames().text)-count(frames().texts[0]))/1.5);
 }));
 await suite.test('actual SSE error without turn_end becomes durable UNKNOWN at settle',()=>fixture(async h=>{
  await run(h,frames({terminal:'response.failed'}),{missingEnd:true});assert.equal(h.d.ledger.value,undefined);
  await h.emit('agent_before_settle');assert.equal(h.d.ledger.average.gaps,1);assert.equal(h.d.ledger.average.unknown,false);assert.equal(h.manager.getEntries().at(-1).data.kind,'unknown');
 }));
}finally{
 closeOpenAICodexWebSocketSessions();globalThis.fetch=oldFetch;globalThis.WebSocket=oldSocket;
}
suite.finish();

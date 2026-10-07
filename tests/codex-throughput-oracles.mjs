// Independent offline acceptance helpers + reference/math oracles. Never reads
// auth, settings or private sessions. Synthetic clocks are NOT network evidence.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir,homedir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {OutputWindow, NativeAverage, NATIVE_ENTRY, NATIVE_METRIC, hash} from '../patches/pi-live-throughput/codex-throughput.ts';
export const repo=dirname(dirname(fileURLToPath(import.meta.url)));
const globalRoot=process.env.PI_CLI_ROOT?undefined:spawnSync('npm',['root','-g'],{encoding:'utf8'});
if(globalRoot)assert.equal(globalRoot.status,0);
export const piRoot=process.env.PI_CLI_ROOT??join(globalRoot.stdout.trim(),'@earendil-works/pi-coding-agent');
export const installed=async path=>import(pathToFileURL(join(piRoot,path)).href);
const runtime=process.env.TPS_TOKENIZER_DIR??join(process.env.PI_CODING_AGENT_DIR??process.env.PI_AGENT_DIR??join(homedir(),'.pi/agent'),'tps-runtime');
const require=createRequire(join(resolve(runtime),'package.json'));
const {encode}=require('gpt-tokenizer/encoding/o200k_base');
export const count=text=>encode(text,{allowedSpecial:new Set(),disallowedSpecial:new Set()}).length;
export const close=(actual,expected)=>assert.ok(typeof actual==='number'&&Math.abs(actual-expected)<=1e-10*Math.max(1,Math.abs(expected)),`${actual} != ${expected}`);
export const model={api:'openai-codex-responses',provider:'openai-codex',id:'gpt-6.1-sol',name:'OFFLINE',baseUrl:'https://invalid.test/backend-api',reasoning:true,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:272000,maxTokens:1000};
export const assistant=(id,text='',output=100,actual=model)=>({role:'assistant',api:actual.api,provider:actual.provider,model:actual.id,responseId:id,stopReason:'stop',content:[{type:'text',text}],usage:{input:100,cacheRead:900,cacheWrite:0,output},timestamp:0});
export class Suite {
 constructor(name){this.name=name;this.passed=0;this.failed=[];}
 async test(name,fn){try{await fn();this.passed++;}catch(error){this.failed.push({name,error});console.error(`FAIL ${this.name}: ${name}\n${error.stack}`);}}
 finish(){console.log(`${this.name}: ${this.passed} PASS, ${this.failed.length} FAIL; offline, zero inference`);if(this.failed.length)process.exitCode=1;}
}
export async function harness({manager,missingTokenizer=false,extraPaths=[],clock}={}){
 const temp=mkdtempSync(join(tmpdir(),'tps-acceptance-'));
 const {loadExtensions}=await installed('dist/core/extensions/loader.js');
 const {ExtensionRunner}=await installed('dist/core/extensions/runner.js');
 const {SessionManager}=await installed('dist/core/session-manager.js');
 const key=`__tpsAcceptance${Math.random().toString(36).slice(2)}`;
 const state={clock:0,clockNow:clock,controller:undefined};globalThis[key]=state;
 const source=process.env.THROUGHPUT_SOURCE??join(repo,'patches/pi-live-throughput/index.ts');
 const bridge=join(temp,'fixture.ts');
 writeFileSync(bridge,`import {createThroughputExtension} from ${JSON.stringify(source)}; export default function(pi){globalThis[${JSON.stringify(key)}].controller=createThroughputExtension(pi,{clock:()=>globalThis[${JSON.stringify(key)}].clockNow?.()??globalThis[${JSON.stringify(key)}].clock${missingTokenizer?',resolver:()=>undefined':''}});}`);
 const loaded=await loadExtensions([bridge,...extraPaths],temp);assert.deepEqual(loaded.errors,[]);
 manager??=SessionManager.inMemory(temp);
 const runner=new ExtensionRunner(loaded.extensions,loaded.runtime,temp,manager,{});
 const statuses=new Map();const widgets=new Map();let footer;let selected=model;let failAppend;
 const ui={setStatus:(key,value)=>{if(value===undefined)statuses.delete(key);else statuses.set(key,value);},setWidget:(key,value)=>{if(value===undefined)widgets.delete(key);else widgets.set(key,value);},setFooter:factory=>{footer=factory?.({}, {}, {getExtensionStatuses:()=>statuses});},notify:()=>{},setTitle:()=>{},setHeader:()=>{}};
 runner.setUIContext(ui,'interactive');runner.getModel=()=>selected;
 loaded.runtime.appendEntry=(type,data)=>{const result=runner.sessionManager.appendCustomEntry(type,data);if(failAppend?.(data))throw Error('injected disk failure AFTER memory append');return result;};
 const errors=[];runner.onError(error=>errors.push(error));
 const h={temp,state,loaded,runner,ui,statuses,widgets,SessionManager,
  get manager(){return runner.sessionManager;},set manager(value){runner.sessionManager=value;},
  get d(){return state.controller;},get footer(){return footer;},get line(){return statuses.get('throughput')??widgets.get('throughput')?.join(' ');},
  set model(value){selected=value;},get model(){return selected;},set failAppend(value){failAppend=value;},
  async emit(type,event={},at=state.clock){state.clock=at;await runner.emit({type,...event});assert.deepEqual(errors,[]);},
  async raw(data,at=state.clock,actual=selected){await h.emit('provider_stream_event',{api:actual.api,provider:actual.provider,model:actual.id,data},at);},
  async command(arg){await loaded.extensions[0].commands.get('throughput').handler(arg,runner.createCommandContext());assert.deepEqual(errors,[]);},
  async save(message,{replacement}={}){
   // Actual runner replacement pipeline; saved object is finalized BEFORE the
   // real turn_end boundary resolves its SessionManager entry.
   let ext;
   if(replacement){ext={path:'offline-replacement',handlers:new Map([['message_end',[()=>({message:replacement(message)})]]])};runner.extensions.push(ext);}
   try {const saved=await runner.emitMessageEnd({type:'message_end',message})??message;assert.deepEqual(errors,[]);
    const id=h.manager.appendMessage(saved);
    await runner.emitBoundary({type:'turn_end',turnIndex:0,message:saved,messageEntryId:id,toolResults:[],toolResultEntryIds:[],outcome:saved.stopReason},()=>({canContinue:false,messages:[],entries:[]}));
    assert.deepEqual(errors,[]);return {id,message:saved};
   }finally{if(ext)runner.extensions.splice(runner.extensions.indexOf(ext),1);}
  },
  async dispose(){try{await h.emit('session_shutdown');}finally{delete globalThis[key];rmSync(temp,{recursive:true,force:true});}},
 };
 await h.emit('session_start');return h;
}
export async function operation(h,{id='r',start=0,duration=1000,output=100,texts=[],times=[],usageDetails,terminalType='response.completed',unsupported=false,actual=h.model,early}={}){
 await h.emit('before_provider_request',{},start);let seq=0;
 const raw=(type,data,t)=>h.raw({type,sequence_number:seq++,...data},t,actual);
 await raw('rate_limits.updated',{rate_limits:[]},start);
 await raw('response.created',{response:{id}},start);
 await h.emit('message_start',{message:{...assistant(id,'',output,actual),responseId:undefined}},start);
 let text='';
 if(texts.length){await raw('response.output_item.added',{output_index:0,item:{type:'message',role:'assistant',id:'msg',content:[]}},start);
  for(let i=0;i<texts.length;i++){text+=texts[i];await raw('response.output_text.delta',{output_index:0,item_id:'msg',content_index:0,delta:texts[i]},start+times[i]);}
  const end=start+duration;
  await raw('response.output_text.done',{output_index:0,item_id:'msg',content_index:0,text},end);
  await raw('response.output_item.done',{output_index:0,item:{type:'message',role:'assistant',id:'msg',content:[{type:'output_text',text}]}},end);
 }
 if(unsupported)await raw('response.output_item.added',{output_index:1,item:{type:'image_generation_call',id:'img'}},start+duration);
 const usage={input_tokens:1000,input_tokens_details:{cached_tokens:900}};
 if(output!==null)usage.output_tokens=output;
 if(usageDetails!==undefined)usage.output_tokens_details=usageDetails;
 await raw(terminalType,{response:{id,status:terminalType==='response.completed'?'completed':'failed',model:actual.id,usage}},start+duration);
 const message=assistant(id,text,output??0,actual);if(terminalType!=='response.completed')message.stopReason='error';
 if(early)await early(message);
 return {message,text,save:options=>h.save(message,options)};
}
export const record=(origin,epoch,kind,operation,extra={})=>({v:1,metric:NATIVE_METRIC,origin,epoch,kind,...(operation?{operation}:{}),...extra});
export const entry=data=>({type:'custom',customType:NATIVE_ENTRY,data});
export function nativeFixture(tokens,ms){return {responseHash:hash(`${tokens}/${ms}`),provider:model.provider,api:model.api,model:model.id,nativeTokens:tokens,elapsedMs:ms};}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const suite=new Suite('independent-oracles');
 for(const text of ['<|endoftext|><|im_start|>','Русский язык и 中文 世界','😀🧑‍🚀','function foo(a){return {a:42}}'])await suite.test(`reference prefix ordinary text ${JSON.stringify(text)}`,()=>{
  const w=new OutputWindow(()=>count);for(let i=0;i<text.length;i++){w.append('p',text[i]);w.checkpoint(i*200);}w.checkpoint(text.length*200,true);assert.equal(w.tokens,count(text));
 });
 await suite.test('manual weighted sums, reasoning independent from live',()=>{
  const origin='own',epoch='enabled';const a=new NativeAverage();
  a.restore([entry(record(origin,epoch,'epoch')),entry(record(origin,epoch,'start','a')),entry(record(origin,epoch,'observation','a',nativeFixture(100,1000))),entry(record(origin,epoch,'start','b')),entry(record(origin,epoch,'observation','b',nativeFixture(100,10000)))],origin);
  close(a.value,200/11);assert.notEqual(a.value,55);
 });
 await suite.test('first atomic baseline, no hidden first-volume denominator',()=>{
  const w=new OutputWindow(()=>text=>text.length);w.append('p','x'.repeat(100));w.checkpoint(0);w.append('p','x'.repeat(20));w.checkpoint(49);w.append('p','x'.repeat(30));close(w.checkpoint(1000),50);
 });
 await suite.test('signed suffix changes may cancel; never stable-token counting',()=>{
  const w=new OutputWindow(()=>count);w.append('p',' internatio');w.checkpoint(0);w.append('p','n');w.checkpoint(1000);
  assert.equal(w.tokens,count(' internation'));assert.ok(count(' internation')<count(' internatio'));assert.equal(w.current(1000),undefined);
 });
 await suite.test('50k chars: expensive encoder only checkpoint cadence',()=>{
  let calls=0;const w=new OutputWindow(()=>text=>{calls++;return count(text);});const started=performance.now();
  for(let i=0;i<50000;i++){w.append('p',' a'[i%2]);w.checkpoint(i/10);}w.checkpoint(5000,true);
  assert.ok(calls<=27,`${calls} encodes`);assert.equal(w.tokens,count(' a'.repeat(25000)));console.log(`BENCH 50k callbacks: ${calls} encodes, ${(performance.now()-started).toFixed(1)}ms`);
 });
 suite.finish();
}

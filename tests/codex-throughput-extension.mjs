// Actual Pi loader + native SSE parser + status footer, entirely offline.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const agentDir = process.env.PI_CODING_AGENT_DIR ?? process.env.PI_AGENT_DIR ?? join(homedir(), '.pi/agent');
const source = process.env.THROUGHPUT_SOURCE ?? join(repo,'patches/pi-live-throughput/index.ts');
const globalRoot=spawnSync('npm',['root','-g'],{encoding:'utf8'});assert.equal(globalRoot.status,0);
const piRoot=process.env.PI_CLI_ROOT??join(globalRoot.stdout.trim(),'@earendil-works/pi-coding-agent');
const {loadExtensions}=await import(pathToFileURL(join(piRoot,'dist/core/extensions/loader.js')).href);
const savedFetch=globalThis.fetch;globalThis.fetch=()=>{throw new Error('Network disabled in TPS tests');};
const temp=mkdtempSync(join(tmpdir(),'safe-throughput-'));
let clock=0;const descriptor=Object.getOwnPropertyDescriptor(performance,'now');
Object.defineProperty(performance,'now',{value:()=>clock,configurable:true});
try {
 const loaded=await loadExtensions([source],temp);assert.deepEqual(loaded.errors,[]);const ext=loaded.extensions[0];
 let line;let footer;const statuses=new Map();
 const ctx={hasUI:true,model:{api:'openai-codex-responses',provider:'openai-codex',id:'test'},ui:{
  setWidget:(_key,lines)=>{if(lines)line=lines.join(' ');},
  setStatus:(key,value)=>{if(value){line=value;statuses.set(key,value);}else statuses.delete(key);},
  setFooter:factory=>{footer=factory?.({}, {}, {getExtensionStatuses:()=>statuses});},notify:()=>{},
 }};
 const emit=async(type,event={})=>{for(const handler of ext.handlers.get(type)??[])await handler({type,...event},ctx);};
 const command=ext.commands.get('throughput');assert.ok(command);
 let seq=0;
 const raw=async(type,data,t)=>{clock=t;await emit('provider_stream_event',{api:ctx.model.api,provider:ctx.model.provider,model:ctx.model.id,data:{type,sequence_number:seq++,...data}});};
 const base={role:'assistant',api:ctx.model.api,provider:ctx.model.provider,model:'test',content:[],usage:{input:0,cacheRead:0,cacheWrite:0,output:0}};
 await emit('session_start');await emit('before_provider_request');
 await raw('response.created',{response:{id:'r'}},100);await emit('message_start',{message:base});
 assert.equal(line,'- TPS hit - in 0 out 0');
 await raw('response.output_item.added',{item:{id:'m',type:'message'}},1000);
 let text='';for(let i=0;i<4;i++){const delta='abcd'.repeat(10);text+=delta;await raw('response.output_text.delta',{item_id:'m',content_index:0,delta},2000+i*500);}
 assert.equal(line,'~20.0 TPS hit - in 0 out 0');
 clock=99000;await command.handler('status',ctx);assert.match(line,/^- TPS/,'in-flight observation expires during idle');
 await raw('response.output_text.done',{item_id:'m',content_index:0,text},100000);
 await raw('response.output_item.done',{item:{id:'m',type:'message',content:[{type:'output_text',text}]}},101000);
 await raw('response.completed',{response:{id:'r',status:'completed',usage:{input_tokens:1000,input_tokens_details:{cached_tokens:900},output_tokens:100000,output_tokens_details:{reasoning_tokens:0}}}},102000);
 const final={...base,responseId:'r',stopReason:'stop',content:[{type:'text',text}],usage:{input:100,cacheRead:900,cacheWrite:0,output:100000}};
 await emit('message_end',{message:final});assert.equal(line,'~20.0 TPS hit 90.0% in 1.0k out 100k','no native usage rescaling');
 const finalLine=line;await emit('message_end',{message:final});assert.equal(line,finalLine,'duplicate end no usage double count');
 clock=200000;await command.handler('widget',ctx);assert.equal(line,finalLine,'completed rate is last response, not live zero');
 await command.handler('status',ctx);await emit('before_provider_request');assert.match(line,/^- TPS/,'new request clears previous response rate');
 seq=0;await raw('response.created',{response:{id:'next'}},210000);await emit('message_start',{message:base});
 await command.handler('reset',ctx);assert.match(line,/- TPS hit 90.0% in 1.0k out 100k/,'reset keeps billing counters');
 await command.handler('off',ctx);assert.equal(statuses.has('throughput'),false);
 await command.handler('on',ctx);assert.equal(statuses.has('throughput'),true);
 await emit('session_shutdown');
 // Real installed native SSE parser with local fetch and generated dummy JWT.
 const {stream}=await import(pathToFileURL(join(piRoot,'node_modules/@earendil-works/pi-ai/dist/api/openai-codex-responses.js')).href);
 const model={api:'openai-codex-responses',provider:'openai-codex',id:'gpt-6.1-sol',name:'offline fixture',baseUrl:'https://chatgpt.com/backend-api',reasoning:true,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:272000,maxTokens:1000};
 ctx.model=model;clock=0;await emit('session_start');
 const chunks=Array(4).fill('text'.repeat(10));const full=chunks.join('');
 const frames=[
  {type:'response.created',response:{id:'native_fixture'}},
  {type:'response.output_item.added',output_index:0,item:{type:'reasoning',id:'thinking',summary:[]}},
  {type:'response.reasoning_summary_text.delta',item_id:'thinking',output_index:0,summary_index:0,delta:'not visible output'},
  {type:'response.output_item.done',output_index:0,item:{type:'reasoning',id:'thinking',summary:[]}},
  {type:'response.output_item.added',output_index:1,item:{type:'message',role:'assistant',id:'msg',content:[]}},
  {type:'response.content_part.added',item_id:'msg',output_index:1,content_index:0,part:{type:'output_text',text:''}},
  ...chunks.map(delta=>({type:'response.output_text.delta',item_id:'msg',output_index:1,content_index:0,delta})),
  {type:'response.output_text.done',item_id:'msg',output_index:1,content_index:0,text:full},
  {type:'response.output_item.done',output_index:1,item:{type:'message',role:'assistant',id:'msg',content:[{type:'output_text',text:full}]}},
  {type:'response.completed',response:{id:'native_fixture',status:'completed',model:model.id,usage:{input_tokens:100,input_tokens_details:{cached_tokens:0},output_tokens:320,output_tokens_details:{reasoning_tokens:300}}}},
 ].map((event,sequence_number)=>({...event,sequence_number}));
 const body=frames.map(event=>`data: ${JSON.stringify(event)}\n\n`).join('');
 const jwt=['{}',JSON.stringify({'https://api.openai.com/auth':{chatgpt_account_id:'offline-fixture'}}),'dummy'].map(x=>Buffer.from(x).toString('base64url')).join('.');
 let fetchCalls=0,deltas=0;
 const response=stream(model,{messages:[{role:'user',content:[{type:'text',text:'offline fixture'}],timestamp:0}]},{apiKey:jwt,transport:'sse',maxRetries:0,
  fetch:async()=>{fetchCalls++;return new Response(body,{headers:{'content-type':'text/event-stream'}});},
  onPayload:async()=>{await emit('before_provider_request');},
  onProviderStreamEvent:async data=>{if(data.type==='response.output_text.delta')clock=1000+(++deltas)*500;else clock++;await emit('provider_stream_event',{api:model.api,provider:model.provider,model:model.id,data});},
 });
 for await(const event of response){if(event.type==='start')await emit('message_start',{message:event.partial});else if(['done','error'].includes(event.type))await emit('message_end',{message:await response.result()});else await emit('message_update',{message:event.partial,assistantMessageEvent:event});}
 assert.equal(fetchCalls,1);assert.equal(line,'~20.0 TPS hit 0.0% in 100 out 320');
 // Legacy command bullets also become middle dots without rerunning Python.
 const uiSource=process.env.STATUSLINE_UI_SOURCE??join(repo,'patches/pi-live-throughput/statusline-ui.ts');
 const bridge=join(temp,'footer.ts');writeFileSync(bridge,`import {applyStatusLineUi} from ${JSON.stringify(uiSource)};export default function(pi){pi.on("session_start",(_e,ctx)=>applyStatusLineUi(ctx,{placement:"footer"},["📁 harness-space ● GPT-6.1 Sol 272k high 18k · named"]));}`);
 const uiLoaded=await loadExtensions([bridge],temp);assert.deepEqual(uiLoaded.errors,[]);
 for(const handler of uiLoaded.extensions[0].handlers.get('session_start'))await handler({type:'session_start'},ctx);
 const clean=s=>s.replace(/\x1b\[[0-9;]*m/g,'');const footerText=width=>clean(footer.render(width).join(' '));
 assert.match(footerText(220),/harness-space · GPT-6.1 Sol.* · ~20.0 TPS hit 0.0% in 100 out 320/);
 assert.doesNotMatch(footerText(220),/●|cumulative|momentum/);
 assert.match(footer.render(220).join(''),/\x1b\[38;5;8m/,'metrics use existing palette-8 gray');
 statuses.set('throughput','~47.4 TPS hit 90.9% in 28.00M out 229k');
 for(const width of [24,40,60,100,220]){const text=footerText(width);assert.match(text,/out 229k/);assert.match(text,/hit 90.9%/);assert.doesNotMatch(text,/●/);}
 const {createRequire}=await import('node:module');const piRequire=createRequire(join(piRoot,'dist/index.js'));
 const {visibleWidth}=await import(pathToFileURL(piRequire.resolve('@earendil-works/pi-tui')).href);
 for(let width=1;width<=220;width++)assert.ok(footer.render(width).every(s=>visibleWidth(s)<=width));
 statuses.delete('throughput');assert.equal(footer.render(220).length,1);
 await emit('session_shutdown');
 // Generic provider: same safe delta-only estimator. Terminal usage-only jump,
 // hidden thinking, failed responses, provider changes never create speed.
 ctx.model={id:'test',provider:'test-generic',api:'openai-completions'};clock=0;await emit('session_start');await emit('before_provider_request');
 const generic={...base,provider:'test-generic',api:'openai-completions',model:'test'};
 await emit('message_start',{message:generic});
 clock=100;await emit('message_update',{message:generic,assistantMessageEvent:{type:'thinking_delta',delta:'x'.repeat(20000)}});assert.match(line,/^- TPS/);
 for(let i=0;i<4;i++){clock=1000+i*500;await emit('message_update',{message:generic,assistantMessageEvent:{type:'text_delta',delta:'text'.repeat(10)}});}
 assert.match(line,/^~20.0 TPS/);
 clock=2501;await emit('message_update',{message:{...generic,usage:{output:100000}},assistantMessageEvent:{type:'done'}});assert.match(line,/^~20.0 TPS/);
 await emit('message_end',{message:{...generic,stopReason:'aborted',usage:{input:100,cacheRead:0,cacheWrite:0,output:100000}}});assert.match(line,/^- TPS hit 0.0% in 100 out 100k/);
 ctx.model={id:'test',provider:'other',api:'other'};await emit('model_select');assert.match(line,/^- TPS/);
 await emit('session_shutdown');
 // Recorded auxiliary usage and idle journal changes update counters, not TPS.
 const ledger=[{type:'message',id:'saved',message:final}];
 ctx.sessionManager={getEntries:()=>ledger};clock=0;await emit('session_start');
 assert.match(line,/in 1.0k out 100k/);
 const auxiliary={input:10,cacheRead:20,cacheWrite:0,output:5};
 ledger.push({type:'usage',id:'warm',usage:auxiliary});await command.handler('status',ctx);
 assert.match(line,/in 1.0k out 100.0k/);
 ledger.push({type:'compaction',id:'compact',usage:auxiliary});await emit('session_compact');
 ledger.push({type:'branch_summary',id:'summary',usage:auxiliary});await emit('session_tree');
 ledger.push({type:'message',id:'tool',message:{role:'toolResult',usage:auxiliary}});await emit('turn_end');
 assert.match(line,/^- TPS hit 90.0% in 1.1k out 100.0k/);
 await emit('session_shutdown');delete ctx.sessionManager;
 // Guard migrations, idempotence, local edits, and no half-written overlay.
 const dir=join(temp,'src');mkdirSync(dir);const target=join(dir,'index.ts');
 const originalPath=process.env.THROUGHPUT_ORIGINAL??join(agentDir,'npm/node_modules/pi-live-throughput/src/index.ts.pi-harness-original');
 const original=readFileSync(originalPath);writeFileSync(target,original);
 const patch=join(repo,'patches/fix-pi-live-throughput-codex.mjs');const apply=()=>spawnSync(process.execPath,[patch,`--target=${target}`],{encoding:'utf8'});
 let result=apply();assert.equal(result.status,0,result.stderr);const installed=readFileSync(target);result=apply();assert.equal(result.status,0,result.stderr);assert.deepEqual(readFileSync(target),installed);
 writeFileSync(target,Buffer.concat([installed,Buffer.from('\n// unknown edit')]));const edited=readFileSync(target);result=apply();assert.notEqual(result.status,0);assert.deepEqual(readFileSync(target),edited);
 writeFileSync(target,original);writeFileSync(join(dir,'codex-throughput.ts'),'// local edit');result=apply();assert.notEqual(result.status,0);assert.deepEqual(readFileSync(target),original);
 const uiTarget=join(dir,'ui.ts');const uiOriginal=process.env.STATUSLINE_ORIGINAL??join(agentDir,'npm/node_modules/pi-statusline/src/ui.ts.pi-harness-original');writeFileSync(uiTarget,readFileSync(uiOriginal));
 const patchUI=()=>spawnSync(process.execPath,[join(repo,'patches/fix-pi-statusline-throughput.mjs'),`--target=${uiTarget}`],{encoding:'utf8'});
 result=patchUI();assert.equal(result.status,0,result.stderr);const uiPatched=readFileSync(uiTarget);result=patchUI();assert.equal(result.status,0,result.stderr);assert.deepEqual(readFileSync(uiTarget),uiPatched);
 writeFileSync(uiTarget,Buffer.concat([uiPatched,Buffer.from('\n// unknown edit')]));const uiEdited=readFileSync(uiTarget);result=patchUI();assert.notEqual(result.status,0);assert.deepEqual(readFileSync(uiTarget),uiEdited);
 console.log('PASS: actual Pi loader + native SSE parser, safe Codex/generic TPS, in/out counters, no native rescale, stale/next/reset/off/model lifecycles, middle dots, widths 1–220, patch guards; zero inference');
} finally {
 if(descriptor)Object.defineProperty(performance,'now',descriptor);else delete performance.now;
 globalThis.fetch=savedFetch;rmSync(temp,{recursive:true,force:true});
}

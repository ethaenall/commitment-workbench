// SPDX-License-Identifier: AGPL-3.0-only
// Reviewed trusted Node bootstrap. Only these fixed imports use Node capabilities.
// No generated source is evaluated by Node, vm, Function, shell, or dynamic import.
// Package-root node_modules (package.json + dist/); no developer-specific paths.
import {parentPort} from 'node:worker_threads';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {newQuickJSWASMModuleFromVariant,newVariant} from 'quickjs-emscripten-core';
import release from '@jitl/quickjs-wasmfile-release-sync';
import {LIMITS,textBytes,integer,keys,wire,parseWire,lowerLimits,fail,fixedCode} from './protocol.mjs';
import {createReadEvidence,recordSuccessfulSlice,recordSuccessfulExecute,snapshotReadEvidence} from './read-evidence.mjs';
function rlmWasmPath(){
  if(typeof process.env.HABENULA_RLM_WASM==='string'&&process.env.HABENULA_RLM_WASM.length>0)return process.env.HABENULA_RLM_WASM;
  try{return fileURLToPath(import.meta.resolve('@jitl/quickjs-wasmfile-release-sync/wasm'));}
  catch{fail('WASM_PATH');}
}
const memory=new WebAssembly.Memory({initial:256,maximum:512});
const compiled=await WebAssembly.compile(await readFile(rlmWasmPath()));
const memoryImportCount=WebAssembly.Module.imports(compiled).filter(item=>item.kind==='memory').length;
if(memoryImportCount!==1)fail('MEMORY_IMPORT_COUNT');
const module=await newQuickJSWASMModuleFromVariant(newVariant(release,{wasmModule:compiled,wasmMemory:memory}));
if(module.getWasmMemory()!==memory)fail('MEMORY_IDENTITY');
let run=null,lastSeq=0,terminal=false,executing=0;
// Captured intrinsics; validates primitive strings BEFORE lossy C UTF-8 copying.
// This helper is evaluated in QuickJS, retained by a host-only handle, and never
// installed on the guest global object. It never reads arbitrary object fields.
const STRING_CHECK=`(()=>{const code=Function.prototype.call.bind(String.prototype.charCodeAt);return(s,cap)=>{if(typeof s!=='string')return -4;if(s.length>cap)return -1;let n=0;for(let i=0;i<s.length;i++){const c=code(s,i);if(c===0)return -2;if(c>=55296&&c<=56319){const d=code(s,i+1);if(!(d>=56320&&d<=57343))return -3;n+=4;i++;}else if(c>=56320&&c<=57343)return -3;else n+=c<128?1:c<2048?2:3;if(n>cap)return -1;}return n;};})()`;
function take(key,n,max,code){if(!run||terminal)fail('CLOSED');if(run[key]+n>max)fail(code);run[key]+=n;}
function callGuest(fn){if(executing)fail('NESTED_GENERATED_EXECUTION');executing++;run.peakExecution=Math.max(run.peakExecution,executing);try{return fn();}finally{executing--;}}
function passiveResult(result){if(result.error){try{result.error.dispose();}finally{fail('GUEST_ERROR');}}return result.value;}
function guestString(vm,value,cap,code){
 const ctx=vm.ctx;if(ctx.typeof(value)!=='string')fail('STRING_REQUIRED');
 const bound=ctx.newNumber(cap);let result;
 try{result=ctx.callFunction(vm.stringCheck,ctx.undefined,value,bound);const checked=passiveResult(result);let n;try{n=ctx.getNumber(checked);}finally{checked.dispose();}
  if(n<0)fail(n===-2?'NUL_REJECTED':n===-3?'SURROGATE_REJECTED':n===-4?'STRING_REQUIRED':code);
  const text=ctx.getString(value);if(textBytes(text,cap,code)!==n)fail('STRING_FIDELITY');return text;
 }finally{bound.dispose();}
}
function newString(vm,text,cap){textBytes(text,cap);return vm.ctx.newString(text);}
function metrics(){return {moduleInitializations:1,memoryInstances:1,memoryImportCount,memoryIdentity:module.getWasmMemory()===memory,wasmBytes:memory.buffer.byteLength,maximumWasmBytes:33554432,
 liveVMs:run?.vms.size??0,createdVMs:run?.created??0,disposedVMs:run?.disposed??0,peakLiveVMs:run?.peakLive??0,peakGeneratedExecutionDepth:run?.peakExecution??0,
 calls:run?.calls??0,nodes:run?.nodes??0,maxDepth:run?.maxDepth??0,bridgeCalls:run?.bridgeCalls??0,interruptChecks:run?.interruptChecks??0,jobs:run?.jobs??0,
 contextReads:run?.contextReads??0,contextTransferBytes:run?.contextTransferBytes??0,promptBytes:run?.promptBytes??0,responseReservationBytes:run?.responseReservationBytes??0,
 guestOutputBytes:run?.guestOutputBytes??0,pendingEvents:run?.pending.size??0,cleanupFailures:run?.cleanupFailures??0,
 nodesSeen:run?.nodesSeen??[],readEvidence:run?snapshotReadEvidence(run.evidence):null};}
function disposeVM(vm){
 // Attempt every teardown independently; NEVER inspect/dump a guest exception.
 let failed=false;const attempt=fn=>{try{fn();}catch{failed=true;}};
 for(const d of vm.deferreds)attempt(()=>{if(d.alive)d.dispose();});vm.deferreds.clear();
 for(const key of ['handle','stringCheck'])attempt(()=>{if(vm[key]?.alive)vm[key].dispose();});
 attempt(()=>{if(vm.ctx?.alive)vm.ctx.dispose();});attempt(()=>{if(vm.rt?.alive)vm.rt.dispose();});
 run.vms.delete(vm.id);run.disposed++;if(failed)run.cleanupFailures++;
 return !failed;
}
function cleanup(){if(!run)return;for(const vm of [...run.vms.values()])disposeVM(vm);run.pending.clear();run.outbox.length=0;}
function event(kind,vm,prompt,deferred=null){
 const depth=kind==='root'?0:vm.depth+1;if(depth>run.limits.depth)fail('DEPTH_BUDGET');
 const bytes=textBytes(prompt,run.limits.promptBytes,'PROMPT_BYTES');
 if(run.calls+1>run.limits.calls)fail('CALL_BUDGET');
 if(run.promptBytes+bytes>run.limits.totalPromptBytes)fail('PROMPT_BUDGET');
 if(run.responseReservationBytes+run.limits.responseBytes>run.limits.totalResponseReservationBytes)fail('RESPONSE_BUDGET');
 if(run.nodes+1>run.limits.totalVMs)fail('NODE_BUDGET');
 run.calls++;run.promptBytes+=bytes;run.responseReservationBytes+=run.limits.responseBytes;
 const nodeId=`n${run.nodes++}`;
 const data={id:`e${run.calls}`,kind,runId:run.id,nodeId,parentId:vm?.id??null,depth,prompt};
 const record={data,deferred,parent:vm};run.pending.set(data.id,record);run.outbox.push(data);return record;
}
function beginVM(id,parentId,depth,source,input,returnTo=null){
 if(terminal)fail('CLOSED');textBytes(source,run.limits.sourceBytes,'SOURCE_BYTES');textBytes(input,run.limits.promptBytes,'INPUT_BYTES');
 if(depth>run.limits.depth)fail('DEPTH_BUDGET');if(run.vms.size>=run.limits.liveVMs)fail('LIVE_VM_BUDGET');
 const vm={id,parentId,depth,returnTo,deferreds:new Set(),rt:null,ctx:null,handle:null,stringCheck:null};
 run.vms.set(id,vm);run.created++;run.peakLive=Math.max(run.peakLive,run.vms.size);run.maxDepth=Math.max(run.maxDepth,depth);
 run.nodesSeen.push({id,parentId,depth,memoryId:'memory-1',moduleId:1});
 vm.rt=module.newRuntime();vm.rt.setMaxStackSize(run.limits.stackBytes);vm.rt.removeModuleLoader();
 vm.rt.setInterruptHandler(()=>{if(terminal||run.interruptChecks>=run.limits.interruptChecks)return true;run.interruptChecks++;return false;});
 vm.ctx=vm.rt.newContext();const ctx=vm.ctx;
 vm.stringCheck=passiveResult(callGuest(()=>ctx.evalCode(STRING_CHECK,'trusted-string-check.js')));
 function install(name,callback){
  const fn=ctx.newFunction(name,function(...args){
   try{take('bridgeCalls',1,run.limits.bridgeCalls,'BRIDGE_BUDGET');return callback(args);}
   catch(error){
    // Allocating this FIXED error may itself fail under OOM. Top-level catch
    // and parent deadline still terminate the Worker; cleanup is independent.
    return {error:ctx.newString(fixedCode(error,'BRIDGE_ERROR'))};
   }
  });ctx.setProp(ctx.global,name,fn);fn.dispose();
 }
 install('contextMeta',args=>{if(args.length)fail('ARITY');return newString(vm,JSON.stringify({id:run.contextId,records:run.rows.length,bytes:run.contextBytes,readonly:true,maxSliceRows:run.limits.sliceRows}),1024);});
 install('contextSlice',args=>{
  if(args.length!==2||ctx.typeof(args[0])!=='number'||ctx.typeof(args[1])!=='number')fail('ARITY');
  const start=integer(ctx.getNumber(args[0]),0,run.rows.length-1),count=integer(ctx.getNumber(args[1]),1,run.limits.sliceRows);
  if(start+count>run.rows.length)fail('INVALID_RANGE');take('contextReads',1,run.limits.contextReads,'CONTEXT_READ_BUDGET');
  const text=run.rows.slice(start,start+count).join('\n');const size=textBytes(text,run.limits.sliceBytes,'SLICE_BYTES');
  take('contextTransferBytes',size,run.limits.contextTransferBytes,'CONTEXT_TRANSFER_BUDGET');const delivered=newString(vm,text,run.limits.sliceBytes);recordSuccessfulSlice(run.evidence,{nodeId:vm.id,start,count,utf8Bytes:size,returnedChars:text.length});return delivered;
 });
 for(const kind of ['llm','rlm'])install(kind,args=>{
  if(args.length!==1)fail('ARITY');const prompt=guestString(vm,args[0],run.limits.promptBytes,'PROMPT_BYTES');
  // All admission/identity/budget state is host-owned. No provider object exists.
  const record=event(kind,vm,prompt);let deferred;
  try{deferred=ctx.newPromise();record.deferred=deferred;vm.deferreds.add(deferred);return deferred.handle;}
  catch{run.pending.delete(record.data.id);run.outbox=run.outbox.filter(e=>e.id!==record.data.id);fail('BRIDGE_OOM');}
 });
 const inputValue=newString(vm,input,run.limits.promptBytes);ctx.setProp(ctx.global,'input',inputValue);inputValue.dispose();
 const locked=passiveResult(callGuest(()=>ctx.evalCode(`for(const n of ['contextMeta','contextSlice','llm','rlm','input']){Object.freeze(globalThis[n]);Object.defineProperty(globalThis,n,{writable:false,configurable:false});}`,'trusted-lock.js')));locked.dispose();
 vm.handle=passiveResult(callGuest(()=>ctx.evalCode(source,'generated-guest-only.js')));
 recordSuccessfulExecute(run.evidence,{nodeId:id,parentId,depth,sourceSha256:createHash('sha256').update(source).digest('hex')});
}
function resolveDeferred(record,value){
 const vm=record.parent;if(!vm||!run.vms.has(vm.id)||!record.deferred)fail('STALE_EVENT');
 const handle=newString(vm,value,run.limits.guestOutputBytes);
 try{record.deferred.resolve(handle);}finally{handle.dispose();}
 record.deferred.dispose();vm.deferreds.delete(record.deferred);record.deferred=null;
}
function settleVM(vm){
 const state=vm.ctx.getPromiseState(vm.handle); // Native Promise state, not guest .then/getters.
 if(state.type==='pending')return false;
 if(state.type==='rejected'){try{state.error.dispose();}finally{fail('GUEST_ERROR');}}
 let output;try{output=guestString(vm,state.value,run.limits.guestOutputBytes,'OUTPUT_BYTES');}
 finally{if(!state.notAPromise)state.value.dispose();}
 take('guestOutputBytes',textBytes(output,run.limits.guestOutputBytes),run.limits.totalGuestOutputBytes,'TOTAL_OUTPUT_BYTES');
 if(vm.deferreds.size)fail('UNJOINED_HOST_CALL');
 const back=vm.returnTo;if(!disposeVM(vm))fail('CLEANUP_FAILURE');
 if(back)resolveDeferred(back,output);else{run.output=output;run.complete=true;}
 return true;
}
function pump(){
 for(let rounds=0;rounds<32;rounds++){
  let progress=false;
  for(const vm of [...run.vms.values()]){
   if(settleVM(vm)){progress=true;continue;}
   take('jobs',1,run.limits.jobs,'JOB_BUDGET');
   const result=callGuest(()=>vm.rt.executePendingJobs(1));
   if(result.error){try{result.error.dispose();}finally{fail('GUEST_ERROR');}}
   if(result.value>0)progress=true;
  }
  if(!progress)break;
 }
 if(run.complete){if(run.vms.size||run.pending.size)fail('UNJOINED_HOST_CALL');terminal=true;}
}
function init(cmd){
 keys(cmd,['v','seq','op','runId','contextId','context','limits','rootPrompt']);if(run)fail('ALREADY_INITIALIZED');
 textBytes(cmd.runId,64);textBytes(cmd.contextId,80);const limits=lowerLimits(cmd.limits);
 const contextBytes=textBytes(cmd.context,limits.contextStoreBytes,'CONTEXT_STORE_BYTES');
 if('sha256:'+createHash('sha256').update(cmd.context).digest('hex')!==cmd.contextId)fail('CONTEXT_DIGEST');
 // Validate row count before split/copies; every row is checked before admission.
 let count=1;for(let i=0;i<cmd.context.length;i++)if(cmd.context.charCodeAt(i)===10&&++count>limits.maxRows)fail('CONTEXT_ROWS');
 const rows=cmd.context.split('\n');for(const row of rows)textBytes(row,limits.sliceBytes,'CONTEXT_RECORD_BYTES');
 run={id:cmd.runId,contextId:cmd.contextId,contextBytes,rows:Object.freeze(rows),limits,vms:new Map(),pending:new Map(),outbox:[],nodesSeen:[],calls:0,nodes:0,
 created:0,disposed:0,peakLive:0,peakExecution:0,maxDepth:0,bridgeCalls:0,interruptChecks:0,jobs:0,contextReads:0,contextTransferBytes:0,promptBytes:0,responseReservationBytes:0,guestOutputBytes:0,cleanupFailures:0,complete:false,evidence:createReadEvidence()};
 if(cmd.rootPrompt!==null)event('root',null,cmd.rootPrompt);
}
function dispatch(cmd){
 if(cmd.v!==1||!Number.isSafeInteger(cmd.seq)||cmd.seq!==lastSeq+1)fail('SEQUENCE');lastSeq=cmd.seq;
 if(lastSeq>LIMITS.commands)fail('COMMAND_BUDGET');
 if(cmd.op==='init'){init(cmd);return;}
 if(!run||cmd.runId!==run.id||terminal)fail('CLOSED');
 switch(cmd.op){
  case 'evaluate':keys(cmd,['v','seq','op','runId','source','input']);if(run.created||run.nodes||run.pending.size)fail('ROOT_EXISTS');run.nodes=1;beginVM('n0',null,0,cmd.source,cmd.input);pump();break;
  case 'resolve':{
   keys(cmd,['v','seq','op','runId','eventId','value']);textBytes(cmd.eventId,16);
   const record=run.pending.get(cmd.eventId);if(!record)fail('STALE_EVENT');
   textBytes(cmd.value,run.limits.responseBytes,'RESPONSE_BYTES');run.pending.delete(cmd.eventId);
   if(record.data.kind==='llm')resolveDeferred(record,cmd.value);
   else beginVM(record.data.nodeId,record.data.parentId,record.data.depth,cmd.value,record.data.prompt,record.data.kind==='root'?null:record);
   pump();break;
  }
  case 'pump':keys(cmd,['v','seq','op','runId']);pump();break;
  case 'dispose':keys(cmd,['v','seq','op','runId']);terminal=true;cleanup();break;
  default:fail('PROTOCOL');
 }
}
parentPort.on('message',raw=>{
 let seq=0;
 try{
  const cmd=parseWire(raw,run?LIMITS.wireBytes:LIMITS.initWireBytes);seq=cmd.seq;dispatch(cmd);
  const events=run.outbox.splice(0);parentPort.postMessage(wire({v:1,seq,ok:true,status:run.complete?'complete':terminal?'disposed':'waiting',events,output:run.complete?run.output:null,metrics:metrics()}));
 }catch(error){
  terminal=true;const code=fixedCode(error,'VM_FAILURE');
  try{cleanup();}catch{} // Does not precede/skip mandatory parent Worker exit.
  try{parentPort.postMessage(wire({v:1,seq,ok:false,error:{code},events:[],output:null,metrics:metrics()}));}catch{parentPort.postMessage('{"v":1,"seq":0,"ok":false,"error":{"code":"VM_FAILURE"},"events":[],"output":null}');}
 }
});
parentPort.postMessage(wire({v:1,kind:'ready',envEmpty:Object.keys(process.env).length===0,metrics:metrics()}));

// RLM bridge assembly04. Local Worker/clock injection only; no daemon enablement.
// Does not import node:worker_threads or QuickJS. protocol.mjs is owned by wire.
import {randomUUID,createHash} from 'node:crypto';
import {LIMITS,parseWire,parseWorkerReply,encodeWorkerCommand,validateHostEvidence,readEvidenceHostSnapshot,keys,assertPlainData,textBytes,fail,lowerLimits} from './protocol.mjs';
import {TIMING_CEILINGS,lowerTiming} from './timing-policy.mjs';

const key=Symbol.for('habenula.rlm-node-backend.global-permit.v1');
const globalState=globalThis[key]??={active:null,admissions:0,exits:0,peakWorkers:0,liveWorkers:0,history:[]};

export function backendStatus(){
 return {activeRunId:globalState.active?.id??null,state:globalState.active?.state??'idle',admissions:globalState.admissions,exits:globalState.exits,liveWorkers:globalState.liveWorkers,peakWorkers:globalState.peakWorkers,history:[...globalState.history]};
}

function defaultClock(){
 return {now:()=>performance.now(),setTimeout,clearTimeout};
}

/** Compose trusted local dependencies; never read Worker/clock from a wire request. */
export function createRlmNodeBackend({Worker,clock}={}){
 if(typeof Worker!=='function')fail('NO_WORKER_FACTORY');
 const localClock=clock??defaultClock();
 if(!localClock||!['now','setTimeout','clearTimeout'].every(k=>typeof localClock[k]==='function'))fail('INVALID_CLOCK');
 return Object.freeze({backendStatus,openSession:args=>{
  keys(args,['context','limits','rootPrompt','timing']);
  return openSession({...args,Worker,clock:localClock});
 }});
}

export function openSession({context,limits={},timing={},rootPrompt=null,clock,Worker}={}){
 if(!Worker)fail('NO_WORKER_FACTORY');
 if(globalState.active)fail('ADMISSION_BUSY');
 const configured=lowerLimits(limits);
 const clocks=clock??defaultClock();
 const slice=lowerTiming(timing);
 textBytes(context,configured.contextStoreBytes,'CONTEXT_STORE_BYTES');
 if(rootPrompt!==null)textBytes(rootPrompt,configured.promptBytes,'PROMPT_BYTES');
 const record={
  id:randomUUID(),state:'starting',worker:null,exitSeen:false,pending:null,seq:0,cancelled:false,published:false,complete:false,
  finishedOutput:null,lastMetrics:null,hostEvidence:null,evidenceFloor:null,termination:null,outstanding:new Set(),seenEvents:new Set(),initRequested:false,initialized:false,readyResolve:null,readyReject:null,releaseGranted:false,
  started:clocks.now(),stopReason:null,wireSent:0,wireReceived:0,cumulativeCommandMs:0,commandStartedAt:null,commandTimerSeq:null,
  taskTimer:null,startupTimer:null,commandTimer:null,openTimerCount:0,
 };
 globalState.active=record;globalState.admissions++;
 let resolveExit;record.exited=new Promise(resolve=>{resolveExit=resolve;});
 const ready=new Promise((resolve,reject)=>{record.readyResolve=resolve;record.readyReject=reject;});ready.catch(()=>{});

 function arm(ms,fn){
  const id=clocks.setTimeout(fn,ms);
  record.openTimerCount++;
  return id;
 }
 function disarm(id){
  if(id==null)return;
  clocks.clearTimeout(id);
  record.openTimerCount=Math.max(0,record.openTimerCount-1);
 }
 function clearAllTimers(){
  disarm(record.taskTimer);record.taskTimer=null;
  disarm(record.startupTimer);record.startupTimer=null;
  disarm(record.commandTimer);record.commandTimer=null;
  record.commandTimerSeq=null;record.commandStartedAt=null;
 }

 function observeHostEvidence(metrics){
  if(!metrics||metrics.readEvidence==null){record.hostEvidence=null;return;}
  const observed=readEvidenceHostSnapshot(metrics.readEvidence,configured),prior=record.evidenceFloor;
  if(prior){
   for(const field of ['reads','executes']){
    if(prior[field].length>observed[field].length||prior[field].some((row,i)=>JSON.stringify(row)!==JSON.stringify(observed[field][i])))fail('HOST_EVIDENCE_REGRESSION');
   }
   if(prior.truncated&&!observed.truncated)fail('HOST_EVIDENCE_REGRESSION');
  }
  record.hostEvidence=observed;record.evidenceFloor=observed;
 }

 function stop(reason='CANCELLED'){
  if(!record.termination){
   record.cancelled=reason!=='COMPLETE';record.stopReason=reason;record.state='terminating';
   clearAllTimers();
   record.readyReject(new Error(reason));
   const began=clocks.now();
   record.termination=Promise.resolve().then(()=>record.worker.terminate()).then(async()=>{
    await record.exited;record.terminateMs=clocks.now()-began;
    return {reason,terminateMs:record.terminateMs,exitSeen:record.exitSeen};
   });
  }
  return record.termination;
 }

 const worker=record.worker=new Worker({env:{},execArgv:[]});
 globalState.liveWorkers++;globalState.peakWorkers=Math.max(globalState.peakWorkers,globalState.liveWorkers);
 if(worker.stdout&&typeof worker.stdout.on==='function')worker.stdout.on('data',()=>{});
 if(worker.stderr&&typeof worker.stderr.on==='function')worker.stderr.on('data',()=>{});
 worker.on('error',()=>{void stop('WORKER_ERROR');});
 worker.on('exit',code=>{
  record.exitSeen=true;globalState.exits++;globalState.liveWorkers--;record.state='exited';record.exitCode=code;
  record.exitAfterMs=clocks.now()-record.started;
  clearAllTimers();
  record.readyReject(new Error('WORKER_EXIT'));
  if(record.pending){record.pending.resolve({v:1,seq:record.pending.seq,ok:false,error:{code:record.stopReason??'WORKER_EXIT'},events:[],output:null});record.pending=null;}
  globalState.history.push({runId:record.id,exitCode:code,reason:record.stopReason,afterMs:record.exitAfterMs});
  if(globalState.history.length>64)globalState.history.shift();
  resolveExit(code);
 });
 worker.on('message',raw=>{
  if(record.cancelled||record.exitSeen)return;
  try{
   let msg=assertPlainData(parseWire(raw));record.wireReceived+=Buffer.byteLength(typeof raw==='string'?raw:String(raw));
   if(msg.kind==='ready'){
    keys(msg,['v','kind','envEmpty','metrics']);
    if(msg.v!==1||record.state!=='starting'||msg.envEmpty!==true||msg.metrics?.memoryInstances!==1||msg.metrics?.memoryIdentity!==true)fail('BOOTSTRAP');
    observeHostEvidence(msg.metrics);
    record.lastMetrics=msg.metrics;record.state='running';
    disarm(record.startupTimer);record.startupTimer=null;
    record.readyResolve(msg);return;
   }
   msg=parseWorkerReply(raw);
   if(!record.pending||msg.seq!==record.pending.seq)fail('SEQUENCE');
   const pending=record.pending;
   if(record.seenEvents.size+msg.events.length>configured.calls)fail('GUEST_EVENT_LIMIT');
   for(const e of msg.events){if(e.runId!==record.id||record.seenEvents.has(e.id)||e.depth>configured.depth)fail('EVENT_IDENTITY');}
   const completed=msg.ok===true&&msg.status==='complete';
   if(completed&&(typeof msg.output!=='string'||msg.events.length!==0||msg.metrics?.pendingEvents!==0))fail('INCOMPLETE_GUEST');
   observeHostEvidence(msg.metrics);
   if(msg.metrics)record.lastMetrics=msg.metrics;
   if(msg.ok===true&&pending.op==='init')record.initialized=true;
   if(msg.ok===true&&pending.op==='resolve')record.outstanding.delete(pending.eventId);
   for(const e of msg.events){record.seenEvents.add(e.id);record.outstanding.add(e.id);}
   if(completed){
    record.complete=true;record.finishedOutput=msg.output;
    // A verified guest completion drops guest events, not native/provider debt.
    // Timeout/cancel/exit paths must never perform this clearing.
    record.outstanding.clear();
   }
   record.pending=null;
   if(record.commandTimerSeq===pending.seq){
    if(record.commandStartedAt!=null){
     record.cumulativeCommandMs+=clocks.now()-record.commandStartedAt;
     record.commandStartedAt=null;
    }
    disarm(record.commandTimer);record.commandTimer=null;record.commandTimerSeq=null;
   }
   pending.resolve(msg);
  }catch{void stop('CHANNEL_ERROR');}
 });

 record.taskTimer=arm(slice.taskLifetimeMs,()=>{void stop('TASK_DEADLINE');});
 record.startupTimer=arm(slice.startupDeadlineMs,()=>{void stop('STARTUP_DEADLINE');});

 async function command(op,data={}){
  if(op==='init'){if(record.initRequested)fail('ALREADY_INITIALIZED');record.initRequested=true;}
  else if(!record.initialized)fail('NOT_INITIALIZED');
  if(record.cancelled||record.exitSeen||record.termination)fail('CANCELLED');if(record.pending)fail('COMMAND_BUSY');
  await ready;
  if(record.cancelled||record.exitSeen||record.termination)fail('CANCELLED');if(record.pending)fail('COMMAND_BUSY');
  if(record.complete&&op!=='pump'&&op!=='dispose')fail('COMPLETE');
  if(op==='resolve'&&!record.outstanding.has(data.eventId))fail('STALE_EVENT');
  if(record.seq>=configured.commands)fail('COMMAND_BUDGET');
  if(record.cumulativeCommandMs>=slice.cumulativeCommandMs){
   void stop('CUMULATIVE_COMMAND_DEADLINE');fail('CUMULATIVE_COMMAND_DEADLINE');
  }
  const seq=++record.seq;
  const message={v:1,seq,op,runId:record.id,...data};
  const raw=encodeWorkerCommand(message);
  const response=new Promise(resolve=>{record.pending={seq,op,eventId:data.eventId,resolve};});
  record.commandStartedAt=clocks.now();
  record.commandTimerSeq=seq;
  const remaining=slice.cumulativeCommandMs-record.cumulativeCommandMs;
  record.commandTimer=arm(Math.min(slice.commandSliceMs,remaining),()=>{
   if(record.commandTimerSeq!==seq)return;
   void stop(remaining<slice.commandSliceMs?'CUMULATIVE_COMMAND_DEADLINE':'COMMAND_DEADLINE');
  });
  record.wireSent+=Buffer.byteLength(raw);
  try{worker.postMessage(raw);}catch{void stop('CHANNEL_ERROR');}
  return response;
 }

 const session={
  id:record.id,
  init:()=>command('init',{context,contextId:'sha256:'+createHash('sha256').update(context).digest('hex'),limits,rootPrompt}),
  evaluate:(source,input='')=>{textBytes(source,configured.sourceBytes,'SOURCE_BYTES');textBytes(input,configured.promptBytes,'INPUT_BYTES');return command('evaluate',{source,input});},
  resolve:(eventId,value)=>{textBytes(value,configured.responseBytes,'RESPONSE_BYTES');return command('resolve',{eventId,value});},
  pump:()=>command('pump'),
  dispose:()=>command('dispose'),
  cancel:()=>stop('CANCELLED'),
  waitExit:()=>record.exited,
  terminate:reason=>stop(reason),
  clearSettledEvent:eventId=>{
   if(!record.outstanding.delete(eventId))fail('STALE_EVENT');
  },
  publish:output=>{if(record.cancelled||record.exitSeen||record.termination||record.published||!record.complete||output!==record.finishedOutput||record.outstanding.size)fail('PUBLICATION_BLOCKED');textBytes(output,configured.guestOutputBytes,'OUTPUT_BYTES');record.published=true;return output;},
  release:async()=>{
   if(!record.exitSeen)fail('WORKER_STILL_LIVE');if(record.outstanding.size)fail('HOST_CALLS_UNSETTLED');
   if(globalState.active!==record)fail('LEASE_IDENTITY');record.releaseGranted=true;globalState.active=null;
  },
  inspect:()=>({
   runId:record.id,state:record.state,cancelled:record.cancelled,exitSeen:record.exitSeen,stopReason:record.stopReason,published:record.published,complete:record.complete,initialized:record.initialized,
   metrics:record.lastMetrics===null?null:JSON.parse(JSON.stringify(record.lastMetrics)),
   ...(record.hostEvidence===null?{}:{hostEvidence:validateHostEvidence(record.hostEvidence,configured)}),
   pendingEvents:record.outstanding.size,seq:record.seq,wireSent:record.wireSent,wireReceived:record.wireReceived,
   terminateMs:record.terminateMs??null,exitAfterMs:record.exitAfterMs??null,
   cumulativeCommandMs:record.cumulativeCommandMs,commandArmed:record.commandTimer!=null,startupArmed:record.startupTimer!=null,taskArmed:record.taskTimer!=null,
   openTimerCount:record.openTimerCount,timingCeilings:TIMING_CEILINGS,timing:slice,
  }),
 };
 return Object.freeze(session);
}

export {LIMITS,TIMING_CEILINGS};

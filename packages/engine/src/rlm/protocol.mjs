// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only
//
// Strict DATA wire. Neither side accepts executable host objects.
// Candidate only. Not production enablement. No VM.
// Primitive LIMITS are the executed spike ceilings
// (node-worker-rlm/src/protocol.mjs sha256 b02b916e953c74c91756b8a530ad9257f8ca30aa64d8bc4317c11f6e1a09abf9).
// TIMING_CEILINGS live in timing-policy.mjs (containment), not here.

export const LIMITS=Object.freeze({
 depth:2,calls:5,liveVMs:3,totalVMs:8,interruptChecks:1000,jobs:1000,bridgeCalls:1024,stackBytes:262144,
 contextStoreBytes:3*1024*1024,contextReads:256,contextTransferBytes:4*1024*1024,sliceRows:64,sliceBytes:20000,
 promptBytes:4096,totalPromptBytes:8192,responseBytes:8192,totalResponseReservationBytes:40960,
 sourceBytes:32768,guestOutputBytes:8192,totalGuestOutputBytes:65536,
 maxRows:16384,wireBytes:65536,initWireBytes:6*3*1024*1024+16384,commands:1200,
});
export const PRIMITIVE_LIMITS=LIMITS;

// Explicitly NEW unaccepted production policy. Not executed spike defaults.
// depth 1 / totalVMs 4 / liveVMs 3 are implementable lowers.
// Guest-event ceiling stays LIMITS.calls 5. Do not propose 10. ModelBudget
// maxAttempts 10 is a different counter and is not admitted as a guest raise.
// Provider attempts are ModelBudget (budget owner), not LIMITS.calls / liveVMs / totalVMs.
export const PRODUCTION_POLICY=Object.freeze({
 status:'UNACCEPTED_NEW_POLICY',
 accepted:false,
 depth:1,
 totalVMs:4,
 liveVMs:3,
 guestEventCap:5,
 guestEventCapRaiseBlocked:true,
 primitiveGuestEventCap:5,
 proposedGuestEventCap10:false,
 providerAttemptsField:null,
 notes:Object.freeze({
  initWireBytes:18890752,
  ordinaryWireBytes:65536,
  rootEvaluateSourceBytes:32768,
  childResolveCodeBytes:8192,
  contextStoreBytes:3145728,
  rowBytes:20000,
  contextReads:256,
  providerAttemptsAreNotGuestEvents:true,
  liveVmAdmissionIsNotProviderAdmission:true,
 }),
});

export class BoundaryError extends Error {constructor(code){super(code);this.code=code;}}
export function fail(code){throw new BoundaryError(code);}
export function textBytes(s,cap,code='BYTE_LIMIT'){
 if(typeof s!=='string')fail('STRING_REQUIRED');
 if(s.length>cap)fail(code);
 let n=0;
 for(let i=0;i<s.length;i++){
  const c=s.charCodeAt(i);
  if(c===0)fail('NUL_REJECTED');
  if(c>=0xd800&&c<=0xdbff){const d=s.charCodeAt(i+1);if(!(d>=0xdc00&&d<=0xdfff))fail('SURROGATE_REJECTED');n+=4;i++;}
  else if(c>=0xdc00&&c<=0xdfff)fail('SURROGATE_REJECTED');
  else n+=c<128?1:c<2048?2:3;
  if(n>cap)fail(code);
 }
 return n;
}
export function integer(n,min,max,code='INVALID_RANGE'){if(!Number.isSafeInteger(n)||n<min||n>max)fail(code);return n;}
export function keys(v,wanted){if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).sort().join(',')!==[...wanted].sort().join(','))fail('PROTOCOL');}
export function wire(value,cap=LIMITS.wireBytes){const s=JSON.stringify(value);textBytes(s,cap,'WIRE_BYTES');return s;}
export function parseWire(s,cap=LIMITS.wireBytes){textBytes(s,cap,'WIRE_BYTES');try{return JSON.parse(s);}catch{fail('PROTOCOL');}}
export function lowerLimits(v={}){const result={...LIMITS};for(const [k,n]of Object.entries(v)){if(!Object.hasOwn(result,k))fail('INVALID_LIMIT');result[k]=integer(n,1,result[k],'INVALID_LIMIT');}return Object.freeze(result);}
export function fixedCode(error,fallback='BACKEND_FAILURE'){return error instanceof BoundaryError?error.code:fallback;}

// Cumulative host observations. Missing telemetry remains UNKNOWN, never empty proof.
export function validateHostEvidence(value,limits=LIMITS){
 assertPlainData(value);keys(value,['reads','executes','truncated']);
 if(!Array.isArray(value.reads)||!Array.isArray(value.executes)||typeof value.truncated!=='boolean')fail('HOST_EVIDENCE');
 if(value.reads.length>limits.contextReads||value.executes.length>limits.totalVMs)fail('HOST_EVIDENCE_LIMIT');
 let transferred=0;const executed=new Set();
 const reads=value.reads.map(row=>{
  keys(row,['nodeId','start','count','returnedChars']);assertNodeId(row.nodeId);
  integer(Number(row.nodeId.slice(1)),0,limits.totalVMs-1,'HOST_EVIDENCE');
  integer(row.start,0,limits.maxRows,'HOST_EVIDENCE');integer(row.count,0,limits.sliceRows,'HOST_EVIDENCE');
  if(row.start+row.count>limits.maxRows)fail('HOST_EVIDENCE');
  integer(row.returnedChars,0,limits.sliceBytes,'HOST_EVIDENCE');
  transferred+=row.returnedChars;if(transferred>limits.contextTransferBytes)fail('HOST_EVIDENCE_LIMIT');
  return {...row};
 });
 const executes=value.executes.map(row=>{
  keys(row,['nodeId','codeHash']);assertNodeId(row.nodeId);
  integer(Number(row.nodeId.slice(1)),0,limits.totalVMs-1,'HOST_EVIDENCE');
  if(typeof row.codeHash!=='string'||!/^(?:sha256:)?[0-9a-f]{64}$/.test(row.codeHash)||executed.has(row.nodeId))fail('HOST_EVIDENCE');
  executed.add(row.nodeId);return {...row};
 });
 return {reads,executes,truncated:value.truncated};
}



/** Validate the actual Worker v2 producer. Never convert utf8Bytes into chars. */
export function readEvidenceHostSnapshot(value,limits=LIMITS){
 assertPlainData(value);
 keys(value,['version','successfulSliceCount','successfulExecuteCount','slices','executes','coverageByNode','truncated']);
 if(value.version!==2||!Array.isArray(value.slices)||!Array.isArray(value.executes)||!Array.isArray(value.coverageByNode)||typeof value.truncated!=='boolean')fail('HOST_EVIDENCE');
 if(value.slices.length>limits.contextReads||value.executes.length>limits.totalVMs||value.coverageByNode.length>limits.totalVMs)fail('HOST_EVIDENCE_LIMIT');
 if(value.successfulSliceCount!==value.slices.length||value.successfulExecuteCount!==value.executes.length)fail('HOST_EVIDENCE');
 let bytes=0;const byNode=new Map();
 const reads=value.slices.map(row=>{
  keys(row,['nodeId','start','count','utf8Bytes','returnedChars']);
  integer(row.count,1,limits.sliceRows,'HOST_EVIDENCE');
  integer(row.utf8Bytes,0,limits.sliceBytes,'HOST_EVIDENCE');
  integer(row.returnedChars,0,row.utf8Bytes,'HOST_EVIDENCE');
  bytes+=row.utf8Bytes;if(bytes>limits.contextTransferBytes)fail('HOST_EVIDENCE_LIMIT');
  const ranges=byNode.get(row.nodeId)??[];ranges.push({start:row.start,end:row.start+row.count});byNode.set(row.nodeId,ranges);
  return {nodeId:row.nodeId,start:row.start,count:row.count,returnedChars:row.returnedChars};
 });
 const executes=value.executes.map(row=>{
  keys(row,['nodeId','parentId','depth','sourceSha256']);
  if(row.parentId!==null){assertNodeId(row.parentId);integer(Number(row.parentId.slice(1)),0,limits.totalVMs-1,'HOST_EVIDENCE');}
  integer(row.depth,0,limits.depth,'HOST_EVIDENCE');
  if((row.nodeId==='n0'&&(row.parentId!==null||row.depth!==0))||(row.nodeId!=='n0'&&(row.parentId===null||row.depth===0))||row.parentId===row.nodeId)fail('HOST_EVIDENCE');
  if(typeof row.sourceSha256!=='string'||!/^[0-9a-f]{64}$/.test(row.sourceSha256))fail('HOST_EVIDENCE');
  return {nodeId:row.nodeId,codeHash:row.sourceSha256};
 });
 const normalized=validateHostEvidence({reads,executes,truncated:value.truncated},limits);
 const expected=[...byNode].map(([nodeId,ranges])=>{
  ranges.sort((a,b)=>a.start-b.start||a.end-b.end);const merged=[];
  for(const row of ranges){const last=merged.at(-1);if(last&&row.start<=last.end)last.end=Math.max(last.end,row.end);else merged.push({...row});}
  return {nodeId,ranges:merged};
 }).sort((a,b)=>a.nodeId.localeCompare(b.nodeId));
 const observed=value.coverageByNode.map(row=>{
  keys(row,['nodeId','ranges']);assertNodeId(row.nodeId);
  if(!Array.isArray(row.ranges)||row.ranges.length>limits.contextReads)fail('HOST_EVIDENCE');
  return {nodeId:row.nodeId,ranges:row.ranges.map(range=>{keys(range,['start','end']);integer(range.start,0,limits.maxRows,'HOST_EVIDENCE');integer(range.end,range.start,limits.maxRows,'HOST_EVIDENCE');return {...range};})};
 }).sort((a,b)=>a.nodeId.localeCompare(b.nodeId));
 if(JSON.stringify(expected)!==JSON.stringify(observed))fail('HOST_EVIDENCE_COVERAGE');
 return normalized;
}

export const WORKER_OPS=Object.freeze(['init','evaluate','resolve','pump','dispose']);
export const BINDING_OPS=Object.freeze(['open','command','init','cancel','settled','inspect','waitExit','release','terminate','publish']);
export const BINDING_TIMING_KEYS=Object.freeze(['taskLifetimeMs','startupDeadlineMs','commandSliceMs','cumulativeCommandMs']);
export const INNER_COMMAND_OPS=Object.freeze(['evaluate','resolve','pump','dispose']);
export const WORKER_COMMAND_KEYS=Object.freeze({
 init:Object.freeze(['v','seq','op','runId','contextId','context','limits','rootPrompt']),
 evaluate:Object.freeze(['v','seq','op','runId','source','input']),
 resolve:Object.freeze(['v','seq','op','runId','eventId','value']),
 pump:Object.freeze(['v','seq','op','runId']),
 dispose:Object.freeze(['v','seq','op','runId']),
});
export const WORKER_REPLY_OK_KEYS=Object.freeze(['v','seq','ok','status','events','output','metrics']);
export const WORKER_REPLY_ERR_KEYS=Object.freeze(['v','seq','ok','error','events','output']);
export const WORKER_READY_KEYS=Object.freeze(['v','kind','envEmpty','metrics']);
export const HOST_EVENT_KEYS=Object.freeze(['id','kind','runId','nodeId','parentId','depth','prompt']);
export const BINDING_IDENTITY_KEYS=Object.freeze(['ownerId','taskId','sessionNonce']);
export const BINDING_HEADERS=Object.freeze({
 owner:'x-habenula-owner',
 task:'x-habenula-task',
 session:'x-habenula-session',
});

export function capForWorkerOp(op){return op==='init'?LIMITS.initWireBytes:LIMITS.wireBytes;}
export function capForBindingOp(op){return op==='open'?LIMITS.initWireBytes:LIMITS.wireBytes;}

export function implementableProductionLowers(){
 return lowerLimits({depth:PRODUCTION_POLICY.depth,totalVMs:PRODUCTION_POLICY.totalVMs,liveVMs:PRODUCTION_POLICY.liveVMs});
}

function isPlainObject(v){
 if(v===null||typeof v!=='object'||Array.isArray(v))return false;
 const proto=Object.getPrototypeOf(v);
 if(proto!==Object.prototype&&proto!==null)return false;
 if(Object.getOwnPropertySymbols(v).length)fail('HOST_OBJECT');
 for(const key of Object.getOwnPropertyNames(v)){
  const d=Object.getOwnPropertyDescriptor(v,key);
  if(!d||d.get||d.set||!d.enumerable||!d.configurable||!d.writable)fail('HOST_OBJECT');
 }
 return true;
}
export function assertPlainData(v){
 if(v===null)return v;
 const t=typeof v;
 if(t==='string'||t==='boolean')return v;
 if(t==='number'){if(!Number.isFinite(v))fail('HOST_OBJECT');return v;}
 if(t!=='object')fail('HOST_OBJECT');
 if(Array.isArray(v)){
  if(Object.getPrototypeOf(v)!==Array.prototype)fail('HOST_OBJECT');
  if(Object.getOwnPropertySymbols(v).length)fail('HOST_OBJECT');
  for(let i=0;i<v.length;i++){
   if(!Object.prototype.hasOwnProperty.call(v,i))fail('HOST_OBJECT');
   assertPlainData(v[i]);
  }
  return v;
 }
 if(!isPlainObject(v))fail('HOST_OBJECT');
 for(const key of Object.keys(v))assertPlainData(v[key]);
 return v;
}

const UUID_RE=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EVENT_RE=/^e(0|[1-9][0-9]*)$/;
const NODE_RE=/^n(0|[1-9][0-9]*)$/;
const CONTEXT_ID_RE=/^sha256:[0-9a-f]{64}$/;

export function assertRunId(s){
 textBytes(s,64,'PROTOCOL');
 if(!UUID_RE.test(s))fail('PROTOCOL');
 return s;
}
export function assertEventId(s){
 textBytes(s,16,'PROTOCOL');
 if(!EVENT_RE.test(s))fail('PROTOCOL');
 return s;
}
export function assertNodeId(s){
 textBytes(s,16,'PROTOCOL');
 if(!NODE_RE.test(s))fail('PROTOCOL');
 return s;
}
export function assertContextId(s){
 textBytes(s,80,'PROTOCOL');
 if(!CONTEXT_ID_RE.test(s))fail('PROTOCOL');
 return s;
}
export function identityToken(s,cap=64){
 if(typeof s!=='string'||s.length<1)fail('PROTOCOL');
 textBytes(s,cap,'PROTOCOL');
 return s;
}

function keysAllow(v,required,optional=[]){
 if(!v||typeof v!=='object'||Array.isArray(v))fail('PROTOCOL');
 const got=Object.keys(v);
 const need=new Set(required);
 const opt=new Set(optional);
 for(const k of got){
  if(need.has(k))need.delete(k);
  else if(!opt.has(k))fail('PROTOCOL');
 }
 if(need.size)fail('PROTOCOL');
}

function assertBindingIdentity(cmd){
 identityToken(cmd.ownerId);
 identityToken(cmd.taskId);
 identityToken(cmd.sessionNonce);
}

function assertLimitsValue(limits){
 if(limits==null||typeof limits!=='object'||Array.isArray(limits))fail('PROTOCOL');
 assertPlainData(limits);
 return lowerLimits(limits);
}
function assertTimingValue(timing){
 if(timing==null||typeof timing!=='object'||Array.isArray(timing))fail('PROTOCOL');
 assertPlainData(timing);
 keys(timing,BINDING_TIMING_KEYS);
 for(const k of BINDING_TIMING_KEYS)integer(timing[k],1,Number.MAX_SAFE_INTEGER,'INVALID_RANGE');
 return timing;
}

export function encodeWorkerCommand(cmd){
 assertPlainData(cmd);
 if(!cmd||typeof cmd!=='object')fail('PROTOCOL');
 const op=cmd.op;
 const wanted=WORKER_COMMAND_KEYS[op];
 if(!wanted)fail('PROTOCOL');
 keys(cmd,wanted);
 integer(cmd.v,1,1,'PROTOCOL');
 integer(cmd.seq,1,LIMITS.commands,'SEQUENCE');
 assertRunId(cmd.runId);
 if(op==='init'){
  assertContextId(cmd.contextId);
  textBytes(cmd.context,LIMITS.contextStoreBytes,'CONTEXT_STORE_BYTES');
  assertLimitsValue(cmd.limits);
  if(cmd.rootPrompt!==null)textBytes(cmd.rootPrompt,LIMITS.promptBytes,'PROMPT_BYTES');
 }else if(op==='evaluate'){
  textBytes(cmd.source,LIMITS.sourceBytes,'SOURCE_BYTES');
  textBytes(cmd.input,LIMITS.promptBytes,'INPUT_BYTES');
 }else if(op==='resolve'){
  assertEventId(cmd.eventId);
  textBytes(cmd.value,LIMITS.responseBytes,'RESPONSE_BYTES');
 }
 return wire(cmd,capForWorkerOp(op));
}

export function parseWorkerCommand(s,cap){
 if(cap==null)fail('PROTOCOL');
 const cmd=assertPlainData(parseWire(s,cap));
 if(!cmd||typeof cmd!=='object'||Array.isArray(cmd))fail('PROTOCOL');
 const wanted=WORKER_COMMAND_KEYS[cmd.op];
 if(!wanted)fail('PROTOCOL');
 keys(cmd,wanted);
 integer(cmd.v,1,1,'PROTOCOL');
 integer(cmd.seq,1,LIMITS.commands,'SEQUENCE');
 assertRunId(cmd.runId);
 if(cmd.op==='init'){
  assertContextId(cmd.contextId);
  textBytes(cmd.context,LIMITS.contextStoreBytes,'CONTEXT_STORE_BYTES');
  assertLimitsValue(cmd.limits);
  if(cmd.rootPrompt!==null)textBytes(cmd.rootPrompt,LIMITS.promptBytes,'PROMPT_BYTES');
 }else if(cmd.op==='evaluate'){
  textBytes(cmd.source,LIMITS.sourceBytes,'SOURCE_BYTES');
  textBytes(cmd.input,LIMITS.promptBytes,'INPUT_BYTES');
 }else if(cmd.op==='resolve'){
  assertEventId(cmd.eventId);
  textBytes(cmd.value,LIMITS.responseBytes,'RESPONSE_BYTES');
 }
 textBytes(s,capForWorkerOp(cmd.op),'WIRE_BYTES');
 return cmd;
}

function assertHostEvent(ev){
 assertPlainData(ev);
 keys(ev,HOST_EVENT_KEYS);
 assertEventId(ev.id);
 if(ev.kind!=='root'&&ev.kind!=='rlm'&&ev.kind!=='llm')fail('PROTOCOL');
 assertRunId(ev.runId);
 assertNodeId(ev.nodeId);
 if(ev.parentId!==null)assertNodeId(ev.parentId);
 integer(ev.depth,0,LIMITS.depth,'PROTOCOL');
 textBytes(ev.prompt,LIMITS.promptBytes,'PROMPT_BYTES');
}

export function encodeWorkerReply(reply){
 assertPlainData(reply);
 if(reply.ok===true){
  keys(reply,WORKER_REPLY_OK_KEYS);
  integer(reply.v,1,1,'PROTOCOL');
  integer(reply.seq,0,LIMITS.commands,'SEQUENCE');
  if(reply.status!=='waiting'&&reply.status!=='complete'&&reply.status!=='disposed')fail('PROTOCOL');
  if(!Array.isArray(reply.events))fail('PROTOCOL');
  for(const ev of reply.events)assertHostEvent(ev);
  if(reply.output!==null)textBytes(reply.output,LIMITS.guestOutputBytes,'OUTPUT_BYTES');
  assertPlainData(reply.metrics);
 }else if(reply.ok===false){
  const got=Object.keys(reply).sort().join(',');
  const withMetrics=[...WORKER_REPLY_ERR_KEYS,'metrics'].sort().join(',');
  const without=WORKER_REPLY_ERR_KEYS.slice().sort().join(',');
  if(got!==withMetrics&&got!==without)fail('PROTOCOL');
  integer(reply.v,1,1,'PROTOCOL');
  integer(reply.seq,0,LIMITS.commands,'SEQUENCE');
  keys(reply.error,['code']);
  if(typeof reply.error.code!=='string'||!reply.error.code)fail('PROTOCOL');
  if(!Array.isArray(reply.events)||reply.events.length)fail('PROTOCOL');
  if(reply.output!==null)fail('PROTOCOL');
 }else fail('PROTOCOL');
 return wire(reply,LIMITS.wireBytes);
}

export function parseWorkerReply(s,cap=LIMITS.wireBytes){
 const reply=assertPlainData(parseWire(s,cap));
 encodeWorkerReply(reply);
 return reply;
}

export function encodeInnerCommand(command){
 assertPlainData(command);
 if(!command||typeof command!=='object')fail('PROTOCOL');
 const op=command.op;
 if(op==='evaluate'){
  keys(command,['op','source','input']);
  textBytes(command.source,LIMITS.sourceBytes,'SOURCE_BYTES');
  textBytes(command.input,LIMITS.promptBytes,'INPUT_BYTES');
 }else if(op==='resolve'){
  keys(command,['op','eventId','value']);
  assertEventId(command.eventId);
  textBytes(command.value,LIMITS.responseBytes,'RESPONSE_BYTES');
 }else if(op==='pump'||op==='dispose'){
  keys(command,['op']);
 }else fail('PROTOCOL');
 return command;
}

export function encodeBindingCommand(cmd){
 assertPlainData(cmd);
 if(!cmd||typeof cmd!=='object')fail('PROTOCOL');
 const op=cmd.op;
 if(op==='open'){
  keysAllow(cmd,['op','ownerId','taskId','sessionNonce','context','rootPrompt'],['limits','timing']);
  assertBindingIdentity(cmd);
  textBytes(cmd.context,LIMITS.contextStoreBytes,'CONTEXT_STORE_BYTES');
  if(cmd.rootPrompt!==null)textBytes(cmd.rootPrompt,LIMITS.promptBytes,'PROMPT_BYTES');
  if('limits' in cmd)assertLimitsValue(cmd.limits);
  if('timing' in cmd)assertTimingValue(cmd.timing);
  if('deadlineMs' in cmd)fail('PROTOCOL'); // legacy; not remapped to timing
 }else if(op==='command'){
  keys(cmd,['op','ownerId','taskId','sessionNonce','runId','command']);
  assertBindingIdentity(cmd);
  assertRunId(cmd.runId);
  encodeInnerCommand(cmd.command);
 }else if(op==='init'||op==='cancel'||op==='inspect'||op==='waitExit'||op==='release'){
  keys(cmd,['op','ownerId','taskId','sessionNonce','runId']);
  assertBindingIdentity(cmd);
  assertRunId(cmd.runId);
 }else if(op==='settled'){
  keys(cmd,['op','ownerId','taskId','sessionNonce','runId','eventId']);
  assertBindingIdentity(cmd);
  assertRunId(cmd.runId);
  assertEventId(cmd.eventId);
 }else if(op==='terminate'){
  keys(cmd,['op','ownerId','taskId','sessionNonce','runId','reason']);
  assertBindingIdentity(cmd);
  assertRunId(cmd.runId);
  identityToken(cmd.reason);
 }else if(op==='publish'){
  keys(cmd,['op','ownerId','taskId','sessionNonce','runId','findings']);
  assertBindingIdentity(cmd);
  assertRunId(cmd.runId);
  textBytes(cmd.findings,LIMITS.guestOutputBytes,'OUTPUT_BYTES');
 }else fail('PROTOCOL');
 return wire(cmd,capForBindingOp(op));
}

export function parseBindingCommand(s,cap){
 if(cap==null)fail('PROTOCOL');
 const cmd=assertPlainData(parseWire(s,cap));
 if(!cmd||typeof cmd!=='object'||Array.isArray(cmd))fail('PROTOCOL');
 if(typeof cmd.op!=='string')fail('PROTOCOL');
 textBytes(s,capForBindingOp(cmd.op),'WIRE_BYTES');
 encodeBindingCommand(cmd);
 return cmd;
}

export function assertBindingHeaderIdentity(getHeader,cmd){
 if(typeof getHeader!=='function'||!cmd||typeof cmd!=='object')fail('PROTOCOL');
 const owner=getHeader(BINDING_HEADERS.owner);
 const task=getHeader(BINDING_HEADERS.task);
 const session=getHeader(BINDING_HEADERS.session);
 if(typeof owner!=='string'||owner.length<1||typeof task!=='string'||task.length<1||typeof session!=='string'||session.length<1)fail('IDENTITY_REQUIRED');
 identityToken(owner);identityToken(task);identityToken(session);
 if(owner!==cmd.ownerId||task!==cmd.taskId||session!==cmd.sessionNonce)fail('IDENTITY_MISMATCH');
 return cmd;
}

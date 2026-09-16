// SPDX-License-Identifier: AGPL-3.0-only
// Guest interface/prompt regressions. No provider connection or model response claims.
import assert from "node:assert/strict";
import {test} from "node:test";
import {Worker} from "node:worker_threads";
import {CODEGEN_SYSTEM,codegenUser,ledgerUser,LEDGER_SYSTEM,RLM_SMALL_CONTEXT_PROGRAM} from "../../src/workflows/rlm-prompts.ts";
import {WORKFLOW_SYSTEM_PROMPT} from "../../src/workflows/run-workflow.ts";
import {LIMITS} from "../../src/rlm/protocol.mjs";
import {createRlmNodeBackend} from "../../src/rlm/node-backend.mjs";
const metadata={snapshotId:"prompt-contract",snapshotHash:"a".repeat(64),coverage:{scope:"supplied-snapshot"},sourceIndex:{kind:"source-offset-index"},contextId:"sha256:"+"b".repeat(64),rows:1,envelopeSha256:"c".repeat(64),envelopeUtf8Bytes:1000};
test("codegen states the enforced guest byte ceilings and unavailable globals",()=>{
 const prompt=CODEGEN_SYSTEM+codegenUser(metadata,null);
 assert.ok(prompt.includes(String(LIMITS.promptBytes)),"per-child prompt byte cap must be disclosed");
 assert.ok(prompt.includes(String(LIMITS.totalPromptBytes)),"aggregate child prompt byte cap must be disclosed");
 assert.match(prompt,/UTF-8 bytes/);assert.match(prompt,/TextEncoder/);assert.match(prompt,/Buffer/);assert.match(prompt,/not available/);
});
test("small-context codegen avoids a redundant child analysis and includes a working retrieval pattern",()=>{
 const prompt=codegenUser(metadata,null);
 assert.match(prompt,/final synthesis performs the analysis/);
 assert.match(prompt,/do not call llm\/rlm just to repeat/);
 assert.ok(prompt.includes('JSON.parse(contextSlice(i,1)).c'));
 assert.match(prompt,/sender.*timestamp/);
});
test("synthesis allows retrieved source excerpts without altering baseline ledger rules",()=>{
 assert.equal(LEDGER_SYSTEM,WORKFLOW_SYSTEM_PROMPT);
 const prompt=ledgerUser(metadata,'{"body":"source-only fixture"}',null);
 assert.match(prompt,/retrieved source/);
 assert.ok(!prompt.includes("findings only, never message bodies"));
});
class LocalWorker extends Worker{constructor(){super(new URL("../../src/rlm/worker.mjs",import.meta.url),{env:{},execArgv:[],stdout:true,stderr:true});}}
const backend=createRlmNodeBackend({Worker:LocalWorker});
async function execute(source,context){
 const s=backend.openSession({context,limits:{},timing:{},rootPrompt:null});
 try{await s.init();return await s.evaluate(source,"");}
 finally{await s.terminate("REGRESSION_DONE");await s.waitExit();const status=s.inspect();assert.equal(status.state,"exited");assert.equal(status.exitSeen,true);await s.release();assert.equal(backend.backendStatus().liveWorkers,0);assert.equal(backend.backendStatus().state,"idle");}
}
test("oversized child prompts fail inside the real VM before any child event is admitted",async()=>{
 const source='(async()=>{contextSlice(0,1);try{return await llm("x".repeat(4097));}catch(e){return typeof e==="string"?e:"OPAQUE";}})()';
 const reply=await execute(source,'{"i":0,"c":"{}"}');
 assert.equal(reply.ok,true);assert.equal(reply.output,"PROMPT_BYTES");assert.deepEqual(reply.events,[]);
});
test("documented retrieval pattern returns exact Unicode source without a model child",async()=>{
 const snapshot={snapshotId:"example",messages:[{id:"m1",sender:"sam@example.test",timestamp:"2026-10-01T12:00:00Z",body:"α🚀 exact source"}]};
 const context=JSON.stringify({i:0,c:JSON.stringify({snapshot,sourceIndex:{}})});
 const source=RLM_SMALL_CONTEXT_PROGRAM;
 const reply=await execute(source,context);
 assert.equal(reply.ok,true);assert.deepEqual(JSON.parse(reply.output),{snapshot});assert.deepEqual(reply.events,[]);
});

// SPDX-License-Identifier: AGPL-3.0-only
// Offline evidence verifier. Does not start a daemon, contact a model, or write files.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {resolve,sep} from 'node:path';
const repo=fileURLToPath(new URL('../',import.meta.url));
const evidence=resolve(repo,'evidence/comparison-02');
const json=p=>JSON.parse(readFileSync(p,'utf8'));
const sha=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
function below(base,relative){const p=resolve(base,relative);assert.ok(p.startsWith(resolve(base)+sep),'PATH_ESCAPE');return p;}
const protocol=json(evidence+'/protocol.json'),results=json(evidence+'/results.json');
assert.equal(results.cohortId,protocol.cohortId);
assert.equal(results.status,'STOPPED_INTERRUPTED_MISSING_NATIVE_PACKET');
assert.equal(results.rows.length,12);
assert.deepEqual(results.rows.map(({id,caseId,arm,difficulty})=>({id,caseId,arm,difficulty})),protocol.runOrder);
assert.equal(results.rows.filter(r=>r.status==='NOT_RUN').length,6);
assert.equal(results.rows.filter(r=>r.status==='INTERRUPTED_UNKNOWN').length,1);
assert.equal(results.rows.filter(r=>!['NOT_RUN','INTERRUPTED_UNKNOWN'].includes(r.status)).length,5);
for(const [p,h] of Object.entries(protocol.repositoryRelativeSourcePins))assert.equal(sha(below(repo,p)),h,'SOURCE_DRIFT: '+p);
// Historical build identity is not the identity of this privacy-normalized projection.
const {WORKFLOW_SOURCE_HASH}=await import(pathToFileURL(resolve(repo,'packages/engine/dist/workflows/build-identity.js')).href);
assert.equal(WORKFLOW_SOURCE_HASH,protocol.publicationProjection.workflowSourceHash,'PUBLIC_BUILD_IDENTITY_DRIFT');
const {loadEvaluationKit}=await import(pathToFileURL(resolve(repo,'evals/governed-learning/harness.mts')).href);
const {scoreWorkflowCase}=await import(pathToFileURL(resolve(repo,'packages/engine/dist/workflows/fixtures.js')).href);
const {validateCommitmentLedger}=await import(pathToFileURL(resolve(repo,'packages/engine/dist/workflows/commitment-handoff.js')).href);
const kit=await loadEvaluationKit();let scored=0;
for(const r of results.rows){
 if(r.ledgerPath){
  const p=below(evidence,r.ledgerPath);assert.equal(sha(p),r.ledgerFileSha256);
  const c=kit.cases.find(c=>c.entry.id===r.caseId);assert.ok(c,'CASE_MISSING');
  const ledger=json(p),v=await validateCommitmentLedger(c.snapshot,ledger),s=await scoreWorkflowCase(c.snapshot,ledger,c.oracle);
  assert.deepEqual(v.report,r.validation,'VALIDATION_DRIFT: '+r.id);assert.deepEqual(s,r.score,'SCORE_DRIFT: '+r.id);scored++;
 }else assert.equal(r.score,null);
 if(r.status==='INTERRUPTED_UNKNOWN'||r.status==='NOT_RUN'){assert.equal(r.usage,null);assert.equal(r.elapsedMs,null);assert.equal(r.localClosure,null);continue;}
 assert.equal(r.localClosure.accepted,true);assert.equal(r.localClosure.supervision.childClosed,true);assert.equal(r.localClosure.supervision.group,'ABSENT');
 if(r.responsePath){const p=below(evidence,r.responsePath);assert.equal(sha(p),r.responseFileSha256);let text=readFileSync(p,'utf8').trim();const fence=text.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i);if(fence)text=fence[1].trim();assert.throws(()=>JSON.parse(text),SyntaxError);}
 if(r.arm==='rlm'&&r.status==='complete'){const t=r.analysisTrace;assert.equal(t.outcome,'complete');assert.equal(t.truncated,false);assert.ok(t.operations.some(o=>o.kind==='execute'));assert.ok(t.operations.some(o=>o.kind==='slice'));}
}
assert.equal(scored,2);
console.log(JSON.stringify({status:'PASS_OFFLINE_PUBLIC_EVIDENCE_RECHECK',scoredLedgers:scored,recordedOutcomes:5,interruptedUnknown:1,notRun:6,inferencePerformed:false,assurance:'synthetic-oracle',semanticVerified:false,historicalExecutionAttested:false,historicalSourceByteIdentical:false}));

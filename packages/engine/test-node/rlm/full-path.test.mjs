// SPDX-License-Identifier: AGPL-3.0-only
// Actual coordinator + bridge + Node Worker/QuickJS + ModelBudget + SDK.
// Only SDK fetch replies are authored fixtures. Network is denied by the host.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { Worker } from "node:worker_threads";
import { writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { createRlmRuntime } from "../../src/workflows/rlm-runtime.ts";
import { createPromptPort } from "../../src/workflows/rlm-prompts.ts";
import { createContextCodecPort } from "../../src/workflows/rlm-context-codec.ts";
import { createRlmTraceCollector, hashGeneratedSource } from "../../src/workflows/rlm-trace.ts";
import { createRlmBackendPort } from "../../src/workflows/rlm-backend-client.ts";
import { createRlmBindingHandler } from "../../src/daemon/rlm-binding.ts";
import { createRlmNodeBackend } from "../../src/rlm/node-backend.mjs";
import * as protocol from "../../src/rlm/protocol.mjs";
import { createAnthropicClient } from "../../src/llm/anthropic-client.ts";
import { createOpenAICompatibleClient } from "../../src/llm/openai-compatible-client.ts";
import { createNativeOperationScope } from "../../src/llm/native-operation-scope.ts";
import { ModelBudget } from "../../src/workflows/model-budget.ts";
import { runCommitmentWorkflow } from "../../src/workflows/run-workflow.ts";
import { createCommitmentSnapshot, validateCommitmentLedger } from "../../src/workflows/commitment-handoff.ts";

const observations = [];
const workers = [];
class ObservedWorker extends Worker {
  constructor(options) {
    super(new URL("../../src/rlm/worker.mjs", import.meta.url), {
      ...options, env: {}, execArgv: [], resourceLimits: { maxOldGenerationSizeMb: 64 },
    });
    const record = { threadId: this.threadId, exitSeen: false, exitCode: null, replies: [] };
    this.on("message", raw => {
      const reply = JSON.parse(raw);
      record.replies.push({ seq: reply.seq, kind: reply.kind, ok: reply.ok, status: reply.status, envEmpty: reply.envEmpty,
        error: reply.error, metrics: reply.metrics, events: reply.events?.map(({ prompt, ...event }) => event) });
    });
    this.on("exit", code => { record.exitSeen = true; record.exitCode = code; });
    workers.push({ worker: this, record });
  }
}
const nodeBackend = createRlmNodeBackend({ Worker: ObservedWorker });
const handler = createRlmBindingHandler({ backend: nodeBackend, protocol });
const binding = { fetch: (input, init) => handler(input instanceof Request && init === undefined ? input : new Request(input, init)) };
const readEnvelope = `const meta=JSON.parse(contextMeta());let joined="";for(let i=0;i<meta.records;i++){joined+=JSON.parse(contextSlice(i,1)).c;}const envelope=JSON.parse(joined);`;
const simpleCode = `(async()=>{${readEnvelope}return JSON.stringify({snapshotId:envelope.snapshot.snapshotId,body:envelope.snapshot.messages[0].body,bodyHash:envelope.snapshot.messages[0].bodyHash});})()`;
const childCode = `(async()=>{${readEnvelope}return JSON.stringify({body:envelope.snapshot.messages[0].body,bodyHash:envelope.snapshot.messages[0].bodyHash});})()`;
const recursiveCode = `(async()=>{${readEnvelope}const child=await rlm("Read the stored source and report the exact commitment body and hash.");const note=await llm("Review these child findings, without tools: "+child);return JSON.stringify({rootBody:envelope.snapshot.messages[0].body,child,note});})()`;
const envelope = source => JSON.stringify({ rlmCode: 1, source });

async function setup(kind) {
  assert.equal(nodeBackend.backendStatus().activeRunId, null);
  const body = "I will send the α🚀 report by 2026-09-14T17:00:00Z.";
  const snapshot = await createCommitmentSnapshot({
    workflowId: "mail.commitment-handoff.v1", schemaVersion: 1, snapshotId: "full-path-" + kind,
    userAddress: "owner@example.test", cutoff: "2026-09-11T12:00:00Z", timezone: "UTC",
    coverage: { scope: "supplied-snapshot", source: "synthetic-fixture", omittedMessages: 0, note: "Authored local integration fixture, not model efficacy." },
    messages: [{ id: "m1", threadId: "t1", subject: "Report", sender: "owner@example.test", to: "colleague@example.test",
      timestamp: "2026-09-11T11:00:00Z", body, truncated: false, omittedChars: 0 }],
  });
  const ledger = {
    workflowId: snapshot.workflowId, snapshotId: snapshot.snapshotId, snapshotHash: snapshot.snapshotHash,
    items: [{ itemId: "report", title: "Send report", owner: "owner@example.test", state: "due", dueAt: "2026-09-14T17:00:00Z",
      changed: false, evidence: [{ messageId: "m1", bodyHash: snapshot.messages[0].bodyHash, start: 0, end: body.length, quote: body }],
      priorEvidence: [], uncertainty: null, nextAction: "Send the report by the stated deadline.", replyText: null }],
    coverage: { scope: "supplied-snapshot", omittedMessages: 0, truncatedMessageIds: [], limitations: [] },
  };
  assert.equal((await validateCommitmentLedger(snapshot, ledger)).ok, true);
  const texts = kind === "recursive"
    ? [envelope(recursiveCode), envelope(childCode), "The supplied body identifies the report and its deadline.", JSON.stringify(ledger)]
    : kind === "repair" ? [envelope(simpleCode), JSON.stringify({ bad: true }), JSON.stringify(ledger)]
    : kind === "ordinary-json" ? [JSON.stringify(ledger)]
    : [envelope(simpleCode), JSON.stringify(ledger)];
  const requests = [];
  const previousFetch = globalThis.fetch;
  let client;
  try {
    globalThis.fetch = async (_url, init) => {
      const request = JSON.parse(String(init?.body));
      requests.push(request);
      assert.ok(requests.length <= texts.length, "No implicit extra model call or retry");
      assert.deepEqual(request.tools, []);
      if (kind === "openai") assert.equal(request.stream, undefined);
      else assert.equal(request.stream, false);
      assert.ok(request.max_tokens <= 4096);
      if (kind === "openai") return new Response(JSON.stringify({ id: "fixture-" + requests.length,
        choices: [{ message: { role: "assistant", content: texts[requests.length - 1] }, finish_reason: "stop" }],
        usage: { prompt_tokens: 5, completion_tokens: 3 } }), { status: 200, headers: { "content-type": "application/json" } });
      return new Response(JSON.stringify({ id: "fixture-" + requests.length, type: "message", role: "assistant", model: "fixture-model",
        content: [{ type: "text", text: texts[requests.length - 1] }], stop_reason: "end_turn", stop_sequence: null,
        usage: { input_tokens: 5, output_tokens: 3, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }),
        { status: 200, headers: { "content-type": "application/json" } });
    };
    client = kind === "openai"
      ? createOpenAICompatibleClient({ endpoint: "https://fixture.invalid/v1", apiKey: "fixture-not-a-real-api-key" })
      : createAnthropicClient("fixture-not-a-real-api-key");
  } finally { globalThis.fetch = previousFetch; }
  const native = createNativeOperationScope();
  const budget = new ModelBudget({ client, model: "fixture-model", nativeOperations: native });
  const runtime = createRlmRuntime({ ownerId: "fixture-owner", backend: createRlmBackendPort({ binding, taskId: randomUUID() }),
    prompts: createPromptPort(), codec: createContextCodecPort(), trace: createRlmTraceCollector(),
    hashSource: hashGeneratedSource, validateLedger: validateCommitmentLedger });
  return { snapshot, ledger, budget, native, runtime, requests, texts, body, firstWorker: workers.length };
}
async function run(kind) {
  const fixture = await setup(kind);
  let result;
  try {
    result = await runCommitmentWorkflow({ runId: randomUUID(), mode: "rlm", snapshot: fixture.snapshot,
      budget: fixture.budget, runtime: fixture.runtime, model: null, usageKind: "synthetic" });
    const started = workers.slice(fixture.firstWorker).map(item => item.record);
    const record = { kind, result, requests: fixture.requests, native: fixture.native.snapshot(), budget: fixture.budget.snapshot(),
      backend: nodeBackend.backendStatus(), workers: started };
    observations.push(record);
    assert.equal(started.length, 1);
    assert.ok(started.every(worker => worker.exitSeen), "Actual Worker exit, not wrapper settlement");
    assert.equal(record.backend.activeRunId, null, "Coordinator releases only after real native/Worker/event settlement");
    assert.equal(record.backend.liveWorkers, 0);
    assert.equal(record.native.observation, "SETTLED");
    assert.equal(record.native.sealed, true);
    assert.equal(record.budget.activeCalls, 0);
    assert.equal(record.budget.attempts, fixture.requests.length);
    for (const call of record.budget.ledger) assert.equal(fixture.budget.attemptNativeObservation(call.id), "SETTLED");
    assert.equal(fixture.requests.length, fixture.texts.length);
    return { ...fixture, result, record };
  } finally { fixture.budget.dispose(); }
}
function assertComplete(f) {
  assert.equal(f.result.status, "complete", JSON.stringify(f.result.validation));
  assert.deepEqual(f.result.ledger, f.ledger);
  assert.equal(f.result.validation.semanticVerified, false);
  assert.equal(f.result.usage.kind, "synthetic");
  assert.equal(f.result.usage.complete, true);
  assert.equal(f.result.analysisTrace.outcome, "complete");
  assert.equal(f.result.analysisTrace.truncated, false);
  assert.deepEqual(f.result.analysisTrace.calls.map(call => call.id), f.record.budget.ledger.map(call => `a${call.id}`));
  assert.ok(f.result.analysisTrace.operations.some(op => op.kind === "execute" && op.codeHash));
  assert.ok(f.result.analysisTrace.operations.some(op => op.kind === "slice" && op.returnedChars > 0));
  assert.ok(f.requests.at(-1).messages.some(message => JSON.stringify(message.content).includes("α🚀")), "Actual guest findings reach synthesis");
  const lastMetrics = f.record.workers[0].replies.filter(reply => reply.metrics?.readEvidence).at(-1).metrics;
  assert.equal(lastMetrics.liveVMs, 0);
  assert.equal(lastMetrics.createdVMs, lastMetrics.disposedVMs);
  assert.equal(lastMetrics.readEvidence.version, 2);
  assert.ok(lastMetrics.readEvidence.slices.some(slice => slice.utf8Bytes > slice.returnedChars));
  return lastMetrics;
}

test("full real path executes context code and returns a validated source-bound ledger", async () => {
  const f = await run("simple");
  const metrics = assertComplete(f);
  assert.equal(metrics.createdVMs, 1);
  assert.equal(f.result.usage.rootCalls, 2);
  assert.equal(f.result.usage.childCalls, 0);
  assert.ok(f.result.analysisTrace.operations.some(op => op.codeHash === createHash("sha256").update(simpleCode).digest("hex")));
});
test("full real path handles recursive code generation plus an ordinary tool-free child call", async () => {
  const f = await run("recursive");
  const metrics = assertComplete(f);
  assert.equal(metrics.createdVMs, 2);
  assert.equal(f.result.usage.rootCalls, 2);
  assert.equal(f.result.usage.childCalls, 2);
  assert.match(f.requests[1].system, /rlmCode/);
  assert.ok(f.requests[2].system.length > 0);
  assert.ok(f.result.analysisTrace.operations.some(op => op.codeHash === createHash("sha256").update(childCode).digest("hex")));
});
test("full real path uses one shared budget and exactly one ledger repair", async () => {
  const f = await run("repair");
  assertComplete(f);
  assert.equal(f.result.usage.rootCalls, 3);
  assert.equal(f.record.budget.attempts, 3);
});
test("ordinary JSON cannot bypass code execution and its known-settled failure releases", async () => {
  const f = await run("ordinary-json");
  assert.equal(f.result.status, "error");
  assert.equal(f.result.validation.level, "contract-only");
  assert.equal(f.result.validation.issues[0].code, "WORKFLOW_RLM_EXECUTION_INCOMPLETE");
  assert.equal(f.result.analysisTrace.outcome, "error");
  assert.equal(f.result.ledger, null);
  assert.equal(f.record.budget.attempts, 1);
  assert.equal(f.record.workers[0].replies.some(reply => reply.metrics?.createdVMs > 0), false);
});
test("the real OpenAI-compatible adapter also closes native work through the full path", async () => {
  const f = await run("openai");
  assertComplete(f);
  assert.equal(f.result.usage.rootCalls, 2);
  assert.equal(f.requests[0].messages[0].role, "system");
});
after(async () => {
  for (const { worker, record } of workers) if (!record.exitSeen) await worker.terminate();
  writeFileSync(process.env.RLM_FULL_PATH_OBSERVATIONS, JSON.stringify({ observations, workers: workers.map(item => item.record), backend: nodeBackend.backendStatus() }, null, 2) + "\n");
});

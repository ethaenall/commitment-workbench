// SPDX-License-Identifier: AGPL-3.0-only
// Actual service/composition/daemon host/bridge/coordinator. Only DB refusal,
// model transport, private Fetcher dispatch, clock and Worker messages are fake.
import assert from "node:assert/strict";
import { test } from "node:test";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { GovernedLearningService } from "../../src/workflows/service.ts";
import { createGovernedRlmRuntime } from "../../src/workflows/rlm-composition.ts";
import { createRlmServiceBindings } from "../../src/daemon/rlm-host.ts";
import { BINDING_SENTINEL_URL } from "../../src/daemon/rlm-binding.ts";
import { backendStatus } from "../../src/rlm/node-backend.mjs";
import * as protocol from "../../src/rlm/protocol.mjs";
import { createCommitmentSnapshot } from "../../src/workflows/commitment-handoff.ts";
import { CODEGEN_SYSTEM } from "../../src/workflows/rlm-prompts.ts";
import { LLM_NATIVE_OPERATIONS, type LLMCreateParams, type LLMResponse } from "../../src/llm/types.ts";
import type { EngineSql } from "../../src/data/helpers/types.ts";
import { planRlmRuntimeStage, RLM_VENDOR_PINS } from "../../scripts/stage-rlm-runtime.mjs";

assert.equal(process.version, "v22.22.1");
console.log("APP_TEST_ENV " + JSON.stringify({ node: process.version, actualWorker: false, actualModel: false, miniflare: false, build: false }));
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const FINDINGS = '{"note":"Synthetic café findings 😃"}';
const SOURCE = '(async()=>{const m=JSON.parse(contextMeta());for(let i=0;i<m.records;i++)contextSlice(i,1);return ' + JSON.stringify(FINDINGS) + ';})()';
class FakeClock {
  next = 0; timers = new Map<number, () => void>();
  now = () => 0;
  setTimeout = (fn: () => void, _ms: number) => { this.timers.set(++this.next, fn); return this.next; };
  clearTimeout = (id: number) => { this.timers.delete(id); };
}
async function fixture(enabled: boolean, failGuest = false) {
  assert.equal(backendStatus().activeRunId, null, "prior test retained a real backend lease");
  const snapshot = await createCommitmentSnapshot({ workflowId: "mail.commitment-handoff.v1", schemaVersion: 1,
    snapshotId: "app-fixture", userAddress: "reader@example.test", cutoff: "2026-09-01T12:00:00Z", timezone: "UTC",
    coverage: { scope: "supplied-snapshot", source: "synthetic-fixture", omittedMessages: 0, note: "Control flow only." },
    messages: [{ id: "m1", threadId: "t1", subject: "Café 😃", sender: "writer@example.test", to: "reader@example.test",
      timestamp: "2026-09-01T10:00:00Z", body: "The café note is closed 😃.\n", truncated: false, omittedChars: 0 }] });
  const ledger = { workflowId: snapshot.workflowId, snapshotId: snapshot.snapshotId, snapshotHash: snapshot.snapshotHash, items: [],
    coverage: { scope: "supplied-snapshot", omittedMessages: 0, truncatedMessageIds: [], limitations: ["Synthetic control flow, not efficacy."] } };
  const clock = new FakeClock(), calls: Array<Record<string, any>> = [], posted: Array<Record<string, any>> = [];
  const workers: FakeWorker[] = [], modelParams: LLMCreateParams[] = [];
  let clientAcquisitions = 0, teardown = false;
  class FakeWorker extends EventEmitter {
    exited = false; context = ""; complete = false;
    reads: Array<{ nodeId: string; start: number; count: number; utf8Bytes: number; returnedChars: number }> = [];
    executes: Array<{ nodeId: string; parentId: null; depth: number; sourceSha256: string }> = [];
    constructor(options: unknown) {
      super(); assert.deepEqual(options, { env: {}, execArgv: [] }); workers.push(this);
      queueMicrotask(() => this.emit("message", JSON.stringify({ v: 1, kind: "ready", envEmpty: true, metrics: this.metrics() })));
    }
    metrics() {
      return { memoryInstances: 1, memoryIdentity: true, pendingEvents: 0, liveVMs: this.complete ? 0 : this.executes.length,
        readEvidence: { version: 2, successfulSliceCount: this.reads.length, successfulExecuteCount: this.executes.length,
          slices: this.reads, executes: this.executes, truncated: false,
          coverageByNode: this.reads.length ? [{ nodeId: "n0", ranges: [{ start: 0, end: this.reads.length }] }] : [] } };
    }
    postMessage(raw: string) {
      const cmd = protocol.parseWorkerCommand(raw, JSON.parse(raw).op === "init" ? protocol.LIMITS.initWireBytes : protocol.LIMITS.wireBytes);
      posted.push(cmd);
      if (cmd.op === "init") { this.context = cmd.context; assert.equal(cmd.contextId, "sha256:" + digest(this.context)); }
      if (cmd.op === "evaluate" && !failGuest) {
        assert.equal(cmd.source, SOURCE);
        this.executes.push({ nodeId: "n0", parentId: null, depth: 0, sourceSha256: digest(cmd.source) });
        this.reads = this.context.split("\n").map((row, start) => ({ nodeId: "n0", start, count: 1, utf8Bytes: Buffer.byteLength(row), returnedChars: row.length }));
        this.complete = true;
      }
      const reply = cmd.op === "evaluate" && failGuest
        ? { v: 1, seq: cmd.seq, ok: false, error: { code: "GUEST_ERROR" }, events: [], output: null, metrics: this.metrics() }
        : { v: 1, seq: cmd.seq, ok: true, status: this.complete ? "complete" : "waiting", events: [], output: this.complete ? FINDINGS : null, metrics: this.metrics() };
      queueMicrotask(() => this.emit("message", protocol.encodeWorkerReply(reply)));
    }
    terminate() { queueMicrotask(() => { if (!this.exited) { this.exited = true; this.emit("exit", 0); } }); return Promise.resolve(0); }
  }
  const bindings = createRlmServiceBindings({ GOVERNED_RLM: enabled ? "true" : "false" }, { Worker: FakeWorker, clock });
  const binding = bindings.RLM_BACKEND ? { async fetch(request: Request) {
    calls.push({ ...await request.clone().json(), teardown }); return bindings.RLM_BACKEND!(request);
  } } : undefined;
  const runtime = createGovernedRlmRuntime({ GOVERNED_RLM: enabled ? "true" : "false", RLM_BACKEND: binding }, "app-owner");
  const sql = (() => { throw new Error("Unexpected database access in source-only run"); }) as EngineSql;
  const service = new GovernedLearningService({ ownerId: "app-owner", sql, transaction: (body) => body(),
    audit: () => { throw new Error("Unexpected audit write"); }, getModelConfig: () => ({ provider: "anthropic", model: "fixture-model", maxTokens: 1024, apiKey: "fake-not-a-secret" }),
    usageKind: "synthetic", runtime, getClient: () => {
      clientAcquisitions++;
      return { async createMessage(params: LLMCreateParams) {
        modelParams.push(params); assert.equal(params.disableRetries, true); assert.deepEqual(params.tools, []);
        const text = params.system === CODEGEN_SYSTEM ? JSON.stringify({ rlmCode: 1, source: SOURCE }) : JSON.stringify(ledger);
        const result: LLMResponse = { id: `m${modelParams.length}`, content: [{ type: "text", text }], stop_reason: "end_turn", usage: { input_tokens: 11, output_tokens: 7 } };
        const observer = params[LLM_NATIVE_OPERATIONS];
        if (!observer) return result;
        const transport = observer.openTransport();
        try { return await transport.trackPromise("fetch", () => Promise.resolve(result)); }
        finally { transport.closeProducer(); }
      } };
    } });
  return { service, ledger, snapshot, calls, posted, workers, modelParams, clock,
    get clientAcquisitions() { return clientAcquisitions; },
    async cleanup() {
      service.cancelAll(); teardown = true;
      if (backendStatus().activeRunId !== null) {
        const open = calls.findLast((call) => call.op === "open"); assert.ok(open); assert.ok(bindings.RLM_BACKEND);
        const identity = { ownerId: open.ownerId, taskId: open.taskId, sessionNonce: open.sessionNonce, runId: backendStatus().activeRunId };
        for (const op of ["terminate", "waitExit", "release"]) {
          const command = { ...identity, op, ...(op === "terminate" ? { reason: "FIXTURE_TEARDOWN" } : {}) };
          const response = await bindings.RLM_BACKEND(new Request(BINDING_SENTINEL_URL, { method: "POST",
            headers: { "content-type": "application/json", "x-habenula-owner": identity.ownerId,
              "x-habenula-task": identity.taskId, "x-habenula-session": identity.sessionNonce }, body: JSON.stringify(command) }));
          assert.equal(response.status, 200);
        }
      }
      assert.equal(backendStatus().activeRunId, null); assert.equal(clock.timers.size, 0); assert.ok(workers.every((worker) => worker.exited));
    } };
}

test("trusted flag AND private Fetcher gate; creating composition and daemon binding is cold", async () => {
  let fetches = 0, constructed = 0;
  const binding = { async fetch() { fetches++; throw new Error("cold"); } };
  assert.equal(createGovernedRlmRuntime({}, "o"), undefined);
  assert.equal(createGovernedRlmRuntime({ GOVERNED_RLM: "true" }, "o"), undefined);
  assert.equal(createGovernedRlmRuntime({ GOVERNED_RLM: "TRUE", RLM_BACKEND: binding }, "o"), undefined);
  assert.equal(createGovernedRlmRuntime({ RLM_BACKEND: binding }, "o"), undefined);
  assert.ok(createGovernedRlmRuntime({ GOVERNED_RLM: "true", RLM_BACKEND: binding }, "o"));
  const Worker = class extends EventEmitter {
    constructor() { super(); constructed++; throw new Error("cold"); }
    postMessage(_value: string) { throw new Error("cold"); }
    terminate() { return Promise.resolve(0); }
  };
  assert.deepEqual(createRlmServiceBindings({}, { Worker }), {});
  assert.ok(createRlmServiceBindings({ GOVERNED_RLM: "true" }, { Worker }).RLM_BACKEND);
  assert.equal(constructed, 0); assert.equal(fetches, 0); assert.equal(backendStatus().activeRunId, null);
});

test("disabled RLM/both block before a model call; ordinary baseline keeps native scope absent", async () => {
  const h = await fixture(false);
  try {
    assert.deepEqual(h.service.describe().supportedModes, ["baseline", "refinements"]);
    for (const mode of ["rlm", "both"] as const) {
      const result = await h.service.run({ userId: "app-owner", workflowId: h.snapshot.workflowId, mode, snapshot: h.snapshot });
      assert.equal(result.status, "blocked"); assert.equal(result.ledger, null);
    }
    assert.equal(h.clientAcquisitions, 0); assert.equal(h.modelParams.length, 0);
    const baseline = await h.service.run({ userId: "app-owner", workflowId: h.snapshot.workflowId, mode: "baseline", snapshot: h.snapshot });
    assert.equal(baseline.status, "complete"); assert.deepEqual(baseline.ledger, h.ledger);
    assert.equal(h.clientAcquisitions, 1); assert.equal(h.modelParams.length, 1);
    assert.equal(h.modelParams[0]![LLM_NATIVE_OPERATIONS], undefined);
    assert.equal(h.calls.length, 0); assert.equal(h.workers.length, 0);
  } finally { await h.cleanup(); }
});

test("actual service/DO composition/private daemon bridge run two tasks with fresh identities, budget and trace", async () => {
  const h = await fixture(true);
  try {
    assert.deepEqual(h.service.describe().supportedModes, ["baseline", "refinements", "rlm", "both"]);
    const results = [];
    for (let i = 0; i < 2; i++) {
      const result = await h.service.run({ userId: "app-owner", workflowId: h.snapshot.workflowId, mode: "rlm", snapshot: h.snapshot }); results.push(result);
      assert.equal(result.status, "complete", JSON.stringify(result)); assert.deepEqual(result.ledger, h.ledger);
      assert.equal(result.usage.rootCalls, 2); assert.equal(result.usage.childCalls, 0); assert.equal(result.usage.complete, true);
      assert.deepEqual(result.analysisTrace?.calls.map((call) => call.id), ["a1", "a2"]);
      assert.equal(result.analysisTrace?.operations.filter((op) => op.kind === "execute").length, 1);
      assert.equal(backendStatus().activeRunId, null); assert.equal(h.clock.timers.size, 0);
    }
    assert.notEqual(results[0]!.analysisTrace, results[1]!.analysisTrace); assert.notEqual(results[0]!.runId, results[1]!.runId);
    assert.equal(h.clientAcquisitions, 2); assert.equal(h.modelParams.length, 4);
    assert.ok(h.modelParams.every((params) => params[LLM_NATIVE_OPERATIONS] !== undefined));
    const opens = h.calls.filter((call) => call.op === "open"), inits = h.posted.filter((cmd) => cmd.op === "init");
    assert.equal(opens.length, 2); assert.equal(inits.length, 2); assert.notEqual(opens[0]!.taskId, opens[1]!.taskId);
    assert.notEqual(opens[0]!.sessionNonce, opens[1]!.sessionNonce);
    assert.ok(opens.every((call) => call.ownerId === "app-owner"));
    assert.equal(h.calls.filter((call) => call.op === "release" && !call.teardown).length, 2);
    for (const init of inits) {
      const decoded = JSON.parse(init.context.split("\n").map((row: string) => JSON.parse(row).c).join(""));
      assert.deepEqual(decoded.snapshot, h.snapshot); assert.ok(decoded.sourceIndex);
    }
    assert.equal(h.workers.length, 2); assert.ok(h.workers.every((worker) => worker.exited));
  } finally { await h.cleanup(); }
});

test("guest failure has no published ledger and releases independently verified resources", async () => {
  const h = await fixture(true, true);
  try {
    const result = await h.service.run({ userId: "app-owner", workflowId: h.snapshot.workflowId, mode: "rlm", snapshot: h.snapshot });
    assert.notEqual(result.status, "complete"); assert.equal(result.ledger, null); assert.equal(h.modelParams.length, 1);
    assert.equal(h.calls.filter((call) => call.op === "publish").length, 0);
    assert.equal(h.calls.filter((call) => call.op === "release" && !call.teardown).length, 1);
    assert.equal(backendStatus().activeRunId, null);
  } finally { await h.cleanup(); }
});

test("stage plan pins actual 15 assets and notices; UserAgent and build use real exported wiring", () => {
  const engine = fileURLToPath(new URL("../../", import.meta.url));
  const plan = planRlmRuntimeStage(engine); // Read-only; this is not a build/stage execution.
  assert.equal(Object.keys(RLM_VENDOR_PINS).length, 15); assert.equal(plan.files.length, 24);
  assert.deepEqual(plan.files.filter((file) => file.path.endsWith(".d.mts")).map((file) => file.path).sort(),
    ["dist/rlm/node-backend.d.mts", "dist/rlm/protocol.d.mts", "dist/rlm/timing-policy.d.mts"]);
  assert.deepEqual(plan.files.filter((file) => /^dist\/rlm\/[^/]+\.mjs$/.test(file.path)).map((file) => file.path).sort(),
    ["dist/rlm/node-backend.mjs", "dist/rlm/protocol.mjs", "dist/rlm/read-evidence.mjs", "dist/rlm/timing-policy.mjs", "dist/rlm/worker.mjs"]);
  assert.equal(plan.files.filter((file) => file.path.startsWith("dist/rlm/node_modules/")).length, 15);
  assert.ok(plan.files.find((file) => file.path === "dist/rlm/NOTICE")?.content.includes("QuickJS"));
  const user = readFileSync(new URL("../../src/agent/user-agent.ts", import.meta.url), "utf8");
  assert.ok(user.includes('runtime: createGovernedRlmRuntime(this.env, ownerId)'));
  const daemon = readFileSync(new URL("../../src/daemon/start.ts", import.meta.url), "utf8");
  assert.ok(daemon.includes('serviceBindings: createRlmServiceBindings(process.env)')); assert.ok(daemon.includes('"GOVERNED_RLM"'));
  assert.ok(daemon.includes('Promise<DaemonHandle>')); assert.ok(daemon.includes('stopSupervision(); await mf.dispose()'));
  assert.ok(daemon.includes('return () => { clearInterval(timer); stopped.abort(); };'));
  const host = readFileSync(new URL("../../src/daemon/rlm-host.ts", import.meta.url), "utf8");
  assert.ok(host.includes('env: {}, execArgv: [], stdout: true, stderr: true'));
  const build = readFileSync(new URL("../../scripts/build.mjs", import.meta.url), "utf8");
  assert.ok(build.includes('run("node", ["scripts/stage-rlm-runtime.mjs"])'));
  const identity = readFileSync(new URL("../../scripts/workflow-identity.mjs", import.meta.url), "utf8");
  assert.ok(identity.includes('"packages/engine/scripts/stage-rlm-runtime.mjs"'));
});

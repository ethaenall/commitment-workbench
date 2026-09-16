// SPDX-License-Identifier: AGPL-3.0-only
// Real coordinator, budget, prompts, trace, codec, facade, binding and Node backend.
// Only model transport, Fetcher dispatch, clock and Worker message boundary are fake.
import assert from "node:assert/strict";
import { test, after } from "node:test";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { createRlmRuntime } from "../../src/workflows/rlm-runtime.ts";
import { createPromptPort } from "../../src/workflows/rlm-prompts.ts";
import { createRlmTraceCollector, hashGeneratedSource } from "../../src/workflows/rlm-trace.ts";
import { createContextCodecPort } from "../../src/workflows/rlm-context-codec.ts";
import { createCommitmentSnapshot, createCommitmentSourceIndex, validateCommitmentLedger } from "../../src/workflows/commitment-handoff.ts";
import { WORKFLOW_SYSTEM_PROMPT } from "../../src/workflows/run-workflow.ts";
import { ModelBudget } from "../../src/workflows/model-budget.ts";
import { createNativeOperationScope } from "../../src/llm/native-operation-scope.ts";
import { fetchBoundedResponse } from "../../src/llm/bounded-response.ts";
import { LLM_NATIVE_OPERATIONS, type LLMCreateParams, type LLMResponse } from "../../src/llm/types.ts";
import { createRlmBackendPort } from "../../src/workflows/rlm-backend-client.ts";
import { createRlmBindingHandler, type BindingSession } from "../../src/daemon/rlm-binding.ts";
import { createRlmNodeBackend } from "../../src/rlm/node-backend.mjs";
import * as protocol from "../../src/rlm/protocol.mjs";
import type { CommitmentSnapshot } from "@habenula-ai/contracts";

assert.equal(process.version, "v22.22.1");
console.log("RUNTIME_TEST_ENV " + JSON.stringify({ node: process.version, execPath: process.execPath, actualWorker: false, actualModel: false }));
const observations: unknown[] = [];
after(() => { if (process.env.RLM_RUNTIME_OBSERVATIONS) writeFileSync(process.env.RLM_RUNTIME_OBSERVATIONS, JSON.stringify(observations, null, 2) + "\n"); });
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}
// Fixed event-loop drainage for these in-memory boundaries; never a settlement oracle.
async function drainTurns() { for (let i = 0; i < 32; i++) await new Promise<void>((resolve) => setImmediate(resolve)); }
class FakeClock {
  next = 0; timers = new Map<number, () => void>();
  now = () => 0;
  setTimeout = (fn: () => void, _ms: number) => { this.timers.set(++this.next, fn); return this.next; };
  clearTimeout = (id: number) => { this.timers.delete(id); };
}
type Mode = "normal" | "evaluate-events" | "pump-events" | "child-rlm" | "invalid-code" | "eval-failed" | "unknown-usage" | "unobserved" | "late-cancel" | "repair" | "duplicate-event" | "no-evidence" | "waiting";
const CHILD_SOURCE = '(() => JSON.stringify({note: input}))()';
const FINDINGS = '{"note":"Synthetic guest findings 😃"}';
async function fixture(mode: Mode = "normal", suffix = "one") {
  assert.equal(createRlmNodeBackend({ Worker: class {} }).backendStatus().activeRunId, null, "prior fixture retained a real backend permit");
  const snapshot = await createCommitmentSnapshot({
    workflowId: "mail.commitment-handoff.v1", schemaVersion: 1, snapshotId: `fixture-${suffix}`,
    userAddress: "reader@example.test", cutoff: "2026-09-01T12:00:00Z", timezone: "UTC",
    coverage: { scope: "supplied-snapshot", source: "synthetic-fixture", omittedMessages: 2, note: "Only fixture correspondence." },
    messages: [{ id: "m1", threadId: "t1", subject: "Café note", sender: "writer@example.test", to: "reader@example.test",
      timestamp: "2026-09-01T10:00:00Z", body: "Status 😃\r\nThe café note is closed.\n", truncated: true, omittedChars: 7 }],
  });
  const sourceIndex = await createCommitmentSourceIndex(snapshot);
  const ledger = { workflowId: snapshot.workflowId, snapshotId: snapshot.snapshotId, snapshotHash: snapshot.snapshotHash, items: [],
    coverage: { scope: "supplied-snapshot", omittedMessages: 2, truncatedMessageIds: ["m1"], limitations: ["Synthetic control-flow fixture, not semantic assessment."] } };
  const work = mode === "child-rlm" ? 'await rlm("child task");' : ["evaluate-events", "pump-events", "duplicate-event"].includes(mode)
    ? 'await llm("first subtask"); await llm("second subtask");' : "";
  const rootSource = '(async()=>{const m=JSON.parse(contextMeta());let s="";for(let i=0;i<m.records;i++)s+=JSON.parse(contextSlice(i,1)).c;JSON.parse(s);' + work + 'return ' + JSON.stringify(FINDINGS) + ';})()';
  const calls: Array<Record<string, any>> = [], posted: Array<Record<string, any>> = [], modelParams: LLMCreateParams[] = [];
  const sessions: BindingSession[] = [], workers: FakeWorker[] = [];
  const clock = new FakeClock();
  let teardown = false, synthesisCount = 0, nativeCancelStarts = 0;
  const readEntered = deferred(), lateCancel = deferred();
  class FakeWorker extends EventEmitter {
    exited = false; context = ""; runId = ""; pumps = 0; afterFirst = false; nextEvent = 1;
    emitted = new Set<string>();
    pending = new Map<string, { id: string; kind: string; runId: string; nodeId: string; parentId: string; depth: number; prompt: string }>();
    reads: Array<{ nodeId: string; start: number; count: number; utf8Bytes: number; returnedChars: number }> = [];
    executes: Array<{ nodeId: string; parentId: string | null; depth: number; sourceSha256: string }> = [];
    complete = false;
    constructor(options: unknown) {
      super(); workers.push(this); assert.deepEqual(options, { env: {}, execArgv: [] });
      queueMicrotask(() => this.emit("message", JSON.stringify({ v: 1, kind: "ready", envEmpty: true, metrics: this.metrics() })));
    }
    metrics() {
      const ranges = this.reads.map((r) => ({ start: r.start, end: r.start + r.count }));
      const merged: Array<{ start: number; end: number }> = [];
      for (const row of ranges) { const last = merged.at(-1); if (last && row.start <= last.end) last.end = Math.max(last.end, row.end); else merged.push({ ...row }); }
      return { memoryInstances: 1, memoryIdentity: true, pendingEvents: this.pending.size, createdVMs: this.executes.length,
        liveVMs: this.complete ? 0 : this.executes.length,
        ...(mode === "no-evidence" ? {} : { readEvidence: { version: 2, successfulSliceCount: this.reads.length, successfulExecuteCount: this.executes.length,
          slices: this.reads, executes: this.executes, coverageByNode: this.reads.length ? [{ nodeId: "n0", ranges: merged }] : [], truncated: false } }) };
    }
    addEvent(kind = "llm") {
      const n = this.nextEvent++;
      const event = { id: `e${n}`, kind, runId: this.runId, nodeId: `n${n}`, parentId: "n0", depth: 1,
        prompt: kind === "rlm" ? "child task" : n === 1 ? "first subtask" : "second subtask" };
      this.pending.set(event.id, event); this.emitted.add(event.id); return event;
    }
    postMessage(raw: string) {
      const cmd = protocol.parseWorkerCommand(raw, JSON.parse(raw).op === "init" ? protocol.LIMITS.initWireBytes : protocol.LIMITS.wireBytes);
      posted.push(cmd); this.runId = cmd.runId;
      let events: unknown[] = [], error: string | null = null;
      if (cmd.op === "init") { this.context = cmd.context; assert.equal(cmd.contextId, "sha256:" + digest(this.context)); }
      if (cmd.op === "evaluate") {
        assert.equal(cmd.source, rootSource);
        if (mode === "eval-failed") error = "GUEST_ERROR";
        else {
          this.executes.push({ nodeId: "n0", parentId: null, depth: 0, sourceSha256: digest(cmd.source) });
          this.reads = this.context.split("\n").map((row, start) => ({ nodeId: "n0", start, count: 1, utf8Bytes: Buffer.byteLength(row), returnedChars: row.length }));
          if (mode === "evaluate-events" || mode === "duplicate-event") events = [this.addEvent()];
          else if (mode === "child-rlm") events = [this.addEvent("rlm")];
          else if (mode !== "pump-events" && mode !== "waiting") this.complete = true;
        }
      }
      if (cmd.op === "resolve") {
        const event = this.pending.get(cmd.eventId); assert.ok(event, "fixture resolution must match an emitted event");
        this.pending.delete(cmd.eventId);
        if (event.kind === "rlm") {
          assert.equal(cmd.value, CHILD_SOURCE, "child resolution must receive parsed code, not the envelope");
          this.executes.push({ nodeId: event.nodeId, parentId: event.parentId, depth: event.depth, sourceSha256: digest(cmd.value) }); this.complete = true;
        } else if (event.id === "e1") {
          this.afterFirst = true;
          if (mode === "duplicate-event") events = [event];
        } else this.complete = true;
      }
      if (cmd.op === "pump" && !this.complete) {
        this.pumps++;
        if (mode === "pump-events" && this.nextEvent === 1) events = [this.addEvent()];
        else if (this.afterFirst && this.nextEvent === 2) events = [this.addEvent()];
        // Fail a deliberately stalled fake boundary promptly, rather than spend
        // the Node test timeout cycling after the coordinator dropped an event.
        else if (this.pending.size && this.pumps > 2) error = "FIXTURE_UNRESOLVED_EVENT";
      }
      const reply = error ? { v: 1, seq: cmd.seq, ok: false, error: { code: error }, events: [], output: null, metrics: this.metrics() }
        : { v: 1, seq: cmd.seq, ok: true, status: this.complete ? "complete" : "waiting", events, output: this.complete ? FINDINGS : null, metrics: this.metrics() };
      queueMicrotask(() => this.emit("message", protocol.encodeWorkerReply(reply)));
    }
    terminate() { queueMicrotask(() => { if (!this.exited) { this.exited = true; this.emit("exit", 0); } }); return Promise.resolve(0); }
  }
  const actualNode = createRlmNodeBackend({ Worker: FakeWorker, clock });
  const backend = { backendStatus: actualNode.backendStatus, openSession(args: Parameters<typeof actualNode.openSession>[0]) {
    const session = actualNode.openSession(args); sessions.push(session); return session;
  } };
  const handler = createRlmBindingHandler({ backend, protocol });
  const port = createRlmBackendPort({ taskId: `runtime-${suffix}`, binding: { async fetch(request: Request) {
    const cmd = await request.clone().json(); calls.push({ ...cmd, teardown });
    return handler(request);
  } } });
  const nativeScope = createNativeOperationScope();
  const controller = new AbortController();
  const budget = new ModelBudget({ model: "fixture-model", signal: controller.signal, nativeOperations: nativeScope, client: { async createMessage(params) {
    modelParams.push(params);
    assert.equal(params.disableRetries, true); assert.deepEqual(params.tools, []);
    const observer = params[LLM_NATIVE_OPERATIONS]; assert.ok(observer);
    if (mode === "late-cancel") {
      const stream = new ReadableStream<Uint8Array>({ pull() { readEntered.resolve(); }, cancel() { nativeCancelStarts++; return lateCancel.promise; } });
      await fetchBoundedResponse((async () => new Response(stream)) as typeof fetch, "https://fixture.invalid/never-requested", { signal: params.signal }, 64, observer);
      throw new Error("The aborted fake read must not produce a model response");
    }
    let text: string;
    if (modelParams.length === 1) text = mode === "invalid-code" ? JSON.stringify(ledger) : JSON.stringify({ rlmCode: 1, source: rootSource });
    else if (mode === "child-rlm" && modelParams.length === 2) text = JSON.stringify({ rlmCode: 1, source: CHILD_SOURCE });
    else if (["evaluate-events", "pump-events", "duplicate-event"].includes(mode) && modelParams.length < 4) text = "bounded subtask answer";
    else { synthesisCount++; text = JSON.stringify(mode === "repair" && synthesisCount === 1 ? { ...ledger, snapshotHash: "0".repeat(64) } : ledger); }
    const response: LLMResponse = { id: `response-${modelParams.length}`, content: [{ type: "text", text }], stop_reason: "end_turn",
      usage: { input_tokens: 11, output_tokens: 7, ...(mode === "unknown-usage" ? { reported: false } : {}) } };
    if (mode === "unobserved") return response;
    const transport = observer.openTransport();
    try { return await transport.trackPromise("fetch", () => Promise.resolve(response)); }
    finally { transport.closeProducer(); }
  } } });
  const runtime = createRlmRuntime({ backend: port, ownerId: "runtime-owner", prompts: createPromptPort(), trace: createRlmTraceCollector(),
    codec: createContextCodecPort(), hashSource: hashGeneratedSource,
    validateLedger: (value, output) => validateCommitmentLedger(value as CommitmentSnapshot, output) });
  const input = { snapshot, sourceIndex, system: WORKFLOW_SYSTEM_PROMPT, guidance: null, budget, signal: controller.signal, maxRepairs: 1, assertCurrent() {} };
  function runtimeReleases() { return calls.filter((c) => c.op === "release" && !c.teardown); }
  return { runtime, input, snapshot, sourceIndex, ledger, rootSource, budget, nativeScope, controller, calls, posted, modelParams, backend,
    readEntered, lateCancel, runtimeReleases, get nativeCancelStarts() { return nativeCancelStarts; },
    async cleanup() {
      // Teardown is separately labelled, never counted as coordinator success.
      teardown = true; lateCancel.resolve(); budget.dispose(); await drainTurns();
      for (const session of sessions) {
        if (backend.backendStatus().activeRunId !== session.id) continue;
        await session.terminate("FIXTURE_TEARDOWN"); await session.waitExit();
        for (const event of workers.flatMap((w) => [...w.emitted])) {
          try { await session.clearSettledEvent(event); } catch { /* It was already resolved. */ }
        }
        // Every model/Worker boundary is owned and stopped here. This direct
        // fixture release is not a claim of runtime native-settlement proof.
        await session.release();
      }
      assert.equal(backend.backendStatus().activeRunId, null); assert.equal(clock.timers.size, 0);
    },
  };
}

test("normal completion terminates, waits, freshly inspects and releases the real backend", async () => {
  const h = await fixture();
  try {
    const result = await h.runtime.run(h.input);
    assert.deepEqual(result.output, h.ledger); assert.equal(result.trace?.outcome, "complete");
    assert.equal(h.runtimeReleases().length, 1); assert.equal(h.backend.backendStatus().activeRunId, null);
    const stop = h.calls.findIndex((c) => c.op === "terminate");
    const wait = h.calls.findIndex((c) => c.op === "waitExit");
    const inspect = h.calls.findIndex((c, i) => i > wait && c.op === "inspect");
    const release = h.calls.findIndex((c) => c.op === "release");
    assert.ok(stop >= 0 && stop < wait && wait < inspect && inspect < release);
    assert.equal(h.calls[stop]?.reason, "COMPLETE"); assert.equal(h.nativeScope.snapshot().observation, "SETTLED");
    assert.equal(h.budget.signal.aborted, false, "success sealing must not abort a successful budget");
    assert.deepEqual(result.trace?.calls.map((c) => c.id), h.budget.snapshot().ledger.map((c) => `a${c.id}`));
    const init = h.posted.find((c) => c.op === "init"); assert.ok(init);
    const envelope = JSON.parse(init.context.split("\n").map((row: string) => JSON.parse(row).c).join(""));
    assert.deepEqual(envelope, { snapshot: h.snapshot, sourceIndex: h.sourceIndex });
    const slices = result.trace?.operations.filter((op) => op.kind === "slice") ?? [];
    assert.equal(slices.reduce((n, row) => n + row.returnedChars, 0), init.context.split("\n").reduce((n: number, row: string) => n + row.length, 0));
    assert.ok(Buffer.byteLength(init.context) > init.context.length, "Unicode witness distinguishes chars from bytes");
    assert.equal(result.trace?.operations.filter((op) => op.kind === "execute")[0]?.codeHash, digest(h.rootSource));
    assert.equal(h.budget.snapshot().attempts, 2);
    await assert.rejects(() => h.budget.clientFor("root").createMessage({ model: "fixture-model", max_tokens: 1, messages: [] }), /DISPOSED/);
    assert.equal(h.modelParams.length, 2);
    observations.push({ case: "normal", trace: result.trace, budget: h.budget.snapshot(), wireOperations: h.calls.map((c) => c.op) });
  } finally { await h.cleanup(); }
});
for (const mode of ["evaluate-events", "pump-events"] as const) test(`${mode}: consume first and later event batches exactly once`, async () => {
  const h = await fixture(mode);
  try {
    const result = await h.runtime.run(h.input);
    assert.deepEqual(result.output, h.ledger);
    assert.deepEqual(h.posted.filter((c) => c.op === "resolve").map((c) => c.eventId), ["e1", "e2"]);
    assert.equal(h.modelParams.length, 4); assert.equal(h.runtimeReleases().length, 1);
    for (const params of h.modelParams.slice(1, 3)) { assert.ok(params.system?.includes("subtask")); assert.ok(params.system?.includes("tool")); }
    assert.deepEqual(result.trace?.calls.map((c) => c.id), ["a1", "a2", "a3", "a4"]);
    assert.equal(result.trace?.operations.filter((op) => op.kind === "execute").length, 1, "cumulative telemetry must not duplicate executes");
  } finally { await h.cleanup(); }
});
test("child rlm uses trusted codegen, parses the mandatory envelope and resolves only source", async () => {
  const h = await fixture("child-rlm");
  try {
    const result = await h.runtime.run(h.input);
    assert.deepEqual(result.output, h.ledger); assert.ok(h.modelParams[1]?.system?.includes("rlmCode"));
    assert.equal(h.posted.find((c) => c.op === "resolve")?.value, CHILD_SOURCE);
    assert.equal(result.trace?.operations.find((op) => op.nodeId === "n1" && op.kind === "execute")?.codeHash, digest(CHILD_SOURCE));
    assert.deepEqual(result.trace?.nodes.find((n) => n.id === "n1"), { id: "n1", parentId: "n0", depth: 1 });
    assert.equal(h.budget.snapshot().attempts, 3); assert.equal(h.runtimeReleases().length, 1);
  } finally { await h.cleanup(); }
});
test("ordinary JSON at codegen fails without guest execution or repair, then releases known-settled failure", async () => {
  const h = await fixture("invalid-code");
  try {
    const result = await h.runtime.run(h.input);
    assert.equal(result.output, null); assert.equal(result.trace?.outcome, "error");
    assert.equal(h.posted.filter((c) => c.op === "evaluate").length, 0); assert.equal(h.budget.snapshot().attempts, 1);
    assert.equal(h.runtimeReleases().length, 1); assert.equal(h.nativeScope.snapshot().observation, "SETTLED");
  } finally { await h.cleanup(); }
});
test("failed evaluate never invents executed-code evidence", async () => {
  const h = await fixture("eval-failed");
  try {
    const result = await h.runtime.run(h.input);
    assert.equal(result.output, null); assert.equal(result.trace?.operations.filter((op) => op.kind === "execute").length, 0);
    assert.equal(h.runtimeReleases().length, 1);
  } finally { await h.cleanup(); }
});
test("unknown billing is not native resource debt when the actual attempt is settled", async () => {
  const h = await fixture("unknown-usage");
  try {
    const result = await h.runtime.run(h.input);
    assert.equal(result.output, null); assert.equal(h.budget.snapshot().usageStatus, "unknown");
    assert.equal(h.budget.snapshot().reservedOutputTokens > 0, true);
    assert.equal(result.trace?.calls[0]?.id, "a1", "failed admitted calls need their real budget identity");
    assert.equal(h.runtimeReleases().length, 1);
  } finally { await h.cleanup(); }
});
test("an uninstrumented client remains quarantined despite no active client promise", async () => {
  const h = await fixture("unobserved");
  try {
    const result = await h.runtime.run(h.input);
    assert.equal(result.output, null); assert.equal(h.budget.snapshot().activeCalls, 0);
    assert.equal(h.nativeScope.snapshot().observation, "UNOBSERVED"); assert.equal(h.runtimeReleases().length, 0);
    assert.notEqual(h.backend.backendStatus().activeRunId, null);
  } finally { await h.cleanup(); }
});
test("late real tracked stream cancellation retains the permit until actual native join", async () => {
  const h = await fixture("late-cancel");
  try {
    const run = h.runtime.run(h.input); await h.readEntered.promise; h.controller.abort();
    const result = await run;
    assert.equal(result.output, null); assert.equal(h.nativeCancelStarts, 1);
    assert.equal(h.nativeScope.snapshot().pendingOperations, 1); assert.equal(h.runtimeReleases().length, 0);
    assert.notEqual(h.backend.backendStatus().activeRunId, null);
    h.lateCancel.resolve(); await drainTurns();
    assert.equal(h.nativeScope.snapshot().observation, "SETTLED");
    assert.equal(h.runtimeReleases().length, 1, "late release must follow the actual join, not just public failure");
    observations.push({ case: "late-cancel", native: h.nativeScope.snapshot(), budget: h.budget.snapshot(), releases: h.runtimeReleases().length });
  } finally { await h.cleanup(); }
});
test("ledger repair uses the same budget and is limited to one additional root call", async () => {
  const h = await fixture("repair");
  try {
    const result = await h.runtime.run(h.input);
    assert.deepEqual(result.output, h.ledger); assert.equal(h.budget.snapshot().attempts, 3);
    assert.ok(h.budget.snapshot().ledger.every((c) => c.role === "root"));
    assert.deepEqual(result.trace?.calls.map((c) => c.id), ["a1", "a2", "a3"]);
    const repair = h.modelParams[2]?.messages[0]?.content;
    assert.ok(typeof repair === "string" && repair.includes("One output-contract repair"));
  } finally { await h.cleanup(); }
});
test("duplicate guest events never dispatch a second model call for the same id", async () => {
  const h = await fixture("duplicate-event");
  try {
    const result = await h.runtime.run(h.input);
    assert.equal(result.output, null); assert.ok(h.modelParams.length <= 2);
    assert.ok(h.posted.filter((c) => c.op === "resolve" && c.eventId === "e1").length <= 1);
  } finally { await h.cleanup(); }
});
test("missing host evidence cannot qualify completion", async () => {
  const h = await fixture("no-evidence");
  try { const result = await h.runtime.run(h.input); assert.equal(result.output, null); assert.notEqual(result.trace?.outcome, "complete"); }
  finally { await h.cleanup(); }
});
test("an idle waiting guest has a finite coordinator command bound", async () => {
  const h = await fixture("waiting");
  try {
    const result = await h.runtime.run(h.input);
    assert.equal(result.output, null); assert.ok(h.posted.length <= 130); assert.equal(h.runtimeReleases().length, 1);
  } finally { await h.cleanup(); }
});

test("two tasks through one runtime get independent real traces and source identities", async () => {
  const first = await fixture("normal", "reuse-one");
  let second: Awaited<ReturnType<typeof fixture>> | undefined;
  try {
    const a = await first.runtime.run(first.input);
    assert.deepEqual(a.output, first.ledger);
    const before = JSON.stringify(a.trace);
    second = await fixture("normal", "reuse-two");
    const b = await first.runtime.run(second.input);
    assert.deepEqual(b.output, second.ledger); assert.equal(b.trace?.outcome, "complete");
    assert.notEqual(a.trace, b.trace); assert.notEqual(a.trace?.snapshotHash, b.trace?.snapshotHash);
    assert.notEqual(a.trace?.contextHash, b.trace?.contextHash);
    assert.equal(JSON.stringify(a.trace), before, "a later run must not mutate the first trace");
    assert.deepEqual(b.trace?.calls.map((c) => c.id), ["a1", "a2"]);
    assert.equal(b.trace?.operations.length, a.trace?.operations.length);
    assert.equal(first.runtimeReleases().length, 2);
  } finally {
    try { await first.cleanup(); } finally { if (second) await second.cleanup(); }
  }
});

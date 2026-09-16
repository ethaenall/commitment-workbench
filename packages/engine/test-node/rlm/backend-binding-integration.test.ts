// Actual assembly path. Only the Fetcher and Worker/clock boundaries are fake.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import * as clientModule from "../../src/workflows/rlm-backend-client.ts";
import { createRlmBindingHandler } from "../../src/daemon/rlm-binding.ts";
import * as nodeBackend from "../../src/rlm/node-backend.mjs";
import * as protocol from "../../src/rlm/protocol.mjs";
import { TIMING_CEILINGS, lowerTiming } from "../../src/rlm/timing-policy.mjs";
import type { RlmBackendPort, RlmSession, RlmOpenSessionRequest } from "../../src/workflows/rlm-host-types.ts";

const CONTEXT = '[{"id":0,"value":"plain"}]';
const CONTEXT_ID = "sha256:" + createHash("sha256").update(CONTEXT).digest("hex");
const FINDINGS = "verified guest findings";
const request = (extra: Partial<RlmOpenSessionRequest> = {}): RlmOpenSessionRequest => ({
  ownerId: "owner-bridge04", context: CONTEXT, contextId: CONTEXT_ID, rootPrompt: null, ...extra,
});
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}
class FakeClock {
  t = 0; next = 1;
  timers = new Map<number, { at: number; fn: () => void }>();
  now = () => this.t;
  setTimeout = (fn: () => void, ms: number) => { const id = this.next++; this.timers.set(id, { at: this.t + ms, fn }); return id; };
  clearTimeout = (id: number) => { this.timers.delete(id); };
  advance(ms: number) {
    const until = this.t + ms;
    while (true) {
      const due = [...this.timers.entries()].filter(([, v]) => v.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      this.t = due[1].at; this.timers.delete(due[0]); due[1].fn();
    }
    this.t = until;
  }
}
function harness(options: { autoExit?: boolean; forgePublication?: boolean } = {}) {
  const createPort = Reflect.get(clientModule, "createRlmBackendPort");
  const createNode = Reflect.get(nodeBackend, "createRlmNodeBackend");
  assert.equal(typeof createPort, "function", "real exported RlmBackendPort facade is missing");
  assert.equal(typeof createNode, "function", "real locally injected Node backend factory is missing");
  const clock = new FakeClock();
  const calls: any[] = [], replies: any[] = [], posted: any[] = [], workers: FakeWorker[] = [];
  const entered = new Map<string, ReturnType<typeof deferred>>();
  const blocks = new Map<string, ReturnType<typeof deferred>>();
  const commandSeen = new Map<string, ReturnType<typeof deferred>>();
  class FakeWorker extends EventEmitter {
    exited = false; autoExit = options.autoExit !== false; mode = "";
    terminated = deferred(); receivedOptions: unknown;
    constructor(workerOptions: unknown) {
      super(); this.receivedOptions = workerOptions; workers.push(this);
      queueMicrotask(() => this.emit("message", JSON.stringify({ v: 1, kind: "ready", envEmpty: true, metrics: { memoryInstances: 1, memoryIdentity: true, pendingEvents: 0 } })));
    }
    postMessage(raw: string) {
      const cmd = JSON.parse(raw); posted.push(cmd);
      commandSeen.get(cmd.op)?.resolve();
      const event = (i: number) => ({ id: `e${i}`, kind: "llm", runId: cmd.runId, nodeId: `n${i}`, parentId: "n0", depth: 1, prompt: `question ${i}` });
      if (cmd.op === "evaluate") this.mode = cmd.source;
      if (this.mode === "hang" && cmd.op !== "init") return;
      let events: unknown[] = [];
      if (cmd.op === "evaluate" && this.mode === "resolve-flow") events = [event(1)];
      if (cmd.op === "evaluate" && this.mode === "drop-flow") events = [event(1), event(2)];
      if (cmd.op === "evaluate" && this.mode === "six-events") events = Array.from({ length: 6 }, (_, i) => event(i + 1));
      const complete = cmd.op === "pump" || (cmd.op === "evaluate" && this.mode === "complete");
      const evidence = this.mode === "read-evidence" || this.mode === "missing-chars" ? {
        version: 2, successfulSliceCount: 1, successfulExecuteCount: 1, truncated: false,
        slices: [{ nodeId: "n0", start: 0, count: 1, utf8Bytes: 4, ...(this.mode === "missing-chars" ? {} : { returnedChars: 2 }) }],
        executes: [{ nodeId: "n0", parentId: null, depth: 0, sourceSha256: createHash("sha256").update(this.mode).digest("hex") }],
        coverageByNode: [{ nodeId: "n0", ranges: [{ start: 0, end: 1 }] }],
      } : undefined;
      const reply = { v: 1, seq: cmd.seq, ok: true, status: complete ? "complete" : "waiting", events, output: complete ? FINDINGS : null,
        metrics: { memoryInstances: 1, memoryIdentity: true, pendingEvents: complete ? 0 : events.length, liveVMs: complete ? 0 : 1, createdVMs: 1,
          ...(evidence === undefined ? {} : { readEvidence: evidence }) } };
      queueMicrotask(() => this.emit("message", JSON.stringify(reply)));
    }
    terminate() {
      this.terminated.resolve();
      if (this.autoExit) queueMicrotask(() => this.exit());
      // Resolving terminate does NOT prove exit. The separate event does.
      return Promise.resolve(0);
    }
    exit() { if (!this.exited) { this.exited = true; this.emit("exit", 0); } }
  }
  const backend = createNode({ Worker: FakeWorker, clock });
  const handler = createRlmBindingHandler({ backend, protocol });
  const binding = { async fetch(req: Request) {
    const cmd = await req.clone().json(); calls.push(cmd); entered.get(cmd.op)?.resolve();
    assert.equal(req.url, clientModule.RLM_BACKEND_BINDING_URL);
    assert.equal(req.headers.get(protocol.BINDING_HEADERS.owner), cmd.ownerId);
    const response = await handler(req);
    const body = await response.clone().json(); replies.push({ op: cmd.op, body });
    const block = blocks.get(cmd.op); if (block) await block.promise;
    if (options.forgePublication && cmd.op === "publish" && body.ok) {
      // A success flag or an echo field must not replace the verified result.
      delete body.result; body.published = cmd.findings;
      return new Response(JSON.stringify(body));
    }
    return response;
  } };
  const port: RlmBackendPort = createPort({ binding, taskId: "task-bridge04" });
  let session: RlmSession | undefined;
  return {
    port, backend, clock, calls, replies, posted, workers,
    get worker() { assert.equal(workers.length, 1); return workers[0]; },
    async open(extra: Partial<RlmOpenSessionRequest> = {}) { session = await port.open(request(extra)); return session; },
    entered(op: string) { const d = deferred(); entered.set(op, d); return d.promise; },
    block(op: string) { const d = deferred(); blocks.set(op, d); return () => { blocks.delete(op); d.resolve(); }; },
    commandSeen(op: string) { const d = deferred(); commandSeen.set(op, d); return d.promise; },
    async cleanup() {
      for (const d of blocks.values()) d.resolve(); blocks.clear();
      if (!session) return;
      for (const w of workers) { w.autoExit = true; w.exit(); }
      for (let i = 1; i <= 6; i++) { try { await session.clearSettledEvent(`e${i}`); } catch { /* no remaining matching debt */ } }
      try { await session.waitExit(); } catch { /* primary assertions retain failures */ }
      try { await session.release(); } catch { /* primary assertions retain failures */ }
      assert.equal(backend.backendStatus().activeRunId, null, "fixture must release actual backend lease");
      assert.equal(clock.timers.size, 0);
    },
  };
}

test("real facade opens once, initializes exactly once, and returns Worker reply with inspect", async () => {
  const h = harness();
  try {
    const s = await h.open({ timing: { commandSliceMs: 40 }, limits: { calls: 3 } });
    assert.equal(h.posted.length, 0, "open must not invoke init");
    assert.equal(h.calls.filter((c) => c.op === "init").length, 0);
    const initialized = await s.init();
    assert.equal(initialized.ok, true); assert.equal(initialized.status, "waiting");
    assert.equal(initialized.inspect?.pendingEvents, 0);
    assert.equal(h.posted[0].contextId, CONTEXT_ID);
    await assert.rejects(() => s.init(), /ALREADY_INITIALIZED/);
    assert.equal(h.posted.filter((c) => c.op === "init").length, 1);
    assert.deepEqual(h.calls[0].timing, { ...TIMING_CEILINGS, commandSliceMs: 40 });
    assert.equal(h.calls[0].limits.calls, 3);
    assert.deepEqual(h.worker.receivedOptions, { env: {}, execArgv: [] });
    assert.ok(h.calls.every((c) => !["Worker", "clock", "deadlineMs", "env", "budget"].some((key) => key in c)));
  } finally { await h.cleanup(); }
});

test("guest findings travel under result, with no ledger publication or client echo", async () => {
  const h = harness();
  try {
    const s = await h.open(); await s.init();
    const done = await s.evaluate("complete");
    assert.equal(done.output, FINDINGS);
    await assert.rejects(() => s.publish("forged findings"), /PUBLICATION_BLOCKED/);
    assert.equal(await s.publish(FINDINGS), FINDINGS);
    const accepted = h.replies.filter((r) => r.op === "publish").at(-1).body;
    assert.equal(accepted.result, FINDINGS); assert.equal("published" in accepted, false);
    await s.terminate("COMPLETE"); await s.waitExit();
    const snapshot: any = await s.inspect();
    assert.equal(snapshot.exitSeen, true); assert.equal(snapshot.stopReason, "COMPLETE"); assert.equal(snapshot.cancelled, false);
    await s.release();
  } finally { await h.cleanup(); }
});

test("a publication echo without verified result is rejected", async () => {
  const h = harness({ forgePublication: true });
  try {
    const s = await h.open(); await s.init(); await s.evaluate("complete");
    await assert.rejects(() => s.publish(FINDINGS), /PROTOCOL/);
  } finally { await h.cleanup(); }
});

test("successful resolve clears debt and never sends duplicate settled RPC", async () => {
  const h = harness();
  try {
    const s = await h.open(); await s.init();
    const waiting = await s.evaluate("resolve-flow"); assert.equal(waiting.events?.[0].id, "e1");
    await s.resolve("e1", "settled provider result");
    assert.equal((await s.inspect()).pendingEvents, 0);
    await s.clearSettledEvent("e1");
    assert.equal(h.calls.filter((c) => c.op === "settled").length, 0);
    await s.pump(); assert.equal(await s.publish(FINDINGS), FINDINGS);
  } finally { await h.cleanup(); }
});

test("inspect and settled RPCs are awaited", async () => {
  const h = harness();
  try {
    const s = await h.open(); await s.init(); await s.evaluate("resolve-flow");
    let finished = false;
    const sawInspect = h.entered("inspect"), unblockInspect = h.block("inspect");
    const inspection = s.inspect().then((x) => { finished = true; return x; });
    await sawInspect; assert.equal(finished, false); unblockInspect(); await inspection;
    finished = false;
    const sawSettled = h.entered("settled"), unblockSettled = h.block("settled");
    const clearing = s.clearSettledEvent("e1").then(() => { finished = true; });
    await sawSettled; assert.equal(finished, false); unblockSettled(); await clearing;
    assert.equal((await s.inspect()).pendingEvents, 0);
  } finally { await h.cleanup(); }
});

test("waitExit remains pending until actual injected Worker exit event", async () => {
  const h = harness({ autoExit: false });
  try {
    const s = await h.open(); await s.init(); await s.evaluate("complete");
    const ending = s.terminate("COMPLETE"); await h.worker.terminated.promise;
    let exited = false;
    const sawWait = h.entered("waitExit");
    const exit = s.waitExit().then((x) => { exited = true; return x; });
    await sawWait; assert.equal(exited, false); assert.equal((await s.inspect()).exitSeen, false);
    h.worker.exit(); await ending; await exit;
    assert.equal((await s.inspect()).exitSeen, true); await s.release();
  } finally { await h.cleanup(); }
});

test("trusted guest completion clears dropped events; model wait consumes no command time", async () => {
  const h = harness();
  try {
    const s = await h.open(); await s.init(); await s.evaluate("drop-flow");
    assert.equal((await s.inspect()).pendingEvents, 2);
    h.clock.advance(6700);
    const idle: any = await s.inspect(); assert.equal(idle.commandArmed, false); assert.equal(idle.cumulativeCommandMs, 0);
    const complete = await s.pump(); assert.equal(complete.status, "complete");
    assert.equal((await s.inspect()).pendingEvents, 0);
    assert.equal(await s.publish(FINDINGS), FINDINGS);
    await s.terminate("COMPLETE"); await s.waitExit(); await s.release();
    assert.equal(h.calls.filter((c) => c.op === "settled").length, 0);
  } finally { await h.cleanup(); }
});

test("timeout cannot clear guest event debt or release the lease", async () => {
  const h = harness();
  try {
    const s = await h.open(); await s.init(); await s.evaluate("drop-flow");
    const started = h.commandSeen("evaluate"); const hung = s.evaluate("hang");
    await started; h.clock.advance(100);
    const reply = await hung; assert.equal(reply.ok, false); assert.equal(reply.error?.code, "COMMAND_DEADLINE");
    await s.waitExit(); const snapshot: any = await s.inspect();
    assert.equal(snapshot.pendingEvents, 2); assert.equal(snapshot.stopReason, "COMMAND_DEADLINE");
    await assert.rejects(() => s.release(), /HOST_CALLS_UNSETTLED/);
    // Explicit host settlement, not timeout, closes each retained event debt.
    await s.clearSettledEvent("e1"); await s.clearSettledEvent("e2"); await s.waitExit(); await s.release();
  } finally { await h.cleanup(); }
});

test("strict timing and guest cap: no raises, no legacy deadline, no sixth event", async () => {
  assert.equal(protocol.LIMITS.calls, 5); assert.equal(TIMING_CEILINGS.commandSliceMs, 100);
  assert.throws(() => lowerTiming({ commandSliceMs: 2000 }), /INVALID_LIMIT/);
  const h = harness();
  try {
    await assert.rejects(() => h.port.open(request({ limits: { calls: 6 } })), /INVALID_LIMIT/);
    await assert.rejects(() => h.port.open({ ...request(), deadlineMs: 1 } as RlmOpenSessionRequest), /REFUSED_HOST_OBJECT|PROTOCOL/);
    await assert.rejects(() => h.port.open(request({ contextId: "sha256:" + "0".repeat(64) })), /CONTEXT_IDENTITY/);
    assert.equal(h.workers.length, 0);
    const s = await h.open(); await s.init();
    const reply = await s.evaluate("six-events"); assert.equal(reply.ok, false);
    assert.equal((await s.inspect()).pendingEvents, 0);
  } finally { await h.cleanup(); }
});


test("actual v2 read/execute metrics survive the real facade with exact chars; missing chars stay unknown", async () => {
  const h = harness();
  try {
    const s = await h.open(); const init = await s.init();
    assert.equal(init.inspect?.hostEvidence, undefined);
    const observed = await s.evaluate("read-evidence");
    const raw: any = observed.metrics?.readEvidence;
    assert.equal(raw.version, 2); assert.equal(raw.slices[0].utf8Bytes, 4); assert.equal(raw.slices[0].returnedChars, 2);
    assert.throws(() => protocol.readEvidenceHostSnapshot({ ...raw, version: 1 }), /HOST_EVIDENCE/);
    const missingTruncation = { ...raw }; delete missingTruncation.truncated;
    assert.throws(() => protocol.readEvidenceHostSnapshot(missingTruncation), /PROTOCOL/);
    assert.deepEqual(observed.inspect?.hostEvidence, {
      reads: [{ nodeId: "n0", start: 0, count: 1, returnedChars: 2 }],
      executes: [{ nodeId: "n0", codeHash: createHash("sha256").update("read-evidence").digest("hex") }], truncated: false,
    });
    assert.deepEqual((await s.inspect()).hostEvidence, observed.inspect?.hostEvidence);
    const final = await s.pump(); assert.deepEqual(final.inspect?.hostEvidence, observed.inspect?.hostEvidence);
  } finally { await h.cleanup(); }
  const invalid = harness();
  try {
    const s = await invalid.open(); await s.init();
    const rejected = await s.evaluate("missing-chars");
    assert.equal(rejected.ok, false); assert.equal(rejected.error?.code, "CHANNEL_ERROR");
    assert.equal((await s.inspect()).hostEvidence, undefined);
  } finally { await invalid.cleanup(); }
});

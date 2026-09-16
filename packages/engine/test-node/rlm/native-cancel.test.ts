import assert from "node:assert/strict";
import { after, test } from "node:test";
import { writeFileSync } from "node:fs";
import { createNativeOperationScope, fireTrackedCancel } from "../../src/llm/native-operation-scope.ts";
import { fetchBoundedResponse } from "../../src/llm/bounded-response.ts";

const observations: unknown[] = [];
after(() => {
  if (process.env.RLM_TEST_OBSERVATIONS) {
    writeFileSync(process.env.RLM_TEST_OBSERVATIONS, JSON.stringify(observations, null, 2) + "\n");
  }
});
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
async function flush() { for (let i = 0; i < 8; i++) await Promise.resolve(); }

test("capacity refusal never starts untracked cancellation", async () => {
  const scope = createNativeOperationScope();
  const transport = scope.openTransport();
  const pending = Array.from({ length: 64 }, () => deferred());
  const admitted = pending.map((item) => transport.trackPromise("read", () => item.promise));
  const cancel = deferred();
  let starts = 0;
  let joined = false;
  try {
    fireTrackedCancel(transport, () => { starts++; return cancel.promise; });
    transport.closeProducer();
    scope.seal();
    void scope.join().then(() => { joined = true; });
    for (const item of pending) item.resolve();
    await Promise.all(admitted);
    await flush();
    observations.push({ case: "capacity", cancelStarts: starts, cancelUnsettled: starts > 0, joined, snapshot: scope.snapshot() });
    assert.equal(starts, 0, "a rejected admission must not dispatch cancellation outside the scope");
    assert.equal(joined, true);
  } finally {
    for (const item of pending) item.resolve();
    cancel.resolve();
    await Promise.all(admitted);
  }
});

test("closed producer never starts untracked cancellation", async () => {
  const scope = createNativeOperationScope();
  const transport = scope.openTransport();
  transport.closeProducer();
  let starts = 0;
  fireTrackedCancel(transport, () => { starts++; return Promise.resolve(); });
  observations.push({ case: "closed-producer", cancelStarts: starts });
  assert.equal(starts, 0);
});

test("synchronous cancel error is not retried outside the tracker", () => {
  const scope = createNativeOperationScope();
  const transport = scope.openTransport();
  let starts = 0;
  let escaped = false;
  try {
    fireTrackedCancel(transport, () => { starts++; throw new Error("synthetic cancel failure"); });
  } catch { escaped = true; }
  transport.closeProducer();
  scope.seal();
  observations.push({ case: "synchronous-error", cancelStarts: starts, escaped, snapshot: scope.snapshot() });
  assert.equal(starts, 1);
  assert.equal(escaped, false);
});

test("admitted cancellation keeps join pending until its real promise settles", async () => {
  const scope = createNativeOperationScope();
  const transport = scope.openTransport();
  const cancel = deferred();
  let starts = 0;
  let joined = false;
  fireTrackedCancel(transport, () => { starts++; return cancel.promise; });
  transport.closeProducer();
  scope.seal();
  const join = scope.join().then(() => { joined = true; });
  await flush();
  try {
    assert.equal(starts, 1);
    assert.equal(joined, false);
    assert.equal(scope.snapshot().pendingOperations, 1);
  } finally { cancel.resolve(); }
  await join;
  assert.equal(scope.snapshot().observation, "SETTLED");
});

test("omitting native observation preserves the existing best-effort cancel", async () => {
  let starts = 0;
  fireTrackedCancel(undefined, () => { starts++; return Promise.resolve(); });
  await flush();
  assert.equal(starts, 1);
});

test("bounded response quarantines cleanup when cancellation cannot be admitted", async () => {
  const scope = createNativeOperationScope();
  const blockers = scope.openTransport();
  const pending = Array.from({ length: 63 }, () => deferred());
  const admitted = pending.map((item) => blockers.trackPromise("read", () => item.promise));
  const readEntered = deferred();
  const read = deferred<ReadableStreamReadResult<Uint8Array>>();
  const cancel = deferred();
  let cancelStarts = 0;
  const reader = {
    read() { readEntered.resolve(); return read.promise; },
    cancel() { cancelStarts++; return cancel.promise; },
    releaseLock() {},
  };
  const response = { status: 200, statusText: "OK", headers: new Headers(), body: { getReader: () => reader } } as unknown as Response;
  const fakeFetch = (async () => response) as typeof fetch;
  const controller = new AbortController();
  const run = fetchBoundedResponse(fakeFetch, "https://fixture.invalid/never-requested", { signal: controller.signal }, 1024, scope);
  const rejected = assert.rejects(run, { code: "RESPONSE_ABORTED" });
  try {
    await readEntered.promise;
    assert.equal(scope.snapshot().pendingOperations, 64);
    controller.abort();
    await rejected;
    scope.seal();
    blockers.closeProducer();
    for (const item of pending) item.resolve();
    read.resolve({ done: true, value: undefined });
    await Promise.all(admitted);
    await flush();
    const snapshot = scope.snapshot();
    observations.push({ case: "bounded-refused-cleanup", cancelStarts, snapshot });
    assert.equal(cancelStarts, 0, "the bounded adapter must not bypass rejected cleanup admission");
    assert.equal(snapshot.pendingOperations, 0);
    assert.equal(snapshot.openTransports, 1, "uncompleted cleanup must retain its producer debt");
    assert.equal(snapshot.observation, "TRACKED_PENDING");
  } finally {
    controller.abort();
    for (const item of pending) item.resolve();
    read.resolve({ done: true, value: undefined });
    cancel.resolve();
    await Promise.all(admitted);
    await rejected;
  }
});

test("asynchronous admission refusal is not reported as dispatched cleanup", async () => {
  const scope = createNativeOperationScope();
  const producer = scope.openTransport();
  const session = {
    ...producer,
    trackPromise: async <T>(_kind: unknown, _start: () => Promise<T>): Promise<T> => {
      throw new Error("NATIVE_PENDING_CAP");
    },
  };
  let starts = 0;
  const dispatched = fireTrackedCancel(session, () => { starts++; return Promise.resolve(); });
  await flush();
  observations.push({ case: "async-refusal", cancelStarts: starts, reportedDispatched: dispatched });
  assert.equal(starts, 0);
  assert.equal(dispatched, false, "a rejected promise is not proof that cancellation started");
});

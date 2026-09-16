import assert from "node:assert/strict";
import { after, test } from "node:test";
import { writeFileSync } from "node:fs";
import { createAnthropicClient } from "../../src/llm/anthropic-client.ts";
import { createNativeOperationScope } from "../../src/llm/native-operation-scope.ts";
import { LLM_NATIVE_OPERATIONS, type LLMClient, type LLMResponse } from "../../src/llm/types.ts";
import { ModelBudget } from "../../src/workflows/model-budget.ts";

const observations: unknown[] = [];
after(() => {
  if (process.env.RLM_TEST_OBSERVATIONS) writeFileSync(process.env.RLM_TEST_OBSERVATIONS, JSON.stringify(observations, null, 2) + "\n");
});
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
async function flush() { for (let i = 0; i < 12; i++) await Promise.resolve(); }
const request = { model: "fixture-model", max_tokens: 16, messages: [{ role: "user" as const, content: "fixture only" }] };
function response() {
  return new Response(JSON.stringify({
    id: "fixture-message", type: "message", role: "assistant", model: "fixture-model",
    content: [{ type: "text", text: "fixture reply" }], stop_reason: "end_turn", stop_sequence: null,
    usage: { input_tokens: 5, output_tokens: 3 },
  }), { status: 200, headers: { "content-type": "application/json" } });
}
function captureAdapter(fetcher: typeof fetch) {
  const previous = globalThis.fetch;
  let adapter: LLMClient;
  try {
    globalThis.fetch = fetcher;
    adapter = createAnthropicClient("fixture-not-a-real-api-key");
  } finally { globalThis.fetch = previous; }
  let raw: Promise<LLMResponse> | undefined;
  const client: LLMClient = { createMessage(params) { raw = adapter.createMessage(params); return raw; } };
  return { client, raw: () => { assert.ok(raw); return raw; } };
}

test("actual SDK pre-fetch cancellation proves never-dispatch without inventing token usage", async () => {
  let fetches = 0;
  const captured = captureAdapter((async () => { fetches++; throw new Error("fetch must not start"); }) as typeof fetch);
  const scope = createNativeOperationScope();
  const budget = new ModelBudget({ client: captured.client, model: request.model, nativeOperations: scope });
  try {
    const call = budget.clientFor("root").createMessage(request);
    const rejection = assert.rejects(call, { code: "CANCELLED" });
    budget.cancel();
    await rejection;
    await assert.rejects(captured.raw());
    await flush();
    const snapshot = budget.snapshot();
    observations.push({ case: "pre-fetch-cancel", fetches, native: scope.snapshot(), attempt: budget.attemptNativeObservation(1), activeCalls: snapshot.activeCalls, usageStatus: snapshot.usageStatus, reservedOutputTokens: snapshot.reservedOutputTokens });
    assert.equal(fetches, 0);
    assert.equal(snapshot.activeCalls, 0);
    assert.equal(snapshot.usageStatus, "unknown");
    assert.equal(snapshot.reservedOutputTokens, 16);
    assert.equal(scope.snapshot().observation, "SETTLED");
    assert.equal(scope.snapshot().registeredOperations, 0);
    assert.equal(budget.attemptNativeObservation(1), "SETTLED");
    await scope.join();
  } finally { budget.dispose(); }
});

test("actual SDK rejection does not settle a dispatched fetch that ignores abort", async () => {
  const entered = deferred();
  const held = deferred<Response>();
  let fetches = 0;
  const captured = captureAdapter((async () => { fetches++; entered.resolve(); return held.promise; }) as typeof fetch);
  const scope = createNativeOperationScope();
  const budget = new ModelBudget({ client: captured.client, model: request.model, nativeOperations: scope });
  let joined = false;
  try {
    const call = budget.clientFor("root").createMessage(request);
    const rejected = assert.rejects(call, { code: "CANCELLED" });
    await entered.promise;
    budget.cancel();
    await rejected;
    await assert.rejects(captured.raw());
    await flush();
    const join = scope.join().then(() => { joined = true; });
    await flush();
    observations.push({ case: "dispatched-cancel", fetches, native: scope.snapshot(), attempt: budget.attemptNativeObservation(1), activeCalls: budget.snapshot().activeCalls, joined });
    assert.equal(fetches, 1);
    assert.equal(budget.snapshot().activeCalls, 0);
    assert.equal(scope.snapshot().observation, "TRACKED_PENDING");
    assert.equal(budget.attemptNativeObservation(1), "TRACKED_PENDING");
    assert.equal(joined, false);
    held.resolve(response());
    await join;
    assert.equal(scope.snapshot().observation, "SETTLED");
    assert.equal(budget.attemptNativeObservation(1), "SETTLED");
  } finally { held.resolve(response()); budget.dispose(); }
});

test("actual SDK bounded success retains correct accounting and no observer in wire JSON", async () => {
  let fetches = 0;
  let wireBody: Record<string, unknown> | undefined;
  const captured = captureAdapter((async (_input, init) => {
    fetches++;
    wireBody = JSON.parse(String(init?.body));
    return response();
  }) as typeof fetch);
  const scope = createNativeOperationScope();
  const budget = new ModelBudget({ client: captured.client, model: request.model, nativeOperations: scope });
  try {
    const result = await budget.clientFor("root").createMessage(request);
    assert.equal(result.content[0]?.type, "text");
    assert.equal(fetches, 1);
    assert.deepEqual(Object.keys(wireBody!).sort(), ["max_tokens", "messages", "model", "stream"]);
    assert.equal(budget.snapshot().usageStatus, "complete");
    assert.equal(budget.snapshot().observedInputTokens, 5);
    assert.equal(budget.snapshot().observedOutputTokens, 3);
    assert.equal(budget.snapshot().reservedOutputTokens, 0);
    assert.equal(budget.attemptNativeObservation(1), "SETTLED");
    budget.dispose();
    await scope.join();
    assert.equal(scope.snapshot().observation, "SETTLED");
  } finally { budget.dispose(); }
});

test("arbitrary clients with zero counters still remain unobserved", async () => {
  const client: LLMClient = { async createMessage() {
    return { id: "unobserved", content: [{ type: "text", text: "fixture" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } };
  } };
  const scope = createNativeOperationScope();
  const budget = new ModelBudget({ client, model: request.model, nativeOperations: scope });
  try {
    await budget.clientFor("root").createMessage(request);
    budget.dispose();
    assert.equal(scope.snapshot().observation, "UNOBSERVED");
    assert.equal(budget.attemptNativeObservation(1), "UNOBSERVED");
  } finally { budget.dispose(); }
});

test("an uncapped raw SDK call is not falsely labeled instrumented", async () => {
  let fetches = 0;
  const captured = captureAdapter((async () => { fetches++; return response(); }) as typeof fetch);
  const scope = createNativeOperationScope();
  await captured.client.createMessage({ ...request, [LLM_NATIVE_OPERATIONS]: scope, disableRetries: true });
  scope.seal();
  assert.equal(fetches, 1);
  assert.equal(scope.snapshot().observation, "UNOBSERVED");
});

test("native finalization seals future admission without cancelling a completed result", async () => {
  let fetches = 0;
  const captured = captureAdapter((async () => { fetches++; return response(); }) as typeof fetch);
  const scope = createNativeOperationScope();
  const budget = new ModelBudget({ client: captured.client, model: request.model, nativeOperations: scope });
  try {
    await budget.clientFor("root").createMessage(request);
    budget.sealNativeOperations();
    await budget.joinNativeOperations();
    assert.equal(scope.snapshot().observation, "SETTLED");
    assert.equal(budget.signal.aborted, false);
    assert.equal(budget.snapshot().closedReason, null);
    await assert.rejects(budget.clientFor("child").createMessage(request), { code: "DISPOSED" });
    assert.equal(fetches, 1);
    assert.equal(budget.snapshot().attempts, 1);
    assert.equal(budget.snapshot().usageStatus, "complete");
  } finally { budget.dispose(); }
});

test("no-observer budgets cannot manufacture native finalization proof", async () => {
  const captured = captureAdapter((async () => response()) as typeof fetch);
  const budget = new ModelBudget({ client: captured.client, model: request.model });
  try {
    assert.throws(() => budget.sealNativeOperations(), { code: "INVALID_REQUEST" });
    await assert.rejects(budget.joinNativeOperations(), { code: "INVALID_REQUEST" });
    assert.equal(budget.nativeObservation(), null);
  } finally { budget.dispose(); }
});

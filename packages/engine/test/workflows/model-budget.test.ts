// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LLMClient, LLMCreateParams, LLMResponse } from "../../src/llm/types";
import {
  MODEL_BUDGET_DEFAULTS,
  MODEL_BUDGET_HARD_CEILINGS,
  ModelBudget,
  type ModelBudgetLimits,
} from "../../src/workflows/model-budget";

// Deterministic clients only. This proves orchestration contracts, not efficacy,
// provider billing bounds, networking containment, or cancellation of effects.
const MODEL = "fixed-fixture-model";
const params: LLMCreateParams = {
  model: MODEL, max_tokens: 8, messages: [{ role: "user", content: "fixture" }],
};
function response(input = 3, output = 2): LLMResponse {
  return { id: "fixture", content: [{ type: "text", text: "local output" }],
    stop_reason: "end_turn", usage: { input_tokens: input, output_tokens: output } };
}
function deferredClient() {
  const calls: Array<{
    params: LLMCreateParams;
    resolve: (value: LLMResponse) => void;
    reject: (error: unknown) => void;
  }> = [];
  const client: LLMClient = {
    createMessage: vi.fn((request) => new Promise<LLMResponse>((resolve, reject) => {
      calls.push({ params: request, resolve, reject });
    })),
  };
  return { client, calls };
}
const budgets: ModelBudget[] = [];
function budget(client: LLMClient, limits: Partial<ModelBudgetLimits> = {}, signal?: AbortSignal) {
  const result = new ModelBudget({ client, model: MODEL, limits, signal });
  budgets.push(result);
  return result;
}
function immediate(value = response()) {
  return { createMessage: vi.fn(async (_params: LLMCreateParams) => value) };
}
const failure = (promise: Promise<LLMResponse>) => promise.then(
  () => { throw new Error("Unexpected evaluated output"); },
  (error: unknown) => error,
);
async function drainSettlements() { await Promise.resolve(); await Promise.resolve(); }

beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] }));
afterEach(() => {
  for (const instance of budgets.splice(0)) instance.dispose();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("ModelBudget shared admission and accounting", () => {
  it("executes in the native Worker pool, not a Node-only fixture environment", () => {
    expect(navigator.userAgent).toBe("Cloudflare-Workers");
  });

  it("uses one ledger and attempt allowance for root and every child facade", async () => {
    const client = immediate();
    const run = budget(client, { maxAttempts: 3 });
    await run.clientFor("root").createMessage(params);
    await run.clientFor("child").createMessage(params);
    await run.clientFor("child").createMessage(params);
    await expect(run.clientFor("root").createMessage(params)).rejects.toMatchObject({ code: "ATTEMPT_LIMIT" });
    expect(client.createMessage).toHaveBeenCalledTimes(3);
    expect(run.snapshot()).toMatchObject({ attempts: 3, observedInputTokens: 9,
      observedOutputTokens: 6, reservedOutputTokens: 0, usageStatus: "complete" });
    expect(run.snapshot().ledger.map((entry) => entry.role)).toEqual(["root", "child", "child"]);
    expect(run.snapshot().ledger.map((entry) => entry.id)).toEqual([1, 2, 3]);
  });

  it("reserves concurrency and output synchronously, clamps uniformly, and releases only known unused output", async () => {
    const fixture = deferredClient();
    const run = budget(fixture.client, { maxConcurrent: 2, maxObservedOutputTokens: 8, maxOutputTokensPerCall: 5 });
    const root = run.clientFor("root").createMessage({ ...params, max_tokens: 100 });
    const child = run.clientFor("child").createMessage({ ...params, max_tokens: 100 });
    expect(fixture.calls.map((call) => call.params.max_tokens)).toEqual([5, 3]);
    expect(run.snapshot()).toMatchObject({ attempts: 2, activeCalls: 2, reservedOutputTokens: 8,
      usageStatus: "pending", peakConcurrent: 2 });
    await expect(run.clientFor("child").createMessage(params)).rejects.toMatchObject({ code: "CONCURRENCY_LIMIT" });
    fixture.calls[0]!.resolve(response(1, 2));
    await root;
    const next = run.clientFor("root").createMessage({ ...params, max_tokens: 100 });
    expect(fixture.calls[2]!.params.max_tokens).toBe(3);
    fixture.calls[1]!.resolve(response(1, 3));
    fixture.calls[2]!.resolve(response(1, 3));
    await Promise.all([child, next]);
    await expect(run.clientFor("root").createMessage(params)).rejects.toMatchObject({ code: "OUTPUT_TOKEN_LIMIT" });
    expect(run.snapshot()).toMatchObject({ attempts: 3, observedOutputTokens: 8,
      totalRequestedOutputTokens: 11, reservedOutputTokens: 0, activeCalls: 0 });
  });

  it("has no recursive-depth control or fresh child budget hidden inside the facade", async () => {
    const fixture = deferredClient();
    const run = budget(fixture.client, { maxAttempts: 1 });
    const request = { ...params, depth: 999_999 };
    const call = run.clientFor("child").createMessage(request);
    expect(fixture.calls[0]!.params).not.toHaveProperty("depth");
    await expect(run.clientFor("child").createMessage(params)).rejects.toMatchObject({ code: "ATTEMPT_LIMIT" });
    fixture.calls[0]!.resolve(response());
    await call;
  });

  it("fixes the model and sets request-local cancellation and no hidden retries", async () => {
    const client = immediate();
    const run = budget(client);
    await expect(run.clientFor("root").createMessage({ ...params, model: "other" })).rejects.toMatchObject({ code: "MODEL_MISMATCH" });
    expect(run.snapshot().attempts).toBe(0);
    await run.clientFor("root").createMessage({ ...params, max_tokens: 50_000, disableRetries: false, max_response_bytes: 1 });
    expect(client.createMessage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      model: MODEL, max_tokens: 4096, signal: run.signal, disableRetries: true, max_response_bytes: 256 * 1024,
    }));
  });

  it("copies the request before effects so later caller mutation cannot change charged bytes", async () => {
    const fixture = deferredClient();
    const run = budget(fixture.client);
    const request = { ...params, messages: [{ role: "user" as const, content: "original" }] };
    const call = run.clientFor("root").createMessage(request);
    request.messages[0]!.content = "mutated".repeat(1000);
    expect(fixture.calls[0]!.params.messages[0]!.content).toBe("original");
    fixture.calls[0]!.resolve(response());
    await call;
  });

  it("counts caller-issued repeated attempts, without automatically making extra ones", async () => {
    let wireAttempts = 0;
    const client: LLMClient = { async createMessage(request) {
      wireAttempts += request.disableRetries ? 1 : 3;
      return response();
    } };
    const run = budget(client, { maxAttempts: 2 });
    await run.clientFor("root").createMessage(params);
    await run.clientFor("root").createMessage(params);
    expect(wireAttempts).toBe(2);
    expect(run.snapshot()).toMatchObject({ attempts: 2, observedOutputTokens: 4 });
  });

  it("counts thrown provider attempts, suppresses hidden retries, and seals unknown settlement", async () => {
    let wireAttempts = 0;
    const client: LLMClient = { createMessage(request) {
      wireAttempts += request.disableRetries ? 1 : 3;
      throw new Error("secret provider error body");
    } };
    const run = budget(client);
    await expect(run.clientFor("root").createMessage(params)).rejects.toMatchObject({ code: "PROVIDER_ERROR" });
    await expect(run.clientFor("child").createMessage(params)).rejects.toMatchObject({ code: "PROVIDER_ERROR" });
    expect(wireAttempts).toBe(1);
    expect(run.snapshot()).toMatchObject({ attempts: 1, activeCalls: 0, reservedOutputTokens: 8,
      usageStatus: "unknown", unknownUsageAttempts: 1 });
    expect(run.snapshot().ledger[0]).toMatchObject({ providerSettlement: "rejected", usageStatus: "unknown", outcome: "rejected" });
    expect(JSON.stringify(run.snapshot())).not.toContain("secret");
  });
});

describe("ModelBudget bounds before effects", () => {
  it("publishes frozen defaults and host ceilings with the specified common budget", () => {
    expect(MODEL_BUDGET_DEFAULTS).toMatchObject({ maxAttempts: 10, maxConcurrent: 2,
      maxInputBytesPerCall: 512 * 1024, maxTotalInputBytes: 2 * 1024 * 1024,
      maxObservedInputTokens: 120_000, maxObservedOutputTokens: 12_000,
      maxOutputTokensPerCall: 4096, wallTimeMs: 300_000 });
    expect(Object.isFrozen(MODEL_BUDGET_DEFAULTS)).toBe(true);
    expect(Object.isFrozen(MODEL_BUDGET_HARD_CEILINGS)).toBe(true);
  });

  it.each(Object.keys(MODEL_BUDGET_DEFAULTS) as Array<keyof ModelBudgetLimits>)("validates %s as a positive safe integer within its host ceiling", (key) => {
    const client = immediate();
    for (const value of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, MODEL_BUDGET_HARD_CEILINGS[key] + 1, undefined]) {
      expect(() => budget(client, { [key]: value })).toThrow("INVALID_LIMITS");
    }
    expect(client.createMessage).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects unknown limit keys and invalid configured models before timers or calls", () => {
    const client = immediate();
    expect(() => budget(client, { depth: 1 } as Partial<ModelBudgetLimits>)).toThrow("INVALID_LIMITS");
    for (const model of ["", "  ", "x".repeat(257)]) {
      expect(() => new ModelBudget({ client, model })).toThrow("INVALID_MODEL");
    }
    expect(vi.getTimerCount()).toBe(0);
    expect(client.createMessage).not.toHaveBeenCalled();
  });

  it.each([0, -1, 1.1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])("rejects invalid max_tokens %s before admission", async (max_tokens) => {
    const client = immediate();
    const run = budget(client);
    await expect(run.clientFor("root").createMessage({ ...params, max_tokens })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(client.createMessage).not.toHaveBeenCalled();
    expect(run.snapshot().attempts).toBe(0);
  });

  it("charges exact canonical JSON UTF-8 including escaping, then refuses aggregate input exhaustion", async () => {
    const client = immediate();
    const request = { ...params, messages: [{ role: "user" as const, content: 'A😀\u0000\ud800"\\é' }] };
    const bytes = new TextEncoder().encode(JSON.stringify(request)).byteLength;
    const run = budget(client, { maxInputBytesPerCall: bytes, maxTotalInputBytes: bytes });
    await run.clientFor("root").createMessage(request);
    expect(run.snapshot().totalRequestInputBytes).toBe(bytes);
    await expect(run.clientFor("child").createMessage(request)).rejects.toMatchObject({ code: "REQUEST_BYTES_LIMIT" });
    expect(client.createMessage).toHaveBeenCalledTimes(1);
    const smaller = budget(client, { maxInputBytesPerCall: bytes - 1 });
    await expect(smaller.clientFor("root").createMessage(request)).rejects.toMatchObject({ code: "REQUEST_BYTES_LIMIT" });
    expect(smaller.snapshot().attempts).toBe(0);
  });

  it("reserves aggregate request bytes across simultaneously admitted root and child calls", async () => {
    const fixture = deferredClient();
    const bytes = new TextEncoder().encode(JSON.stringify(params)).byteLength;
    const run = budget(fixture.client, { maxConcurrent: 8, maxTotalInputBytes: bytes });
    const first = run.clientFor("root").createMessage(params);
    await expect(run.clientFor("child").createMessage(params)).rejects.toMatchObject({ code: "REQUEST_BYTES_LIMIT" });
    expect(fixture.calls).toHaveLength(1);
    fixture.calls[0]!.resolve(response());
    await first;
  });

  it("bounds nested tool schemas and rejects cycles/accessors without invoking them", async () => {
    const client = immediate();
    const run = budget(client, { maxInputBytesPerCall: 256 });
    const tooLarge = { ...params, tools: [{ name: "fixture", description: "x".repeat(4096), input_schema: { type: "object" as const, properties: {} } }] };
    await expect(run.clientFor("root").createMessage(tooLarge)).rejects.toMatchObject({ code: "REQUEST_BYTES_LIMIT" });
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    const accessor = vi.fn(() => "do not call");
    for (const input of [cycle, Object.defineProperty({}, "secret", { get: accessor, enumerable: true })]) {
      await expect(run.clientFor("root").createMessage({ ...params, messages: [{ role: "assistant", content: [
        { type: "tool_use", id: "fixture", name: "fixture", input },
      ] }] })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    }
    expect(accessor).not.toHaveBeenCalled();
    expect(client.createMessage).not.toHaveBeenCalled();
  });
});

describe("ModelBudget measured usage and bounded output", () => {
  it("adds Anthropic separately reported cache reads/writes exactly once", async () => {
    const value = response(3, 2);
    value.usage.cache_read_input_tokens = 5;
    value.usage.cache_creation_input_tokens = 7;
    const run = budget(immediate(value));
    await run.clientFor("root").createMessage(params);
    expect(run.snapshot().observedInputTokens).toBe(15);
    expect(run.snapshot().ledger[0]!.usage).toEqual({ inputTokens: 15, outputTokens: 2,
      uncachedInputTokens: 3, cacheReadInputTokens: 5, cacheCreationInputTokens: 7 });
  });

  it("does not double-count already-inclusive input from other adapters", async () => {
    const run = budget(immediate(response(15, 2)));
    await run.clientFor("child").createMessage(params);
    expect(run.snapshot().observedInputTokens).toBe(15);
  });

  it.each([
    undefined, null, {}, { input_tokens: 1 }, { output_tokens: 1 },
    { input_tokens: -1, output_tokens: 1 }, { input_tokens: 1, output_tokens: -1 },
    { input_tokens: NaN, output_tokens: 1 }, { input_tokens: 1, output_tokens: Infinity },
    { input_tokens: 1.5, output_tokens: 1 }, { input_tokens: "1", output_tokens: 1 },
    { input_tokens: Number.MAX_SAFE_INTEGER + 1, output_tokens: 1 },
    { input_tokens: 0, output_tokens: 0, reported: false },
    { input_tokens: 1, output_tokens: 1, reported: "yes" },
    { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: -1 },
    { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: Infinity },
  ])("fails closed for missing/malformed usage %#, never evaluating output", async (usage) => {
    const client = immediate({ ...response(), usage } as LLMResponse);
    const run = budget(client);
    await expect(run.clientFor("child").createMessage(params)).rejects.toMatchObject({ code: "UNKNOWN_USAGE" });
    expect(run.snapshot()).toMatchObject({ attempts: 1, usageStatus: "unknown", unknownUsageAttempts: 1, reservedOutputTokens: 8 });
    await expect(run.clientFor("root").createMessage(params)).rejects.toMatchObject({ code: "UNKNOWN_USAGE" });
    expect(client.createMessage).toHaveBeenCalledTimes(1);
  });

  it("distinguishes explicitly reported zero from unavailable usage", async () => {
    const value = response(0, 0);
    value.usage.reported = true;
    const run = budget(immediate(value));
    await run.clientFor("root").createMessage(params);
    expect(run.snapshot()).toMatchObject({ usageStatus: "complete", observedInputTokens: 0, observedOutputTokens: 0 });
  });

  it("stops future admission at observed input equality and retains concurrent overshoot", async () => {
    const client = immediate(response(5, 1));
    const run = budget(client, { maxObservedInputTokens: 5 });
    await run.clientFor("root").createMessage(params);
    await expect(run.clientFor("child").createMessage(params)).rejects.toMatchObject({ code: "INPUT_TOKEN_LIMIT" });
    expect(client.createMessage).toHaveBeenCalledTimes(1);
    const fixture = deferredClient();
    const concurrent = budget(fixture.client, { maxObservedInputTokens: 5 });
    const a = concurrent.clientFor("root").createMessage(params);
    const b = failure(concurrent.clientFor("child").createMessage(params));
    fixture.calls[0]!.resolve(response(4, 1));
    await a;
    fixture.calls[1]!.resolve(response(4, 1));
    expect(await b).toMatchObject({ code: "INPUT_TOKEN_LIMIT" });
    expect(concurrent.snapshot()).toMatchObject({ observedInputTokens: 8, observedOutputTokens: 2, usageStatus: "complete" });
  });

  it("rejects output above the reserved request and retains the measured overshoot", async () => {
    const run = budget(immediate(response(3, 9)), { maxObservedOutputTokens: 8 });
    await expect(run.clientFor("root").createMessage(params)).rejects.toMatchObject({ code: "OUTPUT_TOKEN_LIMIT" });
    expect(run.snapshot()).toMatchObject({ observedInputTokens: 3, observedOutputTokens: 9,
      totalRequestedOutputTokens: 8, reservedOutputTokens: 0, usageStatus: "complete" });
  });

  it("retains exact oversized cache totals without unsafe integer rounding", async () => {
    const value = response(Number.MAX_SAFE_INTEGER, 1);
    value.usage.cache_read_input_tokens = Number.MAX_SAFE_INTEGER;
    value.usage.cache_creation_input_tokens = 1;
    const run = budget(immediate(value));
    await expect(run.clientFor("root").createMessage(params)).rejects.toMatchObject({ code: "INPUT_TOKEN_LIMIT" });
    const exact = (2n * BigInt(Number.MAX_SAFE_INTEGER) + 1n).toString();
    expect(run.snapshot().observedInputTokens).toBe(exact);
    expect(run.snapshot().ledger[0]!.usage.inputTokens).toBe(exact);
  });

  it("bounds the entire canonical response before downstream parsing, retaining its valid usage", async () => {
    const value = response();
    value.content = [{ type: "text", text: "sensitive output".repeat(1024) }];
    const run = budget(immediate(value), { maxResponseBytesPerCall: 256 });
    await expect(run.clientFor("root").createMessage(params)).rejects.toMatchObject({ code: "RESPONSE_BYTES_LIMIT" });
    expect(run.snapshot()).toMatchObject({ observedInputTokens: 3, observedOutputTokens: 2, usageStatus: "complete" });
    expect(JSON.stringify(run.snapshot())).not.toContain("sensitive");
    expect(run.snapshot().ledger[0]!.responseBytes).toBeGreaterThan(256);
    expect(run.snapshot().ledger[0]!.responseBytesComplete).toBe(false);
  });

  it("rejects malformed canonical output even when the usage is valid", async () => {
    const value = { ...response(), content: [{ type: "text", text: 123 }] } as unknown as LLMResponse;
    const run = budget(immediate(value));
    await expect(run.clientFor("root").createMessage(params)).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    expect(run.snapshot().ledger[0]).toMatchObject({ outcome: "rejected", usageStatus: "reported" });
  });

  it("returns private response and ledger copies, not provider or mutable shared state", async () => {
    const value = response();
    const run = budget(immediate(value));
    const result = await run.clientFor("root").createMessage({ ...params, system: "private source text" });
    expect(run.snapshot().ledger[0]).toMatchObject({ responseBytesComplete: true,
      responseBytes: new TextEncoder().encode(JSON.stringify(value)).byteLength });
    value.content.length = 0;
    expect(result.content).toHaveLength(1);
    const snapshot = run.snapshot();
    expect(Object.isFrozen(snapshot.ledger[0])).toBe(true);
    expect(Object.isFrozen(snapshot.ledger[0]!.usage)).toBe(true);
    expect(JSON.stringify(snapshot)).not.toContain("private source");
    expect(JSON.stringify(snapshot)).not.toContain("local output");
    expect(run.snapshot().ledger).not.toBe(snapshot.ledger);
  });
});

describe("ModelBudget cancellation, settlement, and lifecycle", () => {
  it("returns on cancellation even if the provider ignores AbortSignal; late output cannot publish or reopen", async () => {
    const fixture = deferredClient();
    const run = budget(fixture.client);
    const published = vi.fn();
    const call = failure(run.clientFor("root").createMessage(params).then((value) => { published(); return value; }));
    run.cancel();
    expect(await call).toMatchObject({ code: "CANCELLED" });
    expect(run.signal.aborted).toBe(true);
    expect(run.snapshot()).toMatchObject({ attempts: 1, activeCalls: 1, reservedOutputTokens: 8,
      usageStatus: "unknown", unknownUsageAttempts: 1 });
    fixture.calls[0]!.resolve(response(4, 2));
    await drainSettlements();
    expect(published).not.toHaveBeenCalled();
    expect(run.snapshot()).toMatchObject({ closedReason: "CANCELLED", activeCalls: 0,
      reservedOutputTokens: 0, observedInputTokens: 4, observedOutputTokens: 2, usageStatus: "complete" });
    expect(run.snapshot().ledger[0]).toMatchObject({ late: true, outcome: "rejected", providerSettlement: "fulfilled" });
    await expect(run.clientFor("child").createMessage(params)).rejects.toMatchObject({ code: "CANCELLED" });
    expect(fixture.calls).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("returns at the shared wall deadline for a permanently hung client, with incomplete settlement", async () => {
    const client: LLMClient = { createMessage: () => new Promise<LLMResponse>(() => {}) };
    const run = budget(client, { wallTimeMs: 30 });
    const result = failure(run.clientFor("child").createMessage(params));
    await vi.advanceTimersByTimeAsync(30);
    expect(await result).toMatchObject({ code: "DEADLINE" });
    expect(run.snapshot()).toMatchObject({ elapsedMs: 30, closedReason: "DEADLINE", activeCalls: 1,
      usageStatus: "unknown", reservedOutputTokens: 8 });
    expect(run.snapshot().ledger[0]).toMatchObject({ providerSettlement: "pending", settledAfterMs: null });
    run.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("also rejects a hung client with the native Worker timer, not only fake timers", async () => {
    vi.useRealTimers();
    const client: LLMClient = { createMessage: () => new Promise<LLMResponse>(() => {}) };
    const run = budget(client, { wallTimeMs: 10 });
    expect(await failure(run.clientFor("root").createMessage(params))).toMatchObject({ code: "DEADLINE" });
    expect(run.snapshot()).toMatchObject({ closedReason: "DEADLINE", activeCalls: 1, usageStatus: "unknown" });
  });

  it("checks elapsed deadline before admission even if the timer callback has not run", async () => {
    const client = immediate();
    const run = budget(client, { wallTimeMs: 30 });
    vi.setSystemTime(Date.now() + 30);
    await expect(run.clientFor("root").createMessage(params)).rejects.toMatchObject({ code: "DEADLINE" });
    expect(client.createMessage).not.toHaveBeenCalled();
  });

  it("does not publish a ready response if cancellation wins before the awaiting caller resumes", async () => {
    const fixture = deferredClient();
    const run = budget(fixture.client);
    const result = failure(run.clientFor("root").createMessage(params));
    fixture.calls[0]!.resolve(response());
    run.cancel();
    expect(await result).toMatchObject({ code: "CANCELLED" });
    expect(run.snapshot().ledger[0]!.outcome).toBe("rejected");
  });

  it("shares external and caller cancellation across all root/child attempts", async () => {
    for (const location of ["external", "caller"] as const) {
      const fixture = deferredClient();
      const controller = new AbortController();
      const run = budget(fixture.client, {}, location === "external" ? controller.signal : undefined);
      const root = failure(run.clientFor("root").createMessage({ ...params,
        ...(location === "caller" ? { signal: controller.signal } : {}) }));
      const child = failure(run.clientFor("child").createMessage(params));
      expect(fixture.calls.every((call) => call.params.signal === run.signal)).toBe(true);
      controller.abort("do not leak this abort reason");
      expect(await root).toMatchObject({ code: "CANCELLED" });
      expect(await child).toMatchObject({ code: "CANCELLED" });
      expect(run.snapshot()).toMatchObject({ attempts: 2, activeCalls: 2, unknownUsageAttempts: 2 });
      fixture.calls[0]!.reject(new Error("late failure"));
      fixture.calls[1]!.resolve(response());
      await drainSettlements();
      expect(run.snapshot()).toMatchObject({ activeCalls: 0, unknownUsageAttempts: 1, reservedOutputTokens: 8 });
      expect(JSON.stringify(run.snapshot())).not.toContain("leak");
    }
  });

  it("pre-aborted signals never invoke a client or leave a deadline timer", async () => {
    const controller = new AbortController();
    controller.abort();
    const client = immediate();
    const run = budget(client, {}, controller.signal);
    await expect(run.clientFor("root").createMessage(params)).rejects.toMatchObject({ code: "CANCELLED" });
    expect(run.snapshot().attempts).toBe(0);
    expect(client.createMessage).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    const other = budget(client);
    await expect(other.clientFor("root").createMessage({ ...params, signal: controller.signal })).rejects.toMatchObject({ code: "CANCELLED" });
    expect(other.snapshot().attempts).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("disposes idempotently, aborts pending waiters, clears its timer, and refuses reuse", async () => {
    const fixture = deferredClient();
    const external = new AbortController();
    const run = budget(fixture.client, {}, external.signal);
    const result = failure(run.clientFor("root").createMessage(params));
    expect(vi.getTimerCount()).toBe(1);
    run.dispose(); run.dispose();
    expect(await result).toMatchObject({ code: "DISPOSED" });
    expect(vi.getTimerCount()).toBe(0);
    external.abort();
    await expect(run.clientFor("child").createMessage(params)).rejects.toMatchObject({ code: "DISPOSED" });
    fixture.calls[0]!.resolve(response());
    await drainSettlements();
    expect(run.snapshot().closedReason).toBe("DISPOSED");
  });

  it("clears the one shared timer after an otherwise successful workflow", async () => {
    const run = budget(immediate());
    await run.clientFor("root").createMessage(params);
    expect(vi.getTimerCount()).toBe(1);
    run.dispose();
    expect(vi.getTimerCount()).toBe(0);
    expect(run.snapshot().usageStatus).toBe("complete");
  });
});

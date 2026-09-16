// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it, vi } from "vitest";
import { createAnthropicClient } from "../../src/llm/anthropic-client";
import { createOpenAICompatibleClient } from "../../src/llm/openai-compatible-client";
import {
  MAX_RESPONSE_BYTES,
  fetchBoundedResponse,
  validateMaxResponseBytes,
} from "../../src/llm/bounded-response";
import type { LLMClient, LLMCreateParams } from "../../src/llm/types";
import { ModelBudget } from "../../src/workflows/model-budget";

// Real adapter + native Worker streams + deterministic fetch fixtures. No
// requests leave this process. This proves parser admission, NOT RSS bounds.
const request: LLMCreateParams = {
  model: "fixture-model", max_tokens: 32,
  messages: [{ role: "user", content: "local fixture only" }],
};
const encoder = new TextEncoder();
const wire = {
  openai: (text = "ok😀é") => ({ id: "fixture", choices: [{ message: { content: text }, finish_reason: "stop" }],
    usage: { prompt_tokens: 5, completion_tokens: 2 } }),
  anthropic: (text = "ok😀é") => ({ id: "fixture", type: "message", role: "assistant", model: "fixture-model",
    content: [{ type: "text", text }], stop_reason: "end_turn", stop_sequence: null,
    usage: { input_tokens: 5, output_tokens: 2 } }),
};
type Provider = keyof typeof wire;
function bytes(provider: Provider, text?: string): Uint8Array {
  return encoder.encode(JSON.stringify(wire[provider](text)));
}
function source(body: Uint8Array, options: { chunkSize?: number; status?: number; headers?: HeadersInit; holdOpen?: boolean } = {}) {
  let offset = 0;
  const cancel = vi.fn(() => new Promise<void>(() => {}));
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= body.byteLength) {
        if (options.holdOpen) return new Promise<void>(() => {});
        controller.close();
        return;
      }
      const end = Math.min(body.byteLength, offset + (options.chunkSize ?? body.byteLength));
      controller.enqueue(body.subarray(offset, end));
      offset = end;
    },
    cancel,
  });
  return { response: new Response(stream, { status: options.status ?? 200,
    headers: { "content-type": "application/json", ...options.headers } }), cancel };
}
function adapter(provider: Provider, fetchFn: typeof fetch): LLMClient {
  if (provider === "openai") return createOpenAICompatibleClient({ endpoint: "https://fixture.invalid/v1", fetchFn });
  vi.spyOn(globalThis, "fetch").mockImplementation(fetchFn);
  return createAnthropicClient("inert-test-key");
}
async function failure<T>(promise: Promise<T>): Promise<unknown> {
  return promise.then(() => { throw new Error("Unexpected output"); }, (error: unknown) => error);
}
async function drain() { await Promise.resolve(); await Promise.resolve(); }

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("bounded wire-body primitive", () => {
  it("runs in the native Worker pool", () => {
    expect(navigator.userAgent).toBe("Cloudflare-Workers");
  });

  it("accepts only positive safe integers at or below the 1MiB host cap", () => {
    expect(MAX_RESPONSE_BYTES).toBe(1024 * 1024);
    expect(validateMaxResponseBytes(undefined)).toBeUndefined();
    expect(validateMaxResponseBytes(1)).toBe(1);
    expect(validateMaxResponseBytes(MAX_RESPONSE_BYTES)).toBe(MAX_RESPONSE_BYTES);
    for (const limit of [0, -1, 1.5, Infinity, NaN, null, "512", MAX_RESPONSE_BYTES + 1, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => validateMaxResponseBytes(limit)).toThrow("INVALID_RESPONSE_LIMIT");
    }
  });

  it("counts UTF-8 bytes, not characters, at the exact multi-byte boundary", async () => {
    const body = encoder.encode("😀");
    const exact = await fetchBoundedResponse(async () => source(body, { chunkSize: 1 }).response, "https://fixture.invalid", {}, 4);
    expect(await exact.text()).toBe("😀");
    await expect(fetchBoundedResponse(async () => source(body, { chunkSize: 1 }).response, "https://fixture.invalid", {}, 3)).rejects.toMatchObject({ code: "RESPONSE_TOO_LARGE" });
  });

  it("copies only an admitted view, not its oversized backing buffer", async () => {
    const backing = new Uint8Array(MAX_RESPONSE_BYTES + 128);
    backing.set(encoder.encode('{"ok":true}'));
    const view = backing.subarray(0, 11);
    const upstream = source(view);
    const bounded = await fetchBoundedResponse(async () => upstream.response, "https://fixture.invalid", {}, 11);
    backing.fill(0);
    expect(await bounded.json()).toEqual({ ok: true });
  });

  it("rejects an oversized first chunk without returning a partial parser response", async () => {
    const upstream = source(encoder.encode("private wire body".repeat(100)), { holdOpen: true });
    const json = vi.spyOn(Response.prototype, "json");
    const text = vi.spyOn(Response.prototype, "text");
    let signal: AbortSignal | null | undefined;
    const fetchFn = vi.fn<typeof fetch>(async (_input, init) => { signal = init?.signal; return upstream.response; });
    const error = await failure(fetchBoundedResponse(fetchFn, "https://fixture.invalid", {}, 32));
    expect(error).toMatchObject({ code: "RESPONSE_TOO_LARGE" });
    expect(String(error)).not.toContain("private");
    expect(error).not.toHaveProperty("cause");
    expect(signal?.aborted).toBe(true);
    expect(upstream.cancel).toHaveBeenCalledTimes(1);
    expect(json).not.toHaveBeenCalled();
    expect(text).not.toHaveBeenCalled();
  });

  it("cancels a late response from a transport that ignored abort while awaiting headers", async () => {
    const controller = new AbortController();
    let release!: (response: Response) => void;
    const fetchFn: typeof fetch = () => new Promise((resolve) => { release = resolve; });
    const pending = failure(fetchBoundedResponse(fetchFn, "https://fixture.invalid", { signal: controller.signal }, 256));
    controller.abort("private reason");
    expect(await pending).toMatchObject({ code: "RESPONSE_ABORTED" });
    const upstream = source(encoder.encode("late"), { holdOpen: true });
    release(upstream.response);
    await drain();
    expect(upstream.cancel).toHaveBeenCalledTimes(1);
  });

  it("fails before fetch for pre-aborted signals and invalid limits", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchFn = vi.fn<typeof fetch>();
    await expect(fetchBoundedResponse(fetchFn, "https://fixture.invalid", { signal: controller.signal }, 1)).rejects.toMatchObject({ code: "RESPONSE_ABORTED" });
    await expect(fetchBoundedResponse(fetchFn, "https://fixture.invalid", {}, 0)).rejects.toMatchObject({ code: "INVALID_RESPONSE_LIMIT" });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("sanitizes stream and transport exceptions and aborts the transport", async () => {
    let signal: AbortSignal | null | undefined;
    const upstream = new Response(new ReadableStream({ pull() { throw new Error("private read failure"); } }));
    const error = await failure(fetchBoundedResponse(async (_input, init) => { signal = init?.signal; return upstream; }, "https://fixture.invalid", {}, 256));
    expect(error).toMatchObject({ code: "RESPONSE_READ_FAILED" });
    expect(String(error)).not.toContain("private");
    expect(error).not.toHaveProperty("cause");
    expect(signal?.aborted).toBe(true);
    const fetchError = await failure(fetchBoundedResponse(async () => { throw new Error("private transport failure"); }, "https://fixture.invalid", {}, 256));
    expect(fetchError).toMatchObject({ code: "RESPONSE_READ_FAILED" });
    expect(String(fetchError)).not.toContain("private");
  });
});

for (const provider of ["openai", "anthropic"] as const) {
  describe(`${provider}: request-local wire cap through the actual adapter`, () => {
    it.each([0, -1, 1.5, Infinity, NaN, null, "512", MAX_RESPONSE_BYTES + 1])("rejects malformed cap %s before inference", async (cap) => {
      const fetchFn = vi.fn<typeof fetch>();
      const client = adapter(provider, fetchFn);
      await expect(client.createMessage({ ...request, max_response_bytes: cap as number })).rejects.toMatchObject({ code: "INVALID_RESPONSE_LIMIT" });
      expect(fetchFn).not.toHaveBeenCalled();
    });

    it.each([undefined, "0", "1", "999999999", "not-a-length"])("counts actual bytes with absent/lying Content-Length %s, including split UTF-8", async (length) => {
      const body = bytes(provider);
      const upstream = source(body, { chunkSize: 1,
        headers: length === undefined ? {} : { "content-length": length } });
      const originalJSON = vi.spyOn(upstream.response, "json");
      const originalText = vi.spyOn(upstream.response, "text");
      const fetchFn = vi.fn<typeof fetch>(async () => upstream.response);
      const client = adapter(provider, fetchFn);
      const result = await client.createMessage({ ...request, max_response_bytes: body.byteLength });
      expect(result.content).toEqual([{ type: "text", text: "ok😀é" }]);
      expect(result.usage.input_tokens).toBe(5);
      expect(originalJSON).not.toHaveBeenCalled();
      expect(originalText).not.toHaveBeenCalled();
      expect(fetchFn).toHaveBeenCalledTimes(1);
    });

    it("rejects the byte after an exact prefix cap, including a UTF-8 multi-byte chunk", async () => {
      const body = bytes(provider);
      const upstream = source(body, { chunkSize: 7, headers: { "content-length": "1" }, holdOpen: true });
      const parse = vi.spyOn(Response.prototype, "json");
      const text = vi.spyOn(Response.prototype, "text");
      const fetchFn = vi.fn<typeof fetch>(async () => upstream.response);
      const client = adapter(provider, fetchFn);
      await expect(client.createMessage({ ...request, max_response_bytes: body.byteLength - 1, disableRetries: false })).rejects.toMatchObject({ code: "RESPONSE_TOO_LARGE" });
      expect(fetchFn).toHaveBeenCalledTimes(1);
      expect(upstream.cancel).toHaveBeenCalledTimes(1);
      expect(parse).not.toHaveBeenCalled();
      expect(text).not.toHaveBeenCalled();
    });

    it("bounds error bodies before SDK/error JSON parsing and never retries the capped call", async () => {
      const body = encoder.encode(JSON.stringify({ error: { message: "private error payload".repeat(100) } }));
      const upstream = source(body, { status: 503, holdOpen: true });
      const parse = vi.spyOn(Response.prototype, "json");
      const text = vi.spyOn(Response.prototype, "text");
      const jsonParse = vi.spyOn(JSON, "parse");
      const fetchFn = vi.fn<typeof fetch>(async () => upstream.response);
      const client = adapter(provider, fetchFn);
      const error = await failure(client.createMessage({ ...request, max_response_bytes: 64 }));
      expect(error).toMatchObject({ code: "RESPONSE_TOO_LARGE" });
      expect(String(error)).not.toContain("private");
      expect(error).not.toHaveProperty("cause");
      expect(parse).not.toHaveBeenCalled();
      expect(text).not.toHaveBeenCalled();
      expect(jsonParse.mock.calls.some(([value]) => String(value).includes("private error payload"))).toBe(false);
      expect(fetchFn).toHaveBeenCalledTimes(1);
    });

    it("sanitizes an in-cap HTTP error instead of retaining the provider payload/cause", async () => {
      const upstream = source(encoder.encode(JSON.stringify({ error: { message: "private provider detail" } })), { status: 503 });
      const fetchFn = vi.fn<typeof fetch>(async () => upstream.response);
      const client = adapter(provider, fetchFn);
      const error = await failure(client.createMessage({ ...request, max_response_bytes: 256 }));
      expect(String(error)).not.toContain("private");
      expect(error).not.toHaveProperty("cause");
      expect(fetchFn).toHaveBeenCalledTimes(1);
    });

    it("keeps simultaneous caps and ordinary requests independent and does not serialize host controls", async () => {
      const sent: Array<Record<string, unknown>> = [];
      const normal = bytes(provider);
      const fetchFn = vi.fn<typeof fetch>(async (_input, init) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        sent.push(body);
        const system = provider === "anthropic" ? body.system : (body.messages as Array<{ content: string }>)[0]?.content;
        return source(system === "ordinary" ? bytes(provider, "ordinary".repeat(1024)) : normal).response;
      });
      const client = adapter(provider, fetchFn);
      const small = failure(client.createMessage({ ...request, system: "small", max_response_bytes: normal.byteLength - 1 }));
      const large = client.createMessage({ ...request, system: "large", max_response_bytes: normal.byteLength });
      const ordinary = client.createMessage({ ...request, system: "ordinary", disableRetries: true });
      expect(await small).toMatchObject({ code: "RESPONSE_TOO_LARGE" });
      expect((await large).content).toEqual([{ type: "text", text: "ok😀é" }]);
      expect((await ordinary).content).toEqual([{ type: "text", text: "ordinary".repeat(1024) }]);
      expect(fetchFn).toHaveBeenCalledTimes(3);
      for (const body of sent) {
        expect(body).not.toHaveProperty("max_response_bytes");
        expect(body).not.toHaveProperty("disableRetries");
        expect(body).not.toHaveProperty("signal");
      }
    });

    it("aborts transport and hung body reads without awaiting a hung reader.cancel()", async () => {
      const controller = new AbortController();
      const upstream = source(new Uint8Array(0), { holdOpen: true });
      let admitted!: () => void;
      const ready = new Promise<void>((resolve) => { admitted = resolve; });
      let signal: AbortSignal | null | undefined;
      const fetchFn = vi.fn<typeof fetch>(async (_input, init) => { signal = init?.signal; admitted(); return upstream.response; });
      const client = adapter(provider, fetchFn);
      const pending = failure(client.createMessage({ ...request, max_response_bytes: 256, signal: controller.signal }));
      await ready;
      await drain();
      controller.abort("private abort reason");
      expect(await pending).toMatchObject({ code: "RESPONSE_ABORTED" });
      expect(signal?.aborted).toBe(true);
      expect(upstream.cancel).toHaveBeenCalledTimes(1);
      expect(fetchFn).toHaveBeenCalledTimes(1);
    });

    it("uses the shared budget's host cap and deadline through the real adapter, retaining unknown settlement", async () => {
      const upstream = source(new Uint8Array(0), { holdOpen: true });
      let signal: AbortSignal | null | undefined;
      const fetchFn = vi.fn<typeof fetch>(async (_input, init) => { signal = init?.signal; return upstream.response; });
      const run = new ModelBudget({ client: adapter(provider, fetchFn), model: request.model,
        limits: { wallTimeMs: 10, maxResponseBytesPerCall: 256 } });
      try {
        expect(await failure(run.clientFor("root").createMessage({ ...request, max_response_bytes: 1 }))).toMatchObject({ code: "DEADLINE" });
        await drain();
        expect(signal?.aborted).toBe(true);
        expect(upstream.cancel).toHaveBeenCalledTimes(1);
        expect(run.snapshot()).toMatchObject({ attempts: 1, usageStatus: "unknown", reservedOutputTokens: 32 });
      } finally { run.dispose(); }
    });

    it("the budget also retains UNKNOWN when a real adapter rejects oversized wire bytes", async () => {
      const upstream = source(bytes(provider), { holdOpen: true });
      const fetchFn = vi.fn<typeof fetch>(async () => upstream.response);
      const run = new ModelBudget({ client: adapter(provider, fetchFn), model: request.model, limits: { maxResponseBytesPerCall: 64 } });
      try {
        await expect(run.clientFor("child").createMessage(request)).rejects.toMatchObject({ code: "PROVIDER_ERROR" });
        expect(run.snapshot()).toMatchObject({ attempts: 1, activeCalls: 0, usageStatus: "unknown", reservedOutputTokens: 32 });
        expect(run.snapshot().ledger[0]!.usage.inputTokens).toBeNull();
        expect(fetchFn).toHaveBeenCalledTimes(1);
      } finally { run.dispose(); }
    });
  });
}

it("does not hide malformed Anthropic cache usage as an omitted, apparently free cache", async () => {
  for (const cache of [null, -1, 1.5]) {
    const value = { ...wire.anthropic(), usage: { input_tokens: 5, output_tokens: 2, cache_read_input_tokens: cache } };
    const client = adapter("anthropic", async () => source(encoder.encode(JSON.stringify(value))).response);
    const result = await client.createMessage({ ...request, max_response_bytes: 512 });
    expect(result.usage.reported).toBe(false);
    expect(result.usage.input_tokens).toBe(5);
  }
});

it("Anthropic's SDK timeout remains active while its custom fetch drains a hung response body", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const upstream = source(new Uint8Array(0), { holdOpen: true });
  let admitted!: () => void;
  const ready = new Promise<void>((resolve) => { admitted = resolve; });
  const fetchFn = vi.fn<typeof fetch>(async () => { admitted(); return upstream.response; });
  const client = adapter("anthropic", fetchFn);
  const pending = failure(client.createMessage({ ...request, max_response_bytes: 256 }));
  await ready;
  await vi.advanceTimersByTimeAsync(600_000);
  expect(await pending).toMatchObject({ code: "RESPONSE_ABORTED" });
  expect(upstream.cancel).toHaveBeenCalledTimes(1);
  expect(fetchFn).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

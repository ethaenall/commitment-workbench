// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it, vi } from "vitest";
import { createAnthropicClient } from "../../src/llm/anthropic-client";
import { createOpenAICompatibleClient } from "../../src/llm/openai-compatible-client";
import type { LLMCreateParams } from "../../src/llm/types";

const request: LLMCreateParams = {
  model: "test-model",
  max_tokens: 32,
  messages: [{ role: "user", content: "fixture only" }],
};

const openaiReply = {
  id: "fixture",
  choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 5, completion_tokens: 2 },
};

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => vi.restoreAllMocks());

describe("request-local model controls", () => {
  it("composes workflow cancellation with the OpenAI-compatible timeout without serializing controls", async () => {
    const controller = new AbortController();
    let signal: AbortSignal | null | undefined;
    let body: Record<string, unknown> = {};
    const fetchFn = vi.fn<typeof fetch>(async (_url, init) => {
      signal = init?.signal;
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return jsonResponse(openaiReply);
    });
    const client = createOpenAICompatibleClient({ endpoint: "https://fixture.invalid/v1", fetchFn });
    await client.createMessage({ ...request, signal: controller.signal, disableRetries: true });
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal?.aborted).toBe(false);
    controller.abort();
    expect(signal?.aborted).toBe(true);
    expect(body).not.toHaveProperty("signal");
    expect(body).not.toHaveProperty("disableRetries");
    expect(body.max_tokens).toBe(32);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("interrupts a pending OpenAI-compatible request and does not retry it", async () => {
    const controller = new AbortController();
    const fetchFn = vi.fn<typeof fetch>((_url, init) => new Promise((_resolve, reject) => {
      const abort = () => reject(new DOMException("fixture cancelled", "AbortError"));
      if (init?.signal?.aborted) abort();
      else init?.signal?.addEventListener("abort", abort, { once: true });
    }));
    const client = createOpenAICompatibleClient({ endpoint: "https://fixture.invalid/v1", fetchFn });
    const pending = client.createMessage({ ...request, signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toThrow();
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("marks missing usage unknown rather than implying a measured free call", async () => {
    const client = createOpenAICompatibleClient({
      endpoint: "https://fixture.invalid/v1",
      fetchFn: async () => jsonResponse({ ...openaiReply, usage: undefined }),
    });
    const result = await client.createMessage(request);
    expect(result.usage.reported).toBe(false);
  });

  it("marks invalid usage unknown while preserving the raw values for bounded-run rejection", async () => {
    const client = createOpenAICompatibleClient({
      endpoint: "https://fixture.invalid/v1",
      fetchFn: async () => jsonResponse({
        ...openaiReply,
        usage: { prompt_tokens: -1, completion_tokens: 2.5 },
      }),
    });
    const result = await client.createMessage(request);
    expect(result.usage.reported).toBe(false);
  });

  it("passes cancellation to the real Anthropic SDK and preserves separate cache accounting", async () => {
    const controller = new AbortController();
    let signal: AbortSignal | null | undefined;
    let body: Record<string, unknown> = {};
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return jsonResponse({
        id: "fixture", type: "message", role: "assistant", model: "test-model",
        content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", stop_sequence: null,
        usage: { input_tokens: 5, output_tokens: 2, cache_read_input_tokens: 20, cache_creation_input_tokens: 10 },
      });
    });
    const client = createAnthropicClient("inert-test-key");
    const result = await client.createMessage({ ...request, signal: controller.signal, disableRetries: true });
    expect(signal).toBeInstanceOf(AbortSignal);
    // The SDK removes its relay when the request settles. Forwarding is checked
    // while a request is pending in the next test, not after that cleanup.
    expect(body).not.toHaveProperty("signal");
    expect(body).not.toHaveProperty("disableRetries");
    expect(result.usage).toEqual({
      input_tokens: 5, output_tokens: 2,
      cache_read_input_tokens: 20, cache_creation_input_tokens: 10,
    });
  });

  it("aborts a pending Anthropic SDK request through the caller signal", async () => {
    const controller = new AbortController();
    let admitFetch!: () => void;
    const admitted = new Promise<void>((resolve) => { admitFetch = resolve; });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => new Promise((_resolve, reject) => {
      const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
      const abort = () => reject(new DOMException("fixture cancelled", "AbortError"));
      if (signal?.aborted) abort();
      else signal?.addEventListener("abort", abort, { once: true });
      admitFetch();
    }));
    const client = createAnthropicClient("inert-test-key");
    const pending = client.createMessage({ ...request, signal: controller.signal, disableRetries: true });
    await admitted;
    controller.abort();
    await expect(pending).rejects.toThrow();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("disables hidden Anthropic SDK retries for a metered workflow attempt", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => jsonResponse({
      type: "error", error: { type: "overloaded_error", message: "fixture overload" },
    }, 503));
    const client = createAnthropicClient("inert-test-key");
    await expect(client.createMessage({ ...request, disableRetries: true })).rejects.toThrow();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

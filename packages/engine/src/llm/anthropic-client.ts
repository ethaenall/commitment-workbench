// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import Anthropic from "@anthropic-ai/sdk";
import type {
  LLMClient,
  LLMCreateParams,
  LLMResponse,
  LLMContentBlock,
  LLMMessage,
  LLMToolDefinition,
} from "./types";
import { LLM_NATIVE_OPERATIONS } from "./types";
import {
  BoundedResponseError,
  fetchBoundedResponse,
  validateMaxResponseBytes,
} from "./bounded-response";
import {
  UpstreamLLMError,
  UpstreamResponseError,
  UPSTREAM_INVALID_RESPONSE_MESSAGE,
  UPSTREAM_UNAVAILABLE_MESSAGE,
  isRetryableLLMStatus,
} from "./errors";

/**
 * Classify an error thrown by the Anthropic SDK. A retryable upstream failure —
 * a connection error (no HTTP status), a timeout/rate-limit (`408`/`429`), or a
 * `5xx` (incl. `529 overloaded`) surviving the SDK's own retries — is wrapped as
 * an `UpstreamLLMError` so the API boundary can return a friendly, retryable
 * `503`. Anything else (e.g. a `4xx` from a malformed request — our bug)
 * propagates unchanged, to surface as a structured `500`.
 */
export function classifyLLMError(err: unknown): unknown {
  if (err instanceof Anthropic.APIError && isRetryableLLMStatus(err.status)) {
    return new UpstreamLLMError(UPSTREAM_UNAVAILABLE_MESSAGE, { cause: err });
  }
  return err;
}

/**
 * Map one canonical content block to the SDK's request block. The shapes
 * coincide today (the canonical form descends from this API), but the mapping
 * is explicit so a canonical-shape change surfaces here as a type error
 * instead of leaking Habenula's shape onto the wire.
 */
function toAnthropicBlock(block: LLMContentBlock): Anthropic.ContentBlockParam {
  switch (block.type) {
    case "text":
      return { type: "text", text: block.text };
    case "tool_use":
      return { type: "tool_use", id: block.id, name: block.name, input: block.input };
    case "tool_result":
      return {
        type: "tool_result",
        tool_use_id: block.tool_use_id,
        content: block.content,
        ...(block.is_error !== undefined ? { is_error: block.is_error } : {}),
      };
  }
}

function toAnthropicMessages(messages: LLMMessage[]): Anthropic.MessageParam[] {
  return messages.map((m) => ({
    role: m.role,
    content:
      typeof m.content === "string" ? m.content : m.content.map(toAnthropicBlock),
  }));
}

function toAnthropicTools(tools: LLMToolDefinition[]): Anthropic.Tool[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema,
  }));
}

/**
 * Narrow the SDK's stop reason to the canonical enum. Values the canonical
 * shape doesn't model (future SDK additions) map to `null` — the loop only
 * branches on `tool_use`, so an unmodeled reason reads as a terminal turn.
 */
function toCanonicalStopReason(
  reason: string | null,
): LLMResponse["stop_reason"] {
  switch (reason) {
    case "end_turn":
    case "tool_use":
    case "max_tokens":
    case "stop_sequence":
      return reason;
    default:
      return null;
  }
}

export function createAnthropicClient(apiKey: string): LLMClient {
  const fetchFn = fetch;
  const client = new Anthropic({ apiKey, fetch: fetchFn });

  return {
    async createMessage(params: LLMCreateParams): Promise<LLMResponse> {
      const maxBytes = validateMaxResponseBytes(params.max_response_bytes);
      const observer = params[LLM_NATIVE_OPERATIONS];
      // Observe the trusted SDK lifetime before its first async preparation step.
      // Raw uncapped calls are not covered by the bounded fetch adapter.
      const sdkLifetime = maxBytes === undefined ? undefined : observer?.openTransport();
      try {
        let boundedFailure: BoundedResponseError | undefined;
        // Official SDK injection, scoped to this call. Never mutate the shared
        // client's fetch/options: simultaneous calls can have different caps.
        // Observer is host-only; the SDK request body never receives it.
        const requestClient = maxBytes === undefined ? client : client.withOptions({
          maxRetries: 0,
          fetch: async (input, init) => {
            try {
              return await fetchBoundedResponse(fetchFn, input, init, maxBytes, observer);
            } catch (error) {
              boundedFailure = error instanceof BoundedResponseError ? error : new BoundedResponseError("RESPONSE_READ_FAILED");
              throw boundedFailure;
            }
          },
        });
        // `.catch` that always rethrows: classify the SDK failure without a typed
        // `let` (the callback returns `never`, so `response` keeps the SDK type).
        const response = await requestClient.messages
          .create({
            model: params.model,
            max_tokens: params.max_tokens,
            ...(params.system !== undefined ? { system: params.system } : {}),
            messages: toAnthropicMessages(params.messages),
            ...(params.tools ? { tools: toAnthropicTools(params.tools) } : {}),
            stream: false,
          }, {
            ...(params.signal ? { signal: params.signal } : {}),
            ...(params.disableRetries || maxBytes !== undefined ? { maxRetries: 0 } : {}),
          })
          .catch((err: unknown) => {
            // The SDK wraps a custom-fetch failure as a connection error. Preserve
            // our fixed reason, never the SDK's provider/body-bearing error cause.
            if (boundedFailure) throw boundedFailure;
            if (maxBytes !== undefined) {
              if (params.signal?.aborted) throw new BoundedResponseError("RESPONSE_ABORTED");
              if (classifyLLMError(err) instanceof UpstreamLLMError) throw new UpstreamLLMError(UPSTREAM_UNAVAILABLE_MESSAGE);
              throw new UpstreamResponseError(UPSTREAM_INVALID_RESPONSE_MESSAGE);
            }
            throw classifyLLMError(err);
          });
        if (maxBytes !== undefined && params.signal?.aborted) throw new BoundedResponseError("RESPONSE_ABORTED");

        if (!response.usage) throw new UpstreamResponseError(UPSTREAM_INVALID_RESPONSE_MESSAGE);
        const usage = response.usage;
        const validUsage = (value: unknown): boolean => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
        const reported = validUsage(usage.input_tokens) && validUsage(usage.output_tokens)
          && (usage.cache_read_input_tokens === undefined || validUsage(usage.cache_read_input_tokens))
          && (usage.cache_creation_input_tokens === undefined || validUsage(usage.cache_creation_input_tokens));
        const content: LLMContentBlock[] = [];
        for (const block of response.content) {
          if (block.type === "text") {
            content.push({ type: "text", text: block.text });
          } else if (block.type === "tool_use") {
            content.push({
              type: "tool_use",
              id: block.id,
              name: block.name,
              input: block.input as Record<string, unknown>,
            });
          }
        }

        return {
          id: response.id,
          content,
          stop_reason: toCanonicalStopReason(response.stop_reason),
          usage: {
            input_tokens: usage.input_tokens,
            output_tokens: usage.output_tokens,
            ...(usage.cache_read_input_tokens != null
              ? { cache_read_input_tokens: usage.cache_read_input_tokens }
              : {}),
            ...(usage.cache_creation_input_tokens != null
              ? { cache_creation_input_tokens: usage.cache_creation_input_tokens }
              : {}),
            ...(reported ? {} : { reported: false }),
          },
        };
      } finally {
        sdkLifetime?.closeProducer();
      }
    },
  };
}

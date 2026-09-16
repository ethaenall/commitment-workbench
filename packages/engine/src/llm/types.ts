// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The Habenula-owned canonical LLM shape.
 *
 * These types are the engine's own inference envelope, not any provider's:
 * every adapter (`anthropic-client.ts`, `openai-compatible-client.ts`) maps
 * this shape to its provider wire form and back, and nothing outside an
 * adapter speaks a vendor API. The block set (`text` / `tool_use` /
 * `tool_result`) is kept as the richer superset; persisted held-turn state
 * built from it is versioned by `CANONICAL_SHAPE_VERSION` (`canonical.ts`).
 * Injectable for testing (same pattern as fetchFn).
 */

// Declared in @habenula-ai/tools (every Tool carries one); re-exported here
// so the adapter's consumers keep one import site for LLM types.
import type { LLMToolInputSchema } from "@habenula-ai/tools";
import type { NativeOperationScope } from "./native-operation-scope.js";
export type { LLMToolInputSchema };

/**
 * Host-only native observer. Symbol keys are not JSON-enumerable and are not a
 * public DTO field. Adapters must never copy this onto provider wire.
 * NativeOperationScope defines this contract; this is not a second DTO.
 */
export const LLM_NATIVE_OPERATIONS = Symbol.for("habenula.internal.llmNativeOperations");

export interface LLMToolDefinition {
  name: string;
  description: string;
  input_schema: LLMToolInputSchema;
}

export interface LLMTextBlock {
  type: "text";
  text: string;
}

export interface LLMToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface LLMToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

export type LLMContentBlock = LLMTextBlock | LLMToolUseBlock | LLMToolResultBlock;

export interface LLMMessage {
  role: "user" | "assistant";
  content: string | LLMContentBlock[];
}

export interface LLMResponse {
  id: string;
  content: LLMContentBlock[];
  stop_reason: "end_turn" | "tool_use" | "max_tokens" | "stop_sequence" | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
    /** Anthropic reports cache reads/writes separately from uncached input. */
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
    /** False if the adapter did not receive valid usage; zero is not a quote. */
    reported?: boolean;
  };
}

export interface LLMCreateParams {
  model: string;
  max_tokens: number;
  system?: string;
  messages: LLMMessage[];
  tools?: LLMToolDefinition[];
  /** Request-local cancellation; never persisted in conversation state. */
  signal?: AbortSignal;
  /** Bounded workflows count attempts themselves; suppress hidden SDK retries. */
  disableRetries?: boolean;
  /** Host-only, per-request wire-body cap (1..1MiB); never sent to a provider. */
  max_response_bytes?: number;
  /** Host-only native observer. Never provider JSON. Transport-06 owns the type. */
  [LLM_NATIVE_OPERATIONS]?: NativeOperationScope;
}

export interface LLMClient {
  createMessage(params: LLMCreateParams): Promise<LLMResponse>;
}

// SPDX-License-Identifier: AGPL-3.0-only

import type { LLMClient, LLMCreateParams, LLMResponse } from "../llm/types.js";
import { LLM_NATIVE_OPERATIONS } from "../llm/types.js";
import { MAX_RESPONSE_BYTES } from "../llm/bounded-response.js";
import type {
  NativeIoKind,
  NativeIoObservation,
  NativeIoSnapshot,
  NativeOperationScope,
} from "../llm/native-operation-scope.js";

/** Host-owned limits, shared by the ordinary root and every recursive child. */
export interface ModelBudgetLimits {
  maxAttempts: number;
  maxConcurrent: number;
  maxInputBytesPerCall: number;
  maxTotalInputBytes: number;
  maxObservedInputTokens: number;
  maxObservedOutputTokens: number;
  maxOutputTokensPerCall: number;
  maxResponseBytesPerCall: number;
  wallTimeMs: number;
}

export const MODEL_BUDGET_DEFAULTS: Readonly<ModelBudgetLimits> = Object.freeze({
  maxAttempts: 10,
  maxConcurrent: 2,
  maxInputBytesPerCall: 512 * 1024,
  maxTotalInputBytes: 2 * 1024 * 1024,
  maxObservedInputTokens: 120_000,
  maxObservedOutputTokens: 12_000,
  maxOutputTokensPerCall: 4096,
  maxResponseBytesPerCall: 256 * 1024,
  wallTimeMs: 300_000,
});

/** Configuration can lower or raise defaults, but cannot raise these host caps. */
export const MODEL_BUDGET_HARD_CEILINGS: Readonly<ModelBudgetLimits> = Object.freeze({
  maxAttempts: 64,
  maxConcurrent: 8,
  maxInputBytesPerCall: 1024 * 1024,
  maxTotalInputBytes: 8 * 1024 * 1024,
  maxObservedInputTokens: 1_000_000,
  maxObservedOutputTokens: 64_000,
  maxOutputTokensPerCall: 16_384,
  maxResponseBytesPerCall: MAX_RESPONSE_BYTES,
  wallTimeMs: 900_000,
});

export type ModelBudgetRole = "root" | "child";
export type ModelBudgetErrorCode =
  | "INVALID_LIMITS" | "INVALID_MODEL" | "MODEL_MISMATCH" | "INVALID_REQUEST"
  | "ATTEMPT_LIMIT" | "CONCURRENCY_LIMIT" | "REQUEST_BYTES_LIMIT"
  | "INPUT_TOKEN_LIMIT" | "OUTPUT_TOKEN_LIMIT" | "RESPONSE_BYTES_LIMIT"
  | "INVALID_RESPONSE" | "UNKNOWN_USAGE" | "PROVIDER_ERROR"
  | "CANCELLED" | "DEADLINE" | "DISPOSED";

/** Fixed messages deliberately exclude prompts, output, and provider errors. */
export class ModelBudgetError extends Error {
  constructor(readonly code: ModelBudgetErrorCode, readonly observedBytes?: number) {
    super(`Model budget: ${code}`);
    this.name = "ModelBudgetError";
  }
}

/** Decimal string only when a reported overshoot exceeds JS's safe integer range. */
export type ModelTokenCount = number | string;
export interface ModelAttemptUsage {
  inputTokens: ModelTokenCount | null;
  outputTokens: number | null;
  uncachedInputTokens: number | null;
  cacheReadInputTokens: number | null;
  cacheCreationInputTokens: number | null;
}
export interface ModelBudgetAttempt {
  id: number;
  role: ModelBudgetRole;
  requestInputBytes: number;
  requestedOutputTokens: number;
  /** A lower bound on a rejected oversized response; null if not inspected. */
  responseBytes: number | null;
  responseBytesComplete: boolean;
  startedAfterMs: number;
  settledAfterMs: number | null;
  providerSettlement: "pending" | "fulfilled" | "rejected";
  usageStatus: "pending" | "reported" | "unknown";
  outcome: "pending" | "succeeded" | "rejected";
  reason: ModelBudgetErrorCode | null;
  late: boolean;
  usage: ModelAttemptUsage;
}
export interface ModelBudgetSnapshot {
  model: string;
  limits: Readonly<ModelBudgetLimits>;
  closedReason: ModelBudgetErrorCode | null;
  elapsedMs: number;
  attempts: number;
  activeCalls: number;
  peakConcurrent: number;
  totalRequestInputBytes: number;
  totalRequestedOutputTokens: number;
  reservedOutputTokens: number;
  /** Known measured portions only; never a quote when usageStatus != complete. */
  observedInputTokens: ModelTokenCount;
  observedOutputTokens: ModelTokenCount;
  usageStatus: "complete" | "pending" | "unknown";
  unknownUsageAttempts: number;
  ledger: ReadonlyArray<Readonly<ModelBudgetAttempt>>;
}

function tokenCount(value: bigint): ModelTokenCount {
  return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value.toString();
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function dataField(value: unknown, key: string): unknown {
  if (!isRecord(value)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}
function validToken(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}
function readUsage(response: unknown): ModelAttemptUsage {
  const usage = dataField(response, "usage");
  const reported = dataField(usage, "reported");
  const empty: ModelAttemptUsage = {
    inputTokens: null, outputTokens: null, uncachedInputTokens: null,
    cacheReadInputTokens: null, cacheCreationInputTokens: null,
  };
  if (!isRecord(usage) || (reported !== undefined && reported !== true)) return empty;
  const reportedDescriptor = Object.getOwnPropertyDescriptor(usage, "reported");
  if (reportedDescriptor && (!("value" in reportedDescriptor) || reported !== true)) return empty;
  const input = validToken(dataField(usage, "input_tokens"));
  const output = validToken(dataField(usage, "output_tokens"));
  const cache = (key: string): number | null => {
    const descriptor = Object.getOwnPropertyDescriptor(usage, key);
    return descriptor === undefined ? 0 : validToken(dataField(usage, key));
  };
  // Only Anthropic's adapter emits these separately. Other adapters' canonical
  // input_tokens already includes cached input: never inspect provider details.
  const read = cache("cache_read_input_tokens");
  const write = cache("cache_creation_input_tokens");
  return {
    inputTokens: input !== null && read !== null && write !== null
      ? tokenCount(BigInt(input) + BigInt(read) + BigInt(write)) : null,
    outputTokens: output, uncachedInputTokens: input,
    cacheReadInputTokens: read, cacheCreationInputTokens: write,
  };
}

/**
 * Copy bounded JSON data without first stringifying/encoding an unbounded body.
 * Count exact JSON UTF-8 bytes (including escaped controls and lone surrogates).
 * No getters/toJSON are invoked. Depth is a data-shape cap, NOT recursion depth.
 * This is not containment of hostile JS objects/proxies or a blocking provider.
 */
function boundedCopy<T>(value: T, limit: number, invalid: ModelBudgetErrorCode,
  exceeded: ModelBudgetErrorCode): { value: T; bytes: number } {
  let bytes = 0;
  const ancestors = new Set<object>();
  const add = (count: number): void => {
    bytes += count;
    if (bytes > limit) throw new ModelBudgetError(exceeded, bytes);
  };
  const string = (text: string): void => {
    add(2);
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      if (c === 34 || c === 92 || c === 8 || c === 9 || c === 10 || c === 12 || c === 13) add(2);
      else if (c < 32) add(6);
      else if (c < 128) add(1);
      else if (c < 2048) add(2);
      else if (c >= 0xd800 && c <= 0xdbff && text.charCodeAt(i + 1) >= 0xdc00 && text.charCodeAt(i + 1) <= 0xdfff) {
        add(4); i++;
      } else if (c >= 0xd800 && c <= 0xdfff) add(6);
      else add(3);
    }
  };
  const visit = (item: unknown, depth: number): unknown => {
    if (depth > 32) throw new ModelBudgetError(invalid);
    if (item === null) { add(4); return null; }
    if (typeof item === "string") { string(item); return item; }
    if (typeof item === "boolean") { add(item ? 4 : 5); return item; }
    if (typeof item === "number" && Number.isFinite(item)) {
      add(JSON.stringify(item).length); return item;
    }
    if ((!Array.isArray(item) && !isRecord(item)) || ancestors.has(item as object)) throw new ModelBudgetError(invalid);
    ancestors.add(item as object);
    add(2);
    let result: unknown;
    if (Array.isArray(item)) {
      const array: unknown[] = [];
      for (let i = 0; i < item.length; i++) {
        if (i > 0) add(1);
        const descriptor = Object.getOwnPropertyDescriptor(item, String(i));
        if (!descriptor || !("value" in descriptor)) throw new ModelBudgetError(invalid);
        array.push(visit(descriptor.value, depth + 1));
      }
      result = array;
    } else {
      const object: Record<string, unknown> = Object.create(null);
      let first = true;
      for (const key in item) {
        if (!Object.hasOwn(item, key)) continue;
        if (!first) add(1);
        first = false;
        string(key); add(1);
        const descriptor = Object.getOwnPropertyDescriptor(item, key);
        if (!descriptor || !("value" in descriptor)) throw new ModelBudgetError(invalid);
        object[key] = visit(descriptor.value, depth + 1);
      }
      result = object;
    }
    ancestors.delete(item as object);
    return result;
  };
  return { value: visit(value, 0) as T, bytes };
}

function validContent(content: unknown): boolean {
  return Array.isArray(content) && content.every((block: unknown) => {
    if (!isRecord(block)) return false;
    if (block.type === "text") return typeof block.text === "string";
    if (block.type === "tool_use") return typeof block.id === "string" && typeof block.name === "string" && isRecord(block.input);
    if (block.type === "tool_result") return typeof block.tool_use_id === "string" && typeof block.content === "string"
      && (block.is_error === undefined || typeof block.is_error === "boolean");
    return false;
  });
}
function validRequest(request: LLMCreateParams): boolean {
  return (request.system === undefined || typeof request.system === "string")
    && Array.isArray(request.messages) && request.messages.every((message) => isRecord(message)
      && (message.role === "user" || message.role === "assistant")
      && (typeof message.content === "string" || validContent(message.content)))
    && (request.tools === undefined || (Array.isArray(request.tools) && request.tools.every((tool) => isRecord(tool)
      && typeof tool.name === "string" && typeof tool.description === "string" && isRecord(tool.input_schema))));
}

interface NativeAttemptState {
  instrumented: boolean;
  openProducers: number;
  pendingOps: number;
}

function isNativeScope(value: unknown): value is NativeOperationScope {
  if (value === null || typeof value !== "object") return false;
  const scope = value as NativeOperationScope;
  return typeof scope.snapshot === "function" && typeof scope.openTransport === "function"
    && typeof scope.seal === "function" && typeof scope.join === "function";
}

/**
 * Per-attempt view of the SAME injected scope. Not a second factory or DTO.
 * fetchBoundedResponse still calls openTransport on this object, which delegates
 * to the injected scope so sibling attempts cannot steal attribution.
 */
function bindAttempt(scope: NativeOperationScope, rec: NativeAttemptState): NativeOperationScope {
  return {
    snapshot: () => scope.snapshot(),
    join: () => scope.join(),
    seal(): void {
      throw new Error("NATIVE_ATTEMPT_CANNOT_SEAL");
    },
    openTransport() {
      const session = scope.openTransport();
      rec.instrumented = true;
      rec.openProducers += 1;
      let producerOpen = true;
      return {
        id: session.id,
        trackPromise<T>(kind: NativeIoKind, start: () => Promise<T>): Promise<T> {
          rec.pendingOps += 1;
          try {
            return session.trackPromise(kind, start).then(
              (value) => {
                rec.pendingOps -= 1;
                return value;
              },
              (error: unknown) => {
                rec.pendingOps -= 1;
                throw error;
              },
            );
          } catch (error) {
            rec.pendingOps -= 1;
            throw error;
          }
        },
        closeProducer(): void {
          if (!producerOpen) return;
          producerOpen = false;
          rec.openProducers -= 1;
          session.closeProducer();
        },
      };
    },
  };
}

/**
 * One host-owned instance per workflow, shared by root and all children.
 *
 * Bounds admissions, concurrency, canonical request bytes, deadline, and requested
 * output. Observed token limits stop FUTURE admission; an in-flight request can
 * overshoot its request or report bad usage. This is not a provider billing cap,
 * a host isolation boundary, or cancellation of already-performed effects.
 *
 * Unknown usage/settlement seals the budget. Failed attempts retain their output
 * reservation. Explicit retry means another admitted createMessage call; there
 * is no retry here and adapters receive disableRetries:true. Do not reuse a
 * budget after failure. A caller signal cancels the whole shared workflow.
 *
 * The response cap covers canonical JSON BEFORE workflow/guest parsing and is
 * also forwarded as max_response_bytes for the existing adapters to bound wire
 * bytes admitted to their parsers. This does not bound network chunks or RSS.
 * A fixture that ignores AbortSignal cannot prevent our rejection,
 * but may remain unsettled. Late usage is recorded; late output is never returned.
 * Always dispose in the workflow's finally block, including on success.
 */
export class ModelBudget {
  readonly limits: Readonly<ModelBudgetLimits>;
  private readonly client: LLMClient;
  private readonly model: string;
  private readonly controller = new AbortController();
  private readonly startedAt = Date.now();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private detachExternal: (() => void) | undefined;
  private closed: ModelBudgetError | null = null;
  private readonly ledger: ModelBudgetAttempt[] = [];
  private active = 0;
  private peak = 0;
  private requestBytes = 0;
  private requestedOutput = 0;
  private reservedOutput = 0;
  private observedInput = 0n;
  private observedOutput = 0n;
  private readonly nativeOperationsScope: NativeOperationScope | undefined = undefined;
  private readonly nativeAttempts = new Map<number, NativeAttemptState>();

  constructor(options: {
    client: LLMClient;
    model: string;
    limits?: Partial<ModelBudgetLimits>;
    signal?: AbortSignal;
    /** Opt-in. Inject transport-06 createNativeOperationScope(); never a public DTO. */
    nativeOperations?: NativeOperationScope;
  }) {
    const overrides = options.limits === undefined ? {} : options.limits;
    if (!isRecord(overrides) || Object.keys(overrides).some((key) => !Object.hasOwn(MODEL_BUDGET_DEFAULTS, key))) {
      throw new ModelBudgetError("INVALID_LIMITS");
    }
    const limits = { ...MODEL_BUDGET_DEFAULTS, ...overrides };
    for (const key of Object.keys(MODEL_BUDGET_DEFAULTS) as Array<keyof ModelBudgetLimits>) {
      if (!Number.isSafeInteger(limits[key]) || limits[key] <= 0 || limits[key] > MODEL_BUDGET_HARD_CEILINGS[key]) {
        throw new ModelBudgetError("INVALID_LIMITS");
      }
    }
    if (typeof options.model !== "string" || options.model.length > 256 || !options.model.trim()) {
      throw new ModelBudgetError("INVALID_MODEL");
    }
    this.client = options.client;
    this.model = options.model;
    this.limits = Object.freeze(limits);
    if (options.nativeOperations !== undefined) {
      if (!isNativeScope(options.nativeOperations)) throw new ModelBudgetError("INVALID_REQUEST");
      this.nativeOperationsScope = options.nativeOperations;
    }
    if (options.signal?.aborted) this.close("CANCELLED");
    else {
      if (options.signal) {
        const signal = options.signal;
        const abort = (): void => this.close("CANCELLED");
        signal.addEventListener("abort", abort, { once: true });
        this.detachExternal = () => signal.removeEventListener("abort", abort);
      }
      this.timer = setTimeout(() => this.close("DEADLINE"), limits.wallTimeMs);
    }
  }

  get signal(): AbortSignal { return this.controller.signal; }
  clientFor(role: ModelBudgetRole): LLMClient {
    if (role !== "root" && role !== "child") throw new ModelBudgetError("INVALID_REQUEST");
    return { createMessage: (params) => this.createMessage(role, params) };
  }
  cancel(): void { this.close("CANCELLED"); }
  dispose(): void { this.close("DISPOSED"); }

  snapshot(): ModelBudgetSnapshot {
    const unknown = this.ledger.filter((entry) => entry.usageStatus === "unknown").length;
    return {
      model: this.model, limits: this.limits, closedReason: this.closed?.code ?? null,
      elapsedMs: this.elapsed(), attempts: this.ledger.length,
      activeCalls: this.active, peakConcurrent: this.peak,
      totalRequestInputBytes: this.requestBytes, totalRequestedOutputTokens: this.requestedOutput,
      reservedOutputTokens: this.reservedOutput,
      observedInputTokens: tokenCount(this.observedInput), observedOutputTokens: tokenCount(this.observedOutput),
      usageStatus: unknown > 0 ? "unknown" : this.active > 0 ? "pending" : "complete",
      unknownUsageAttempts: unknown,
      ledger: this.ledger.map((entry) => Object.freeze({ ...entry, usage: Object.freeze({ ...entry.usage }) })),
    };
  }

  /** Seal native admission without aborting an already completed workflow result. */
  sealNativeOperations(): void {
    if (!this.nativeOperationsScope) throw new ModelBudgetError("INVALID_REQUEST");
    this.nativeOperationsScope.seal();
  }

  /** Join actual observed native work; no observer or unknown work is not settlement. */
  async joinNativeOperations(): Promise<void> {
    if (!this.nativeOperationsScope) throw new ModelBudgetError("INVALID_REQUEST");
    await this.nativeOperationsScope.join();
  }

  /** Null when native coverage was not opted in. Transport-06 snapshot; not a budget DTO. */
  nativeObservation(): NativeIoSnapshot | null {
    return this.nativeOperationsScope ? this.nativeOperationsScope.snapshot() : null;
  }
  attemptNativeObservation(id: number): NativeIoObservation {
    if (!Number.isSafeInteger(id) || id < 1) throw new ModelBudgetError("INVALID_REQUEST");
    const rec = this.nativeAttempts.get(id);
    if (!rec?.instrumented) return "UNOBSERVED";
    if (rec.openProducers > 0 || rec.pendingOps > 0) return "TRACKED_PENDING";
    return "SETTLED";
  }

  private elapsed(): number { return Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Date.now() - this.startedAt)); }
  private close(code: ModelBudgetErrorCode): void {
    if (this.closed) return;
    this.closed = new ModelBudgetError(code);
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.detachExternal?.();
    this.detachExternal = undefined;
    this.controller.abort(this.closed);
    // Seal only: no new producers. Do not join, timeout-release, or treat zeros as settled.
    this.nativeOperationsScope?.seal();
  }
  private checkOpen(): void {
    if (!this.closed && this.elapsed() >= this.limits.wallTimeMs) this.close("DEADLINE");
    if (this.closed) throw this.closed;
  }

  private async createMessage(role: ModelBudgetRole, params: LLMCreateParams): Promise<LLMResponse> {
    this.checkOpen();
    // Finalization cannot be followed by a new unobserved provider dispatch.
    if (this.nativeOperationsScope?.snapshot().sealed) throw new ModelBudgetError("DISPOSED");
    if (params.signal?.aborted) { this.close("CANCELLED"); this.checkOpen(); }
    if (params.model !== this.model) throw new ModelBudgetError("MODEL_MISMATCH");
    if (!Number.isSafeInteger(params.max_tokens) || params.max_tokens <= 0) throw new ModelBudgetError("INVALID_REQUEST");
    if (this.ledger.length >= this.limits.maxAttempts) throw new ModelBudgetError("ATTEMPT_LIMIT");
    if (this.active >= this.limits.maxConcurrent) throw new ModelBudgetError("CONCURRENCY_LIMIT");
    if (this.observedInput >= BigInt(this.limits.maxObservedInputTokens)) throw new ModelBudgetError("INPUT_TOKEN_LIMIT");
    const available = BigInt(this.limits.maxObservedOutputTokens - this.reservedOutput) - this.observedOutput;
    if (available <= 0n) throw new ModelBudgetError("OUTPUT_TOKEN_LIMIT");
    const maxTokens = Math.min(params.max_tokens, this.limits.maxOutputTokensPerCall, Number(available));
    const request = boundedCopy({
      model: this.model, max_tokens: maxTokens, messages: params.messages,
      ...(params.system !== undefined ? { system: params.system } : {}),
      ...(params.tools !== undefined ? { tools: params.tools } : {}),
    }, Math.min(this.limits.maxInputBytesPerCall, this.limits.maxTotalInputBytes - this.requestBytes),
    "INVALID_REQUEST", "REQUEST_BYTES_LIMIT");
    if (!validRequest(request.value)) throw new ModelBudgetError("INVALID_REQUEST");
    this.checkOpen();
    // No await before all shared reservations and the ledger entry exist.
    const entry: ModelBudgetAttempt = {
      id: this.ledger.length + 1, role, requestInputBytes: request.bytes,
      requestedOutputTokens: maxTokens, responseBytes: null, responseBytesComplete: false,
      startedAfterMs: this.elapsed(), settledAfterMs: null,
      providerSettlement: "pending", usageStatus: "pending", outcome: "pending", reason: null,
      late: false, usage: readUsage(undefined),
    };
    this.ledger.push(entry);
    this.active++;
    this.peak = Math.max(this.peak, this.active);
    this.requestBytes += request.bytes;
    this.requestedOutput += maxTokens;
    this.reservedOutput += maxTokens;
    const nativeRec: NativeAttemptState = { instrumented: false, openProducers: 0, pendingOps: 0 };
    this.nativeAttempts.set(entry.id, nativeRec);
    const observer = this.nativeOperationsScope
      ? bindAttempt(this.nativeOperationsScope, nativeRec)
      : undefined;

    const callerSignal = params.signal;
    let abortRun: () => void = () => {};
    const aborted = new Promise<never>((_resolve, reject) => {
      abortRun = () => {
        if (entry.outcome === "pending") {
          entry.outcome = "rejected";
          entry.reason = this.closed?.code ?? "CANCELLED";
        }
        if (entry.providerSettlement === "pending") entry.usageStatus = "unknown";
        reject(this.closed ?? new ModelBudgetError("CANCELLED"));
      };
      this.signal.addEventListener("abort", abortRun, { once: true });
    });
    try {
      // Invoke exactly once, synchronously after reservation. Promise.resolve
      // also handles a fixture that throws synchronously or returns a thenable.
      let provider: Promise<LLMResponse>;
      try {
        const providerSignal = callerSignal ? AbortSignal.any([this.signal, callerSignal]) : this.signal;
        provider = Promise.resolve(this.client.createMessage({
          ...request.value,
          signal: providerSignal,
          disableRetries: true,
          max_response_bytes: this.limits.maxResponseBytesPerCall,
          ...(observer ? { [LLM_NATIVE_OPERATIONS]: observer } : {}),
        }));
      } catch {
        provider = Promise.reject(new ModelBudgetError("PROVIDER_ERROR"));
      }
      const settled = provider.then(
        (response) => this.receive(entry, response),
        () => {
          this.active--;
          entry.providerSettlement = "rejected";
          entry.settledAfterMs = this.elapsed();
          entry.usageStatus = "unknown";
          entry.late = entry.outcome === "rejected";
          throw this.reject(entry, "PROVIDER_ERROR");
        },
      );
      const response = await Promise.race([settled, aborted]);
      // A cancellation between provider settlement and this continuation wins.
      this.checkOpen();
      entry.outcome = "succeeded";
      return response;
    } finally {
      this.signal.removeEventListener("abort", abortRun);
    }
  }

  private reject(entry: ModelBudgetAttempt, code: ModelBudgetErrorCode): ModelBudgetError {
    if (entry.outcome === "pending") { entry.outcome = "rejected"; entry.reason = code; }
    this.close(code);
    return new ModelBudgetError(entry.reason ?? code);
  }

  private receive(entry: ModelBudgetAttempt, raw: unknown): LLMResponse {
    this.active--;
    entry.providerSettlement = "fulfilled";
    entry.settledAfterMs = this.elapsed();
    entry.late = entry.outcome === "rejected";
    entry.usage = readUsage(raw);
    const usage = entry.usage;
    this.observedInput += BigInt(usage.uncachedInputTokens ?? 0) + BigInt(usage.cacheReadInputTokens ?? 0) + BigInt(usage.cacheCreationInputTokens ?? 0);
    this.observedOutput += BigInt(usage.outputTokens ?? 0);
    entry.usageStatus = usage.inputTokens !== null && usage.outputTokens !== null ? "reported" : "unknown";
    if (entry.usageStatus === "reported") this.reservedOutput -= entry.requestedOutputTokens;
    if (this.closed) throw this.reject(entry, this.closed.code);
    if (entry.usageStatus === "unknown") throw this.reject(entry, "UNKNOWN_USAGE");
    if (this.observedInput > BigInt(this.limits.maxObservedInputTokens)) throw this.reject(entry, "INPUT_TOKEN_LIMIT");
    if (this.observedOutput > BigInt(this.limits.maxObservedOutputTokens) || (usage.outputTokens ?? 0) > entry.requestedOutputTokens) {
      throw this.reject(entry, "OUTPUT_TOKEN_LIMIT");
    }
    try {
      const bounded = boundedCopy(raw, this.limits.maxResponseBytesPerCall, "INVALID_RESPONSE", "RESPONSE_BYTES_LIMIT");
      entry.responseBytes = bounded.bytes;
      entry.responseBytesComplete = true;
      const copy = bounded.value;
      if (!isRecord(copy) || typeof copy.id !== "string" || !validContent(copy.content)
        || !["end_turn", "tool_use", "max_tokens", "stop_sequence", null].includes(copy.stop_reason as string | null)) {
        throw new ModelBudgetError("INVALID_RESPONSE");
      }
      this.checkOpen();
      return copy as unknown as LLMResponse;
    } catch (error) {
      if (error instanceof ModelBudgetError && error.code === "RESPONSE_BYTES_LIMIT") {
        entry.responseBytes = error.observedBytes ?? null;
      }
      throw this.reject(entry, error instanceof ModelBudgetError ? error.code : "INVALID_RESPONSE");
    }
  }
}

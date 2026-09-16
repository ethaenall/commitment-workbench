// SPDX-License-Identifier: AGPL-3.0-only

import {
  RefinementActivateRequest,
  RefinementApproveRequest,
  RefinementDetailResponse,
  RefinementDisableRequest,
  RefinementGetRequest,
  RefinementListRequest,
  RefinementListResponse,
  RefinementMutationResponse,
  RefinementProposeRequest,
  RefinementRollbackRequest,
  RefinementValidateRequest,
  RefinementValidationResponse,
  WorkflowRunRequest,
  WorkflowRunResult,
  WorkflowDescribeResponse,
} from "@habenula-ai/contracts";
import { ApiError, CONTROL_DEADLINE_MS, EngineUnavailableError, type FetchFn } from "./api-client";
import { requireUsableConfig, type Config } from "./config";
import { unauthorizedGuidance } from "./internal-client";
import { nodeFetch, ResponseSizeError } from "./transport";
import { renderUntrusted } from "./render/attribution";

// The workflow/validation engine ceiling is 300s; allow 10s to deliver its result.
// This bound does not change ordinary control or chat request deadlines.
export const GOVERNED_LONG_DEADLINE_MS = 310_000;
export const GOVERNED_RESPONSE_MAX_BYTES = 8 * 1024 * 1024;
// Prevent tiny/empty injected chunks from turning a byte cap into unbounded work.
export const GOVERNED_RESPONSE_MAX_READS = 65_536;
export const GOVERNED_RESPONSE_MAX_EMPTY_CHUNKS = 32;
export const GOVERNED_WAIT_NOTICE = "Timeout or Ctrl-C cannot retract inference already dispatched. No automatic retry.";

type Input<T> = Omit<T, "userId">;
export type RefinementProposal = Input<RefinementProposeRequest>;
export type RefinementListOptions = Input<RefinementListRequest>;

/** Narrow trusted-caller surface. No governance grants, MCP verbs or service actions. */
export interface RefinementDriver {
  describeWorkflow(): Promise<WorkflowDescribeResponse>;
  list(options?: RefinementListOptions): Promise<RefinementListResponse>;
  get(versionId: string): Promise<RefinementDetailResponse>;
  propose(input: RefinementProposal): Promise<RefinementDetailResponse>;
  validate(input: Input<RefinementValidateRequest>): Promise<RefinementValidationResponse>;
  approve(input: Input<RefinementApproveRequest>): Promise<RefinementMutationResponse>;
  activate(input: Input<RefinementActivateRequest>): Promise<RefinementMutationResponse>;
  disable(input: Input<RefinementDisableRequest>): Promise<RefinementMutationResponse>;
  rollback(input: Input<RefinementRollbackRequest>): Promise<RefinementMutationResponse>;
  runWorkflow(input: Input<WorkflowRunRequest>): Promise<WorkflowRunResult>;
}

interface Parser<T> {
  safeParse(value: unknown): { success: true; data: T } | { success: false };
}

/** Shared contracts validate new input and responses; old CLI clients are untouched. */
export class RefinementClient implements RefinementDriver {
  constructor(private readonly config: Config, private readonly fetchFn: FetchFn = nodeFetch) {}

  describeWorkflow(): Promise<WorkflowDescribeResponse> {
    return this.request(`/api/workflows?${new URLSearchParams({ userId: this.config.userId })}`, WorkflowDescribeResponse);
  }

  list(options: RefinementListOptions = {}): Promise<RefinementListResponse> {
    const input = this.input(RefinementListRequest, options);
    const params = new URLSearchParams({ userId: input.userId });
    if (input.scopeKey !== undefined) params.set("scopeKey", input.scopeKey);
    if (input.limit !== undefined) params.set("limit", String(input.limit));
    if (input.cursor !== undefined) params.set("cursor", input.cursor);
    return this.request(`/api/refinements?${params}`, RefinementListResponse);
  }

  get(versionId: string): Promise<RefinementDetailResponse> {
    const input = this.input(RefinementGetRequest, { versionId });
    return this.request(`/api/refinements/get?${new URLSearchParams(input)}`, RefinementDetailResponse);
  }

  propose(input: RefinementProposal): Promise<RefinementDetailResponse> {
    return this.request("/api/refinements/propose", RefinementDetailResponse,
      this.input(RefinementProposeRequest, input));
  }

  validate(input: Input<RefinementValidateRequest>): Promise<RefinementValidationResponse> {
    return this.request("/api/refinements/validate", RefinementValidationResponse,
      this.input(RefinementValidateRequest, input), GOVERNED_LONG_DEADLINE_MS);
  }

  approve(input: Input<RefinementApproveRequest>): Promise<RefinementMutationResponse> {
    return this.request("/api/refinements/approve", RefinementMutationResponse,
      this.input(RefinementApproveRequest, input));
  }

  activate(input: Input<RefinementActivateRequest>): Promise<RefinementMutationResponse> {
    return this.request("/api/refinements/activate", RefinementMutationResponse,
      this.input(RefinementActivateRequest, input));
  }

  disable(input: Input<RefinementDisableRequest>): Promise<RefinementMutationResponse> {
    return this.request("/api/refinements/disable", RefinementMutationResponse,
      this.input(RefinementDisableRequest, input));
  }

  rollback(input: Input<RefinementRollbackRequest>): Promise<RefinementMutationResponse> {
    return this.request("/api/refinements/rollback", RefinementMutationResponse,
      this.input(RefinementRollbackRequest, input));
  }

  runWorkflow(input: Input<WorkflowRunRequest>): Promise<WorkflowRunResult> {
    return this.request("/api/workflows/run", WorkflowRunResult,
      this.input(WorkflowRunRequest, input), GOVERNED_LONG_DEADLINE_MS);
  }

  private input<T>(schema: Parser<T>, value: object): T {
    // Config owns userId even if an untyped caller supplies a forged field.
    const result = schema.safeParse({ ...value, userId: this.config.userId });
    if (!result.success) throw new Error("Invalid governed-learning request; check the command inputs.");
    return result.data;
  }

  private async request<T>(path: string, schema: Parser<T>, body?: unknown,
    deadlineMs = CONTROL_DEADLINE_MS): Promise<T> {
    requireUsableConfig(this.config);
    const url = new URL(path, this.config.apiUrl);
    if (url.username || url.password || !["http:", "https:"].includes(url.protocol)) {
      throw new Error("Governed-learning API URL must be HTTP(S) without embedded credentials.");
    }
    if (this.config.internalTokenSource === "file" && !sameProvenLocalOrigin(
      url, new URL(this.config.internalMcpUrl ?? "/internal/mcp", this.config.apiUrl),
    )) {
      throw new ApiError(401, unauthorizedGuidance("withheld-remote"), "UNAUTHORIZED");
    }
    if (!this.config.internalToken) {
      throw new ApiError(401, unauthorizedGuidance(this.config.internalTokenSource), "UNAUTHORIZED");
    }
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, deadlineMs);
    let gotResponse = false;
    try {
      // nodeFetch never follows redirects. There is exactly one attempt, also on mutations.
      const res = await this.fetchFn(url.toString(), {
        method: body === undefined ? "GET" : "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json",
          Authorization: `Bearer ${this.config.internalToken}` },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
        maxResponseBytes: GOVERNED_RESPONSE_MAX_BYTES,
      });
      gotResponse = true;
      // Also enforce locally: an injected fetch may ignore the transport option.
      // Read error responses under the same bound, including auth and redirects.
      const text = await readBoundedResponse(res, controller.signal);
      if (res.status === 401) {
        throw new ApiError(401, unauthorizedGuidance(this.config.internalTokenSource), "UNAUTHORIZED");
      }
      if (!res.ok) {
        let message = `engine error (${res.status})`;
        let code: string | undefined;
        try {
          const error = JSON.parse(text) as { error?: unknown; error_code?: unknown };
          if (typeof error.error === "string") message = renderUntrusted(error.error, 400).text;
          if (typeof error.error_code === "string" && /^[A-Z0-9_]{1,80}$/.test(error.error_code)) code = error.error_code;
        } catch { /* A proxy page must not become terminal output. */ }
        throw new ApiError(res.status, message, code);
      }
      let data: unknown;
      try { data = JSON.parse(text); } catch {
        throw new ApiError(502, "Malformed governed-learning response; no result accepted.");
      }
      const result = schema.safeParse(data);
      if (!result.success) throw new ApiError(502, "Governed-learning response failed its contract; no result accepted.");
      return result.data;
    } catch (err) {
      if (err instanceof ApiError) throw err;
      if (err instanceof ResponseSizeError) {
        throw new ApiError(502, "Governed-learning response exceeds the 8 MiB limit; no result accepted.");
      }
      if (timedOut) throw new EngineUnavailableError(this.config.apiUrl, "deadline", err);
      if (!gotResponse) throw new EngineUnavailableError(this.config.apiUrl, "reject", err);
      throw err;
    } finally { clearTimeout(timer); }
  }
}


/** A hung injected stream must not defeat the existing request deadline. */
async function readWithAbort(reader: ReadableStreamDefaultReader<Uint8Array>, signal: AbortSignal): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (signal.aborted) throw signal.reason;
  let onAbort: () => void = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try { return await Promise.race([reader.read(), aborted]); }
  finally { signal.removeEventListener("abort", onAbort); }
}

/** Bounded exact UTF-8 decoding for native and injected transports alike. */
async function readBoundedResponse(res: Response, signal: AbortSignal): Promise<string> {
  if (signal.aborted) {
    void res.body?.cancel().catch(() => {});
    throw signal.reason;
  }
  if (!res.body) return "";
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try { reader = res.body.getReader(); }
  catch { throw new ApiError(502, "Governed-learning response body could not be read; no result accepted."); }
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const pieces: string[] = [];
  let bytes = 0;
  let emptyChunks = 0;
  let complete = false;
  try {
    for (let reads = 0; ; reads++) {
      if (reads >= GOVERNED_RESPONSE_MAX_READS) {
        throw new ApiError(502, "Governed-learning response exceeded the stream read limit; no result accepted.");
      }
      const chunk = await readWithAbort(reader, signal);
      if (chunk.done) { complete = true; break; }
      if (!(chunk.value instanceof Uint8Array)) {
        throw new ApiError(502, "Governed-learning response contains an invalid byte chunk; no result accepted.");
      }
      if (chunk.value.byteLength > GOVERNED_RESPONSE_MAX_BYTES - bytes) throw new ResponseSizeError();
      bytes += chunk.value.byteLength;
      if (chunk.value.byteLength === 0) {
        emptyChunks++;
        if (emptyChunks >= GOVERNED_RESPONSE_MAX_EMPTY_CHUNKS) {
          throw new ApiError(502, "Governed-learning response exceeded the empty-chunk limit; no result accepted.");
        }
        continue;
      }
      emptyChunks = 0;
      try { pieces.push(decoder.decode(chunk.value, { stream: true })); }
      catch { throw new ApiError(502, "Governed-learning response is not valid UTF-8; no result accepted."); }
    }
    try { pieces.push(decoder.decode()); }
    catch { throw new ApiError(502, "Governed-learning response is not valid UTF-8; no result accepted."); }
    return pieces.join("");
  } catch (err) {
    pieces.length = 0;
    if (signal.aborted || err instanceof ApiError || err instanceof ResponseSizeError) throw err;
    throw new ApiError(502, "Governed-learning response body could not be read; no result accepted.");
  } finally {
    // Do not await cancellation: an injected stream's cancel hook can itself
    // hang. Closing stops retention; any late read rejection is already handled.
    if (!complete) void reader.cancel().catch(() => {});
    try { reader.releaseLock(); } catch { /* A hostile pending read may still own it. */ }
  }
}

/** loadConfig already proved the file-token MCP origin; never widen it to an API override. */
function sameProvenLocalOrigin(target: URL, proven: URL): boolean {
  const loopback = new Set(["localhost", "127.0.0.1", "[::1]"]);
  return target.protocol === "http:" && proven.protocol === "http:"
    && !proven.username && !proven.password
    && loopback.has(target.hostname) && loopback.has(proven.hostname)
    && (target.port || "80") === (proven.port || "80");
}

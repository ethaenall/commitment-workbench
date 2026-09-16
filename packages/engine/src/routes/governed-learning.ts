// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/** Local token-holder controls, never model or MCP tools. No source acquisition. */
import { z } from "zod";
import {
  ErrorResponse, RefinementActivateRequest, RefinementApproveRequest,
  RefinementDetailResponse, RefinementDisableRequest, RefinementGetRequest,
  RefinementListRequest, RefinementListResponse, RefinementMutationResponse,
  RefinementProposeRequest, RefinementRollbackRequest, RefinementValidateRequest,
  RefinementValidationResponse, UserIdQuery, WorkflowDescribeResponse,
  WorkflowRunRequest, WorkflowRunResult,
} from "@habenula-ai/contracts";
import type { HabenulaEnv } from "../env";
import type { GovernedLearningErrorCode, GovernedLearningReply } from "../agent/user-agent";
import { respond } from "../respond";

export type GovernedLearningOperation = "list" | "get" | "propose" | "validate"
  | "approve" | "activate" | "disable" | "rollback" | "describe" | "run";

// Bounds apply to bytes read, not claimed Content-Length or UTF-16 characters.
export const REFINEMENT_REQUEST_MAX_BYTES = 64 * 1024;
export const WORKFLOW_REQUEST_MAX_BYTES = 1024 * 1024;
const BODY_TIMEOUT_MS = 5_000;
const MAX_BODY_READS = 4_096;

const ERRORS: Record<GovernedLearningErrorCode, { status: number; message: string }> = {
  GOVERNED_LEARNING_DISABLED: { status: 404, message: "Not found" },
  GOVERNED_LEARNING_UNAVAILABLE: { status: 503, message: "Governed learning is unavailable" },
  REFINEMENT_INVALID_REQUEST: { status: 400, message: "Invalid governed-learning request" },
  REFINEMENT_NOT_FOUND: { status: 404, message: "Refinement not found" },
  REFINEMENT_CONFLICT: { status: 409, message: "Refinement state changed; read it again" },
  REFINEMENT_INELIGIBLE: { status: 409, message: "Refinement is not eligible for this transition" },
  REFINEMENT_UNAVAILABLE: { status: 503, message: "Refinement control is unavailable" },
  REFINEMENT_CORRUPT: { status: 503, message: "Refinement control is unavailable" },
  REFINEMENT_CHANGED: { status: 409, message: "Refinement changed during this operation" },
  REFINEMENT_CAPACITY: { status: 409, message: "Refinement capacity reached" },
};

function failure(code: GovernedLearningErrorCode): Response {
  const fixed = ERRORS[code];
  return respond(ErrorResponse, { error: fixed.message, error_code: code }, fixed.status);
}

class BodyError extends Error {
  constructor(readonly tooLarge = false) { super("Invalid request body"); }
}

async function boundedJson(request: Request, maxBytes: number): Promise<unknown> {
  const length = request.headers.get("content-length");
  if (length !== null && /^\d+$/.test(length) && Number(length) > maxBytes) throw new BodyError(true);
  const encoding = request.headers.get("content-encoding");
  if (encoding !== null && encoding !== "identity") throw new BodyError();
  if (request.body === null) throw new BodyError();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let reads = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new BodyError()), BODY_TIMEOUT_MS);
  });
  try {
    for (;;) {
      if (++reads > MAX_BODY_READS) throw new BodyError();
      const { done, value } = await Promise.race([reader.read(), timeout]);
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new BodyError(true);
      // Keep no more than the fixed byte cap even if the stream's advertised
      // length is missing or false. The final copy is bounded by the same cap.
      if (value.byteLength > 0) chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes)) as unknown;
  } catch (error) {
    // Do not wait on a producer-controlled cancel promise.
    void reader.cancel().catch(() => undefined);
    throw error instanceof BodyError ? error : new BodyError();
  } finally {
    clearTimeout(timer);
    reader.releaseLock();
  }
}

/** Fail closed on a malformed service/RPC result too; respond() is log-and-pass. */
async function deliver<T>(schema: z.ZodType<T>, call: () => Promise<GovernedLearningReply<T>>): Promise<Response> {
  try {
    const reply = await call();
    if (!reply.ok) {
      return Object.hasOwn(ERRORS, reply.code) ? failure(reply.code) : failure("GOVERNED_LEARNING_UNAVAILABLE");
    }
    const checked = schema.safeParse(reply.value);
    if (!checked.success) return failure("GOVERNED_LEARNING_UNAVAILABLE");
    return respond(schema, checked.data);
  } catch {
    // RPC throws may have lost their custom properties and may contain SQL,
    // provider or source text. Only typed tagged replies carry known failures.
    return failure("GOVERNED_LEARNING_UNAVAILABLE");
  }
}

/** The caller supplies the SAME timing-safe token check used by /internal/mcp. */
export async function handleGovernedLearning(
  request: Request,
  env: HabenulaEnv,
  operation: GovernedLearningOperation,
  authorized: (request: Request, env: HabenulaEnv) => Promise<boolean>,
): Promise<Response> {
  if (env.GOVERNED_LEARNING !== "true") return respond(ErrorResponse, { error: "Not found" }, 404);
  // Before body/query parsing, owner lookup, or any state/existence disclosure.
  if (!(await authorized(request, env))) return respond(ErrorResponse, { error: "unauthorized" }, 401);

  try {
    const stub = (userId: string) => env.USER_AGENT.get(env.USER_AGENT.idFromName(userId));
    if (operation === "list" || operation === "get" || operation === "describe") {
      const params = new URL(request.url).searchParams;
      const query = Object.create(null) as Record<string, unknown>;
      for (const [key, value] of params) {
        if (Object.hasOwn(query, key)) return failure("REFINEMENT_INVALID_REQUEST");
        query[key] = key === "limit" && /^\d+$/.test(value) ? Number(value) : value;
      }
      if (operation === "describe") {
        if (Object.keys(query).some((key) => key !== "userId")) return failure("REFINEMENT_INVALID_REQUEST");
        const r = UserIdQuery.safeParse(query);
        if (!r.success) return failure("REFINEMENT_INVALID_REQUEST");
        return deliver(WorkflowDescribeResponse, () => stub(r.data.userId).describeWorkflows(r.data));
      }
      if (operation === "list") {
        const r = RefinementListRequest.safeParse(query);
        if (!r.success) return failure("REFINEMENT_INVALID_REQUEST");
        return deliver(RefinementListResponse, () => stub(r.data.userId).listRefinements(r.data));
      }
      const r = RefinementGetRequest.safeParse(query);
      if (!r.success) return failure("REFINEMENT_INVALID_REQUEST");
      return deliver(RefinementDetailResponse, () => stub(r.data.userId).getRefinement(r.data));
    }

    const body = await boundedJson(request, operation === "run" ? WORKFLOW_REQUEST_MAX_BYTES : REFINEMENT_REQUEST_MAX_BYTES);
    switch (operation) {
      case "propose": {
        const r = RefinementProposeRequest.safeParse(body);
        if (!r.success) return failure("REFINEMENT_INVALID_REQUEST");
        return deliver(RefinementDetailResponse, () => stub(r.data.userId).proposeRefinement(r.data));
      }
      case "validate": {
        const r = RefinementValidateRequest.safeParse(body);
        if (!r.success) return failure("REFINEMENT_INVALID_REQUEST");
        return deliver(RefinementValidationResponse, () => stub(r.data.userId).validateRefinement(r.data));
      }
      case "approve": {
        const r = RefinementApproveRequest.safeParse(body);
        if (!r.success) return failure("REFINEMENT_INVALID_REQUEST");
        return deliver(RefinementMutationResponse, () => stub(r.data.userId).approveRefinement(r.data));
      }
      case "activate": {
        const r = RefinementActivateRequest.safeParse(body);
        if (!r.success) return failure("REFINEMENT_INVALID_REQUEST");
        return deliver(RefinementMutationResponse, () => stub(r.data.userId).activateRefinement(r.data));
      }
      case "disable": {
        const r = RefinementDisableRequest.safeParse(body);
        if (!r.success) return failure("REFINEMENT_INVALID_REQUEST");
        return deliver(RefinementMutationResponse, () => stub(r.data.userId).disableRefinement(r.data));
      }
      case "rollback": {
        const r = RefinementRollbackRequest.safeParse(body);
        if (!r.success) return failure("REFINEMENT_INVALID_REQUEST");
        return deliver(RefinementMutationResponse, () => stub(r.data.userId).rollbackRefinement(r.data));
      }
      case "run": {
        const r = WorkflowRunRequest.safeParse(body);
        if (!r.success) return failure("REFINEMENT_INVALID_REQUEST");
        return deliver(WorkflowRunResult, () => stub(r.data.userId).runGovernedWorkflow(r.data));
      }
    }
  } catch (error) {
    if (error instanceof BodyError) {
      return error.tooLarge
        ? respond(ErrorResponse, { error: "Request body is too large", error_code: "REQUEST_TOO_LARGE" }, 413)
        : failure("REFINEMENT_INVALID_REQUEST");
    }
    return failure("GOVERNED_LEARNING_UNAVAILABLE");
  }
}

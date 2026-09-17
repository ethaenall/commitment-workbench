// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Shared RLM host ABI revision 3.
 * Not a public DTO. Not a wire document. Not production enablement.
 * Uses type-only imports of existing ModelBudget / LLM types. Do not fork those.
 */

import type { LLMCreateParams, LLMResponse } from "../llm/types.js";
import type { ModelBudget } from "./model-budget.js";

export const RLM_HOST_ABI = {
  revision: 3,
  id: "habenula-rlm-host-abi.v3",
} as const;

export const RLM_RUNTIME_ID = "habenula-rlm-coordinator.v0";

export type { LLMCreateParams, LLMResponse, ModelBudget };

export type RlmBudgetRole = "root" | "child";

/** One existing parent ModelBudget. Do not duplicate snapshot/createMessage shapes. */
export type RlmParentBudget = Pick<ModelBudget,
  "signal" | "clientFor" | "snapshot" | "nativeObservation" | "attemptNativeObservation" |
  "sealNativeOperations" | "joinNativeOperations">;

export interface RlmGuestEvent {
  id: string;
  kind: "root" | "llm" | "rlm";
  nodeId: string;
  parentId: string | null;
  depth: number;
  prompt: string;
  runId: string;
}

/** Actual Worker-host DATA producer v2; chars are measured at delivery. */
export interface RlmReadEvidenceSnapshot {
  version: 2;
  successfulSliceCount: number;
  successfulExecuteCount: number;
  slices: Array<RlmDeliveredSlice & { utf8Bytes: number }>;
  executes: Array<{ nodeId: string; parentId: string | null; depth: number; sourceSha256: string }>;
  coverageByNode: Array<{ nodeId: string; ranges: Array<{ start: number; end: number }> }>;
  truncated: boolean;
}

/** Normalized view of verified v2 evidence; missing is UNKNOWN. */
export interface RlmHostEvidenceSnapshot {
  reads: RlmDeliveredSlice[];
  executes: Array<{ nodeId: string; codeHash: string }>;
  truncated: boolean;
}

export interface RlmInspectSnapshot {
  exitSeen: boolean;
  pendingEvents: number;
  createdVMs?: number;
  liveVMs?: number;
  /** Missing means no host evidence was observed. */
  hostEvidence?: RlmHostEvidenceSnapshot;
  metrics?: Record<string, unknown>;
}

export interface RlmSessionReply {
  ok: boolean;
  status?: "complete" | "waiting" | "disposed";
  events?: RlmGuestEvent[];
  output?: string | null;
  error?: { code: string };
  inspect?: RlmInspectSnapshot;
  /** Bounded raw Worker metrics, including the actual v2 readEvidence. */
  metrics?: Record<string, unknown>;
}

/**
 * Release vs publication: unknown billing does not block resource release.
 * Uninstrumented native work quarantines. Provider HTTP 200 is not native SETTLED.
 */
export interface RlmNativeSettlementPort {
  optedIn: boolean;
  allInstrumentedAttemptsSettled(): boolean;
}

/**
 * Private RPC session. inspect and clearSettledEvent are awaitable.
 * publish(findings) accepts guest findings and returns that same string
 * (guest-output acceptance). It is not user-ledger publication.
 * terminate(reason) must preserve reason including "COMPLETE".
 * No deadlineMs field.
 */
export interface RlmSession {
  readonly id: string;
  init(): Promise<RlmSessionReply>;
  evaluate(source: string, input?: string): Promise<RlmSessionReply>;
  resolve(eventId: string, value: string): Promise<RlmSessionReply>;
  pump(): Promise<RlmSessionReply>;
  cancel(): Promise<unknown>;
  waitExit(): Promise<unknown>;
  terminate(reason: string): Promise<unknown>;
  inspect(): Promise<RlmInspectSnapshot>;
  publish(findings: string): Promise<string>;
  release(): Promise<unknown>;
  clearSettledEvent(eventId: string): Promise<void>;
}

export interface RlmTimingFields {
  taskLifetimeMs?: number;
  startupDeadlineMs?: number;
  commandSliceMs?: number;
  cumulativeCommandMs?: number;
}

export interface RlmOpenSessionRequest {
  ownerId: string;
  context: string;
  contextId: string;
  rootPrompt: null;
  limits?: Record<string, number>;
  timing?: RlmTimingFields;
}

export interface RlmBackendPort {
  open(request: RlmOpenSessionRequest): Promise<RlmSession>;
}

export interface RlmCodegenMetadata {
  snapshotId: string;
  snapshotHash: string;
  coverage: unknown;
  sourceIndex: unknown;
  contextId: string;
  rows: number;
  envelopeSha256: string;
  envelopeUtf8Bytes: number;
}

export type RlmCodeEnvelopeParse =
  | { kind: "code"; source: string }
  | { kind: "ordinary-json" }
  | { kind: "invalid" };

export interface RlmPromptPort {
  codegenSystem(): string;
  ledgerSystem(): string;
  codegenUser(meta: RlmCodegenMetadata, guidance: string | null): string;
  ledgerUser(meta: RlmCodegenMetadata, findings: string, guidance: string | null): string;
  ledgerUserFromTrustedSnapshot(meta: RlmCodegenMetadata, snapshot: unknown, findings: string, guidance: string | null): string;
  repairUser(meta: RlmCodegenMetadata, findings: string, issues: Array<{ code: string; path: string }>): string;
  repairUserFromTrustedSnapshot(meta: RlmCodegenMetadata, snapshot: unknown, findings: string, issues: Array<{ code: string; path: string }>): string;
  parseCodeEnvelope(text: string): RlmCodeEnvelopeParse;
}

export interface RlmDeliveredSlice {
  nodeId: string;
  start: number;
  count: number;
  returnedChars: number;
}

export interface RlmReadEvidencePort {
  deliveredSlices(): readonly RlmDeliveredSlice[];
  coversAllRows(totalRows: number): boolean;
}

export interface RlmTracePort {
  begin(args: { snapshotHash: string; contextHash: string; totalRows: number }): void;
  recordExecute(nodeId: string, codeHash: string): void;
  recordNode?(node: { id: string; parentId: string | null; depth: number }): void;
  recordSlice(slice: RlmDeliveredSlice): void;
  recordCall(args: {
    id: string;
    nodeId: string;
    parentCallId: string | null;
    inputTokens: number | null;
    outputTokens: number | null;
    outcome: "complete" | "blocked" | "error" | "cancelled" | "budget_exceeded";
  }): void;
  recordResult(nodeId: string, returnedChars: number): void;
  finish(outcome: "complete" | "blocked" | "error" | "cancelled" | "budget_exceeded"): unknown;
  truncated(): boolean;
  hasRootNode(): boolean;
  contextHash(): string | null;
}

export interface RlmContextCodecPort {
  encode(snapshot: unknown, sourceIndex: unknown): Promise<{
    context: string;
    contextId: string;
    contextHash: string;
    envelopeSha256: string;
    envelopeUtf8Bytes: number;
    rows: number;
  }>;
}

export interface RlmLedgerCheck {
  ok: boolean;
  report: { valid: boolean; issues: Array<{ code: string; path: string }> };
  value?: unknown;
}

export interface RlmRuntimeDependencies {
  backend: RlmBackendPort;
  prompts: RlmPromptPort;
  trace: RlmTracePort;
  codec: RlmContextCodecPort;
  hashSource(source: string): Promise<string>;
  validateLedger(snapshot: unknown, output: unknown): Promise<RlmLedgerCheck>;
  ownerId: string;
}

export type { LLMCreateParams as RlmCreateParams };
export type { LLMResponse as RlmModelResponse };

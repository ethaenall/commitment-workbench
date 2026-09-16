// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only
//
// Typed DATA wire and unaccepted production policy. Candidate only.
// Runtime values live in protocol.mjs. This file must not invent a host ABI,
// ModelBudget, NativeOperationScope, or session/Worker type.
// Coordinator owns rlm-host-types.ts. Containment owns timing-policy.mjs.
// Budget owns provider attempts. do-client / node-binding own HTTP wrapping.

export const PRIMITIVE_LIMITS = {
  depth: 2,
  calls: 5,
  liveVMs: 3,
  totalVMs: 8,
  interruptChecks: 1000,
  jobs: 1000,
  bridgeCalls: 1024,
  stackBytes: 262144,
  contextStoreBytes: 3 * 1024 * 1024,
  contextReads: 256,
  contextTransferBytes: 4 * 1024 * 1024,
  sliceRows: 64,
  sliceBytes: 20000,
  promptBytes: 4096,
  totalPromptBytes: 8192,
  responseBytes: 8192,
  totalResponseReservationBytes: 40960,
  sourceBytes: 32768,
  guestOutputBytes: 8192,
  totalGuestOutputBytes: 65536,
  maxRows: 16384,
  wireBytes: 65536,
  initWireBytes: 6 * 3 * 1024 * 1024 + 16384,
  commands: 1200,
} as const;

/** Lowering a ceiling changes its number, not its key set. */
export type Limits = { readonly [K in keyof typeof PRIMITIVE_LIMITS]: number };
export type LimitName = keyof Limits;

/** NEW unaccepted policy. Not spike defaults. Guest-event cap stays 5; 10 is not proposed. ModelBudget attempts are a different counter. */
export const PRODUCTION_POLICY = {
  status: "UNACCEPTED_NEW_POLICY",
  accepted: false,
  depth: 1,
  totalVMs: 4,
  liveVMs: 3,
  guestEventCap: 5,
  guestEventCapRaiseBlocked: true,
  primitiveGuestEventCap: 5,
  proposedGuestEventCap10: false,
  providerAttemptsField: null,
  notes: {
    initWireBytes: 18890752,
    ordinaryWireBytes: 65536,
    rootEvaluateSourceBytes: 32768,
    childResolveCodeBytes: 8192,
    contextStoreBytes: 3145728,
    rowBytes: 20000,
    contextReads: 256,
    providerAttemptsAreNotGuestEvents: true,
    liveVmAdmissionIsNotProviderAdmission: true,
  },
} as const;

export type RunId = string;
export type NodeId = `n${number}`;
export type EventId = `e${number}`;
export type ContextId = `sha256:${string}`;

export const BINDING_HEADERS = {
  owner: "x-habenula-owner",
  task: "x-habenula-task",
  session: "x-habenula-session",
} as const;

export const BINDING_OPS = ["open", "command", "init", "cancel", "settled", "inspect", "waitExit", "release", "terminate", "publish"] as const;
export const BINDING_TIMING_KEYS = [
  "taskLifetimeMs",
  "startupDeadlineMs",
  "commandSliceMs",
  "cumulativeCommandMs",
] as const;
export type BindingTiming = {
  taskLifetimeMs: number;
  startupDeadlineMs: number;
  commandSliceMs: number;
  cumulativeCommandMs: number;
};
export type BindingOp = (typeof BINDING_OPS)[number];
export const INNER_COMMAND_OPS = ["evaluate", "resolve", "pump", "dispose"] as const;
export type InnerCommandOp = (typeof INNER_COMMAND_OPS)[number];
export const WORKER_OPS = ["init", "evaluate", "resolve", "pump", "dispose"] as const;
export type WorkerOp = (typeof WORKER_OPS)[number];

export type BindingIdentity = {
  ownerId: string;
  taskId: string;
  sessionNonce: string;
};

interface WorkerHeader {
  v: 1;
  seq: number;
  runId: RunId;
}

export type WorkerCommand =
  | (WorkerHeader & {
      op: "init";
      contextId: ContextId;
      context: string;
      limits: Partial<Limits>;
      rootPrompt: string | null;
    })
  | (WorkerHeader & { op: "evaluate"; source: string; input: string })
  | (WorkerHeader & { op: "resolve"; eventId: EventId; value: string })
  | (WorkerHeader & { op: "pump" })
  | (WorkerHeader & { op: "dispose" });

export type InnerCommand =
  | { op: "evaluate"; source: string; input: string }
  | { op: "resolve"; eventId: EventId; value: string }
  | { op: "pump" }
  | { op: "dispose" };

export type BindingCommand =
  | (BindingIdentity & {
      op: "open";
      context: string;
      rootPrompt: string | null;
      limits?: Partial<Limits>;
      timing?: BindingTiming;
    })
  | (BindingIdentity & { op: "command"; runId: RunId; command: InnerCommand })
  | (BindingIdentity & { op: "init"; runId: RunId })
  | (BindingIdentity & { op: "cancel"; runId: RunId })
  | (BindingIdentity & { op: "settled"; runId: RunId; eventId: EventId })
  | (BindingIdentity & { op: "inspect"; runId: RunId })
  | (BindingIdentity & { op: "waitExit"; runId: RunId })
  | (BindingIdentity & { op: "release"; runId: RunId })
  | (BindingIdentity & { op: "terminate"; runId: RunId; reason: string })
  | (BindingIdentity & { op: "publish"; runId: RunId; findings: string });

export type HostModelEvent = {
  id: EventId;
  kind: "root" | "rlm" | "llm";
  runId: RunId;
  nodeId: NodeId;
  parentId: NodeId | null;
  depth: number;
  prompt: string;
};

import type { RlmReadEvidenceSnapshot } from "../workflows/rlm-host-types.js";

export type WorkerMetrics = {
  readEvidence?: RlmReadEvidenceSnapshot | null;
  moduleInitializations: 1;
  memoryInstances: 1;
  memoryImportCount: 1;
  memoryIdentity: boolean;
  wasmBytes: number;
  maximumWasmBytes: 33554432;
  liveVMs: number;
  createdVMs: number;
  disposedVMs: number;
  peakLiveVMs: number;
  peakGeneratedExecutionDepth: number;
  calls: number;
  nodes: number;
  maxDepth: number;
  bridgeCalls: number;
  interruptChecks: number;
  jobs: number;
  contextReads: number;
  contextTransferBytes: number;
  promptBytes: number;
  responseReservationBytes: number;
  guestOutputBytes: number;
  pendingEvents: number;
  cleanupFailures: number;
  nodesSeen: Array<{
    id: NodeId;
    parentId: NodeId | null;
    depth: number;
    memoryId: "memory-1";
    moduleId: 1;
  }>;
};

export type WorkerReply =
  | {
      v: 1;
      seq: number;
      ok: true;
      status: "waiting" | "complete" | "disposed";
      events: HostModelEvent[];
      output: string | null;
      metrics: WorkerMetrics;
    }
  | {
      v: 1;
      seq: number;
      ok: false;
      error: { code: string };
      events: [];
      output: null;
      metrics?: WorkerMetrics;
    };

export type WorkerReady = {
  v: 1;
  kind: "ready";
  envEmpty: boolean;
  metrics: WorkerMetrics;
};

/**
 * Outer binding HTTP JSON. Extra fields are node-binding/do-client owned.
 * pendingEvents missing or null is UNKNOWN, never 0.
 * protocol.mjs does not encode this envelope; it only types the DATA contract.
 */
export type BindingReply = {
  ok: boolean;
  runId?: RunId;
  reply?: WorkerReply;
  result?: unknown;
  inspect?: {
    exitSeen?: boolean;
    pendingEvents?: number | null;
    [key: string]: unknown;
  };
  error?: { code: string };
  lease?: unknown;
  openFailureCleanup?: unknown;
};

export type WireCode =
  | "PROTOCOL"
  | "STRING_REQUIRED"
  | "BYTE_LIMIT"
  | "WIRE_BYTES"
  | "NUL_REJECTED"
  | "SURROGATE_REJECTED"
  | "INVALID_RANGE"
  | "INVALID_LIMIT"
  | "HOST_OBJECT"
  | "SEQUENCE"
  | "IDENTITY_REQUIRED"
  | "IDENTITY_MISMATCH"
  | "CONTEXT_STORE_BYTES"
  | "PROMPT_BYTES"
  | "SOURCE_BYTES"
  | "INPUT_BYTES"
  | "RESPONSE_BYTES"
  | "OUTPUT_BYTES"
  | "BACKEND_FAILURE";

export const WIRE_OWNED_CODES = [
  "PROTOCOL",
  "STRING_REQUIRED",
  "BYTE_LIMIT",
  "WIRE_BYTES",
  "NUL_REJECTED",
  "SURROGATE_REJECTED",
  "INVALID_RANGE",
  "INVALID_LIMIT",
  "HOST_OBJECT",
  "SEQUENCE",
  "IDENTITY_REQUIRED",
  "IDENTITY_MISMATCH",
  "CONTEXT_STORE_BYTES",
  "PROMPT_BYTES",
  "SOURCE_BYTES",
  "INPUT_BYTES",
  "RESPONSE_BYTES",
  "OUTPUT_BYTES",
  "BACKEND_FAILURE",
] as const satisfies readonly WireCode[];

export function capForWorkerOp(op: WorkerOp): number {
  return op === "init" ? PRIMITIVE_LIMITS.initWireBytes : PRIMITIVE_LIMITS.wireBytes;
}

export function capForBindingOp(op: BindingOp): number {
  return op === "open" ? PRIMITIVE_LIMITS.initWireBytes : PRIMITIVE_LIMITS.wireBytes;
}

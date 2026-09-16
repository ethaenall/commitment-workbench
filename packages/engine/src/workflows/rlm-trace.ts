// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Bounded host trace/coverage collector. Publishes WorkflowAnalysisTrace only.
 * Implements coordinator RlmTracePort. Not a public DTO. Not contract-schema.
 * Task-local collector. Runtime integration does not imply production acceptance.
 *
 * Rules:
 * - codeHash is the actual SHA-256 of generated UTF-8 source (caller-supplied 64-hex).
 * - call.id is the actual ModelBudget attempt identity string, not a guest event id.
 * - one root, depth 1, max 3 children.
 * - successful read union from delivered slices only.
 * - operations[].sourceIds stays []: NDJSON rows are envelope fragments, not mail ids.
 * - all-rows-read is access, not semantic completeness.
 * - 64-op bound is honest: omitted required proof never yields outcome complete.
 */

import { WorkflowAnalysisTrace, WORKFLOW_BOUNDS } from "@habenula-ai/contracts";
import type { RlmDeliveredSlice, RlmTracePort } from "./rlm-host-types.js";

export type RlmTraceOutcome = "complete" | "blocked" | "error" | "cancelled" | "budget_exceeded";

export const RLM_TRACE_LIMITS = Object.freeze({
  schemaVersion: 1 as const,
  maxDepth: 1,
  maxCalls: 10,
  maxOperations: 64,
  maxReturnedChars: WORKFLOW_BOUNDS.totalBodyChars,
  maxChildren: 3,
  maxNodes: 16,
  maxCallRows: 32,
  maxRows: 16_384,
});

const IDENTIFIER = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const HASH64 = /^[a-f0-9]{64}$/;
const OUTCOMES = new Set<RlmTraceOutcome>(["complete", "blocked", "error", "cancelled", "budget_exceeded"]);

export function rlmTraceCallId(attemptId: number): string {
  if (!Number.isSafeInteger(attemptId) || attemptId < 1) {
    throw new Error("INVALID_ATTEMPT_ID");
  }
  return `a${attemptId}`;
}

export async function hashGeneratedSource(source: string): Promise<string> {
  if (typeof source !== "string" || !source.isWellFormed()) {
    throw new Error("UNHASHABLE_SOURCE");
  }
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(source));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function validId(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 80 && IDENTIFIER.test(value);
}

function validHash(value: unknown): value is string {
  return typeof value === "string" && HASH64.test(value);
}

function validToken(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isSafeInteger(value) && value >= 0);
}

function validChars(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export interface RlmTraceHostView {
  canAcceptComplete(): boolean;
  missingRequiredProof(): readonly string[];
  allRowsAccessed(): boolean;
  publishedOperationCount(): number;
  publishedCallCount(): number;
}

export function createRlmTraceCollector(): RlmTracePort & RlmTraceHostView {
  let begun = false;
  let truncated = false;
  let snapshotHash: string | null = null;
  let contextHashValue: string | null = null;
  let totalRows = 0;
  let opSeq = 0;
  const nodes: Array<{ id: string; parentId: string | null; depth: number }> = [];
  const nodeIds = new Set<string>();
  const childIds: string[] = [];
  const calls: Array<{
    id: string; nodeId: string; parentCallId: string | null;
    inputTokens: number | null; outputTokens: number | null; outcome: RlmTraceOutcome;
  }> = [];
  const callIds = new Set<string>();
  const operations: Array<{
    id: string; nodeId: string; kind: "slice" | "transform" | "execute" | "model_query" | "result";
    codeHash: string | null; outcome: RlmTraceOutcome; returnedChars: number; sourceIds: string[];
  }> = [];
  const delivered = new Set<number>();
  let executePublished = false;

  function markTruncated(): void {
    truncated = true;
  }

  function ensureRoot(): void {
    if (nodeIds.has("n0")) return;
    nodes.push({ id: "n0", parentId: null, depth: 0 });
    nodeIds.add("n0");
  }

  function ensureNode(nodeId: string): boolean {
    if (!validId(nodeId)) {
      markTruncated();
      return false;
    }
    if (nodeIds.has(nodeId)) return true;
    if (nodeId === "n0") {
      ensureRoot();
      return true;
    }
    if (childIds.length >= RLM_TRACE_LIMITS.maxChildren || nodes.length >= RLM_TRACE_LIMITS.maxNodes) {
      markTruncated();
      return false;
    }
    nodes.push({ id: nodeId, parentId: "n0", depth: 1 });
    nodeIds.add(nodeId);
    childIds.push(nodeId);
    return true;
  }

  function nextOpId(): string | null {
    if (operations.length >= RLM_TRACE_LIMITS.maxOperations) {
      markTruncated();
      return null;
    }
    opSeq += 1;
    return `o${opSeq}`;
  }

  function allRowsAccessed(): boolean {
    return begun && totalRows >= 1 && delivered.size === totalRows;
  }

  function missingRequiredProof(): string[] {
    const missing: string[] = [];
    if (!begun || snapshotHash === null) missing.push("NOT_BEGUN");
    if (contextHashValue === null) missing.push("CONTEXT_HASH");
    if (!nodeIds.has("n0")) missing.push("ROOT_NODE");
    if (!executePublished) missing.push("EXECUTE_HASH");
    if (!allRowsAccessed()) missing.push("ROW_COVERAGE");
    if (truncated) missing.push("TRUNCATED");
    if (calls.length > RLM_TRACE_LIMITS.maxCalls) missing.push("CALL_CAP");
    return missing;
  }

  function canAcceptComplete(): boolean {
    return missingRequiredProof().length === 0;
  }

  const port: RlmTracePort & RlmTraceHostView = {
    begin(args: { snapshotHash: string; contextHash: string; totalRows: number }): void {
      if (begun) {
        markTruncated();
        return;
      }
      if (!validHash(args.snapshotHash) || !validHash(args.contextHash)) return;
      if (!Number.isSafeInteger(args.totalRows) || args.totalRows < 1 || args.totalRows > RLM_TRACE_LIMITS.maxRows) {
        return;
      }
      snapshotHash = args.snapshotHash;
      contextHashValue = args.contextHash;
      totalRows = args.totalRows;
      begun = true;
      ensureRoot();
    },

    recordNode(node: { id: string; parentId: string | null; depth: number }): void {
      if (!begun || !validId(node.id) || !Number.isSafeInteger(node.depth) || node.depth < 0 || node.depth > RLM_TRACE_LIMITS.maxDepth) {
        markTruncated(); return;
      }
      const existing = nodes.find((entry) => entry.id === node.id);
      if (existing) {
        if (existing.parentId !== node.parentId || existing.depth !== node.depth) markTruncated();
        return;
      }
      const parent = nodes.find((entry) => entry.id === node.parentId);
      if (node.id === "n0" || !parent || node.depth !== parent.depth + 1 || childIds.length >= RLM_TRACE_LIMITS.maxChildren || nodes.length >= RLM_TRACE_LIMITS.maxNodes) {
        markTruncated(); return;
      }
      nodes.push({ ...node }); nodeIds.add(node.id); childIds.push(node.id);
    },

    recordExecute(nodeId: string, codeHash: string): void {
      if (!begun) {
        markTruncated();
        return;
      }
      if (!ensureNode(nodeId) || !validHash(codeHash)) {
        markTruncated();
        return;
      }
      const id = nextOpId();
      if (id === null) return;
      operations.push({
        id, nodeId, kind: "execute", codeHash, outcome: "complete",
        returnedChars: 0, sourceIds: [],
      });
      executePublished = true;
    },

    recordSlice(slice: RlmDeliveredSlice): void {
      if (!begun) {
        markTruncated();
        return;
      }
      if (!ensureNode(slice.nodeId)) return;
      const start = slice.start;
      const count = slice.count;
      const returnedChars = slice.returnedChars;
      if (!Number.isSafeInteger(start) || start < 0) {
        markTruncated();
        return;
      }
      if (!Number.isSafeInteger(count) || count < 1) {
        markTruncated();
        return;
      }
      if (start + count > totalRows || !Number.isSafeInteger(start + count)) {
        markTruncated();
        return;
      }
      if (!validChars(returnedChars)) {
        markTruncated();
        return;
      }
      if (returnedChars > RLM_TRACE_LIMITS.maxReturnedChars) {
        markTruncated();
        return;
      }
      for (let i = 0; i < count; i++) delivered.add(start + i);
      const id = nextOpId();
      if (id === null) return;
      operations.push({
        id, nodeId: slice.nodeId, kind: "slice", codeHash: null, outcome: "complete",
        returnedChars, sourceIds: [],
      });
    },

    recordCall(args: {
      id: string;
      nodeId: string;
      parentCallId: string | null;
      inputTokens: number | null;
      outputTokens: number | null;
      outcome: RlmTraceOutcome;
    }): void {
      if (!begun) {
        markTruncated();
        return;
      }
      if (!validId(args.id) || callIds.has(args.id)) {
        markTruncated();
        return;
      }
      if (!ensureNode(args.nodeId)) return;
      if (args.parentCallId !== null && (!validId(args.parentCallId) || !callIds.has(args.parentCallId))) {
        markTruncated();
        return;
      }
      if (!validToken(args.inputTokens) || !validToken(args.outputTokens)) {
        markTruncated();
        return;
      }
      if (!OUTCOMES.has(args.outcome)) {
        markTruncated();
        return;
      }
      if (calls.length >= RLM_TRACE_LIMITS.maxCalls || calls.length >= RLM_TRACE_LIMITS.maxCallRows) {
        markTruncated();
        return;
      }
      calls.push({
        id: args.id,
        nodeId: args.nodeId,
        parentCallId: args.parentCallId,
        inputTokens: args.inputTokens,
        outputTokens: args.outputTokens,
        outcome: args.outcome,
      });
      callIds.add(args.id);
    },

    recordResult(nodeId: string, returnedChars: number): void {
      if (!begun) {
        markTruncated();
        return;
      }
      if (!ensureNode(nodeId) || !validChars(returnedChars)) {
        markTruncated();
        return;
      }
      if (returnedChars > RLM_TRACE_LIMITS.maxReturnedChars) {
        markTruncated();
        return;
      }
      const id = nextOpId();
      if (id === null) return;
      operations.push({
        id, nodeId, kind: "result", codeHash: null, outcome: "complete",
        returnedChars, sourceIds: [],
      });
    },

    finish(outcome: RlmTraceOutcome): unknown {
      if (!OUTCOMES.has(outcome)) outcome = "error";
      let published: RlmTraceOutcome = outcome;
      if (published === "complete" && !canAcceptComplete()) published = "error";
      if (!begun || snapshotHash === null) {
        throw new Error("TRACE_NOT_BEGUN");
      }
      const trace = {
        schemaVersion: 1 as const,
        snapshotHash,
        contextHash: contextHashValue,
        outcome: published,
        limits: {
          maxDepth: RLM_TRACE_LIMITS.maxDepth,
          maxCalls: RLM_TRACE_LIMITS.maxCalls,
          maxOperations: RLM_TRACE_LIMITS.maxOperations,
          maxReturnedChars: RLM_TRACE_LIMITS.maxReturnedChars,
        },
        nodes: nodes.map((node) => ({ ...node })),
        calls: calls.map((call) => ({ ...call })),
        operations: operations.map((operation) => ({
          ...operation,
          sourceIds: [...operation.sourceIds],
        })),
        truncated,
      };
      return WorkflowAnalysisTrace.parse(trace);
    },

    truncated: () => truncated,
    hasRootNode: () => nodeIds.has("n0"),
    contextHash: () => contextHashValue,
    canAcceptComplete,
    missingRequiredProof: () => Object.freeze([...missingRequiredProof()]),
    allRowsAccessed,
    publishedOperationCount: () => operations.length,
    publishedCallCount: () => calls.length,
  };

  return port;
}

// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from "zod";
import { userIdField } from "./requests/common.js";

export const COMMITMENT_WORKFLOW_ID = "mail.commitment-handoff.v1" as const;
export const COMMITMENT_SCHEMA_VERSION = 1 as const;
export const WORKFLOW_BOUNDS = Object.freeze({
  messages: 32,
  bodyChars: 12_000,
  totalBodyChars: 96_000,
  ledgerItems: 12,
  evidencePerItem: 6,
  quoteChars: 1_000,
  replyChars: 1_200,
  issues: 64,
});

// Exact, well-formed UTF-16 strings. Do not trim/normalize source before hashing.
function text(max: number, min = 0) {
  return z.string().min(min).max(max).refine((s) => s.isWellFormed(), {
    message: "Text contains an unpaired UTF-16 surrogate",
  });
}
const identifier = z.string().min(1).max(80).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const timestamp = z.iso.datetime({ offset: true }).refine(
  (s) => Number.isFinite(Date.parse(s)),
  "Timestamp must be a real instant with an explicit offset",
);
const nonBlank = (max: number) => text(max, 1).refine((s) => s.trim().length > 0);

export const WorkflowMode = z.enum(["baseline", "refinements", "rlm", "both"]);
export type WorkflowMode = z.infer<typeof WorkflowMode>;

export const CommitmentMessage = z.strictObject({
  id: identifier,
  threadId: identifier,
  subject: text(240),
  sender: nonBlank(320),
  to: text(640),
  timestamp,
  body: text(WORKFLOW_BOUNDS.bodyChars),
  bodyHash: hash,
  truncated: z.boolean(),
  // Exact omitted UTF-16 unit count when known; null means unknown, not zero.
  omittedChars: z.number().int().min(0).max(100_000_000).nullable(),
}).superRefine((m, ctx) => {
  if ((!m.truncated && m.omittedChars !== 0) || (m.truncated && m.omittedChars === 0)) {
    ctx.addIssue({ code: "custom", path: ["omittedChars"], message: "Truncation and omittedChars disagree" });
  }
});
export type CommitmentMessage = z.infer<typeof CommitmentMessage>;

export const CommitmentSnapshot = z.strictObject({
  workflowId: z.literal(COMMITMENT_WORKFLOW_ID),
  schemaVersion: z.literal(COMMITMENT_SCHEMA_VERSION),
  snapshotId: identifier,
  snapshotHash: hash,
  userAddress: text(254, 3).refine((s) => /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(s), "Expected a bare email address"),
  cutoff: timestamp,
  timezone: nonBlank(80),
  coverage: z.strictObject({
    scope: z.literal("supplied-snapshot"),
    source: z.enum(["synthetic-fixture", "user-supplied"]),
    omittedMessages: z.number().int().min(0).max(1_000_000).nullable(),
    note: text(500),
  }),
  messages: z.array(CommitmentMessage).max(WORKFLOW_BOUNDS.messages),
}).superRefine((s, ctx) => {
  if (s.messages.reduce((sum, m) => sum + m.body.length, 0) > WORKFLOW_BOUNDS.totalBodyChars) {
    ctx.addIssue({ code: "custom", path: ["messages"], message: "Total body size exceeds the snapshot bound" });
  }
  const ids = new Set<string>();
  for (const [index, message] of s.messages.entries()) {
    if (ids.has(message.id)) ctx.addIssue({ code: "custom", path: ["messages", index, "id"], message: "Duplicate message id" });
    ids.add(message.id);
    if (Date.parse(message.timestamp) > Date.parse(s.cutoff)) {
      ctx.addIssue({ code: "custom", path: ["messages", index, "timestamp"], message: "Message is after the snapshot cutoff" });
    }
  }
});
export type CommitmentSnapshot = z.infer<typeof CommitmentSnapshot>;

/** UTF-16 half-open [start,end), bound to the exact decoded source body. */
export const CommitmentEvidence = z.strictObject({
  messageId: identifier,
  bodyHash: hash,
  start: z.number().int().min(0).max(WORKFLOW_BOUNDS.bodyChars),
  end: z.number().int().min(1).max(WORKFLOW_BOUNDS.bodyChars),
  quote: text(WORKFLOW_BOUNDS.quoteChars, 1),
}).superRefine((e, ctx) => {
  if (e.end <= e.start) ctx.addIssue({ code: "custom", path: ["end"], message: "Evidence span must be nonempty" });
});
export type CommitmentEvidence = z.infer<typeof CommitmentEvidence>;

export const CommitmentItem = z.strictObject({
  itemId: identifier,
  title: nonBlank(160),
  owner: nonBlank(320).nullable(),
  state: z.enum(["due", "waiting", "closed", "uncertain"]),
  dueAt: timestamp.nullable(),
  changed: z.boolean(),
  evidence: z.array(CommitmentEvidence).min(1).max(WORKFLOW_BOUNDS.evidencePerItem),
  priorEvidence: z.array(CommitmentEvidence).max(WORKFLOW_BOUNDS.evidencePerItem),
  uncertainty: nonBlank(500).nullable(),
  nextAction: nonBlank(500),
  // Text only. No recipient envelope, send operation, draft id, or tool params.
  replyText: nonBlank(WORKFLOW_BOUNDS.replyChars).nullable(),
}).superRefine((item, ctx) => {
  if ((item.state === "uncertain" || item.owner === null) && item.uncertainty === null) {
    ctx.addIssue({ code: "custom", path: ["uncertainty"], message: "Unknown state/owner needs an explicit explanation" });
  }
  if (item.changed && item.priorEvidence.length === 0) {
    ctx.addIssue({ code: "custom", path: ["priorEvidence"], message: "An asserted change needs prior evidence" });
  }
});
export type CommitmentItem = z.infer<typeof CommitmentItem>;

export const CommitmentLedger = z.strictObject({
  workflowId: z.literal(COMMITMENT_WORKFLOW_ID),
  snapshotId: identifier,
  snapshotHash: hash,
  items: z.array(CommitmentItem).max(WORKFLOW_BOUNDS.ledgerItems),
  coverage: z.strictObject({
    scope: z.literal("supplied-snapshot"),
    omittedMessages: z.number().int().min(0).max(1_000_000).nullable(),
    truncatedMessageIds: z.array(identifier).max(WORKFLOW_BOUNDS.messages),
    limitations: z.array(nonBlank(500)).max(12),
  }),
}).superRefine((ledger, ctx) => {
  const ids = new Set<string>();
  for (const [index, item] of ledger.items.entries()) {
    if (ids.has(item.itemId)) ctx.addIssue({ code: "custom", path: ["items", index, "itemId"], message: "Duplicate item id" });
    ids.add(item.itemId);
  }
  if (new Set(ledger.coverage.truncatedMessageIds).size !== ledger.coverage.truncatedMessageIds.length) {
    ctx.addIssue({ code: "custom", path: ["coverage", "truncatedMessageIds"], message: "Duplicate truncated message id" });
  }
});
export type CommitmentLedger = z.infer<typeof CommitmentLedger>;

export const WorkflowValidationIssue = z.strictObject({
  code: identifier,
  path: text(300),
  message: text(500, 1),
});
export type WorkflowValidationIssue = z.infer<typeof WorkflowValidationIssue>;
export const WorkflowValidationReport = z.strictObject({
  level: z.literal("contract-only"),
  valid: z.boolean(),
  semanticVerified: z.literal(false),
  issues: z.array(WorkflowValidationIssue).max(WORKFLOW_BOUNDS.issues),
}).superRefine((r, ctx) => {
  if (r.valid !== (r.issues.length === 0)) ctx.addIssue({ code: "custom", path: ["valid"], message: "Validity and issues disagree" });
});
export type WorkflowValidationReport = z.infer<typeof WorkflowValidationReport>;

export const WorkflowUsage = z.strictObject({
  kind: z.enum(["synthetic", "provider-reported", "unknown"]),
  inputTokens: z.number().int().min(0).nullable(),
  outputTokens: z.number().int().min(0).nullable(),
  rootCalls: z.number().int().min(0),
  childCalls: z.number().int().min(0),
  complete: z.boolean(),
}).superRefine((u, ctx) => {
  if (u.complete && (u.inputTokens === null || u.outputTokens === null || u.kind === "unknown")) {
    ctx.addIssue({ code: "custom", path: ["complete"], message: "Unknown usage cannot be complete" });
  }
});
export type WorkflowUsage = z.infer<typeof WorkflowUsage>;

/** Host-owned discovery metadata. No source bodies, oracles, or model settings. */
export const WorkflowDescribeResponse = z.strictObject({
  workflowId: z.literal(COMMITMENT_WORKFLOW_ID),
  workflowContractHash: hash,
  schemaVersion: z.literal(COMMITMENT_SCHEMA_VERSION),
  supportedModes: z.array(WorkflowMode).min(1).max(4),
  fixtures: z.array(z.strictObject({
    id: identifier,
    title: nonBlank(160),
    split: z.enum(["learning", "validation"]),
  })).max(64),
}).superRefine((description, ctx) => {
  if (new Set(description.supportedModes).size !== description.supportedModes.length) {
    ctx.addIssue({ code: "custom", path: ["supportedModes"], message: "Duplicate supported mode" });
  }
  if (new Set(description.fixtures.map((fixture) => fixture.id)).size !== description.fixtures.length) {
    ctx.addIssue({ code: "custom", path: ["fixtures"], message: "Duplicate fixture id" });
  }
});
export type WorkflowDescribeResponse = z.infer<typeof WorkflowDescribeResponse>;

export const WorkflowRunRequest = z.strictObject({
  userId: userIdField,
  workflowId: z.literal(COMMITMENT_WORKFLOW_ID).default(COMMITMENT_WORKFLOW_ID),
  mode: WorkflowMode.default("baseline"),
  fixtureId: identifier.optional(),
  snapshot: CommitmentSnapshot.optional(),
}).superRefine((request, ctx) => {
  if ((request.fixtureId === undefined) === (request.snapshot === undefined)) {
    ctx.addIssue({ code: "custom", path: ["snapshot"], message: "Provide exactly one of fixtureId or snapshot" });
  }
});
export type WorkflowRunRequest = z.infer<typeof WorkflowRunRequest>;

/** Optional host-produced trace. Bounded identifiers/hashes, never raw code/HTML.
 * This reserves a result extension; it does not prove an RLM runtime ran safely. */
const analysisOutcome = z.enum(["complete", "blocked", "error", "cancelled", "budget_exceeded"]);
export const WorkflowAnalysisTrace = z.strictObject({
  schemaVersion: z.literal(1),
  snapshotHash: hash,
  contextHash: hash.nullable(),
  outcome: analysisOutcome,
  limits: z.strictObject({
    maxDepth: z.number().int().min(0).max(8),
    maxCalls: z.number().int().min(0).max(32),
    maxOperations: z.number().int().min(0).max(64),
    maxReturnedChars: z.number().int().min(0).max(WORKFLOW_BOUNDS.totalBodyChars),
  }),
  nodes: z.array(z.strictObject({
    id: identifier, parentId: identifier.nullable(), depth: z.number().int().min(0).max(8),
  })).max(16),
  calls: z.array(z.strictObject({
    id: identifier, nodeId: identifier, parentCallId: identifier.nullable(),
    inputTokens: z.number().int().min(0).nullable(), outputTokens: z.number().int().min(0).nullable(),
    outcome: analysisOutcome,
  })).max(32),
  operations: z.array(z.strictObject({
    id: identifier, nodeId: identifier,
    kind: z.enum(["slice", "transform", "execute", "model_query", "result"]),
    codeHash: hash.nullable(), outcome: analysisOutcome,
    returnedChars: z.number().int().min(0).max(WORKFLOW_BOUNDS.totalBodyChars),
    sourceIds: z.array(identifier).max(WORKFLOW_BOUNDS.messages),
  })).max(64),
  truncated: z.boolean(),
}).superRefine((trace, ctx) => {
  const bad = (path: string, message: string) => ctx.addIssue({ code: "custom", path: [path], message });
  if (trace.outcome === "complete" && (trace.contextHash === null || trace.nodes.length === 0)) bad("contextHash", "A complete trace needs context identity and a root node");
  const nodes = new Map(trace.nodes.map((node) => [node.id, node]));
  if (nodes.size !== trace.nodes.length) bad("nodes", "Duplicate analysis node id");
  if (trace.nodes.length > 0 && trace.nodes.filter((node) => node.parentId === null).length !== 1) bad("nodes", "Trace needs one root node");
  for (const node of trace.nodes) {
    if (node.parentId === null ? node.depth !== 0 : nodes.get(node.parentId)?.depth !== node.depth - 1) bad("nodes", "Invalid node parent/depth lineage");
  }
  const seenCalls = new Set<string>();
  for (const call of trace.calls) {
    if (!nodes.has(call.nodeId) || seenCalls.has(call.id) || (call.parentCallId !== null && !seenCalls.has(call.parentCallId))) bad("calls", "Invalid call lineage/order");
    seenCalls.add(call.id);
  }
  const seenOperations = new Set<string>();
  for (const operation of trace.operations) {
    if (!nodes.has(operation.nodeId) || seenOperations.has(operation.id)) bad("operations", "Invalid operation node/id");
    seenOperations.add(operation.id);
  }
});
export type WorkflowAnalysisTrace = z.infer<typeof WorkflowAnalysisTrace>;

export const WorkflowRunResult = z.strictObject({
  runId: identifier,
  workflowId: z.literal(COMMITMENT_WORKFLOW_ID),
  workflowContractHash: hash.optional(),
  mode: WorkflowMode,
  snapshotId: identifier,
  snapshotHash: hash,
  status: z.enum(["complete", "invalid_output", "blocked", "error", "cancelled", "budget_exceeded"]),
  ledger: CommitmentLedger.nullable(),
  validation: WorkflowValidationReport,
  usage: WorkflowUsage,
  // Immutable version pin, not an authorization or a mutable guidance lookup.
  refinement: z.strictObject({ id: identifier, version: z.number().int().min(1), hash }).nullable(),
  // Informational actual settings, not a claim that an arbitrary provider ran MAX.
  // null effort means unknown/not exposed. This does not authorize live evaluation.
  model: z.strictObject({ provider: text(100, 1), model: text(150, 1), effort: text(40, 1).nullable() }).nullable(),
  elapsedMs: z.number().min(0),
  analysisTrace: WorkflowAnalysisTrace.optional(),
  notices: z.array(nonBlank(500)).max(20),
}).superRefine((result, ctx) => {
  if (result.status === "complete" && (result.ledger === null || !result.validation.valid)) {
    ctx.addIssue({ code: "custom", path: ["status"], message: "Complete requires a contract-valid ledger" });
  }
  if (result.ledger && (result.ledger.snapshotHash !== result.snapshotHash || result.ledger.snapshotId !== result.snapshotId)) {
    ctx.addIssue({ code: "custom", path: ["ledger"], message: "Result and ledger snapshot binding disagree" });
  }
  if (result.analysisTrace && result.analysisTrace.snapshotHash !== result.snapshotHash) {
    ctx.addIssue({ code: "custom", path: ["analysisTrace"], message: "Trace and run snapshot binding disagree" });
  }
  if ((result.mode === "baseline" || result.mode === "rlm") && result.refinement !== null) {
    ctx.addIssue({ code: "custom", path: ["refinement"], message: "This arm cannot contain an active refinement" });
  }
});
export type WorkflowRunResult = z.infer<typeof WorkflowRunResult>;

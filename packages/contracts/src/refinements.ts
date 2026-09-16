// SPDX-License-Identifier: AGPL-3.0-only

import { z } from "zod";
import { userIdField, wellFormedString } from "./requests/common.js";

const text = (name: string, max: number) => wellFormedString(name).min(1).max(max);
export const RefinementId = text("id", 160);
export const RefinementHash = z.string().regex(/^[a-f0-9]{64}$/);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const instant = z.string().refine((s) => {
  const n = Date.parse(s);
  return Number.isFinite(n) && new Date(n).toISOString() === s;
}, "expected canonical UTC timestamp");
export const REFINEMENT_CONTENT_MAX_BYTES = 16 * 1024;
export const REFINEMENT_REPORT_MAX_BYTES = 128 * 1024;

export const RefinementScope = z.strictObject({
  workflowId: text("workflowId", 64),
  slot: z.literal("reasoning"),
  workflowContractHash: RefinementHash,
});
export type RefinementScope = z.infer<typeof RefinementScope>;
export const RefinementContent = z.strictObject({
  schemaVersion: z.literal(1),
  kind: z.literal("workflow-guidance"),
  title: text("title", 80),
  rationale: text("rationale", 1024),
  scope: RefinementScope,
  procedure: z.strictObject({ steps: z.array(text("step", 512)).min(1).max(8) }),
}).refine((c) => new TextEncoder().encode(JSON.stringify(c)).length <= REFINEMENT_CONTENT_MAX_BYTES,
  "content exceeds byte limit");
export type RefinementContent = z.infer<typeof RefinementContent>;
export const RefinementSourceRef = z.strictObject({
  kind: z.enum(["learning_fixture", "correction", "run_outcome"]),
  id: RefinementId,
});
export type RefinementSourceRef = z.infer<typeof RefinementSourceRef>;
export const RefinementSource = RefinementSourceRef.extend({
  sha256: RefinementHash.nullable(), auditEntryId: RefinementId.nullable(), resolved: z.boolean(),
}).refine((s) => s.resolved === (s.sha256 !== null));
export type RefinementSource = z.infer<typeof RefinementSource>;
export const RefinementProvenance = z.strictObject({
  createdAt: instant,
  producerKind: z.enum(["operator_import", "engine_model", "deterministic_mock"]),
  producerRunId: RefinementId.nullable(), modelConfigHash: RefinementHash.nullable(),
  sources: z.array(RefinementSource).min(1).max(16),
});
export const RefinementEnvelope = z.strictObject({
  versionId: RefinementId, familyId: RefinementId,
  revision: count.refine((n) => n > 0), parentVersionId: RefinementId.nullable(),
  content: RefinementContent, provenance: RefinementProvenance,
});
export type RefinementEnvelope = z.infer<typeof RefinementEnvelope>;
export const RefinementState = z.enum(["proposed", "validated", "approved", "active", "disabled"]);
export type RefinementState = z.infer<typeof RefinementState>;
export const RefinementAction = z.enum(["propose", "validate", "approve", "activate", "disable", "rollback"]);
export type RefinementAction = z.infer<typeof RefinementAction>;
export const RefinementExecutionKind = z.enum(["schema_contract", "deterministic_mock", "real_model"]);
export const RefinementQualification = z.strictObject({
  suiteId: RefinementId, suiteHash: RefinementHash,
  learningManifestHash: RefinementHash, validationManifestHash: RefinementHash,
  caseIds: z.array(RefinementId).min(1).max(128),
  checkIds: z.array(RefinementId).min(1).max(32),
  executionKind: RefinementExecutionKind, modelConfigHash: RefinementHash.nullable(),
}).refine((q) => new Set(q.caseIds).size === q.caseIds.length &&
  new Set(q.checkIds).size === q.checkIds.length &&
  q.learningManifestHash !== q.validationManifestHash &&
  (q.executionKind === "schema_contract" ? q.modelConfigHash === null : q.modelConfigHash !== null));
export type RefinementQualification = z.infer<typeof RefinementQualification>;
export const RefinementValidationBindings = z.strictObject({
  versionId: RefinementId, versionHash: RefinementHash, scopeKey: RefinementHash,
  workflowContractHash: RefinementHash, workflowBuildHash: RefinementHash,
  validatorBuildHash: RefinementHash, qualification: RefinementQualification,
});
export type RefinementValidationBindings = z.infer<typeof RefinementValidationBindings>;
export const RefinementValidationReport = z.strictObject({
  cases: z.array(z.strictObject({
    caseId: RefinementId, inputHash: RefinementHash, outputHash: RefinementHash,
    checks: z.array(z.strictObject({ checkId: RefinementId, passed: z.boolean() })).min(1).max(32),
  })).min(1).max(128),
  elapsedMs: count,
  usage: z.strictObject({
    accounting: z.enum(["none", "synthetic", "provider_reported"]),
    calls: z.array(z.strictObject({
      callId: RefinementId, parentCallId: RefinementId.nullable(),
      role: z.enum(["root", "child"]), inputTokens: count, outputTokens: count,
    })).max(512),
    inputTokens: count, outputTokens: count,
  }),
}).refine((r) => new TextEncoder().encode(JSON.stringify(r)).length <= REFINEMENT_REPORT_MAX_BYTES,
  "report exceeds byte limit");
export type RefinementValidationReport = z.infer<typeof RefinementValidationReport>;
export const RefinementValidation = z.strictObject({
  id: RefinementId, bindings: RefinementValidationBindings,
  status: z.enum(["running", "passed", "failed", "error"]),
  assurance: z.enum(["contract_only", "behavior_measured"]),
  report: RefinementValidationReport.nullable(), reportHash: RefinementHash.nullable(),
  reason: z.enum(["CHECK_FAILED", "VALIDATOR_ERROR", "VALIDATOR_TIMEOUT", "INCOMPATIBLE", "PROVENANCE_UNRESOLVED", "EVALUATION_OVERLAP", "REPORT_INVALID"]).nullable(),
  startedAt: instant, deadlineAt: instant, completedAt: instant.nullable(),
});
export type RefinementValidation = z.infer<typeof RefinementValidation>;
export const RefinementVersion = z.strictObject({
  envelope: RefinementEnvelope, versionHash: RefinementHash, scopeKey: RefinementHash,
  state: RefinementState, latestAttemptId: RefinementId.nullable(),
  validatedAttemptId: RefinementId.nullable(), approvalAuditId: RefinementId.nullable(),
  lastTransitionAuditId: RefinementId, updatedAt: instant,
});
export type RefinementVersion = z.infer<typeof RefinementVersion>;
export const RefinementScopeState = z.strictObject({
  scopeKey: RefinementHash, activeVersionId: RefinementId.nullable(),
  generation: count, lastTransitionAuditId: RefinementId.nullable(),
});
export type RefinementScopeState = z.infer<typeof RefinementScopeState>;
export const RefinementPin = z.strictObject({
  versionId: RefinementId, versionHash: RefinementHash, validationId: RefinementId,
  scopeKey: RefinementHash, scopeGeneration: count,
});
export type RefinementPin = z.infer<typeof RefinementPin>;

export const RefinementProposeRequest = z.strictObject({
  userId: userIdField, content: RefinementContent,
  parentVersionId: RefinementId.nullable(), sources: z.array(RefinementSourceRef).min(1).max(16),
});
export type RefinementProposeRequest = z.infer<typeof RefinementProposeRequest>;
export const RefinementGetRequest = z.strictObject({ userId: userIdField, versionId: RefinementId });
export type RefinementGetRequest = z.infer<typeof RefinementGetRequest>;
export const RefinementListRequest = z.strictObject({
  userId: userIdField, scopeKey: RefinementHash.optional(),
  limit: z.number().int().min(1).max(50).optional(), cursor: RefinementId.optional(),
});
export type RefinementListRequest = z.infer<typeof RefinementListRequest>;
export const RefinementValidateRequest = z.strictObject({
  userId: userIdField, versionId: RefinementId, versionHash: RefinementHash, suiteId: RefinementId,
});
export type RefinementValidateRequest = z.infer<typeof RefinementValidateRequest>;
export const RefinementApproveRequest = z.strictObject({
  userId: userIdField, versionId: RefinementId, versionHash: RefinementHash,
  validationId: RefinementId, reportHash: RefinementHash, expectedScopeGeneration: count,
});
export type RefinementApproveRequest = z.infer<typeof RefinementApproveRequest>;
export const RefinementActivateRequest = RefinementApproveRequest.extend({ approvalAuditId: RefinementId });
export type RefinementActivateRequest = z.infer<typeof RefinementActivateRequest>;
export const RefinementDisableRequest = z.strictObject({
  userId: userIdField, versionId: RefinementId, versionHash: RefinementHash,
  expectedScopeGeneration: count, reason: text("reason", 512),
});
export type RefinementDisableRequest = z.infer<typeof RefinementDisableRequest>;
export const RefinementRollbackRequest = RefinementApproveRequest.extend({ reason: text("reason", 512) });
export type RefinementRollbackRequest = z.infer<typeof RefinementRollbackRequest>;
export const RefinementMutationResponse = z.strictObject({
  versionId: RefinementId, versionHash: RefinementHash, state: RefinementState,
  scopeGeneration: count, auditEntryId: RefinementId,
});
export type RefinementMutationResponse = z.infer<typeof RefinementMutationResponse>;
export const RefinementTransitionRecord = z.strictObject({
  action: RefinementAction, requestHash: RefinementHash, response: RefinementMutationResponse,
});
export type RefinementTransitionRecord = z.infer<typeof RefinementTransitionRecord>;
export const RefinementDetailResponse = z.strictObject({
  version: RefinementVersion, scope: RefinementScopeState,
  validations: z.array(RefinementValidation).max(32), compatible: z.boolean(),
  qualification: RefinementQualification.nullable(),
});
export type RefinementDetailResponse = z.infer<typeof RefinementDetailResponse>;
export const RefinementListResponse = z.strictObject({
  refinements: z.array(RefinementVersion).max(50), nextCursor: RefinementId.nullable(),
});
export type RefinementListResponse = z.infer<typeof RefinementListResponse>;
export const RefinementValidationResponse = z.strictObject({
  validation: RefinementValidation, version: RefinementVersion, scope: RefinementScopeState,
});
export type RefinementValidationResponse = z.infer<typeof RefinementValidationResponse>;

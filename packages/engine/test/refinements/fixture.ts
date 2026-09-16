// SPDX-License-Identifier: AGPL-3.0-only

import type { EngineSql } from "../../src/data/helpers/types";
import { insertAuditEntryInTxn } from "../../src/data/helpers/audit-log";
import { inTxn } from "../helpers/audit-closer";
import { bindDoSql } from "../helpers/do-sql";
import { RefinementManager, type RefinementManagerDependencies } from "../../src/refinements/manager";
import { refinementHash } from "../../src/refinements/canonical";
import type { RefinementWorkflowRegistration } from "../../src/refinements/registry";
import type { RefinementContent, RefinementDetailResponse, RefinementValidationReport } from "@habenula-ai/contracts";

export const OWNER = "refinement-test-owner";
export const HASH = refinementHash("test-workflow-contract");
export const CONTENT: RefinementContent = {
  schemaVersion: 1, kind: "workflow-guidance", title: "Inspect both revisions",
  rationale: "Learning fixture showed a stale deadline; not a model efficacy claim.",
  scope: { workflowId: "test.commitments.v1", slot: "reasoning", workflowContractHash: HASH },
  procedure: { steps: ["Compare prior and current explicit updates; preserve uncertainty."] },
};
export function contractReport(): RefinementValidationReport {
  return { cases: [{ caseId: "validation-1", inputHash: refinementHash("input"), outputHash: refinementHash("output"),
    checks: [{ checkId: "evidence-schema", passed: true }] }], elapsedMs: 1,
    usage: { accounting: "none", calls: [], inputTokens: 0, outputTokens: 0 } };
}
/** TEST ONLY: a scripted report exercises plumbing, never model efficacy. */
export function fixture(instance: unknown) {
  const sql = bindDoSql(instance as { sql: EngineSql });
  let time = Date.parse("2026-09-10T00:00:00.000Z");
  const registration: RefinementWorkflowRegistration = {
    workflowId: CONTENT.scope.workflowId, workflowContractHash: HASH,
    workflowBuildHash: refinementHash("workflow-build"), validatorBuildHash: refinementHash("validator-build"),
    qualification: { suiteId: "test-suite", suiteHash: refinementHash("suite"),
      learningManifestHash: refinementHash("learning"), validationManifestHash: refinementHash("validation"),
      caseIds: ["validation-1"], checkIds: ["evidence-schema"], executionKind: "schema_contract", modelConfigHash: null },
    runValidation: async () => contractReport(),
  };
  let depth = 0;
  const deps: RefinementManagerDependencies = {
    ownerId: OWNER, sql,
    transaction: <T>(body: () => T): T => {
      if (depth !== 0) throw new Error("nested manager transaction");
      depth++;
      try { return inTxn(instance, body); } finally { depth--; }
    },
    audit: (event) => insertAuditEntryInTxn(sql, { userId: OWNER, agentId: "test-refinements",
      sessionId: "refinement-control", toolName: `refinement.${event.action}`, service: "refinement",
      verb: event.action, noun: event.versionId, decision: "allow", outcome: event.outcome,
      parametersMetadata: event.metadata, latencyMs: 0, timestamp: event.timestamp }),
    registry: (id) => id === registration.workflowId ? registration : null,
    resolveSource: (ref, owner) => owner === OWNER && ref.kind === "learning_fixture" && ref.id === "learning-1"
      ? { sha256: refinementHash("learning-case-1"), auditEntryId: null } : null,
    now: () => new Date(time),
  };
  return { sql, registration, deps, manager: new RefinementManager(deps),
    advance: (ms: number) => { time += ms; },
    rebuild: (override: Partial<RefinementManagerDependencies> = {}) => new RefinementManager({ ...deps, ...override }) };
}
export function proposal(content = CONTENT, parentVersionId: string | null = null) {
  return { userId: OWNER, content, parentVersionId, sources: [{ kind: "learning_fixture" as const, id: "learning-1" }] };
}
export async function qualified(manager: RefinementManager, content = CONTENT, parentId: string | null = null) {
  const detail = await manager.propose(proposal(content, parentId));
  const result = await manager.validate({ userId: OWNER, versionId: detail.version.envelope.versionId,
    versionHash: detail.version.versionHash, suiteId: "test-suite" });
  return { detail: manager.get(detail.version.envelope.versionId), approval: {
    userId: OWNER, versionId: detail.version.envelope.versionId, versionHash: detail.version.versionHash,
    validationId: result.validation.id, reportHash: result.validation.reportHash!,
    expectedScopeGeneration: result.scope.generation,
  } };
}
export async function activate(manager: RefinementManager, content = CONTENT, parentId: string | null = null) {
  const q = await qualified(manager, content, parentId);
  const approval = manager.approve(q.approval);
  const request = { ...q.approval, approvalAuditId: approval.auditEntryId };
  const activated = manager.activate(request);
  return { ...q, request, activated };
}
export function binding(detail: RefinementDetailResponse) {
  const a = detail.validations[0]!;
  return { userId: OWNER, versionId: detail.version.envelope.versionId, versionHash: detail.version.versionHash,
    validationId: a.id, reportHash: a.reportHash!, expectedScopeGeneration: detail.scope.generation };
}

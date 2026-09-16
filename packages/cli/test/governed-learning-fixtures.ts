// SPDX-License-Identifier: AGPL-3.0-only

import { vi } from "vitest";
import type {
  CommitmentSnapshot, RefinementDetailResponse, RefinementMutationResponse,
  RefinementValidation, WorkflowRunResult, WorkflowDescribeResponse,
} from "@habenula-ai/contracts";
import type { RefinementDriver } from "../src/refinement-client";
import type { RefinementIO } from "../src/commands/refinement";

export const HASH = "a".repeat(64);
export const REPORT_HASH = "b".repeat(64);
export const AT = "2026-09-01T00:00:00.000Z";
export function detail(state: RefinementDetailResponse["version"]["state"] = "validated"): RefinementDetailResponse {
  const qualification = {
    suiteId: "contract-suite", suiteHash: HASH, learningManifestHash: HASH,
    validationManifestHash: REPORT_HASH, caseIds: ["fresh-1"], checkIds: ["evidence-span"],
    executionKind: "schema_contract" as const, modelConfigHash: null,
  };
  const validation: RefinementValidation = {
    id: "receipt-1", bindings: { versionId: "version-1", versionHash: HASH, scopeKey: HASH,
      workflowContractHash: HASH, workflowBuildHash: HASH, validatorBuildHash: HASH, qualification },
    status: "passed", assurance: "contract_only", reportHash: REPORT_HASH,
    report: { cases: [{ caseId: "fresh-1", inputHash: HASH, outputHash: HASH,
      checks: [{ checkId: "evidence-span", passed: true }] }], elapsedMs: 1,
      usage: { accounting: "none", calls: [], inputTokens: 0, outputTokens: 0 } },
    reason: null, startedAt: AT, deadlineAt: "2026-09-01T00:01:00.000Z", completedAt: AT,
  };
  return {
    version: {
      envelope: { versionId: "version-1", familyId: "family-1", revision: 1, parentVersionId: null,
        content: { schemaVersion: 1, kind: "workflow-guidance", title: "Changed deadlines",
          rationale: "Preserve the prior date and quote the correction.",
          scope: { workflowId: "mail.commitment-handoff.v1", slot: "reasoning", workflowContractHash: HASH },
          procedure: { steps: ["Check newer corrections before assigning a due date."] } },
        provenance: { createdAt: AT, producerKind: "operator_import", producerRunId: null,
          modelConfigHash: null, sources: [{ kind: "learning_fixture", id: "learn-1",
            sha256: HASH, auditEntryId: "source-audit", resolved: true }] } },
      versionHash: HASH, scopeKey: HASH, state, latestAttemptId: validation.id,
      validatedAttemptId: validation.id, approvalAuditId: state === "approved" || state === "active" || state === "disabled" ? "approval-1" : null,
      lastTransitionAuditId: "audit-1", updatedAt: AT,
    },
    scope: { scopeKey: HASH, activeVersionId: state === "active" ? "version-1" : null,
      generation: 4, lastTransitionAuditId: "scope-audit" },
    validations: [validation], qualification, compatible: true,
  };
}
export function mutation(state: RefinementMutationResponse["state"] = "approved"): RefinementMutationResponse {
  return { versionId: "version-1", versionHash: HASH, state, scopeGeneration: 4, auditEntryId: "audit-result" };
}
export function descriptor(): WorkflowDescribeResponse {
  return { workflowId: "mail.commitment-handoff.v1", workflowContractHash: HASH,
    schemaVersion: 1, supportedModes: ["baseline", "refinements"],
    fixtures: [{ id: "learn-1", title: "Learning example", split: "learning" }] };
}
export function fakeClient(d = detail()): RefinementDriver {
  return {
    describeWorkflow: vi.fn(async () => descriptor()),
    list: vi.fn(async () => ({ refinements: [d.version], nextCursor: null })),
    get: vi.fn(async () => structuredClone(d)),
    propose: vi.fn(async () => {
      const proposed = structuredClone(d);
      proposed.version.state = "proposed";
      return proposed;
    }),
    validate: vi.fn(async () => ({ validation: d.validations[0]!, version: d.version, scope: d.scope })),
    approve: vi.fn(async () => mutation()), activate: vi.fn(async () => mutation("active")),
    disable: vi.fn(async () => mutation("disabled")), rollback: vi.fn(async () => mutation("active")),
    runWorkflow: vi.fn(async () => workflowResult()),
  };
}
export function fakeIO(answer: string | null = "yes") {
  const out: string[] = []; const err: string[] = [];
  const io: RefinementIO = { write: (line) => out.push(line), writeErr: (line) => err.push(line),
    ask: vi.fn(async () => answer), readJson: vi.fn(async () => ({})), width: 80 };
  return { io, out, err };
}
export function snapshot(): CommitmentSnapshot {
  return { workflowId: "mail.commitment-handoff.v1", schemaVersion: 1,
    snapshotId: "snapshot-1", snapshotHash: HASH, userAddress: "owner@example.test",
    cutoff: AT, timezone: "UTC", coverage: { scope: "supplied-snapshot",
      source: "synthetic-fixture", omittedMessages: null, note: "Not an inbox search." },
    messages: [{ id: "mail-1", threadId: "thread-1", subject: "Updated delivery",
      sender: "peer@example.test", to: "owner@example.test", timestamp: AT,
      body: "Move to Friday.", bodyHash: REPORT_HASH, truncated: false, omittedChars: 0 }] };
}
export function workflowResult(): WorkflowRunResult {
  return { runId: "run-1", workflowId: "mail.commitment-handoff.v1", mode: "baseline",
    snapshotId: "snapshot-1", snapshotHash: HASH, status: "complete", refinement: null, model: null,
    ledger: { workflowId: "mail.commitment-handoff.v1", snapshotId: "snapshot-1", snapshotHash: HASH,
      items: [{ itemId: "item-1", title: "Delivery", owner: "owner@example.test", state: "due",
        dueAt: "2026-09-04T17:00:00.000Z", changed: true,
        evidence: [{ messageId: "mail-1", bodyHash: REPORT_HASH, start: 0, end: 15, quote: "Move to Friday." }],
        priorEvidence: [{ messageId: "mail-1", bodyHash: REPORT_HASH, start: 0, end: 4, quote: "Move" }],
        uncertainty: "Meaning requires human review.", nextAction: "Check the new date.", replyText: "I will review the new date." }],
      coverage: { scope: "supplied-snapshot", omittedMessages: null, truncatedMessageIds: [], limitations: ["Only the supplied messages."] } },
    validation: { level: "contract-only", valid: true, semanticVerified: false, issues: [] },
    usage: { kind: "synthetic", inputTokens: 0, outputTokens: 0, rootCalls: 1, childCalls: 2, complete: true },
    elapsedMs: 4, notices: ["Deterministic test output."] };
}

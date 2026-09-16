// SPDX-License-Identifier: AGPL-3.0-only

import type {
  RefinementDetailResponse,
  RefinementListResponse,
  RefinementMutationResponse,
  RefinementValidation,
} from "@habenula-ai/contracts";
import { displayWidth, layoutField, renderUntrusted } from "./attribution";

/** Every external value stays quoted, bounded and indented at narrow widths. */
export function dataField(label: string, value: unknown, width = 80, max = 1024): string[] {
  const rendered = renderUntrusted(value, max);
  const prefix = `  ${label}: `;
  const flags = [rendered.altered ? "[unusual value]" : "", rendered.truncated ? "[display shortened]" : ""]
    .filter(Boolean).join(" ");
  // Keep a digest copyable at ordinary terminal widths, without truncating it.
  const digestLine = typeof value === "string" && /^[a-f0-9]{64}$/.test(value)
    && width >= 70 && displayWidth(prefix) + 66 > width;
  const rows = layoutField({
    prefixColored: digestLine ? "    " : prefix,
    prefixWidth: digestLine ? 4 : displayWidth(prefix), value: rendered.text,
    width, continuationIndent: 4,
    ...(flags ? { suffixColored: flags, suffixWidth: displayWidth(flags) } : {}),
  });
  return digestLine ? [prefix.trimEnd(), ...rows] : rows;
}

/** JSON remains lossless when parsed; terminal controls never reach stdout raw. */
export function machineJson(value: unknown): string {
  return JSON.stringify(value).replace(/[\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g,
    (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`);
}


export function renderQualification(validation: RefinementValidation | undefined, width = 80): string[] {
  if (!validation) return ["  Qualification: not validated; behavior unmeasured."];
  const q = validation.bindings.qualification;
  const rows = [
    `  Validation: ${validation.status} · ${q.executionKind}`,
    validation.assurance === "behavior_measured" && q.executionKind === "real_model"
      ? "  BEHAVIOR MEASURED on the named suite only; no generalization claim."
      : "  CONTRACT-ONLY CHECKS · behavior unmeasured; no efficacy claim.",
    ...dataField("Validation receipt", validation.id, width, 160),
    ...dataField("Report SHA-256", validation.reportHash, width, 64),
    ...dataField("Suite", q.suiteId, width, 160),
    ...dataField("Suite SHA-256", q.suiteHash, width, 64),
    ...dataField("Learning manifest", q.learningManifestHash, width, 64),
    ...dataField("Validation manifest", q.validationManifestHash, width, 64),
    `  Qualified cases: ${q.caseIds.length} · checks: ${q.checkIds.length}`,
  ];
  if (validation.report) {
    const usage = validation.report.usage;
    const roots = usage.calls.filter((c) => c.role === "root").length;
    rows.push(`  Usage: ${usage.accounting} · ${roots} root + ${usage.calls.length - roots} child calls`,
      `  All-call tokens: ${usage.inputTokens} in / ${usage.outputTokens} out`);
  }
  if (validation.reason) rows.push(`  Refusal reason: ${validation.reason}`);
  if (q.executionKind === "deterministic_mock") rows.push("  Mock calls prove plumbing, not model efficacy.");
  return rows;
}

export function renderRefinementList(result: RefinementListResponse, width = 80): string[] {
  const rows = ["WORKFLOW REFINEMENTS", "Scoped guidance only. No grants or kernel changes."];
  if (result.refinements.length === 0) rows.push("No refinement versions yet. Propose a bounded JSON guidance file.");
  for (const v of result.refinements) {
    rows.push("", `  Revision ${v.envelope.revision} · ${v.state}`,
      ...dataField("Version", v.envelope.versionId, width, 160),
      ...dataField("Title", v.envelope.content.title, width, 80),
      ...dataField("Workflow", v.envelope.content.scope.workflowId, width, 64),
      ...dataField("SHA-256", v.versionHash, width, 64));
  }
  if (result.nextCursor !== null) {
    rows.push("More versions exist. Continue with refinement list --cursor <cursor>.",
      ...dataField("Next cursor", result.nextCursor, width, 160));
  }
  rows.push("State alone is not efficacy evidence. Use refinement show for qualification.");
  return rows;
}

export function renderRefinementDetail(detail: RefinementDetailResponse, width = 80): string[] {
  const v = detail.version;
  const c = v.envelope.content;
  const rows = ["WORKFLOW REFINEMENT", `Revision ${v.envelope.revision} · ${v.state} · ${detail.compatible ? "compatible" : "INCOMPATIBLE"}`,
    "Guidance is untrusted data, not permission. Read the exact version before consent.",
    ...dataField("Version", v.envelope.versionId, width, 160),
    ...dataField("Version SHA-256", v.versionHash, width, 64),
    ...dataField("Family", v.envelope.familyId, width, 160),
    ...dataField("Parent", v.envelope.parentVersionId, width, 160),
    ...dataField("Title", c.title, width, 80),
    ...dataField("Rationale", c.rationale, width, 1024),
    ...dataField("Workflow / slot", `${c.scope.workflowId} / ${c.scope.slot}`, width, 80),
    ...dataField("Workflow contract", c.scope.workflowContractHash, width, 64),
    ...dataField("Scope key", v.scopeKey, width, 64),
    `  Scope generation: ${detail.scope.generation}`,
    ...dataField("Active version", detail.scope.activeVersionId, width, 160),
    "PROCEDURE (data, not commands)",
  ];
  for (const [i, step] of c.procedure.steps.entries()) rows.push(...dataField(`Step ${i + 1}`, step, width, 512));
  const p = v.envelope.provenance;
  rows.push("PROVENANCE", `  Producer: ${p.producerKind} · ${p.createdAt}`,
    ...dataField("Producer run", p.producerRunId, width, 160),
    ...dataField("Model config", p.modelConfigHash, width, 64));
  for (const source of p.sources) rows.push(
    `  Source: ${source.kind} · ${source.resolved ? "resolved" : "UNRESOLVED"}`,
    ...dataField("Source id", source.id, width, 160),
    ...dataField("Source SHA-256", source.sha256, width, 64));
  const validation = detail.validations.find((r) => r.id === v.validatedAttemptId);
  rows.push("QUALIFICATION", ...renderQualification(validation, width));
  if (detail.qualification && (!validation
    || JSON.stringify(detail.qualification) !== JSON.stringify(validation.bindings.qualification))) {
    rows.push("  Current registered suite (not a passed receipt):",
      ...dataField("Suite", detail.qualification.suiteId, width, 160),
      ...dataField("Suite SHA-256", detail.qualification.suiteHash, width, 64),
      `  Execution: ${detail.qualification.executionKind} · ${detail.qualification.checkIds.length} checks`);
    if (validation) rows.push("  Accepted receipt differs from current qualification; revalidation is required.");
  }
  const latest = detail.validations.find((r) => r.id === v.latestAttemptId);
  if (latest && latest.id !== validation?.id) {
    rows.push("LATEST ATTEMPT (not the accepted receipt)", ...renderQualification(latest, width));
  }
  rows.push(...dataField("Approval audit receipt", v.approvalAuditId, width, 160),
    ...dataField("Last transition receipt", v.lastTransitionAuditId, width, 160));
  return rows;
}

/** A bounded positional diff; both sides shown, never a candidate-authored change summary. */
export function renderRefinementDiff(before: RefinementDetailResponse | null,
  after: RefinementDetailResponse, label: string, width = 80): string[] {
  const rows = [label];
  if (!before) return [...rows, "  No prior version in this comparison; all displayed guidance is new."];
  rows.push(...dataField("From", before.version.envelope.versionId, width, 160),
    ...dataField("To", after.version.envelope.versionId, width, 160));
  const a = before.version.envelope.content;
  const b = after.version.envelope.content;
  let changes = 0;
  const changed = (field: string, oldValue: unknown, newValue: unknown, max = 1024): void => {
    if (JSON.stringify(oldValue) === JSON.stringify(newValue)) return;
    changes += 1;
    rows.push(...dataField(`- ${field}`, oldValue, width, max), ...dataField(`+ ${field}`, newValue, width, max));
  };
  changed("Title", a.title, b.title, 80);
  changed("Rationale", a.rationale, b.rationale);
  changed("Workflow", a.scope.workflowId, b.scope.workflowId, 64);
  changed("Contract", a.scope.workflowContractHash, b.scope.workflowContractHash, 64);
  const count = Math.max(a.procedure.steps.length, b.procedure.steps.length);
  for (let i = 0; i < count; i++) changed(`Step ${i + 1}`, a.procedure.steps[i] ?? null, b.procedure.steps[i] ?? null, 512);
  if (changes === 0) rows.push("  Guidance content is unchanged; version/provenance may differ.");
  return rows;
}

export function renderRefinementMutation(action: string, result: RefinementMutationResponse, width = 80): string[] {
  return [`${action.toUpperCase()} RECORDED · ${result.state}`,
    ...dataField("Version", result.versionId, width, 160),
    ...dataField("Version SHA-256", result.versionHash, width, 64),
    `  Scope generation: ${result.scopeGeneration}`,
    ...dataField("Audit receipt", result.auditEntryId, width, 160),
    "Guidance only. No service action, grant or model efficacy established."];
}

// SPDX-License-Identifier: AGPL-3.0-only

import type { CommitmentEvidence, CommitmentSnapshot, WorkflowRunResult } from "@habenula-ai/contracts";
import { dataField } from "./refinement";

/** Source quotes are data. They never render as operator instructions or sent mail. */
export function renderWorkflow(result: WorkflowRunResult, snapshot: CommitmentSnapshot, width = 80): string[] {
  const accepted = result.status === "complete" && result.validation.valid && result.ledger !== null;
  const rows = ["COMMITMENT HANDOFF · LOCAL REVIEW", `${result.mode} · ${result.status}`,
    accepted
      ? "CONTRACT-CHECKED · behavior unmeasured. Evidence location is not semantic proof."
      : result.validation.valid ? "RUN INCOMPLETE · no accepted review packet. Behavior unmeasured."
        : "CONTRACT NOT PASSED · no accepted review packet. Behavior unmeasured.",
    "Read-only snapshot analysis. No message sent and no service draft created.",
    ...dataField("Run", result.runId, width, 80),
    ...dataField("Snapshot", result.snapshotId, width, 80),
    ...dataField("Snapshot SHA-256", result.snapshotHash, width, 64),
    ...dataField("Cutoff", snapshot.cutoff, width, 80),
    ...dataField("Timezone", snapshot.timezone, width, 80),
    `  Source: ${snapshot.coverage.source} · supplied-snapshot only · ${snapshot.messages.length} messages`,
    `  Omitted messages: ${snapshot.coverage.omittedMessages === null ? "unknown" : snapshot.coverage.omittedMessages}`,
  ];
  if (result.workflowContractHash) rows.push(...dataField("Workflow contract SHA-256", result.workflowContractHash, width, 64));
  if (snapshot.coverage.note) rows.push(...dataField("Source note", snapshot.coverage.note, width, 500));
  if (result.refinement) rows.push(`  Pinned refinement revision: ${result.refinement.version}`,
    ...dataField("Refinement", result.refinement.id, width, 80),
    ...dataField("Refinement SHA-256", result.refinement.hash, width, 64));
  else rows.push("  Refinement: none pinned");

  const ledger = accepted ? result.ledger : null;
  if (ledger) {
    const states = ["due", "waiting", "closed", "uncertain"] as const;
    rows.push("", "LEDGER", "  " + states.map((s) => `${s.toUpperCase()} ${ledger.items.filter((i) => i.state === s).length}`).join("  |  "));
    const evidence = (ref: CommitmentEvidence, label: string): void => {
      const source = snapshot.messages.find((m) => m.id === ref.messageId);
      rows.push(...dataField(label, `${ref.messageId} [${ref.start}, ${ref.end}) UTF-16`, width, 130));
      if (source) rows.push(...dataField("Mail", `${source.timestamp} / ${source.subject}`, width, 320));
      rows.push(...dataField("Body SHA-256", ref.bodyHash, width, 64),
        ...dataField("Quoted source", ref.quote, width, 240));
    };
    for (const state of states) {
      for (const item of ledger.items.filter((i) => i.state === state)) {
        rows.push("", `${state.toUpperCase()}${item.changed ? " · CHANGED — compare current / prior source" : ""}`,
          ...dataField("Commitment", item.title, width, 160),
          ...dataField("Owner", item.owner ?? "unknown", width, 320),
          ...dataField("Due", item.dueAt ?? "not established", width, 80),
          ...dataField("Next action", item.nextAction, width, 500));
        if (item.uncertainty) rows.push(...dataField("Uncertainty", item.uncertainty, width, 500));
        for (const ref of item.evidence) evidence(ref, "Current evidence");
        for (const ref of item.priorEvidence) evidence(ref, "Prior evidence");
        if (item.replyText) rows.push(...dataField("Local reply text (NOT sent/saved)", item.replyText, width, 1200));
      }
    }
    if (ledger.items.length === 0) rows.push("  No commitments identified in this supplied snapshot; not an inbox-wide finding.");
    rows.push("", "COVERAGE & LIMITS",
      `  Truncated messages: ${ledger.coverage.truncatedMessageIds.length}`);
    for (const id of ledger.coverage.truncatedMessageIds) rows.push(...dataField("Truncated id", id, width, 80));
    for (const limit of ledger.coverage.limitations) rows.push(...dataField("Limit", limit, width, 500));
  } else {
    rows.push("", "No accepted ledger. No service action was taken.");
  }
  for (const issue of result.validation.issues) {
    rows.push(...dataField("Contract issue", `${issue.code}: ${issue.path}: ${issue.message}`, width, 900));
  }
  for (const notice of result.notices) rows.push(...dataField("Notice", notice, width, 500));
  const trace = result.analysisTrace;
  if (trace) {
    rows.push("", "ANALYSIS TRACE · host metadata, not a containment or quality claim",
      `  Outcome: ${trace.outcome} · ${trace.nodes.length} nodes · ${trace.calls.length} calls · ${trace.operations.length} operations`,
      `  Limits: depth ${trace.limits.maxDepth} · calls ${trace.limits.maxCalls} · operations ${trace.limits.maxOperations}`,
      `  Returned-text limit: ${trace.limits.maxReturnedChars} characters · trace ${trace.truncated ? "TRUNCATED" : "not truncated"}`,
      ...dataField("Context SHA-256", trace.contextHash, width, 64));
    for (const kind of ["slice", "transform", "execute", "model_query", "result"] as const) {
      const operations = trace.operations.filter((op) => op.kind === kind);
      if (operations.length) rows.push(`  ${kind}: ${operations.length} · ${operations.filter((op) => op.outcome === "complete").length} complete`);
    }
    rows.push("  Full bounded lineage and operation outcomes are in --json. No raw code is displayed.");
  }
  const u = result.usage;
  rows.push("", "RUN ACCOUNTING",
    `  ${u.kind} · ${u.complete ? "complete" : "INCOMPLETE"} · ${u.rootCalls} root + ${u.childCalls} child calls`,
    `  All-call tokens: ${u.inputTokens ?? "unknown"} in / ${u.outputTokens ?? "unknown"} out`,
    `  Elapsed: ${result.elapsedMs} ms`);
  if (result.model) rows.push(...dataField("Model / effort", `${result.model.provider} / ${result.model.model} / ${result.model.effort ?? "unknown"}`, width, 280));
  if (u.kind === "synthetic") rows.push("  DETERMINISTIC MOCK: plumbing only, not model efficacy.");
  rows.push("Evidence spans are UTF-16 [start, end). Source quotes may be shortened for display.",
    "Use --json for the full bounded packet. Verify meanings and dates against the source.");
  return rows;
}

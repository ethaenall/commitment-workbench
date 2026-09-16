// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/** Evaluator/test helper ONLY. Never feed an oracle or this output to a real model. */
import type { CommitmentLedger, CommitmentSnapshot, CommitmentEvidence } from "@habenula-ai/contracts";
import type { CommitmentOracle, OracleAnchor } from "../../packages/engine/src/workflows/fixtures.js";

export function oracleLedger(snapshot: CommitmentSnapshot, oracle: CommitmentOracle): CommitmentLedger {
  if (oracle.caseId !== snapshot.snapshotId) throw new Error("Oracle belongs to another snapshot");
  const ref = (anchor: OracleAnchor): CommitmentEvidence => {
    const message = snapshot.messages.find((m) => m.id === anchor.messageId);
    const start = message?.body.indexOf(anchor.quote) ?? -1;
    if (!message || start < 0 || message.body.indexOf(anchor.quote, start + 1) !== -1) throw new Error("Invalid authored oracle anchor");
    return { messageId: message.id, bodyHash: message.bodyHash, start, end: start + anchor.quote.length, quote: anchor.quote };
  };
  return {
    workflowId: snapshot.workflowId, snapshotId: snapshot.snapshotId, snapshotHash: snapshot.snapshotHash,
    items: oracle.items.map((item) => ({
      itemId: item.key, title: item.titleTerms[0]!, owner: item.owner,
      state: item.state, dueAt: item.dueAt, changed: item.changed,
      evidence: item.evidence.map(ref), priorEvidence: item.priorEvidence.map(ref),
      uncertainty: item.state === "uncertain" || item.owner === null ? "The supplied source does not settle this item." : null,
      nextAction: item.state === "closed" ? "No further action on this closed item." : "Review the cited evidence before acting.",
      replyText: null,
    })),
    coverage: { scope: "supplied-snapshot", omittedMessages: snapshot.coverage.omittedMessages,
      truncatedMessageIds: snapshot.messages.filter((m) => m.truncated).map((m) => m.id),
      limitations: snapshot.coverage.omittedMessages !== 0 || snapshot.messages.some((m) => m.truncated)
        ? ["This bounded snapshot has omitted or truncated source; no claim of live mailbox completeness."] : [],
    },
  };
}

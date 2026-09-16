// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from "vitest";
import {
  CommitmentLedger, CommitmentSnapshot, WorkflowMode, WorkflowRunRequest, WorkflowRunResult, WorkflowUsage,
  WorkflowAnalysisTrace, WorkflowValidationReport, WorkflowDescribeResponse,
  WORKFLOW_BOUNDS, type CommitmentEvidence,
} from "@habenula-ai/contracts";
import {
  createCommitmentSnapshot, hashCommitmentSnapshot, hashWorkflowText,
  createCommitmentSourceIndex, COMMITMENT_SOURCE_INDEX_BOUNDS,
  validateCommitmentSnapshot, validateCommitmentLedger, type CommitmentSnapshotDraft,
} from "../../src/workflows/commitment-handoff";
import {
  getWorkflowFixture, listWorkflowFixtures, evaluateWorkflowSuite,
  scoreWorkflowCase, WORKFLOW_VALIDATION_SUITE, type CommitmentOracle,
} from "../../src/workflows/fixtures";
import { oracleLedger } from "../../../../evals/governed-learning/oracle-ledger";
import learningOracle from "../../../../evals/governed-learning/oracles/learning/learn-01.json";
import validationOracle1 from "../../../../evals/governed-learning/oracles/validation/validate-01.json";
import validationOracle2 from "../../../../evals/governed-learning/oracles/validation/validate-02.json";
import validationOracle3 from "../../../../evals/governed-learning/oracles/validation/validate-03.json";
import validationOracle4 from "../../../../evals/governed-learning/oracles/validation/validate-04.json";
import dayOnlyOracle from "../../../../evals/governed-learning/oracles/learning/learn-03.json";

const oracle = learningOracle as CommitmentOracle;
async function fixture() {
  const snapshot = await getWorkflowFixture("learn-01");
  if (!snapshot) throw new Error("Missing registered fixture");
  return { snapshot, ledger: oracleLedger(snapshot, oracle) };
}
function draft(snapshot: CommitmentSnapshot): CommitmentSnapshotDraft {
  const { snapshotHash: _hash, messages, ...rest } = snapshot;
  return { ...rest, messages: messages.map(({ bodyHash: _bodyHash, ...m }) => ({ ...m })) };
}

async function ref(snapshot: CommitmentSnapshot, messageId: string, quote: string): Promise<CommitmentEvidence> {
  const source = snapshot.messages.find((message) => message.id === messageId)!;
  const start = source.body.indexOf(quote);
  return { messageId, bodyHash: await hashWorkflowText(source.body), start, end: start + quote.length, quote };
}

describe("bounded immutable commitment snapshots", () => {
  it("checks registered source hashes and returns isolated deep-frozen copies", async () => {
    const { snapshot } = await fixture();
    const copy = JSON.parse(JSON.stringify(snapshot));
    const checked = await validateCommitmentSnapshot(copy);
    expect(checked.ok).toBe(true);
    if (!checked.ok) throw new Error("Invalid fixture");
    expect(Object.isFrozen(checked.value.messages[0])).toBe(true);
    copy.messages[0].body = "modified afterwards";
    expect(checked.value.messages[0]!.body).toBe(snapshot.messages[0]!.body);
    expect(checked.report.semanticVerified).toBe(false);
    expect(await getWorkflowFixture("__proto__")).toBeUndefined();
  });

  it("binds body bytes and snapshot metadata without whitespace normalization", async () => {
    const { snapshot } = await fixture();
    const changedBody = JSON.parse(JSON.stringify(snapshot));
    changedBody.messages[0].body += " ";
    const bodyResult = await validateCommitmentSnapshot(changedBody);
    expect(bodyResult.ok).toBe(false);
    expect(bodyResult.report.issues.some((i) => i.code === "source_hash")).toBe(true);
    const changedMetadata = { ...snapshot, userAddress: "other@example.test" };
    expect((await validateCommitmentSnapshot(changedMetadata)).ok).toBe(false);
    expect(await hashCommitmentSnapshot({ ...snapshot, coverage: { ...snapshot.coverage, note: "different coverage" } })).not.toBe(snapshot.snapshotHash);
  });

  it("rejects duplicate ids, future messages, bad timezone, unknown fields, and bad Unicode", async () => {
    const { snapshot } = await fixture();
    expect(CommitmentSnapshot.safeParse({ ...snapshot, messages: [snapshot.messages[0], snapshot.messages[0]] }).success).toBe(false);
    expect(CommitmentSnapshot.safeParse({ ...snapshot, messages: [{ ...snapshot.messages[0], timestamp: "2026-11-01T00:00:00Z" }] }).success).toBe(false);
    expect(CommitmentSnapshot.safeParse({ ...snapshot, approved: true }).success).toBe(false);
    expect(CommitmentSnapshot.safeParse({ ...snapshot, messages: [{ ...snapshot.messages[0], body: "\ud800" }] }).success).toBe(false);
    const badZone = { ...snapshot, timezone: "Arbitrary/Not-A-Zone" };
    badZone.snapshotHash = await hashCommitmentSnapshot(badZone);
    expect((await validateCommitmentSnapshot(badZone)).report.issues.some((i) => i.code === "timezone")).toBe(true);
  });

  it("rejects body, total-body, and message-count overflows instead of silently clipping", async () => {
    const { snapshot } = await fixture();
    const message = snapshot.messages[0]!;
    expect(CommitmentSnapshot.safeParse({ ...snapshot, messages: [{ ...message, body: "x".repeat(WORKFLOW_BOUNDS.bodyChars + 1) }] }).success).toBe(false);
    const messages = Array.from({ length: 9 }, (_, i) => ({ ...message, id: `m${i}`, body: "x".repeat(WORKFLOW_BOUNDS.bodyChars) }));
    expect(CommitmentSnapshot.safeParse({ ...snapshot, messages }).success).toBe(false);
    expect((await validateCommitmentSnapshot({ ...snapshot, messages: Array(33).fill(message) })).ok).toBe(false);
  });

  it("requires accurate truncation metadata and accepts a truly empty snapshot", async () => {
    const { snapshot } = await fixture();
    expect(CommitmentSnapshot.safeParse({ ...snapshot, messages: [{ ...snapshot.messages[0], truncated: true, omittedChars: 0 }] }).success).toBe(false);
    const empty = await createCommitmentSnapshot({ ...draft(snapshot), messages: [] });
    const ledger = oracleLedger(empty, { caseId: empty.snapshotId, items: [] });
    expect((await validateCommitmentLedger(empty, ledger)).ok).toBe(true);
  });
});

describe("same output/evidence contract for every arm", () => {
  it.each(WorkflowMode.options)("validates a good report in %s without claiming entailment", async (_mode) => {
    const { snapshot, ledger } = await fixture();
    const result = await validateCommitmentLedger(snapshot, ledger);
    expect(result.ok).toBe(true);
    expect(result.report).toEqual({ level: "contract-only", valid: true, semanticVerified: false, issues: [] });
  });

  it("accepts a located but semantically wrong span; the separate oracle rejects it", async () => {
    const { snapshot, ledger } = await fixture();
    // The report claims Monday but cites the OLD Friday promise. Its span exists.
    ledger.items[0]!.evidence = [await ref(snapshot, "learn-01-m1", snapshot.messages[0]!.body)];
    expect(CommitmentLedger.safeParse(ledger).success).toBe(true);
    const structural = await validateCommitmentLedger(snapshot, ledger);
    expect(structural.ok).toBe(true);
    expect(structural.report.semanticVerified).toBe(false);
    const scored = await scoreWorkflowCase(snapshot, ledger, oracle);
    expect(scored.oraclePassed).toBe(false);
    expect(scored.checks.find((c) => c.checkId === "oracle.evidence")?.passed).toBe(false);
  });

  it("rejects source substitution, stale hashes, wrong quotes, out-of-range and empty spans", async () => {
    const { snapshot, ledger } = await fixture();
    const good = ledger.items[0]!.evidence[0]!;
    const variants = [
      { ...good, messageId: "another-user-message" }, { ...good, bodyHash: "0".repeat(64) },
      { ...good, quote: "not the exact source text" }, { ...good, end: 12_000 }, { ...good, end: good.start },
    ];
    for (const bad of variants) {
      const copy = structuredClone(ledger);
      copy.items[0]!.evidence[0] = bad;
      expect((await validateCommitmentLedger(snapshot, copy)).ok).toBe(false);
    }
    expect((await validateCommitmentLedger(snapshot, { ...ledger, snapshotHash: "0".repeat(64) })).ok).toBe(false);
  });

  it("uses half-open UTF-16 offsets and rejects splitting either side of an emoji", async () => {
    const { snapshot, ledger } = await fixture();
    const d = draft(snapshot);
    d.messages[0]!.body = "Note 😀. I will send it.";
    const unicode = await createCommitmentSnapshot(d);
    const base = { ...ledger, snapshotHash: unicode.snapshotHash };
    base.items[0]!.changed = false;
    base.items[0]!.priorEvidence = [];
    base.items[0]!.evidence = [await ref(unicode, "learn-01-m1", "😀")];
    expect(base.items[0]!.evidence[0]!.end - base.items[0]!.evidence[0]!.start).toBe(2);
    expect((await validateCommitmentLedger(unicode, base)).ok).toBe(true);
    for (const offsets of [{ start: 6, end: 8 }, { start: 4, end: 6 }]) {
      const copy = structuredClone(base);
      Object.assign(copy.items[0]!.evidence[0]!, offsets);
      const bad = await validateCommitmentLedger(unicode, copy);
      expect(bad.ok).toBe(false);
      expect(bad.report.issues.some((i) => i.code === "span")).toBe(true);
    }
  });

  it("requires explicit uncertainty, prior evidence, unique items, and local text only", async () => {
    const { ledger } = await fixture();
    const item = ledger.items[0]!;
    const badItems = [
      { ...item, owner: null, uncertainty: null }, { ...item, state: "uncertain", uncertainty: null },
      { ...item, priorEvidence: [] }, { ...item, replyText: { tool: "gmail_send" } }, { ...item, to: ["target@example.test"] },
    ];
    for (const bad of badItems) expect(CommitmentLedger.safeParse({ ...ledger, items: [bad] }).success).toBe(false);
    expect(CommitmentLedger.safeParse({ ...ledger, items: [item, item] }).success).toBe(false);
  });

  it("requires matching truncation/omissions and explicit incomplete coverage", async () => {
    const { snapshot, ledger } = await fixture();
    const d = draft(snapshot);
    d.coverage = { ...d.coverage, omittedMessages: null };
    d.messages[0] = { ...d.messages[0]!, truncated: true, omittedChars: 10 };
    const incomplete = await createCommitmentSnapshot(d);
    const output = { ...ledger, snapshotHash: incomplete.snapshotHash };
    expect((await validateCommitmentLedger(incomplete, output)).ok).toBe(false);
    output.coverage = { scope: "supplied-snapshot", omittedMessages: null, truncatedMessageIds: ["learn-01-m1"], limitations: ["Source is incomplete."] };
    expect((await validateCommitmentLedger(incomplete, output)).ok).toBe(true);
  });
});

describe("trusted validation-suite registry and wire boundaries", () => {
  it("keeps fresh cases and all oracle fields out of model-input getters", async () => {
    expect(listWorkflowFixtures().map((f) => f.id)).toEqual(["learn-01", "learn-02", "learn-03", "learn-04", "validate-01", "validate-02", "validate-03", "validate-04"]);
    expect(await getWorkflowFixture("fresh-01")).toBeUndefined();
    expect(await getWorkflowFixture("fresh-11")).toBeUndefined();
    const snapshot = await getWorkflowFixture("validate-01");
    expect(JSON.stringify(snapshot)).not.toContain('"oracle"');
    expect(JSON.stringify(snapshot)).not.toContain('"titleTerms"');
    expect(JSON.stringify(snapshot)).not.toContain('"items"');
  });

  it("runs the host oracle, not a candidate-uploaded PASS", async () => {
    const result = await evaluateWorkflowSuite(WORKFLOW_VALIDATION_SUITE.id, async () => ({ passed: true, checks: [] }));
    expect(result.passed).toBe(false);
    expect(result.cases).toHaveLength(4);
    expect(result.cases.every((c) => !c.contractValid && !c.oraclePassed)).toBe(true);
  });

  it("checks good actual fixture outputs and reports only synthetic-oracle assurance", async () => {
    const oracles: Record<string, CommitmentOracle> = { "validate-01": validationOracle1 as CommitmentOracle, "validate-02": validationOracle2 as CommitmentOracle,
      "validate-03": validationOracle3 as CommitmentOracle, "validate-04": validationOracle4 as CommitmentOracle };
    const seen: string[] = [];
    const result = await evaluateWorkflowSuite(WORKFLOW_VALIDATION_SUITE.id, async (snapshot, caseId) => {
      seen.push(snapshot.snapshotHash);
      return oracleLedger(snapshot, oracles[caseId]!);
    });
    expect(result.passed).toBe(true);
    expect(seen).toHaveLength(4);
    expect(result.modelEfficacyMeasured).toBe(false);
    expect(result.cases.every((c) => !c.semanticVerified && c.checks.every((check) => check.passed))).toBe(true);
  });

  it("retains every thrown/failed case and refuses an unknown suite", async () => {
    const result = await evaluateWorkflowSuite(WORKFLOW_VALIDATION_SUITE.id, async () => { throw new Error("callback failed"); });
    expect(result.cases).toHaveLength(4);
    expect(result.cases.every((c) => c.error === "callback failed")).toBe(true);
    expect(result.passed).toBe(false);
    await expect(evaluateWorkflowSuite("candidate-custom-suite", async () => ({ passed: true }))).rejects.toThrow("Unknown host-registered");
  });

  it("validates request exclusivity and never treats missing usage as complete", async () => {
    const { snapshot } = await fixture();
    expect(WorkflowRunRequest.safeParse({ userId: "user", fixtureId: "learn-01" }).success).toBe(true);
    expect(WorkflowRunRequest.safeParse({ userId: "user", fixtureId: "learn-01", snapshot }).success).toBe(false);
    expect(WorkflowRunRequest.safeParse({ userId: "user", oracle: { passed: true } }).success).toBe(false);
    expect(WorkflowUsage.safeParse({ kind: "unknown", inputTokens: null, outputTokens: null, rootCalls: 0, childCalls: 0, complete: true }).success).toBe(false);
  });
});


describe("truthful metadata and reserved bounded trace", () => {
  it("describes actual/unknown effort instead of asserting every provider ran max", async () => {
    const { snapshot, ledger } = await fixture();
    const result = {
      runId: "metadata-test", workflowId: snapshot.workflowId, mode: "baseline",
      snapshotId: snapshot.snapshotId, snapshotHash: snapshot.snapshotHash, status: "complete", ledger,
      validation: { level: "contract-only", valid: true, semanticVerified: false, issues: [] },
      usage: { kind: "synthetic", inputTokens: 0, outputTokens: 0, rootCalls: 0, childCalls: 0, complete: true },
      refinement: null, model: { provider: "fixture-metadata", model: "not-invoked", effort: null }, elapsedMs: 0, notices: [],
    };
    expect(WorkflowRunResult.safeParse(result).success).toBe(true);
    expect(WorkflowRunResult.safeParse({ ...result, model: { ...result.model, effort: "provider-default" } }).success).toBe(true);
    expect(WorkflowRunResult.safeParse({ ...result, model: null }).success).toBe(true);
  });

  it("bounds trace lineage and refuses raw code/HTML or dangling references", () => {
    const trace = {
      schemaVersion: 1, snapshotHash: "1".repeat(64), contextHash: "2".repeat(64), outcome: "complete",
      limits: { maxDepth: 1, maxCalls: 2, maxOperations: 2, maxReturnedChars: 1_000 },
      nodes: [{ id: "root", parentId: null, depth: 0 }, { id: "child", parentId: "root", depth: 1 }],
      calls: [
        { id: "call-1", nodeId: "root", parentCallId: null, inputTokens: 2, outputTokens: 2, outcome: "complete" },
        { id: "call-2", nodeId: "child", parentCallId: "call-1", inputTokens: 3, outputTokens: 3, outcome: "complete" },
      ],
      operations: [{ id: "op-1", nodeId: "root", kind: "slice", codeHash: null, outcome: "complete", returnedChars: 10, sourceIds: ["m1"] }],
      truncated: false,
    };
    expect(WorkflowAnalysisTrace.safeParse(trace).success).toBe(true);
    expect(WorkflowAnalysisTrace.safeParse({ ...trace, contextHash: null }).success).toBe(false);
    expect(WorkflowAnalysisTrace.safeParse({ ...trace, nodes: [{ id: "bad", parentId: "missing", depth: 1 }] }).success).toBe(false);
    expect(WorkflowAnalysisTrace.safeParse({ ...trace, calls: [{ ...trace.calls[1], parentCallId: "missing" }] }).success).toBe(false);
    expect(WorkflowAnalysisTrace.safeParse({ ...trace, operations: [{ ...trace.operations[0], rawCode: "<script>run()</script>" }] }).success).toBe(false);
    expect(WorkflowAnalysisTrace.safeParse({ ...trace, operations: Array(65).fill(trace.operations[0]) }).success).toBe(false);
  });

  it("keeps even long Unicode schema diagnostics valid and bounded", async () => {
    const { snapshot } = await fixture();
    const report = (await validateCommitmentSnapshot({ ...snapshot, ["a".repeat(478) + "😀".repeat(40)]: true })).report;
    expect(report.valid).toBe(false);
    expect(WorkflowValidationReport.safeParse(report).success).toBe(true);
    expect(report.issues.every((entry) => entry.message.length <= 500 && entry.message.isWellFormed())).toBe(true);
  });
});


describe("public workflow discovery contract", () => {
  it("exposes current contract identity and bounded learning/validation metadata only", () => {
    const value = {
      workflowId: "mail.commitment-handoff.v1", workflowContractHash: "a".repeat(64), schemaVersion: 1,
      supportedModes: ["baseline", "refinements"],
      fixtures: [{ id: "learn-01", title: "Studio correspondence", split: "learning" }, { id: "validate-01", title: "Workshop correspondence", split: "validation" }],
    };
    expect(WorkflowDescribeResponse.safeParse(value).success).toBe(true);
    expect(WorkflowDescribeResponse.safeParse({ ...value, model: "unrequested-model-setting" }).success).toBe(false);
    expect(WorkflowDescribeResponse.safeParse({ ...value, fixtures: [{ ...value.fixtures[0], body: "private body" }] }).success).toBe(false);
    expect(WorkflowDescribeResponse.safeParse({ ...value, fixtures: [{ ...value.fixtures[0], oracle: { passed: true } }] }).success).toBe(false);
    expect(WorkflowDescribeResponse.safeParse({ ...value, fixtures: [{ ...value.fixtures[0], split: "fresh" }] }).success).toBe(false);
  });

  it("rejects invalid contract identity, duplicate modes/fixtures, and reference URLs", () => {
    const value = {
      workflowId: "mail.commitment-handoff.v1", workflowContractHash: "b".repeat(64), schemaVersion: 1,
      supportedModes: ["baseline"], fixtures: [{ id: "learn-01", title: "Studio correspondence", split: "learning" }],
    };
    expect(WorkflowDescribeResponse.safeParse({ ...value, workflowContractHash: "latest" }).success).toBe(false);
    expect(WorkflowDescribeResponse.safeParse({ ...value, schemaVersion: 2 }).success).toBe(false);
    expect(WorkflowDescribeResponse.safeParse({ ...value, supportedModes: [] }).success).toBe(false);
    expect(WorkflowDescribeResponse.safeParse({ ...value, supportedModes: ["baseline", "baseline"] }).success).toBe(false);
    expect(WorkflowDescribeResponse.safeParse({ ...value, fixtures: [value.fixtures[0], value.fixtures[0]] }).success).toBe(false);
    expect(WorkflowDescribeResponse.safeParse({ ...value, fixtures: [{ ...value.fixtures[0], id: "https://example.test/source" }] }).success).toBe(false);
  });
});


describe("expanded registered corpus", () => {
  it("keeps four small qualification cases inside one eight-request source envelope", async () => {
    const snapshots = await Promise.all(WORKFLOW_VALIDATION_SUITE.caseIds.map(getWorkflowFixture));
    expect(snapshots).toHaveLength(4);
    expect(snapshots.every((snapshot) => snapshot && snapshot.messages.length <= 5)).toBe(true);
    const sourceReplayBytes = snapshots.reduce((sum, snapshot) => sum + new TextEncoder().encode(JSON.stringify(snapshot)).byteLength, 0) * 2;
    // Source-component headroom only; the parent enforces complete request bytes.
    expect(sourceReplayBytes).toBeLessThan(2 * 1024 * 1024);
    expect(snapshots.length * 2).toBeLessThanOrEqual(10);
  });

  it("rejects an invented end-of-day instant for a day-only commitment", async () => {
    const snapshot = (await getWorkflowFixture("learn-03"))!;
    const authored = dayOnlyOracle as CommitmentOracle;
    const ledger = oracleLedger(snapshot, authored);
    expect(ledger.items[0]!.dueAt).toBeNull();
    ledger.items[0]!.dueAt = "2026-10-14T23:59:59-07:00";
    expect((await validateCommitmentLedger(snapshot, ledger)).ok).toBe(true);
    const score = await scoreWorkflowCase(snapshot, ledger, authored);
    expect(score.oraclePassed).toBe(false);
    expect(score.corrections.some((correction) => correction.field === "dueAt")).toBe(true);
  });

  it("requires the accepted owner transfer rather than retaining the original sender", async () => {
    const snapshot = (await getWorkflowFixture("validate-03"))!;
    const authored = validationOracle3 as CommitmentOracle;
    const ledger = oracleLedger(snapshot, authored);
    ledger.items[0]!.owner = snapshot.userAddress;
    const score = await scoreWorkflowCase(snapshot, ledger, authored);
    expect(score.contractValid).toBe(true);
    expect(score.oraclePassed).toBe(false);
    expect(score.corrections.some((correction) => correction.field === "owner")).toBe(true);
  });

  it("does not turn a truncated conditional offer into accepted ownership", async () => {
    const snapshot = (await getWorkflowFixture("validate-04"))!;
    const authored = validationOracle4 as CommitmentOracle;
    const ledger = oracleLedger(snapshot, authored);
    expect(ledger.coverage.omittedMessages).toBe(1);
    expect(ledger.coverage.truncatedMessageIds).toEqual(["validate-04-m2"]);
    ledger.items[0]!.owner = "jo@example.test";
    ledger.items[0]!.state = "waiting";
    const score = await scoreWorkflowCase(snapshot, ledger, authored);
    expect(score.oraclePassed).toBe(false);
    expect(score.corrections.some((correction) => correction.field === "state")).toBe(true);
  });
});


describe("common source-only UTF16 offset aid", () => {
  it("is deterministic, immutable, source-bound, and contains no duplicated body/semantic fields", async () => {
    const { snapshot } = await fixture();
    const before = JSON.stringify(snapshot);
    const index = await createCommitmentSourceIndex(snapshot);
    expect(JSON.stringify(index)).toBe(JSON.stringify(await createCommitmentSourceIndex(snapshot)));
    expect(JSON.stringify(snapshot)).toBe(before);
    expect(index.snapshotId).toBe(snapshot.snapshotId);
    expect(index.snapshotHash).toBe(snapshot.snapshotHash);
    expect(index.lineIndexComplete).toBe(true);
    expect(Object.isFrozen(index.messages[0]!.lines[0])).toBe(true);
    for (const [position, indexed] of index.messages.entries()) {
      const message = snapshot.messages[position]!;
      expect(indexed.messageId).toBe(message.id);
      expect(indexed.bodyHash).toBe(message.bodyHash);
      expect(indexed.fullBody).toEqual([0, message.body.length]);
      expect(Object.keys(indexed)).toEqual(["messageId", "bodyHash", "fullBody", "lineCount", "lines", "omittedLineCount"]);
      expect(Object.hasOwn(indexed, "body")).toBe(false);
      expect(Object.hasOwn(indexed, "oracle")).toBe(false);
      expect(Object.hasOwn(indexed, "state")).toBe(false);
    }
    expect(JSON.stringify(index)).not.toContain("Design pack:");
  });

  it("counts UTF16 exactly across CRLF, CR, LF and Unicode line separators", async () => {
    const { snapshot } = await fixture();
    const input = draft(snapshot);
    input.messages = [{ ...input.messages[0]!, body: "A\r\n😀\rB\nC\u0085D\u2028E\u2029" }];
    const source = await createCommitmentSnapshot(input);
    const index = await createCommitmentSourceIndex(source);
    expect(index.lineBreaks).toBe("CRLF|CR|LF|NEL|LS|PS");
    expect(index.messages[0]!.fullBody).toEqual([0, 14]);
    expect(index.messages[0]!.lineCount).toBe(7);
    expect(index.messages[0]!.lines).toEqual([[0, 1], [3, 5], [6, 7], [8, 9], [10, 11], [12, 13], [14, 14]]);
    expect(index.messages[0]!.lines.map(([start, end]) => source.messages[0]!.body.slice(start, end))).toEqual(["A", "😀", "B", "C", "D", "E", ""]);
  });

  it("keeps empty, unterminated and trailing empty lines without normalizing text", async () => {
    const { snapshot } = await fixture();
    const input = draft(snapshot);
    input.messages = ["", "Cafe\u0301", "a\n", "literal\\n"].map((body, i) => ({ ...input.messages[0]!, id: `line-${i}`, body }));
    const source = await createCommitmentSnapshot(input);
    const index = await createCommitmentSourceIndex(source);
    expect(index.messages.map(({ lines }) => lines)).toEqual([[[0, 0]], [[0, 5]], [[0, 1], [2, 2]], [[0, 9]]]);
    expect(source.messages[1]!.body).toBe("Cafe\u0301");
    const empty = await createCommitmentSourceIndex(await createCommitmentSnapshot({ ...input, messages: [] }));
    expect(empty.messages).toEqual([]);
    expect(empty.lineIndexComplete).toBe(true);
  });

  it("discloses a fixed line cap without clipping source or late message body bounds", async () => {
    const { snapshot } = await fixture();
    const input = draft(snapshot);
    input.messages = Array.from({ length: 32 }, (_, i) => ({ ...input.messages[0]!, id: `dense-${i}`, body: "\n".repeat(3_000) }));
    const source = await createCommitmentSnapshot(input);
    const index = await createCommitmentSourceIndex(source);
    expect(index.messages).toHaveLength(32);
    expect(index.lineIndexComplete).toBe(false);
    expect(index.messages.every((message) => message.lineCount === 3_001 && message.lines.length === 256 && message.omittedLineCount === 2_745)).toBe(true);
    expect(index.messages[31]!.fullBody).toEqual([0, 3_000]);
    expect(source.messages.every((message) => message.body.length === 3_000)).toBe(true);
    expect(new TextEncoder().encode(JSON.stringify(index)).byteLength).toBeLessThanOrEqual(COMMITMENT_SOURCE_INDEX_BOUNDS.serializedBytes);
    expect(COMMITMENT_SOURCE_INDEX_BOUNDS.serializedBytes).toBeLessThan(512 * 1024);
  });

  it("does not call source truncation a complete mailbox and rejects stale identity", async () => {
    const { snapshot } = await fixture();
    const input = draft(snapshot);
    input.coverage = { ...input.coverage, omittedMessages: null };
    input.messages[0] = { ...input.messages[0]!, body: "Visible prefix", truncated: true, omittedChars: 91 };
    const source = await createCommitmentSnapshot(input);
    const index = await createCommitmentSourceIndex(source);
    expect(index.lineIndexComplete).toBe(true); // Only the supplied-line aid is complete.
    expect(Object.hasOwn(index, "coverage")).toBe(false);
    expect(index.messages[0]!.fullBody).toEqual([0, 14]);
    const tampered = structuredClone(source);
    tampered.messages[0]!.body += "!";
    await expect(createCommitmentSourceIndex(tampered)).rejects.toThrow("invalid commitment snapshot");
  });
});

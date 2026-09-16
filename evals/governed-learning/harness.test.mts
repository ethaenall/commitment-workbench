// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import test from "node:test";
import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { loadEvaluationKit, evaluateMatrix, deterministicReplay, summarizeMatrix, verifyFoundationArchive, MATRIX_ARM_ORDERS } from "./harness.mjs";
import { oracleLedger } from "./oracle-ledger.js";

test("manifest hashes and split identities agree with all registered source/oracle files", async () => {
  const kit = await loadEvaluationKit();
  assert.equal(kit.cases.length, 20);
  assert.deepEqual(["learning", "validation", "fresh"].map((split) => kit.cases.filter((c) => c.entry.split === split).length), [4, 4, 12]);
  assert.equal(new Set(kit.cases.map((c) => c.entry.snapshotHash)).size, 20);
  assert.equal(new Set(kit.cases.map((c) => c.entry.family)).size, 20);
  assert.equal(kit.manifest.modelPolicy.liveCallsAuthorized, false);
});

test("authored replay retains every arm/case and never claims real efficacy or forced uplift", async () => {
  const replay = await deterministicReplay(await loadEvaluationKit());
  assert.equal(replay.rows.length, 80);
  assert.equal(replay.kind, "authored-answer-contract-replay");
  assert.equal(replay.runtimeModesExercised, false);
  assert.equal(replay.modelEfficacyMeasured, false);
  assert.equal(replay.realModelCalls, 0);
  assert.ok(replay.rows.every((row) => row.score?.oraclePassed));
  assert.deepEqual(replay.summary.map((arm) => arm.authoredOraclePasses), [20, 20, 20, 20]);
});

test("matrix gives identical frozen input bytes to all arms; unavailable modes remain blocked", async () => {
  const kit = await loadEvaluationKit();
  const inputs = new Map<string, string[]>();
  const rows = await evaluateMatrix(kit, async (input) => {
    assert.deepEqual(Object.keys(input).sort(), ["mode", "snapshot"]);
    assert.ok(Object.isFrozen(input.snapshot.messages[0]));
    const seen = inputs.get(input.snapshot.snapshotId) ?? [];
    seen.push(JSON.stringify(input.snapshot));
    inputs.set(input.snapshot.snapshotId, seen);
    if (input.mode === "rlm" || input.mode === "both") return {
      status: "blocked", ledger: null, elapsedMs: 0,
      usage: { kind: "synthetic", inputTokens: 0, outputTokens: 0, rootCalls: 0, childCalls: 0, complete: true },
    };
    const oracle = kit.cases.find((c) => c.entry.id === input.snapshot.snapshotId)!.oracle;
    return { status: "complete", ledger: oracleLedger(input.snapshot, oracle), elapsedMs: 1,
      usage: { kind: "synthetic", inputTokens: 20, outputTokens: 10, rootCalls: 2, childCalls: 0, complete: true } };
  });
  assert.ok([...inputs.values()].every((values) => values.length === 4 && new Set(values).size === 1));
  assert.equal(rows.filter((row) => row.status === "blocked").length, 40);
  assert.ok(rows.filter((row) => row.status === "blocked").every((row) => row.score === null));
});

test("all errors are retained and missing usage is unknown, not a free run", async () => {
  const rows = await evaluateMatrix(await loadEvaluationKit(), async () => { throw new Error("fixture runner failed"); });
  assert.equal(rows.length, 80);
  assert.ok(rows.every((row) => row.status === "error" && row.usage.inputTokens === null && !row.usage.complete));
  assert.ok(summarizeMatrix(rows).every((arm) => arm.errors === 20 && arm.inputTokens === null && arm.childCalls === null));
});

test("report retains child usage in every arm rather than counting only roots", async () => {
  const kit = await loadEvaluationKit();
  const rows = await evaluateMatrix(kit, async ({ snapshot }) => ({
    status: "complete", ledger: oracleLedger(snapshot, kit.cases.find((c) => c.entry.id === snapshot.snapshotId)!.oracle), elapsedMs: 2,
    usage: { kind: "synthetic", inputTokens: 37, outputTokens: 11, rootCalls: 2, childCalls: 3, complete: true },
  }));
  assert.ok(summarizeMatrix(rows).every((arm) => arm.inputTokens === 740 && arm.outputTokens === 220 && arm.rootCalls === 40 && arm.childCalls === 60));
});

test("invalid usage and forged pass cannot bypass real result checks", async () => {
  const rows = await evaluateMatrix(await loadEvaluationKit(), async () => ({
    status: "complete", ledger: { passed: true }, elapsedMs: 0,
    usage: { kind: "unknown", inputTokens: null, outputTokens: null, rootCalls: 0, childCalls: 0, complete: true },
  }));
  assert.ok(rows.every((row) => row.status === "error" && row.score === null));
});


test("new fresh pilot excludes examined foundation while preserving original bytes", async () => {
  const kit = await loadEvaluationKit();
  const archive = await verifyFoundationArchive(kit.manifest.foundationArchive.indexHash, kit.manifest.foundationArchive.manifestHash);
  assert.equal(archive.status, "examined-foundation-development-not-held-out");
  assert.equal(archive.fileCount, 27);
  assert.equal(archive.manifestHash, "7caf81e7a9df37441755738f7935a4525da6779196ff2008e72f13b55e3ebb93");
  assert.ok(kit.cases.every(({ entry }) => !archive.excludedFreshCaseIds.includes(entry.id)));
  assert.deepEqual(kit.cases.filter(({ entry }) => entry.split === "fresh").map(({ entry }) => entry.id), Array.from({ length: 12 }, (_, i) => `fresh-${String(i + 5).padStart(2, "0")}`));
});

test("difficulty strata are substantive, bounded, and not supplied to model callbacks", async () => {
  const kit = await loadEvaluationKit();
  const routine = kit.cases.filter(({ entry }) => entry.difficulty === "routine");
  const demanding = kit.cases.filter(({ entry }) => entry.difficulty === "demanding");
  assert.equal(routine.length, 6);
  assert.equal(demanding.length, 6);
  assert.ok(routine.every(({ snapshot }) => snapshot.messages.length >= 3 && snapshot.messages.length < 12));
  assert.ok(demanding.every(({ snapshot, oracle }) => snapshot.messages.length >= 12 && snapshot.messages.length <= 32 && oracle.items.length >= 3 && oracle.items.length <= 12));
  assert.ok(demanding.every(({ snapshot }) => new Set(snapshot.messages.map(({ threadId }) => threadId)).size >= 3));
  await evaluateMatrix(kit, async (input) => {
    assert.deepEqual(Object.keys(input).sort(), ["mode", "snapshot"]);
    for (const field of ["oracle", "family", "difficulty", "titleTerms", "corrections"]) assert.equal(Object.hasOwn(input.snapshot, field), false);
    return { status: "blocked", ledger: null, elapsedMs: 0,
      usage: { kind: "synthetic", inputTokens: 0, outputTokens: 0, rootCalls: 0, childCalls: 0, complete: true } };
  });
});

test("multilingual revised dates and Unicode evidence remain exact without invented instants", async () => {
  const kit = await loadEvaluationKit();
  const example = kit.cases.find(({ entry }) => entry.id === "fresh-13")!;
  const ledger = oracleLedger(example.snapshot, example.oracle);
  const spanish = ledger.items.find(({ title }) => title.includes("Spanish"))!;
  assert.equal(spanish.changed, true);
  assert.equal(spanish.dueAt, null);
  assert.ok(spanish.priorEvidence.length > 0);
  assert.ok(example.snapshot.messages.some(({ body }) => body.includes("Cafe\u0301")));
  for (const item of ledger.items) {
    for (const evidence of [...item.evidence, ...item.priorEvidence]) {
      const message = example.snapshot.messages.find(({ id }) => id === evidence.messageId)!;
      assert.equal(message.body.slice(evidence.start, evidence.end), evidence.quote);
      assert.ok([...message.body.slice(0, evidence.start)].length < evidence.start);
    }
  }
});


test("frozen pilot order balances every mode pair within each difficulty stratum", async () => {
  const kit = await loadEvaluationKit();
  const protocol = JSON.parse(await readFile(new URL("./pilot-protocol.json", import.meta.url), "utf8")) as {
    freshRunOrder: string[]; armOrder: { sequences: string[][] };
  };
  assert.deepEqual(protocol.armOrder.sequences, MATRIX_ARM_ORDERS);
  const freshCases = protocol.freshRunOrder.map((id) => kit.cases.find(({ entry }) => entry.id === id)!);
  assert.equal(new Set(freshCases.map(({ entry }) => entry.id)).size, 12);
  const rows = await evaluateMatrix({ ...kit, cases: freshCases }, async () => ({
    status: "blocked", ledger: null, elapsedMs: 0,
    usage: { kind: "synthetic", inputTokens: 0, outputTokens: 0, rootCalls: 0, childCalls: 0, complete: true },
  }));
  for (const difficulty of ["routine", "demanding"]) {
    const orders = freshCases.filter(({ entry }) => entry.difficulty === difficulty).map(({ entry }) => rows.filter((row) => row.caseId === entry.id).map(({ mode }) => mode));
    assert.equal(orders.length, 6);
    for (const first of kit.manifest.arms) {
      for (const second of kit.manifest.arms) {
        if (first !== second) assert.equal(orders.filter((order) => order.indexOf(first) < order.indexOf(second)).length, 3);
      }
    }
  }
});

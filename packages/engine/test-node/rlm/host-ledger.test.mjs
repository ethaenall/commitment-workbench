// SPDX-License-Identifier: AGPL-3.0-only
// Host ledger assembly regressions. No provider connection.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assembleHostLedger,
  bindExtractQuote,
  collapseHostItems,
  shouldRecoverHostSnapshot,
  titleCore,
  titlesOverlap,
} from "../../src/workflows/rlm-runtime.ts";

const HASH = "a".repeat(64);
const BODY = "I will finish the reed material-use table review on 12 October 2026.";
const snapshot = {
  workflowId: "mail.commitment-handoff.v1",
  schemaVersion: 1,
  snapshotId: "host-ledger-fixture",
  snapshotHash: "b".repeat(64),
  userAddress: "sam@example.test",
  cutoff: "2026-10-20T00:00:00Z",
  timezone: "UTC",
  coverage: { scope: "supplied-snapshot", source: "synthetic-fixture", omittedMessages: 0, note: "fixture" },
  messages: [{
    id: "m1", threadId: "t1", subject: "review", sender: "sam@example.test", to: "leila@example.test",
    timestamp: "2026-10-05T15:10:00Z", body: BODY, bodyHash: HASH, truncated: false, omittedChars: 0,
  }],
};

test("bindExtractQuote records the exact UTF-16 span", () => {
  const bound = bindExtractQuote(snapshot, "m1", BODY);
  assert.equal(bound.messageId, "m1");
  assert.equal(bound.bodyHash, HASH);
  assert.equal(bound.start, 0);
  assert.equal(bound.end, BODY.length);
  assert.equal(bound.quote, BODY);
  assert.equal(bindExtractQuote(snapshot, "m1", "not in body"), null);
});

test("shouldRecoverHostSnapshot recovers truncated JSON and matching dumps", () => {
  assert.equal(shouldRecoverHostSnapshot("{not-json", snapshot), true);
  assert.equal(shouldRecoverHostSnapshot(JSON.stringify({ snapshot: { snapshotHash: snapshot.snapshotHash } }), snapshot), true);
  assert.equal(shouldRecoverHostSnapshot(JSON.stringify({ excerpt: "ok" }), snapshot), false);
});

test("title overlap treats a verb-prefixed title as the same commitment", () => {
  assert.equal(titleCore("Finish reed material-use table review"), "reed material use table review");
  assert.equal(titlesOverlap("Finish reed material-use table review", "Reed material-use table review"), true);
  assert.equal(titlesOverlap("Sediment control review", "Return sediment control review"), true);
  assert.equal(titlesOverlap("Sediment control review", "Reed accession transcription"), false);
});

test("collapse keeps the longer specific title", () => {
  const rows = [
    { title: "Material-use review", owner: "sam@example.test", state: "due", dueAt: null, evidence: [{ messageId: "m1", bodyHash: HASH, start: 0, end: 4, quote: "I wi" }] },
    { title: "Reed material-use table review", owner: "sam@example.test", state: "due", dueAt: null, evidence: [{ messageId: "m1", bodyHash: HASH, start: 5, end: 10, quote: "l fin" }] },
  ];
  const out = collapseHostItems(rows);
  assert.equal(out.length, 1);
  assert.equal(out[0].title, "Reed material-use table review");
  assert.equal(out[0].evidence.length, 2);
});

test("assembleHostLedger binds quotes and strips illegal dueAt", () => {
  const extracts = [
    { items: [{ title: "Finish reed material-use table review", owner: "sam@example.test", state: "due", dueAt: "12 October 2026", evidence: [{ messageId: "m1", quote: BODY }] }] },
    { items: [{ title: "Reed material-use table review", owner: "sam@example.test", state: "due", dueAt: null, evidence: [{ messageId: "m1", quote: BODY }] }] },
  ];
  const ledger = assembleHostLedger(snapshot, extracts);
  assert.equal(ledger.snapshotId, snapshot.snapshotId);
  assert.equal(ledger.snapshotHash, snapshot.snapshotHash);
  assert.equal(ledger.items.length, 1);
  assert.match(ledger.items[0].title, /reed material-use table review/i);
  assert.equal(ledger.items[0].dueAt, null);
  assert.equal(ledger.items[0].evidence[0].quote, BODY);
  assert.equal(ledger.items[0].evidence[0].start, 0);
  assert.equal(ledger.coverage.scope, "supplied-snapshot");
});

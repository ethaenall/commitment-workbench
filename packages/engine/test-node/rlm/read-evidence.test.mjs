import assert from "node:assert/strict";
import { test } from "node:test";
import { createReadEvidence, recordSuccessfulSlice, recordSuccessfulExecute, snapshotReadEvidence } from "../../src/rlm/read-evidence.mjs";

const slice = (extra = {}) => ({ nodeId: "n0", start: 0, count: 1, utf8Bytes: 8, returnedChars: 5, ...extra });
const execute = (extra = {}) => ({ nodeId: "n0", parentId: null, depth: 0, sourceSha256: "a".repeat(64), ...extra });

test("v2 preserves UTF16 delivery length separately from UTF8 bytes", () => {
  const text = "α🚀\nX";
  const evidence = createReadEvidence();
  recordSuccessfulSlice(evidence, slice({ count: 2, utf8Bytes: Buffer.byteLength(text), returnedChars: text.length }));
  const snapshot = snapshotReadEvidence(evidence);
  assert.equal(snapshot.version, 2);
  assert.equal(snapshot.slices[0].returnedChars, 5);
  assert.equal(snapshot.slices[0].utf8Bytes, 8);
  assert.equal(snapshot.truncated, false);
});

test("missing or malformed delivery length is refused before retention", () => {
  for (const returnedChars of [undefined, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    const evidence = createReadEvidence();
    assert.throws(() => recordSuccessfulSlice(evidence, slice({ returnedChars })), { code: "INVALID_INPUT" });
    assert.equal(evidence.slices.length, 0);
  }
});

test("UTF16 length cannot exceed its well-formed UTF8 byte count", () => {
  const evidence = createReadEvidence();
  assert.throws(() => recordSuccessfulSlice(evidence, slice({ utf8Bytes: 2, returnedChars: 3 })), { code: "INVALID_INPUT" });
});

test("slice capacity refusal explicitly marks incomplete evidence", () => {
  const evidence = createReadEvidence({ maxSlices: 1 });
  recordSuccessfulSlice(evidence, slice());
  assert.throws(() => recordSuccessfulSlice(evidence, slice({ start: 1 })), { code: "SLICE_EVIDENCE_BUDGET" });
  const snapshot = snapshotReadEvidence(evidence);
  assert.equal(snapshot.slices.length, 1);
  assert.equal(snapshot.truncated, true);
});

test("execution capacity refusal explicitly marks incomplete evidence", () => {
  const evidence = createReadEvidence({ maxExecutes: 1 });
  recordSuccessfulExecute(evidence, execute());
  assert.throws(() => recordSuccessfulExecute(evidence, execute({ nodeId: "n1", parentId: "n0", depth: 1 })), { code: "EXECUTE_EVIDENCE_BUDGET" });
  const snapshot = snapshotReadEvidence(evidence);
  assert.equal(snapshot.executes.length, 1);
  assert.equal(snapshot.truncated, true);
});

test("successful ranges remain a frozen union, not semantic completeness", () => {
  const evidence = createReadEvidence();
  recordSuccessfulSlice(evidence, slice({ count: 2 }));
  recordSuccessfulSlice(evidence, slice({ start: 1, count: 2 }));
  recordSuccessfulExecute(evidence, execute());
  const snapshot = snapshotReadEvidence(evidence);
  assert.deepEqual(snapshot.coverageByNode, [{ nodeId: "n0", ranges: [{ start: 0, end: 3 }] }]);
  assert.equal(snapshot.successfulSliceCount, 2);
  assert.equal(snapshot.successfulExecuteCount, 1);
  assert.equal(Object.isFrozen(snapshot.slices[0]), true);
});

// SPDX-License-Identifier: AGPL-3.0-only
// Host-owned successful slice/read/execute provenance. Not guest-trusted.
// Record only after the Worker has allocated/delivered the guest string.
// Failed reads (range/bytes/NUL/surrogate/OOM) must not be recorded.
// Coverage is a union of delivered row ranges per node, not semantic completeness
// and not NDJSON fragment sourceIds.

export const READ_EVIDENCE_VERSION = 2;

function fail(code) {
  throw Object.assign(new Error(code), { code });
}

function isNodeId(id) {
  return typeof id === "string" && id.length > 0 && id.length <= 32;
}

export function createReadEvidence(limits = {}) {
  const maxSlices = limits.maxSlices ?? 256;
  const maxExecutes = limits.maxExecutes ?? 8;
  const maxNodes = limits.maxNodes ?? 8;
  if (![maxSlices, maxExecutes, maxNodes].every((n) => Number.isSafeInteger(n) && n > 0)) fail("INVALID_LIMITS");
  return {
    slices: [],
    executes: [],
    truncated: false,
    limits: Object.freeze({ maxSlices, maxExecutes, maxNodes }),
  };
}

/** Call only after newString/delivery of the joined slice succeeded. */
export function recordSuccessfulSlice(evidence, rec) {
  if (!evidence || !rec) fail("INVALID_INPUT");
  if (!isNodeId(rec.nodeId)) fail("INVALID_INPUT");
  if (!Number.isSafeInteger(rec.start) || rec.start < 0) fail("INVALID_INPUT");
  if (!Number.isSafeInteger(rec.count) || rec.count < 1) fail("INVALID_INPUT");
  if (!Number.isSafeInteger(rec.utf8Bytes) || rec.utf8Bytes < 0) fail("INVALID_INPUT");
  if (!Number.isSafeInteger(rec.returnedChars) || rec.returnedChars < 0 || rec.returnedChars > rec.utf8Bytes) fail("INVALID_INPUT");
  if (evidence.slices.length >= evidence.limits.maxSlices) { evidence.truncated = true; fail("SLICE_EVIDENCE_BUDGET"); }
  evidence.slices.push(Object.freeze({
    nodeId: rec.nodeId,
    start: rec.start,
    count: rec.count,
    utf8Bytes: rec.utf8Bytes,
    returnedChars: rec.returnedChars,
  }));
  return true;
}

/** Call only after generated-guest evalCode handle was allocated. */
export function recordSuccessfulExecute(evidence, rec) {
  if (!evidence || !rec) fail("INVALID_INPUT");
  if (!isNodeId(rec.nodeId)) fail("INVALID_INPUT");
  if (typeof rec.sourceSha256 !== "string" || !/^[a-f0-9]{64}$/.test(rec.sourceSha256)) fail("INVALID_INPUT");
  if (rec.parentId != null && !isNodeId(rec.parentId)) fail("INVALID_INPUT");
  if (!Number.isSafeInteger(rec.depth) || rec.depth < 0) fail("INVALID_INPUT");
  if (evidence.executes.length >= evidence.limits.maxExecutes) { evidence.truncated = true; fail("EXECUTE_EVIDENCE_BUDGET"); }
  evidence.executes.push(Object.freeze({
    nodeId: rec.nodeId,
    parentId: rec.parentId ?? null,
    depth: rec.depth,
    sourceSha256: rec.sourceSha256,
  }));
  return true;
}

function mergeRanges(ranges) {
  const sorted = ranges.map((r) => ({ start: r.start, end: r.end })).sort((a, b) => a.start - b.start || a.end - b.end);
  const out = [];
  for (const r of sorted) {
    const last = out.length ? out[out.length - 1] : null;
    if (last && r.start <= last.end) last.end = Math.max(last.end, r.end);
    else out.push({ start: r.start, end: r.end });
  }
  return Object.freeze(out.map((r) => Object.freeze(r)));
}

export function snapshotReadEvidence(evidence) {
  if (!evidence || typeof evidence.truncated !== "boolean") fail("INVALID_INPUT");
  const byNode = new Map();
  for (const s of evidence.slices) {
    const list = byNode.get(s.nodeId) ?? [];
    list.push({ start: s.start, end: s.start + s.count });
    byNode.set(s.nodeId, list);
  }
  if (byNode.size > evidence.limits.maxNodes) fail("NODE_EVIDENCE_BUDGET");
  const coverageByNode = Object.freeze([...byNode.entries()].map(([nodeId, ranges]) =>
    Object.freeze({ nodeId, ranges: mergeRanges(ranges) })));
  return Object.freeze({
    version: READ_EVIDENCE_VERSION,
    truncated: evidence.truncated,
    successfulSliceCount: evidence.slices.length,
    successfulExecuteCount: evidence.executes.length,
    slices: Object.freeze(evidence.slices.slice()),
    executes: Object.freeze(evidence.executes.slice()),
    coverageByNode,
  });
}

// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Host-side source-only codec: pack the baseline workflow envelope
 * `JSON.stringify({ snapshot, sourceIndex })` into guest context rows.
 *
 * Guest reconstruction (documented; not exported as an untrusted decoder):
 *   split context on U+000A, JSON.parse each row, concatenate `.c`
 * Rows are NDJSON `{ i, c }` — envelope fragments, not a mail data model.
 *
 * Identity is the decoded snapshot+index. Evidence spans stay on original
 * UTF-16 bodies. Row UTF-8 cap is 20_000 (guest sliceBytes). 8KiB is the
 * native response cap, not a row cap.
 *
 * contextSlice joins up to 64 contiguous rows with U+000A and caps the
 * entire joined UTF-8 (including separators) at 20_000. Two full-size rows
 * cannot share a read. minContextReads is the greedy plan length, not
 * ceil(rows/64).
 *
 * Does not recompute or enrich the source-offset aid. Index JSON >128KiB
 * is refused. Fail closed; never trim.
 */

import type { CommitmentSnapshot } from "@habenula-ai/contracts";
import {
  COMMITMENT_SOURCE_INDEX_BOUNDS,
  hashWorkflowText,
  type CommitmentSourceIndex,
} from "./commitment-handoff";

/** Guest `LIMITS.sliceBytes` — per-row UTF-8 and joined-slice UTF-8. */
export const RLM_CONTEXT_ROW_UTF8_MAX = 20_000;
export const RLM_CONTEXT_SLICE_UTF8_MAX = 20_000;
export const RLM_CONTEXT_STORE_UTF8_MAX = 3 * 1024 * 1024;
export const RLM_CONTEXT_MAX_ROWS = 16_384;
export const RLM_CONTEXT_SLICE_ROWS = 64;
export const RLM_CONTEXT_MAX_READS = 256;

export type WorkflowRlmContextCodecCode =
  | "INVALID_INPUT"
  | "INDEX_BOUND"
  | "ROW_LIMIT"
  | "STORE_LIMIT"
  | "READ_LIMIT"
  | "UNENCODABLE";

export class WorkflowRlmContextCodecError extends Error {
  readonly code: WorkflowRlmContextCodecCode;
  constructor(code: WorkflowRlmContextCodecCode, message?: string) {
    super(message ?? code);
    this.name = "WorkflowRlmContextCodecError";
    this.code = code;
  }
}

export interface WorkflowRlmContextSlice {
  readonly start: number;
  readonly count: number;
  readonly utf8Bytes: number;
}

export interface WorkflowRlmContextCodecResult {
  readonly context: string;
  readonly contextId: string;
  readonly envelopeSha256: string;
  readonly envelopeUtf8Bytes: number;
  readonly contextUtf8Bytes: number;
  readonly rows: number;
  readonly maxRowUtf8Bytes: number;
  readonly contextSlicePlan: readonly WorkflowRlmContextSlice[];
  /** Equal to `contextSlicePlan.length`. Not `ceil(rows/64)`. */
  readonly minContextReads: number;
}

const utf8 = new TextEncoder();

function utf8Bytes(text: string): number {
  return utf8.encode(text).byteLength;
}

function fail(code: WorkflowRlmContextCodecCode, message?: string): never {
  throw new WorkflowRlmContextCodecError(code, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * UTF-8 length of `JSON.stringify(text)` for a well-formed string.
 * Matches Node 22 / JSON.stringify then TextEncoder (U+2028/U+2029 unescaped).
 */
function jsonStringUtf8Bytes(text: string): number {
  let n = 2;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 34 || c === 92 || c === 8 || c === 9 || c === 10 || c === 12 || c === 13) n += 2;
    else if (c < 32) n += 6;
    else if (c < 128) n += 1;
    else if (c < 2048) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff) {
      const d = text.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) { n += 4; i++; }
      else n += 3;
    } else if (c >= 0xdc00 && c <= 0xdfff) n += 3;
    else n += 3;
  }
  return n;
}

function jsonCharUtf8Bytes(text: string, i: number): { add: number; consume: number } {
  const c = text.charCodeAt(i);
  if (c === 34 || c === 92 || c === 8 || c === 9 || c === 10 || c === 12 || c === 13) return { add: 2, consume: 1 };
  if (c < 32) return { add: 6, consume: 1 };
  if (c < 128) return { add: 1, consume: 1 };
  if (c < 2048) return { add: 2, consume: 1 };
  if (c >= 0xd800 && c <= 0xdbff) {
    const d = text.charCodeAt(i + 1);
    if (d >= 0xdc00 && d <= 0xdfff) return { add: 4, consume: 2 };
    return { add: 3, consume: 1 };
  }
  if (c >= 0xdc00 && c <= 0xdfff) return { add: 3, consume: 1 };
  return { add: 3, consume: 1 };
}

function rowPrefixUtf8(index: number): number {
  return 5 + String(index).length + 5;
}

function serializedRowUtf8Bytes(index: number, fragment: string): number {
  return rowPrefixUtf8(index) + jsonStringUtf8Bytes(fragment) + 1;
}

function packRow(envelope: string, start: number, index: number): { end: number; row: string; bytes: number } {
  const overhead = rowPrefixUtf8(index) + 1 + 2;
  const budget = RLM_CONTEXT_ROW_UTF8_MAX - overhead;
  if (budget < 1) fail("UNENCODABLE");
  let i = start;
  let used = 0;
  while (i < envelope.length) {
    const step = jsonCharUtf8Bytes(envelope, i);
    if (used + step.add > budget) break;
    used += step.add;
    i += step.consume;
  }
  if (i <= start) fail("UNENCODABLE");
  const fragment = envelope.slice(start, i);
  const row = JSON.stringify({ i: index, c: fragment });
  const bytes = utf8Bytes(row);
  if (bytes !== serializedRowUtf8Bytes(index, fragment)) fail("UNENCODABLE");
  if (bytes > RLM_CONTEXT_ROW_UTF8_MAX || row.includes("\n") || row.includes("\0")) fail("UNENCODABLE");
  return { end: i, row, bytes };
}

/**
 * Greedy contiguous reads matching worker.mjs contextSlice:
 * count in 1..64, start+count <= rows.length, UTF-8 of join("\n") <= 20_000.
 */
export function planContextSlices(rows: readonly string[]): WorkflowRlmContextSlice[] {
  const plan: WorkflowRlmContextSlice[] = [];
  let start = 0;
  while (start < rows.length) {
    const first = utf8Bytes(rows[start]!);
    if (first > RLM_CONTEXT_SLICE_UTF8_MAX) fail("UNENCODABLE");
    let count = 1;
    let bytes = first;
    while (count < RLM_CONTEXT_SLICE_ROWS && start + count < rows.length) {
      const extra = 1 + utf8Bytes(rows[start + count]!);
      if (bytes + extra > RLM_CONTEXT_SLICE_UTF8_MAX) break;
      bytes += extra;
      count += 1;
    }
    plan.push(Object.freeze({ start, count, utf8Bytes: bytes }));
    start += count;
  }
  return plan;
}

export function workflowRlmEnvelope(snapshot: CommitmentSnapshot, sourceIndex: CommitmentSourceIndex): string {
  return JSON.stringify({ snapshot, sourceIndex });
}

export async function encodeWorkflowRlmContext(
  snapshot: CommitmentSnapshot,
  sourceIndex: CommitmentSourceIndex,
): Promise<Readonly<WorkflowRlmContextCodecResult>> {
  if (!isRecord(snapshot) || !isRecord(sourceIndex)) fail("INVALID_INPUT");
  if (typeof snapshot.snapshotId !== "string" || typeof snapshot.snapshotHash !== "string") fail("INVALID_INPUT");
  if (sourceIndex.kind !== "source-offset-index" || sourceIndex.schemaVersion !== 1) fail("INVALID_INPUT");
  if (sourceIndex.snapshotId !== snapshot.snapshotId || sourceIndex.snapshotHash !== snapshot.snapshotHash) {
    fail("INVALID_INPUT", "sourceIndex is not bound to this snapshot");
  }
  if (utf8Bytes(JSON.stringify(sourceIndex)) > COMMITMENT_SOURCE_INDEX_BOUNDS.serializedBytes) fail("INDEX_BOUND");

  const envelope = workflowRlmEnvelope(snapshot, sourceIndex);
  if (!envelope.isWellFormed()) fail("INVALID_INPUT", "envelope is not well-formed UTF-16");
  const envelopeSha256 = await hashWorkflowText(envelope);
  const envelopeUtf8Bytes = utf8Bytes(envelope);

  const rows: string[] = [];
  let offset = 0;
  let maxRowUtf8Bytes = 0;
  while (offset < envelope.length) {
    if (rows.length >= RLM_CONTEXT_MAX_ROWS) fail("ROW_LIMIT");
    const packed = packRow(envelope, offset, rows.length);
    rows.push(packed.row);
    maxRowUtf8Bytes = Math.max(maxRowUtf8Bytes, packed.bytes);
    offset = packed.end;
  }
  if (rows.length === 0) fail("INVALID_INPUT", "empty envelope");

  const context = rows.join("\n");
  if (context.includes("\0")) fail("UNENCODABLE");
  const contextUtf8Bytes = utf8Bytes(context);
  if (contextUtf8Bytes > RLM_CONTEXT_STORE_UTF8_MAX) fail("STORE_LIMIT");

  const contextSlicePlan = Object.freeze(planContextSlices(rows));
  const minContextReads = contextSlicePlan.length;
  if (minContextReads > RLM_CONTEXT_MAX_READS) fail("READ_LIMIT");

  return Object.freeze({
    context,
    contextId: "sha256:" + await hashWorkflowText(context),
    envelopeSha256,
    envelopeUtf8Bytes,
    contextUtf8Bytes,
    rows: rows.length,
    maxRowUtf8Bytes,
    contextSlicePlan,
    minContextReads,
  });
}


/** Coordinator adapter for validated snapshots and host-created source indexes. */
export function createContextCodecPort(): import("./rlm-host-types").RlmContextCodecPort {
  return Object.freeze({
    async encode(snapshot: unknown, sourceIndex: unknown) {
      const packed = await encodeWorkflowRlmContext(
        snapshot as CommitmentSnapshot, sourceIndex as CommitmentSourceIndex,
      );
      return Object.freeze({ ...packed, contextHash: packed.contextId.slice("sha256:".length) });
    },
  });
}

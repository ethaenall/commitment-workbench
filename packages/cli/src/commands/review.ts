// SPDX-License-Identifier: AGPL-3.0-only

import { constants, open } from "node:fs/promises";
import { COMMITMENT_WORKFLOW_ID, CommitmentSnapshot, WorkflowMode, WorkflowRunResult } from "@habenula-ai/contracts";
import { GOVERNED_WAIT_NOTICE, type RefinementDriver } from "../refinement-client";
import { terminalWidth } from "../render/attribution";
import { machineJson } from "../render/refinement";
import { renderWorkflow } from "../render/workflow";

export const SNAPSHOT_MAX_BYTES = 1024 * 1024;

/** Regular UTF-8 JSON DATA only. Stat before reading; cap even if the file grows. */
export async function readBoundedJson(path: string, maxBytes = SNAPSHOT_MAX_BYTES): Promise<unknown> {
  let file;
  try {
    // NONBLOCK prevents a supplied FIFO from hanging before fstat can reject it.
    // The legacy node:fs ambient shim only lists X_OK; these are native Node flags.
    const flags = constants as unknown as { O_RDONLY: number; O_NONBLOCK: number };
    file = await open(path, flags.O_RDONLY | flags.O_NONBLOCK);
  } catch {
    throw new Error("Cannot open the input JSON file. Check the path and read permission.");
  }
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw new Error("Input must be a regular JSON file, not a device, directory or pipe.");
    if (stat.size > maxBytes) throw new Error(`Input exceeds the ${maxBytes}-byte limit; nothing was submitted.`);
    const buffer = Buffer.alloc(maxBytes + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, null);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > maxBytes) throw new Error(`Input exceeds the ${maxBytes}-byte limit; nothing was submitted.`);
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, offset));
      return JSON.parse(text) as unknown;
    } catch {
      throw new Error("Input must be valid UTF-8 JSON data. It is never imported or executed.");
    }
  } finally { await file.close(); }
}

export interface ReviewOptions { mode: WorkflowMode; json?: boolean }
export interface ReviewIO {
  readJson: (path: string, maxBytes: number) => Promise<unknown>;
  write: (line: string) => void;
  writeErr?: (line: string) => void;
  width: number;
}
const defaultIO: ReviewIO = {
  readJson: readBoundedJson,
  write: (line) => process.stdout.write(`${line}\n`),
  writeErr: (line) => process.stderr.write(`${line}\n`),
  get width() { return terminalWidth(); },
};

/** Explicit fresh-context local analysis; no chat, service send or draft route. */
export async function runReview(client: Pick<RefinementDriver, "runWorkflow">, path: string,
  options: ReviewOptions, io: ReviewIO = defaultIO): Promise<number> {
  const mode = WorkflowMode.safeParse(options.mode);
  if (!mode.success) throw new Error("Mode must be baseline, refinements, rlm or both.");
  const parsed = CommitmentSnapshot.safeParse(await io.readJson(path, SNAPSHOT_MAX_BYTES));
  if (!parsed.success) throw new Error("Input does not match the commitment snapshot contract. Supply a sealed snapshot, not a draft, request envelope or oracle file.");
  const snapshot = parsed.data;
  io.writeErr?.(GOVERNED_WAIT_NOTICE);
  const response = WorkflowRunResult.safeParse(await client.runWorkflow({
    workflowId: COMMITMENT_WORKFLOW_ID, mode: mode.data, snapshot,
  }));
  if (!response.success) throw new Error("Workflow response failed its contract; no result accepted.");
  const result = response.data;
  if (result.snapshotHash !== snapshot.snapshotHash || result.snapshotId !== snapshot.snapshotId || result.mode !== mode.data) {
    throw new Error("Workflow response does not match the requested snapshot and mode; no result accepted.");
  }
  if (options.json) io.write(machineJson(result));
  else for (const line of renderWorkflow(result, snapshot, io.width)) io.write(line);
  return result.status === "complete" ? 0 : 1;
}

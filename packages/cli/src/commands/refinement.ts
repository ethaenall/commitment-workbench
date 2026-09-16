// SPDX-License-Identifier: AGPL-3.0-only

import { createInterface } from "node:readline";
import { stdin, stderr } from "node:process";
import type { Readable, Writable } from "node:stream";
import {
  RefinementDetailResponse,
  RefinementMutationResponse,
  RefinementProposeRequest,
  RefinementValidationResponse,
  WorkflowDescribeResponse,
  type RefinementApproveRequest,
} from "@habenula-ai/contracts";
import { GOVERNED_WAIT_NOTICE, type RefinementDriver, type RefinementListOptions } from "../refinement-client";
import type { PresenceGate } from "../gate/confirm-presence";
import { terminalWidth } from "../render/attribution";
import {
  dataField, machineJson, renderQualification, renderRefinementDetail,
  renderRefinementDiff, renderRefinementList, renderRefinementMutation,
} from "../render/refinement";
import { readBoundedJson } from "./review";

export interface JsonOptions { json?: boolean }
export interface RefinementListCommandOptions extends JsonOptions, RefinementListOptions {}
export interface RefinementValidateOptions extends JsonOptions { suite?: string }
export type RefinementTransition = "approve" | "activate" | "disable" | "rollback";
export interface RefinementTransitionOptions extends JsonOptions { reason?: string }
export interface RefinementIO {
  write: (line: string) => void;
  writeErr: (line: string) => void;
  ask: (prompt: string) => Promise<string | null>;
  readJson: (path: string, maxBytes: number) => Promise<unknown>;
  width: number;
}

/** EOF and Ctrl-C both decline. One line only; there is no buffered auto-yes loop. */
export function readConfirmation(input: Readable, output: Writable, prompt: string): Promise<string | null> {
  return new Promise((resolve) => {
    const rl = createInterface({ input, output, terminal: true });
    let done = false;
    const finish = (answer: string | null): void => {
      if (done) return;
      done = true;
      rl.close();
      resolve(answer);
    };
    rl.once("line", (line) => finish(line));
    rl.once("close", () => finish(null));
    rl.once("SIGINT", () => finish(null));
    output.write(prompt);
  });
}

// The legacy CLI ambient shim narrows these streams; Node supplies real streams.
const confirmationInput = stdin as Readable & { isTTY?: boolean };
const confirmationOutput = stderr as Writable & { isTTY?: boolean };
const defaultIO: RefinementIO = {
  write: (line) => process.stdout.write(`${line}\n`),
  writeErr: (line) => process.stderr.write(`${line}\n`),
  ask: (prompt) => confirmationInput.isTTY && confirmationOutput.isTTY
    ? readConfirmation(confirmationInput, confirmationOutput, prompt) : Promise.resolve(null),
  readJson: readBoundedJson,
  get width() { return terminalWidth(); },
};

async function exactDetail(client: RefinementDriver, id: string): Promise<RefinementDetailResponse> {
  const parsed = RefinementDetailResponse.safeParse(await client.get(id));
  if (!parsed.success || parsed.data.version.envelope.versionId !== id
    || parsed.data.scope.scopeKey !== parsed.data.version.scopeKey) {
    throw new Error("Refinement detail does not match the requested version and scope; no change made.");
  }
  return parsed.data;
}

function output(lines: string[], io: RefinementIO, preview = false): void {
  for (const line of lines) (preview ? io.writeErr : io.write)(line);
}

export async function runRefinementDescribe(client: RefinementDriver,
  options: JsonOptions = {}, io: RefinementIO = defaultIO): Promise<number> {
  const parsed = WorkflowDescribeResponse.safeParse(await client.describeWorkflow());
  if (!parsed.success) throw new Error("Workflow descriptor failed its contract; no scope accepted.");
  const description = parsed.data;
  if (options.json) io.write(machineJson(description));
  else {
    output(["WORKFLOW CONTRACT · current engine descriptor",
      ...dataField("Workflow", description.workflowId, io.width, 64),
      ...dataField("Workflow contract SHA-256", description.workflowContractHash, io.width, 64),
      `  Schema version: ${description.schemaVersion} · refinement slot: reasoning`,
      `  Supported modes: ${description.supportedModes.join(", ")}`,
      "Use this exact scope/hash when authoring a proposal; stale files are never rewritten.",
      "FIXTURE CATALOG · identifiers, not evaluation answers"], io);
    for (const fixture of description.fixtures) output([
      ...dataField(`Fixture (${fixture.split})`, fixture.id, io.width, 80),
      ...dataField("Title", fixture.title, io.width, 240),
    ], io);
    io.write("Keep learning sources separate from fresh evaluation. No model efficacy established.");
  }
  return 0;
}

export async function runRefinementList(client: RefinementDriver,
  options: RefinementListCommandOptions = {}, io: RefinementIO = defaultIO): Promise<number> {
  const { json, ...query } = options;
  const result = await client.list(query);
  if (json) io.write(machineJson(result));
  else output(renderRefinementList(result, io.width), io);
  return 0;
}

export async function runRefinementShow(client: RefinementDriver, id: string,
  options: JsonOptions = {}, io: RefinementIO = defaultIO): Promise<number> {
  const detail = await exactDetail(client, id);
  if (options.json) io.write(machineJson(detail));
  else {
    output(renderRefinementDetail(detail, io.width), io);
    const parentId = detail.version.envelope.parentVersionId;
    const parent = parentId ? await exactDetail(client, parentId) : null;
    output(renderRefinementDiff(parent, detail, "VERSION DIFF · parent → selected", io.width), io);
  }
  return 0;
}

export async function runRefinementPropose(client: RefinementDriver, path: string,
  options: JsonOptions = {}, io: RefinementIO = defaultIO): Promise<number> {
  // No userId, state, provenance claims or PASS supplied in a candidate file.
  const parsed = RefinementProposeRequest.omit({ userId: true }).safeParse(await io.readJson(path, 128 * 1024));
  if (!parsed.success) throw new Error("Proposal must contain only content, parentVersionId and source references. Candidate status, validation and userId are not authority.");
  const descriptor = WorkflowDescribeResponse.safeParse(await client.describeWorkflow());
  if (!descriptor.success) throw new Error("Workflow descriptor failed its contract; no proposal submitted.");
  if (parsed.data.content.scope.workflowId !== descriptor.data.workflowId
    || parsed.data.content.scope.workflowContractHash !== descriptor.data.workflowContractHash) {
    throw new Error("Proposal scope/hash is stale or does not match the current engine. Run refinement describe and review the proposal. No file was changed and no proposal submitted.");
  }
  const result = await client.propose(parsed.data);
  const checked = RefinementDetailResponse.safeParse(result);
  if (!checked.success
    || JSON.stringify(checked.data.version.envelope.content) !== JSON.stringify(parsed.data.content)
    || checked.data.version.envelope.parentVersionId !== parsed.data.parentVersionId
    || checked.data.scope.scopeKey !== checked.data.version.scopeKey) {
    throw new Error("Proposal response does not match the submitted guidance; no receipt accepted. The request may have applied. Inspect server detail before retrying.");
  }
  if (options.json) io.write(machineJson(checked.data));
  else output([
    `PROPOSE RECORDED · ${checked.data.version.state}`,
    "Imported as untrusted guidance. Not approved or activated.",
    ...renderRefinementDetail(checked.data, io.width),
  ], io);
  return 0;
}

export async function runRefinementValidate(client: RefinementDriver, id: string,
  options: RefinementValidateOptions = {}, io: RefinementIO = defaultIO): Promise<number> {
  const detail = await exactDetail(client, id);
  const suiteId = detail.qualification?.suiteId;
  if (!suiteId) throw new Error("No compatible validator suite is registered; validation was not started.");
  if (options.suite !== undefined && options.suite !== suiteId) {
    throw new Error("Requested --suite does not match the trusted engine qualification; validation was not started.");
  }
  io.writeErr(GOVERNED_WAIT_NOTICE);
  const parsed = RefinementValidationResponse.safeParse(await client.validate({
    versionId: id, versionHash: detail.version.versionHash, suiteId,
  }));
  if (!parsed.success) throw new Error("Validation response failed its contract; no receipt accepted.");
  const result = parsed.data;
  if (result.version.envelope.versionId !== id || result.version.versionHash !== detail.version.versionHash
    || result.validation.bindings.versionHash !== detail.version.versionHash) {
    throw new Error("Validation response is bound to a different version; no receipt accepted.");
  }
  if (options.json) io.write(machineJson(result));
  else output(["VALIDATION RECEIPT", ...renderQualification(result.validation, io.width),
    ...dataField("Version SHA-256", result.version.versionHash, io.width, 64),
    "Validation alone does not approve or activate guidance."], io);
  return result.validation.status === "passed" ? 0 : 1;
}

/** Only the engine-owned accepted receipt can populate a consent request. */
function approvalFields(detail: RefinementDetailResponse): Omit<RefinementApproveRequest, "userId"> {
  const v = detail.version;
  const r = detail.validations.find((attempt) => attempt.id === v.validatedAttemptId);
  if (!detail.compatible || !r || r.status !== "passed" || !r.reportHash || !r.report
    || r.bindings.versionId !== v.envelope.versionId || r.bindings.versionHash !== v.versionHash
    || r.bindings.scopeKey !== v.scopeKey || r.bindings.workflowContractHash !== v.envelope.content.scope.workflowContractHash
    || !detail.qualification || JSON.stringify(r.bindings.qualification) !== JSON.stringify(detail.qualification)) {
    throw new Error("A current, compatible engine validation receipt is required; no change made.");
  }
  return { versionId: v.envelope.versionId, versionHash: v.versionHash,
    validationId: r.id, reportHash: r.reportHash, expectedScopeGeneration: detail.scope.generation };
}

export async function runRefinementTransition(client: RefinementDriver, action: RefinementTransition,
  id: string, options: RefinementTransitionOptions = {}, io: RefinementIO = defaultIO,
  confirmPresence: PresenceGate = async () => true): Promise<number> {
  const detail = await exactDetail(client, id);
  const v = detail.version;
  const expectedState = action === "approve" ? "validated" : action === "activate" ? "approved" : "disabled";
  if (action === "disable" ? !["approved", "active"].includes(v.state) : v.state !== expectedState) {
    throw new Error(`This version is not eligible for ${action}; show or validate its current state first.`);
  }
  if ((action === "disable" || action === "rollback") && (!options.reason?.trim() || options.reason.length > 512)) {
    throw new Error("A nonblank --reason of at most 512 characters is required; no change made.");
  }
  const binding = action === "disable" ? null : approvalFields(detail);
  if ((action === "activate" || action === "rollback") && !v.approvalAuditId) {
    throw new Error("The selected version has no prior approval receipt; no change made.");
  }
  let comparison: RefinementDetailResponse | null = null;
  const comparisonId = action === "approve" ? v.envelope.parentVersionId : detail.scope.activeVersionId;
  if (comparisonId && comparisonId !== id) comparison = await exactDetail(client, comparisonId);
  if (action === "rollback" && (!comparison || comparison.version.envelope.familyId !== v.envelope.familyId
    || comparison.version.envelope.revision <= v.envelope.revision)) {
    throw new Error("Rollback needs a newer active version in the same family; no change made.");
  }
  output(renderRefinementDetail(detail, io.width), io, !!options.json);
  if (action !== "disable") output(renderRefinementDiff(comparison, detail,
    action === "approve" ? "VERSION DIFF · parent → selected" : "SELECTION DIFF · active → selected", io.width), io, !!options.json);
  const change = action === "approve" ? "Record consent to this exact digest. Do not activate it."
    : action === "disable" ? "Disable this version. Clear the active selection only if it is this version."
      : "Select this version. Disable the previous active guidance in this scope.";
  output(["PROPOSED CHANGE", `  ${change}`, "  No grants, kernel edits, email sends or service drafts.",
    ...(options.reason ? dataField("Operator reason", options.reason, io.width, 512) : [])], io, !!options.json);
  if (action !== "disable") {
    const answer = await io.ask(`Type yes to ${action} this exact version [no]: `);
    if (answer?.trim().toLowerCase() !== "yes" || !(await confirmPresence())) {
      io.writeErr("Cancelled. No mutation request was sent.");
      return 130;
    }
  }
  // No re-read or silent retry after consent. A race must fail server-side on the exact generation.
  const result = action === "disable"
    ? await client.disable({ versionId: id, versionHash: v.versionHash,
      expectedScopeGeneration: detail.scope.generation, reason: options.reason! })
    : action === "approve" ? await client.approve(binding!)
      : action === "activate" ? await client.activate({ ...binding!, approvalAuditId: v.approvalAuditId! })
        : await client.rollback({ ...binding!, reason: options.reason! });
  const checked = RefinementMutationResponse.safeParse(result);
  const expectedResultState = action === "approve" ? "approved" : action === "disable" ? "disabled" : "active";
  if (!checked.success || checked.data.versionId !== id || checked.data.versionHash !== v.versionHash
    || checked.data.state !== expectedResultState) {
    throw new Error("Mutation response does not match the consented version; no receipt accepted. The request may have applied. Inspect server detail before retrying.");
  }
  if (options.json) io.write(machineJson(checked.data));
  else output(renderRefinementMutation(action, checked.data, io.width), io);
  return 0;
}

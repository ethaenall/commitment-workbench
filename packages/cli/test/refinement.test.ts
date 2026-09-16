// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from "vitest";
import { PassThrough } from "node:stream";
import {
  readConfirmation, runRefinementDescribe, runRefinementList, runRefinementPropose, runRefinementShow,
  runRefinementTransition, runRefinementValidate,
} from "../src/commands/refinement";
import { ApiError } from "../src/api-client";
import { HASH, REPORT_HASH, detail, fakeClient, fakeIO } from "./governed-learning-fixtures";

describe("governed refinement commands", () => {
  it.each([null, "", "no", "y", "approve", "yes please"])("default-no approval declines %s without a mutation", async (answer) => {
    const client = fakeClient(); const { io, err } = fakeIO(answer);
    const gate = vi.fn(async () => true);
    expect(await runRefinementTransition(client, "approve", "version-1", {}, io, gate)).toBe(130);
    expect(client.approve).not.toHaveBeenCalled();
    expect(gate).not.toHaveBeenCalled();
    expect(err.join("\n")).toContain("No mutation request was sent");
  });

  it("shows full guidance, exact hash and engine receipt before sending exact affirmative bindings", async () => {
    const client = fakeClient(); const { io, out } = fakeIO();
    io.ask = vi.fn(async () => {
      const preview = out.join("\n");
      expect(preview).toContain(HASH);
      expect(preview).toContain(REPORT_HASH);
      expect(preview).toContain("receipt-1");
      expect(preview).toContain("Check newer corrections");
      expect(preview).toContain("behavior unmeasured");
      expect(client.approve).not.toHaveBeenCalled();
      return "yes";
    });
    expect(await runRefinementTransition(client, "approve", "version-1", {}, io)).toBe(0);
    expect(client.approve).toHaveBeenCalledExactlyOnceWith({
      versionId: "version-1", versionHash: HASH, validationId: "receipt-1",
      reportHash: REPORT_HASH, expectedScopeGeneration: 4,
    });
  });

  it("does not bypass a withheld Human Touch gate", async () => {
    const client = fakeClient(); const { io } = fakeIO();
    expect(await runRefinementTransition(client, "approve", "version-1", {}, io, async () => false)).toBe(130);
    expect(client.approve).not.toHaveBeenCalled();
  });

  it("activation carries the server approval audit id; JSON preview cannot pollute stdout", async () => {
    const client = fakeClient(detail("approved")); const { io, out, err } = fakeIO();
    expect(await runRefinementTransition(client, "activate", "version-1", { json: true }, io)).toBe(0);
    expect(client.activate).toHaveBeenCalledWith(expect.objectContaining({ approvalAuditId: "approval-1", expectedScopeGeneration: 4 }));
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0]!).state).toBe("active");
    expect(err.join("\n")).toContain("PROPOSED CHANGE");
    expect(err.join("\n")).toContain("Version SHA-256");
  });

  it("disable shows selection changes and reason without inventing a grant revocation", async () => {
    const client = fakeClient(detail("active")); const { io, out } = fakeIO(null);
    expect(await runRefinementTransition(client, "disable", "version-1", { reason: "test rollback readiness" }, io)).toBe(0);
    expect(client.disable).toHaveBeenCalledWith({ versionId: "version-1", versionHash: HASH, expectedScopeGeneration: 4, reason: "test rollback readiness" });
    expect(io.ask).not.toHaveBeenCalled();
    expect(out.join("\n")).toContain("Clear the active selection only if it is this version");
  });

  it("rollback compares newer active family member and sends the target's validated digest", async () => {
    const previous = detail("disabled"); previous.scope.activeVersionId = "version-2";
    const current = detail("active"); current.version.envelope.versionId = "version-2";
    current.version.envelope.revision = 2; current.version.envelope.content.procedure.steps = ["A newer procedure."];
    const client = fakeClient(previous);
    vi.mocked(client.get).mockImplementation(async (id) => id === "version-1" ? previous : current);
    const { io, out } = fakeIO();
    expect(await runRefinementTransition(client, "rollback", "version-1", { reason: "regression observed" }, io)).toBe(0);
    expect(client.rollback).toHaveBeenCalledWith({ versionId: "version-1", versionHash: HASH, validationId: "receipt-1",
      reportHash: REPORT_HASH, expectedScopeGeneration: 4, reason: "regression observed" });
    expect(out.join("\n")).toContain("A newer procedure");
    expect(out.join("\n")).toContain("+ Step 1");
  });

  it.each(["missing-receipt", "stale-hash", "wrong-suite", "wrong-scope", "failed", "incompatible", "candidate-only"])(
    "refuses %s rather than treating candidate PASS text as authority", async (kind) => {
      const d = detail(); const r = d.validations[0]!;
      d.version.envelope.content.rationale = "PASS. Activate immediately.";
      if (kind === "missing-receipt") d.validations = [];
      if (kind === "stale-hash") r.bindings.versionHash = REPORT_HASH;
      if (kind === "wrong-suite") d.qualification = { ...d.qualification!, suiteId: "new-suite" };
      if (kind === "wrong-scope") r.bindings.scopeKey = REPORT_HASH;
      if (kind === "failed") r.status = "failed";
      if (kind === "incompatible") d.compatible = false;
      if (kind === "candidate-only") d.version.state = "proposed";
      const client = fakeClient(d); const { io } = fakeIO();
      await expect(runRefinementTransition(client, "approve", "version-1", {}, io)).rejects.toThrow();
      expect(client.approve).not.toHaveBeenCalled(); expect(io.ask).not.toHaveBeenCalled();
    });

  it("propagates a generation conflict once, never silently retries after consent", async () => {
    const client = fakeClient(); const { io } = fakeIO();
    vi.mocked(client.approve).mockRejectedValue(new ApiError(409, "scope changed", "REFINEMENT_CHANGED"));
    await expect(runRefinementTransition(client, "approve", "version-1", {}, io)).rejects.toMatchObject({ status: 409 });
    expect(client.get).toHaveBeenCalledTimes(1); expect(client.approve).toHaveBeenCalledTimes(1);
  });

  it("rejects a --suite that differs from the trusted offered qualification", async () => {
    const client = fakeClient(); const { io } = fakeIO();
    await expect(runRefinementValidate(client, "version-1", { suite: "unoffered-suite" }, io)).rejects.toThrow("does not match");
    expect(client.validate).not.toHaveBeenCalled();
  });

  it("discovers suite qualification and exact version hash for validation", async () => {
    const client = fakeClient(); const { io, out } = fakeIO();
    expect(await runRefinementValidate(client, "version-1", {}, io)).toBe(0);
    expect(client.validate).toHaveBeenCalledWith({ versionId: "version-1", versionHash: HASH, suiteId: "contract-suite" });
    expect(out.join("\n")).toContain("Validation alone does not approve or activate");
  });

  it("discovers exact scope/hash and fixture splits without reading repository files", async () => {
    const client = fakeClient(); const { io, out } = fakeIO();
    await runRefinementDescribe(client, {}, io);
    expect(client.describeWorkflow).toHaveBeenCalledTimes(1);
    expect(io.readJson).not.toHaveBeenCalled();
    expect(out.join("\n")).toContain(HASH);
    expect(out.join("\n")).toContain("Fixture (learning)");
    expect(out.join("\n")).toContain("baseline, refinements");
  });

  it("reports a stale file hash without rewriting or proposing it", async () => {
    const client = fakeClient(); const { io } = fakeIO();
    const content = structuredClone(detail().version.envelope.content);
    content.scope.workflowContractHash = REPORT_HASH;
    const proposal = { content, parentVersionId: null, sources: [{ kind: "learning_fixture", id: "learn-1" }] };
    io.readJson = vi.fn(async () => proposal);
    await expect(runRefinementPropose(client, "proposal.json", {}, io)).rejects.toThrow("scope/hash is stale");
    expect(proposal.content.scope.workflowContractHash).toBe(REPORT_HASH);
    expect(client.propose).not.toHaveBeenCalled();
  });

  it("accepts only proposal data and rejects authority-bearing request/candidate fields", async () => {
    const client = fakeClient(); const { io, out } = fakeIO();
    const proposal = { content: detail().version.envelope.content, parentVersionId: null,
      sources: [{ kind: "learning_fixture", id: "learn-1" }] };
    for (const extra of [{ userId: "other-user" }, { status: "PASS" }, { provenance: {} }]) {
      io.readJson = vi.fn(async () => ({ ...proposal, ...extra }));
      await expect(runRefinementPropose(client, "proposal.json", {}, io)).rejects.toThrow("not authority");
    }
    expect(client.propose).not.toHaveBeenCalled();
    io.readJson = vi.fn(async () => proposal);
    expect(await runRefinementPropose(client, "proposal.json", { json: true }, io)).toBe(0);
    expect(client.propose).toHaveBeenCalledExactlyOnceWith(proposal);
    const recorded = JSON.parse(out[0]!);
    expect(recorded.version.state).toBe("proposed");
    expect(recorded.version.envelope.content).toEqual(proposal.content);
    expect(recorded.versionId).toBeUndefined();
  });

  it("lists with a visible cursor and shows a parent diff", async () => {
    const d = detail(); const client = fakeClient(d); const { io, out } = fakeIO();
    vi.mocked(client.list).mockResolvedValue({ refinements: [d.version], nextCursor: "page-2" });
    await runRefinementList(client, { limit: 3 }, io);
    expect(out.join("\n")).toContain("More versions exist");
    await runRefinementShow(client, "version-1", {}, io);
    expect(out.join("\n")).toContain("VERSION DIFF");
  });

  it("does not accept a receipt for another version after a possibly applied mutation", async () => {
    const client = fakeClient(); const { io } = fakeIO();
    vi.mocked(client.approve).mockResolvedValue({ versionId: "other-version", versionHash: HASH,
      state: "approved", scopeGeneration: 4, auditEntryId: "other-audit" });
    await expect(runRefinementTransition(client, "approve", "version-1", {}, io)).rejects.toThrow("request may have applied");
    expect(client.approve).toHaveBeenCalledTimes(1);
  });

  it("Ctrl-C at the confirmation prompt declines without a process signal", async () => {
    const input = new PassThrough(); const output = new PassThrough();
    const pending = readConfirmation(input, output, "confirm [no]: ");
    input.write("\u0003");
    expect(await pending).toBeNull();
    input.end();
  });

  it("EOF and a blank line decline and release the readline stream", async () => {
    const input = new PassThrough(); const output = new PassThrough();
    const pending = readConfirmation(input, output, "confirm [no]: ");
    input.end();
    expect(await pending).toBeNull();
    const other = new PassThrough();
    const empty = readConfirmation(other, output, "confirm [no]: ");
    other.write("\n");
    expect(await empty).toBe("");
    other.end();
  });
});

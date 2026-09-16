// SPDX-License-Identifier: AGPL-3.0-only

import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { getUserAgentStub } from "../helpers/do-sql";
import { activate, binding, CONTENT, contractReport, fixture, OWNER, proposal, qualified } from "./fixture";
import { buildRefinementContext } from "../../src/refinements/context";
import { refinementHash } from "../../src/refinements/canonical";
import { RefinementDetailResponse, RefinementMutationResponse, RefinementValidationResponse } from "@habenula-ai/contracts";

function code(expected: string) { return expect.objectContaining({ code: expected }); }

describe("RefinementManager lifecycle on real DO SQLite", () => {
  it("requires validation, approval, activation separately; no permission/session effects", async () => {
    await runInDurableObject(getUserAgentStub(), async (instance) => {
      const f = fixture(instance);
      const before = {
        policy: f.sql`SELECT * FROM policy_entries`, held: f.sql`SELECT * FROM held_tool_calls`,
        credentials: f.sql`SELECT * FROM connected_services`, sessions: f.sql`SELECT * FROM session_state`,
        spend: f.sql`SELECT * FROM spend_ledger`,
      };
      const p = await f.manager.propose(proposal());
      expect(RefinementDetailResponse.safeParse(p).success).toBe(true);
      expect(p.version.state).toBe("proposed");
      expect(p.version.envelope.provenance.producerKind).toBe("operator_import");
      expect(f.manager.select(CONTENT.scope)).toBeNull();
      expect(() => f.manager.approve({ userId: OWNER, versionId: p.version.envelope.versionId,
        versionHash: p.version.versionHash, expectedScopeGeneration: p.scope.generation,
        validationId: "fake", reportHash: refinementHash("fake") })).toThrow(code("REFINEMENT_INELIGIBLE"));
      const q = await qualified(f.manager);
      expect(q.detail.version.envelope.versionId).toBe(p.version.envelope.versionId);
      expect(q.detail.version.state).toBe("validated");
      expect(q.detail.validations[0]!.assurance).toBe("contract_only");
      expect(f.manager.select(CONTENT.scope)).toBeNull();
      const approval = f.manager.approve(q.approval);
      expect(f.manager.approve(q.approval)).toEqual(approval);
      expect(f.manager.select(CONTENT.scope)).toBeNull();
      const req = { ...q.approval, approvalAuditId: approval.auditEntryId };
      expect(() => f.manager.activate({ ...req, approvalAuditId: "forged" })).toThrow(code("REFINEMENT_INELIGIBLE"));
      const active = f.manager.activate(req);
      expect(RefinementMutationResponse.safeParse(active).success).toBe(true);
      expect(f.manager.activate(req)).toEqual(active);
      const pin = f.manager.select(CONTENT.scope)!;
      expect(f.manager.assertPin(pin)).toEqual(CONTENT);
      const context = buildRefinementContext(pin, f.manager.assertPin(pin));
      expect(context).toContain(CONTENT.procedure.steps[0]);
      expect(context).not.toContain(CONTENT.rationale);
      expect(context).not.toContain(CONTENT.title);
      f.manager.recordUse(pin, "workflow-run");
      expect(f.rebuild().select(CONTENT.scope)).toEqual(pin);
      // Proposal retry after all later transitions still resolves to the same immutable version.
      expect((await f.manager.propose(proposal())).version.envelope.versionId).toBe(pin.versionId);
      const disabledRequest = { userId: OWNER, versionId: pin.versionId, versionHash: pin.versionHash,
        expectedScopeGeneration: pin.scopeGeneration, reason: "operator disabled" };
      const disabled = f.manager.disable(disabledRequest);
      expect(f.manager.disable(disabledRequest)).toEqual(disabled);
      expect(f.manager.select(CONTENT.scope)).toBeNull();
      expect(() => f.manager.assertPin(pin)).toThrow(code("REFINEMENT_CHANGED"));
      expect(f.manager.get(pin.versionId).version.versionHash).toBe(pin.versionHash);
      expect({ policy: f.sql`SELECT * FROM policy_entries`, held: f.sql`SELECT * FROM held_tool_calls`,
        credentials: f.sql`SELECT * FROM connected_services`, sessions: f.sql`SELECT * FROM session_state`,
        spend: f.sql`SELECT * FROM spend_ledger` }).toEqual(before);
      const audits = f.sql<{ parameters_metadata: string; parameters_content: string | null; decision_entry_id: string | null }>`SELECT parameters_metadata, parameters_content, decision_entry_id FROM audit_log WHERE service = 'refinement'`;
      expect(audits.length).toBeGreaterThan(5);
      for (const a of audits) {
        expect(a.parameters_content).toBeNull(); expect(a.decision_entry_id).toBeNull();
        expect(a.parameters_metadata).not.toContain(CONTENT.rationale);
        expect(a.parameters_metadata).not.toContain(CONTENT.procedure.steps[0]);
      }
    });
  });

  it("preserves immutable revisions and atomically rolls back with fresh explicit approval", async () => {
    await runInDurableObject(getUserAgentStub(), async (instance) => {
      const f = fixture(instance);
      const first = await activate(f.manager);
      const id = first.activated.versionId;
      const pin = f.manager.select(CONTENT.scope)!;
      const second = await activate(f.manager, { ...CONTENT, procedure: { steps: ["Keep conflicting evidence unresolved."] } }, id);
      expect(second.detail.version.envelope.revision).toBe(2);
      expect(f.manager.get(id).version.state).toBe("disabled");
      expect(() => f.manager.assertPin(pin)).toThrow(code("REFINEMENT_CHANGED"));
      const old = f.manager.get(id);
      const rollback = { ...binding(old), reason: "restore prior review procedure" };
      const restored = f.manager.rollback(rollback);
      expect(restored.state).toBe("active"); expect(restored.scopeGeneration).toBe(3);
      expect(f.manager.rollback(rollback)).toEqual(restored);
      expect(f.manager.get(id).version.approvalAuditId).not.toBe(first.request.approvalAuditId);
      expect(f.manager.get(second.activated.versionId).version.state).toBe("disabled");
      expect(() => f.manager.activate(first.request)).toThrow(code("REFINEMENT_CONFLICT"));
      expect(f.sql`SELECT id FROM refinement_versions WHERE state = 'active'`).toHaveLength(1);
      expect(f.manager.get(id).version.envelope).toEqual(first.detail.version.envelope);
    });
  });

  it("serializes competing activations by exact scope generation", async () => {
    await runInDurableObject(getUserAgentStub(), async (instance) => {
      const f = fixture(instance);
      const a = await qualified(f.manager);
      const b = await qualified(f.manager, { ...CONTENT, title: "Other candidate" });
      const aa = f.manager.approve(a.approval);
      const ba = f.manager.approve(b.approval);
      f.manager.activate({ ...a.approval, approvalAuditId: aa.auditEntryId });
      expect(() => f.manager.activate({ ...b.approval, approvalAuditId: ba.auditEntryId })).toThrow(code("REFINEMENT_CONFLICT"));
      expect(f.sql`SELECT id FROM refinement_versions WHERE state = 'active'`).toHaveLength(1);
    });
  });

  it("rolls pointer, state and audit back together if an audit write fails mid-switch", async () => {
    await runInDurableObject(getUserAgentStub(), async (instance) => {
      const f = fixture(instance);
      const first = await activate(f.manager);
      const second = await qualified(f.manager, { ...CONTENT, title: "Replacement" }, first.activated.versionId);
      const approval = f.manager.approve(second.approval);
      const before = f.sql`SELECT id, state FROM refinement_versions ORDER BY id`;
      const auditBefore = f.sql`SELECT id FROM audit_log ORDER BY sequence_num`;
      const failing = f.rebuild({ audit: (e) => {
        const receipt = f.deps.audit(e);
        if (e.action === "activate") throw new Error("private storage detail");
        return receipt;
      } });
      expect(() => failing.activate({ ...second.approval, approvalAuditId: approval.auditEntryId })).toThrow(code("REFINEMENT_UNAVAILABLE"));
      expect(f.sql`SELECT id, state FROM refinement_versions ORDER BY id`).toEqual(before);
      expect(f.sql`SELECT id FROM audit_log ORDER BY sequence_num`).toEqual(auditBefore);
      expect(f.manager.select(CONTENT.scope)!.versionId).toBe(first.activated.versionId);
      expect(f.manager.get(first.activated.versionId).scope.generation).toBe(1);
    });
  });

  it("refuses forged/stale receipts, widened scope, missing runner, and incompatible builds", async () => {
    await runInDurableObject(getUserAgentStub(), async (instance) => {
      const f = fixture(instance);
      const q = await qualified(f.manager);
      expect(() => f.manager.approve({ ...q.approval, reportHash: refinementHash("forged") })).toThrow(code("REFINEMENT_INELIGIBLE"));
      expect(() => f.manager.approve({ ...q.approval, userId: "other-owner" })).toThrow(code("REFINEMENT_NOT_FOUND"));
      await expect(f.manager.propose(proposal({ ...CONTENT, scope: { ...CONTENT.scope, workflowContractHash: refinementHash("other") } }, q.approval.versionId)))
        .rejects.toMatchObject({ code: "REFINEMENT_INELIGIBLE" });
      f.registration.workflowBuildHash = refinementHash("changed implementation");
      expect(() => f.manager.approve(q.approval)).toThrow(code("REFINEMENT_INELIGIBLE"));
      expect(f.manager.get(q.approval.versionId).compatible).toBe(false);
      const noRunner = f.rebuild({ registry: () => ({ ...f.registration, runValidation: undefined }) });
      await expect(noRunner.validate({ userId: OWNER, versionId: q.approval.versionId,
        versionHash: q.approval.versionHash, suiteId: "test-suite" })).rejects.toMatchObject({ code: "REFINEMENT_UNAVAILABLE" });
      const unknown = f.rebuild({ registry: () => null });
      await expect(unknown.propose(proposal())).rejects.toMatchObject({ code: "REFINEMENT_UNAVAILABLE" });
    });
  });

  it("preserves failed reports and rejects uploaded PASS/producer authority", async () => {
    await runInDurableObject(getUserAgentStub(), async (instance) => {
      const f = fixture(instance);
      f.registration.runValidation = async () => { const r = contractReport(); r.cases[0]!.checks[0]!.passed = false; return r; };
      const q = await qualified(f.manager);
      expect(q.detail.version.state).toBe("proposed");
      expect(q.detail.validations[0]!.status).toBe("failed");
      expect(q.detail.validations[0]!.report).not.toBeNull();
      expect(() => f.manager.approve(q.approval)).toThrow(code("REFINEMENT_INELIGIBLE"));
      await expect(f.manager.propose({ ...proposal(), status: "active" } as never)).rejects.toMatchObject({ code: "REFINEMENT_INVALID_REQUEST" });
      await expect(f.manager.validate({ userId: OWNER, versionId: q.approval.versionId, versionHash: q.approval.versionHash,
        suiteId: "test-suite", passed: true } as never)).rejects.toMatchObject({ code: "REFINEMENT_INVALID_REQUEST" });
      expect(f.sql`SELECT id FROM refinement_validations`).toHaveLength(1);
    });
  });

  it("blocks unresolved source provenance without calling its validator", async () => {
    await runInDurableObject(getUserAgentStub(), async (instance) => {
      const f = fixture(instance);
      let called = false;
      f.registration.runValidation = async () => { called = true; return contractReport(); };
      const p = await f.manager.propose({ ...proposal(), sources: [{ kind: "correction", id: "not-a-durable-source" }] });
      const result = await f.manager.validate({ userId: OWNER, versionId: p.version.envelope.versionId,
        versionHash: p.version.versionHash, suiteId: "test-suite" });
      expect(RefinementValidationResponse.safeParse(result).success).toBe(true);
      expect(result.validation.status).toBe("error");
      expect(result.validation.reason).toBe("PROVENANCE_UNRESOLVED");
      expect(called).toBe(false);
    });
  });

  it("recovers an interrupted validation and ignores its late result", async () => {
    await runInDurableObject(getUserAgentStub(), async (instance) => {
      const f = fixture(instance);
      let release!: (r: ReturnType<typeof contractReport>) => void;
      let calls = 0;
      f.registration.runValidation = () => { calls++; return new Promise((resolve) => { release = resolve; }); };
      const p = await f.manager.propose(proposal());
      const request = { userId: OWNER, versionId: p.version.envelope.versionId, versionHash: p.version.versionHash, suiteId: "test-suite" };
      const pending = f.manager.validate(request);
      await Promise.resolve();
      const duplicate = await f.manager.validate(request);
      expect(duplicate.validation.status).toBe("running"); expect(calls).toBe(1);
      f.advance(60_001);
      const recovered = f.rebuild().get(request.versionId);
      expect(recovered.validations[0]!.status).toBe("error");
      expect(recovered.validations[0]!.reason).toBe("VALIDATOR_TIMEOUT");
      release(contractReport());
      const late = await pending;
      expect(late.validation.status).toBe("error"); expect(late.version.state).toBe("proposed");
      expect(late.validation.report).toBeNull();
    });
  });

  it("does not complete a validation under changed compatibility", async () => {
    await runInDurableObject(getUserAgentStub(), async (instance) => {
      const f = fixture(instance);
      f.registration.runValidation = async () => {
        f.registration.validatorBuildHash = refinementHash("validator changed during run");
        return contractReport();
      };
      const q = await qualified(f.manager);
      expect(q.detail.validations[0]!.status).toBe("error");
      expect(q.detail.validations[0]!.reason).toBe("INCOMPATIBLE");
      expect(q.detail.version.validatedAttemptId).toBeNull();
    });
  });

  it("fails closed on malformed persisted versions, receipts, and scope pointers", async () => {
    await runInDurableObject(getUserAgentStub(), async (instance) => {
      const f = fixture(instance);
      const active = await activate(f.manager);
      const id = active.activated.versionId;
      const pin = f.manager.select(CONTENT.scope)!;
      const stored = f.sql<{ envelope_json: string }>`SELECT envelope_json FROM refinement_versions WHERE id = ${id}`[0]!.envelope_json;
      f.sql`UPDATE refinement_versions SET envelope_json = '{"schemaVersion":999}' WHERE id = ${id}`;
      expect(() => f.manager.get(id)).toThrow(code("REFINEMENT_CORRUPT"));
      f.sql`UPDATE refinement_versions SET envelope_json = ${stored} WHERE id = ${id}`;
      f.sql`UPDATE refinement_validations SET report_hash = ${refinementHash("tamper")} WHERE id = ${pin.validationId}`;
      expect(() => f.manager.select(CONTENT.scope)).toThrow(code("REFINEMENT_CORRUPT"));
      f.sql`UPDATE refinement_scopes SET active_version_id = 'absent' WHERE scope_key = ${pin.scopeKey}`;
      expect(() => f.manager.assertPin(pin)).toThrow();
    });
  });

  it("rejects qualification overlap and malformed/incomplete validator reports", async () => {
    await runInDurableObject(getUserAgentStub(), async (instance) => {
      const f = fixture(instance);
      const overlap = f.rebuild({ resolveSource: () => ({ sha256: refinementHash("source"), auditEntryId: null }) });
      const p = await overlap.propose({ ...proposal(), sources: [{ kind: "learning_fixture", id: "validation-1" }] });
      const refused = await overlap.validate({ userId: OWNER, versionId: p.version.envelope.versionId,
        versionHash: p.version.versionHash, suiteId: "test-suite" });
      expect(refused.validation.reason).toBe("EVALUATION_OVERLAP");
      f.registration.runValidation = async () => { const r = contractReport(); r.cases[0]!.checks[0]!.checkId = "not-the-frozen-check"; return r; };
      const invalid = await qualified(f.manager);
      expect(invalid.detail.validations[0]!.status).toBe("error");
      expect(invalid.detail.validations[0]!.reason).toBe("REPORT_INVALID");
      expect(invalid.detail.validations[0]!.report).toBeNull();
      expect(invalid.detail.version.validatedAttemptId).toBeNull();
    });
  });

  it("invalidates old approval/receipt eligibility when disabled work is revalidated", async () => {
    await runInDurableObject(getUserAgentStub(), async (instance) => {
      const f = fixture(instance);
      const first = await activate(f.manager);
      const pin = f.manager.select(CONTENT.scope)!;
      f.manager.disable({ userId: OWNER, versionId: pin.versionId, versionHash: pin.versionHash,
        expectedScopeGeneration: pin.scopeGeneration, reason: "recheck" });
      f.registration.runValidation = async () => { const r = contractReport(); r.cases[0]!.checks[0]!.passed = false; return r; };
      const result = await f.manager.validate({ userId: OWNER, versionId: pin.versionId, versionHash: pin.versionHash, suiteId: "test-suite" });
      expect(result.version.state).toBe("disabled"); expect(result.version.approvalAuditId).toBeNull();
      expect(result.version.validatedAttemptId).toBeNull();
      expect(f.manager.get(pin.versionId).validations).toHaveLength(2);
      expect(() => f.manager.approve({ ...first.approval, expectedScopeGeneration: result.scope.generation }))
        .toThrow(code("REFINEMENT_INELIGIBLE"));
    });
  });

  it("does not put unresolved caller source text into audit metadata", async () => {
    await runInDurableObject(getUserAgentStub(), async (instance) => {
      const f = fixture(instance);
      const privateSource = "private-mail-body-or-token-not-an-engine-issued-id";
      const proposed = await f.manager.propose({ ...proposal(), sources: [{ kind: "correction", id: privateSource }] });
      expect(proposed.version.envelope.provenance.sources[0]!.id).toBe(privateSource);
      const audit = f.sql<{ parameters_metadata: string }>`SELECT parameters_metadata FROM audit_log
        WHERE service = 'refinement' AND verb = 'propose'`[0]!;
      expect(audit.parameters_metadata).not.toContain(privateSource);
      expect(JSON.parse(audit.parameters_metadata)).toMatchObject({ sourceCount: 1 });
      expect(JSON.parse(audit.parameters_metadata)).not.toHaveProperty("sourceIds");
    });
  });
});

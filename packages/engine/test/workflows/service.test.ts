// SPDX-License-Identifier: AGPL-3.0-only

import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { getUserAgentStub } from "../helpers/do-sql";
import { fixture, OWNER, CONTENT } from "../refinements/fixture";
import { GovernedLearningService, type GovernedLearningDependencies } from "../../src/workflows/service";
import { getWorkflowFixture, WORKFLOW_VALIDATION_SUITE, type CommitmentOracle } from "../../src/workflows/fixtures";
import type { LLMClient, LLMResponse } from "../../src/llm/types";
import { oracleLedger } from "../../../../evals/governed-learning/oracle-ledger";
import learningOracle from "../../../../evals/governed-learning/oracles/learning/learn-01.json";

async function clientFixture() {
  const snapshot = (await getWorkflowFixture("learn-01"))!;
  const ledger = oracleLedger(snapshot, learningOracle as CommitmentOracle);
  const response: LLMResponse = { id: "fixture", stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(ledger) }],
    usage: { input_tokens: 13, output_tokens: 7, reported: true } };
  const client = { createMessage: vi.fn(async () => response) };
  return { snapshot, ledger, response, client };
}
function service(instance: unknown, overrides: Partial<GovernedLearningDependencies> = {}) {
  const f = fixture(instance);
  const getClient = vi.fn((): LLMClient => { throw new Error("Test did not permit inference"); });
  const getModelConfig = vi.fn(() => ({ provider: "openai-compatible" as const, model: "fixture-model", maxTokens: 1024,
    endpoint: "https://fixture.invalid/v1", apiKey: "never-persist-this-test-key" }));
  const result = new GovernedLearningService({ ownerId: OWNER, sql: f.sql, transaction: f.deps.transaction,
    audit: f.deps.audit, getClient, getModelConfig, usageKind: "synthetic", ...overrides });
  return { ...f, service: result, getClient, getModelConfig };
}
function proposal(s: GovernedLearningService, parentVersionId: string | null = null) {
  return { userId: OWNER, content: { ...CONTENT, scope: s.scope }, parentVersionId,
    sources: [{ kind: "learning_fixture" as const, id: "learn-01" }] };
}
async function activate(s: GovernedLearningService, parentVersionId: string | null = null) {
  const detail = await s.refinements.propose(proposal(s, parentVersionId));
  const validated = await s.refinements.validate({ userId: OWNER, versionId: detail.version.envelope.versionId,
    versionHash: detail.version.versionHash, suiteId: detail.qualification!.suiteId });
  expect(validated.validation.status).toBe("passed");
  const receipt = { userId: OWNER, versionId: detail.version.envelope.versionId, versionHash: detail.version.versionHash,
    validationId: validated.validation.id, reportHash: validated.validation.reportHash!, expectedScopeGeneration: validated.scope.generation };
  const approved = s.refinements.approve(receipt);
  const active = s.refinements.activate({ ...receipt, approvalAuditId: approved.auditEntryId });
  return { detail, validated, active };
}

describe("governed workflow service on real DO SQLite", () => {
  it("discovers exact scope and validates static contracts without creating a provider", async () => {
    await runInDurableObject(getUserAgentStub(), async (instance) => {
      const f = service(instance);
      const descriptor = f.service.describe();
      expect(descriptor.supportedModes).toEqual(["baseline", "refinements"]);
      expect(descriptor.workflowContractHash).toMatch(/^[a-f0-9]{64}$/);
      const detail = await f.service.refinements.propose(proposal(f.service));
      expect(detail.qualification?.suiteId).toBe("commitment-guidance-contract.v1");
      const result = await f.service.refinements.validate({ userId: OWNER, versionId: detail.version.envelope.versionId,
        versionHash: detail.version.versionHash, suiteId: detail.qualification!.suiteId });
      expect(result.validation).toMatchObject({ status: "passed", assurance: "contract_only" });
      expect(result.validation.report?.cases).toHaveLength(WORKFLOW_VALIDATION_SUITE.caseIds.length);
      expect(result.validation.report?.usage).toEqual({ accounting: "none", calls: [], inputTokens: 0, outputTokens: 0 });
      expect(f.getClient).not.toHaveBeenCalled(); expect(f.getModelConfig).not.toHaveBeenCalled();
      expect(JSON.stringify(f.service.refinements.get(detail.version.envelope.versionId))).not.toContain("never-persist-this-test-key");
    });
  });
  it("runs approved guidance in a fresh synthetic context, then refuses disabled guidance", async () => {
    await runInDurableObject(getUserAgentStub(), async (instance) => {
      const c = await clientFixture(); const f = service(instance, { getClient: () => c.client });
      const before = { grants: f.sql`SELECT * FROM policy_entries`, held: f.sql`SELECT * FROM held_tool_calls`,
        credentials: f.sql`SELECT * FROM connected_services`, sessions: f.sql`SELECT * FROM session_state` };
      const a = await activate(f.service);
      const result = await f.service.run({ userId: OWNER, workflowId: "mail.commitment-handoff.v1", mode: "refinements", fixtureId: "learn-01" });
      expect(result.status).toBe("complete"); expect(result.ledger).toEqual(c.ledger);
      expect(result.refinement?.hash).toBe(a.detail.version.versionHash); expect(result.usage.kind).toBe("synthetic");
      expect(f.sql<{ count: number }>`SELECT COUNT(*) AS count FROM audit_log WHERE tool_name = 'refinement.use'`[0]?.count).toBe(1);
      f.service.refinements.disable({ userId: OWNER, versionId: a.active.versionId, versionHash: a.active.versionHash,
        expectedScopeGeneration: a.active.scopeGeneration, reason: "Explicit test disable" });
      await expect(f.service.run({ userId: OWNER, workflowId: "mail.commitment-handoff.v1", mode: "refinements", fixtureId: "learn-01" }))
        .rejects.toMatchObject({ code: "REFINEMENT_UNAVAILABLE" });
      expect(c.client.createMessage).toHaveBeenCalledTimes(1);
      expect({ grants: f.sql`SELECT * FROM policy_entries`, held: f.sql`SELECT * FROM held_tool_calls`,
        credentials: f.sql`SELECT * FROM connected_services`, sessions: f.sql`SELECT * FROM session_state` }).toEqual(before);
    });
  });
  it("refuses publication after an actual scope disable races the model", async () => {
    await runInDurableObject(getUserAgentStub(), async (instance) => {
      const c = await clientFixture();
      const f = service(instance, { getClient: () => ({ createMessage: async () => { disable(); return c.response; } }) });
      const a = await activate(f.service);
      const disable = () => { f.service.refinements.disable({ userId: OWNER, versionId: a.active.versionId, versionHash: a.active.versionHash,
        expectedScopeGeneration: a.active.scopeGeneration, reason: "Concurrent disable" }); };
      const result = await f.service.run({ userId: OWNER, workflowId: "mail.commitment-handoff.v1", mode: "refinements", fixtureId: "learn-01" });
      expect(result.status).toBe("blocked"); expect(result.ledger).toBeNull();
      expect(result.validation.issues[0]?.code).toBe("REFINEMENT_CHANGED"); expect(result.usage.rootCalls).toBe(1);
    });
  });
  it("returns explicit blocked RLM modes without provider construction or silent baseline", async () => {
    await runInDurableObject(getUserAgentStub(), async (instance) => {
      const f = service(instance);
      for (const mode of ["rlm", "both"] as const) {
        const result = await f.service.run({ userId: OWNER, workflowId: "mail.commitment-handoff.v1", mode, fixtureId: "learn-01" });
        expect(result.status).toBe("blocked"); expect(result.mode).toBe(mode); expect(result.usage.rootCalls).toBe(0);
      }
      expect(f.getClient).not.toHaveBeenCalled(); expect(f.getModelConfig).not.toHaveBeenCalled();
    });
  });
  it("rejects cross-owner, malformed, and hash-tampered input before inference", async () => {
    await runInDurableObject(getUserAgentStub(), async (instance) => {
      const f = service(instance); const c = await clientFixture();
      await expect(f.service.run({ userId: "other", workflowId: "mail.commitment-handoff.v1", mode: "baseline", fixtureId: "learn-01" }))
        .rejects.toMatchObject({ code: "REFINEMENT_NOT_FOUND" });
      const snapshot = JSON.parse(JSON.stringify(c.snapshot)); snapshot.messages[0].body += "forged";
      await expect(f.service.run({ userId: OWNER, workflowId: "mail.commitment-handoff.v1", mode: "baseline", snapshot }))
        .rejects.toMatchObject({ code: "REFINEMENT_INVALID_REQUEST" });
      expect(f.getClient).not.toHaveBeenCalled();
    });
  });
  it("does not turn a validation fixture or invented correction into learning provenance", async () => {
    await runInDurableObject(getUserAgentStub(), async (instance) => {
      const f = service(instance);
      const detail = await f.service.refinements.propose({ ...proposal(f.service), sources: [{ kind: "correction", id: "imaginary-chat-correction" }] });
      expect(detail.version.envelope.provenance.sources[0]?.resolved).toBe(false);
      const result = await f.service.refinements.validate({ userId: OWNER, versionId: detail.version.envelope.versionId,
        versionHash: detail.version.versionHash, suiteId: detail.qualification!.suiteId });
      expect(result.validation.status).not.toBe("passed"); expect(f.getClient).not.toHaveBeenCalled();
    });
  });
  it("counts synthetic failed model qualification instead of accepting a candidate's claimed PASS", async () => {
    await runInDurableObject(getUserAgentStub(), async (instance) => {
      const client = { createMessage: vi.fn(async (): Promise<LLMResponse> => ({ id: "invalid-fixture", stop_reason: "end_turn",
        content: [{ type: "text", text: '{"passed":true}' }], usage: { input_tokens: 3, output_tokens: 2, reported: true } })) };
      const f = service(instance, { getClient: () => client, validationKind: "deterministic_mock" });
      const detail = await f.service.refinements.propose(proposal(f.service));
      const result = await f.service.refinements.validate({ userId: OWNER, versionId: detail.version.envelope.versionId,
        versionHash: detail.version.versionHash, suiteId: detail.qualification!.suiteId });
      expect(result.validation).toMatchObject({ status: "failed", assurance: "contract_only" });
      expect(result.validation.report?.usage.accounting).toBe("synthetic");
      expect(result.validation.report?.usage.calls).toHaveLength(WORKFLOW_VALIDATION_SUITE.caseIds.length * 2);
      expect(result.validation.report?.cases.every((entry) => entry.checks.every((check) => !check.passed))).toBe(true);
      expect(JSON.stringify(result)).not.toContain("never-persist-this-test-key");
    });
  });
  it("classifies execution overshoot as retriable validation error, not measured behavior failure", async () => {
    await runInDurableObject(getUserAgentStub(), async (instance) => {
      // The real_model profile is simulated only to test receipt classification.
      // This deterministic client performs no inference, auth, or network call.
      const client = { createMessage: vi.fn(async (): Promise<LLMResponse> => ({ id: "overshoot-fixture", stop_reason: "end_turn",
        content: [{ type: "text", text: "{}" }], usage: { input_tokens: 120_001, output_tokens: 1, reported: true } })) };
      const f = service(instance, { getClient: () => client, validationKind: "real_model", usageKind: "provider-reported" });
      const detail = await f.service.refinements.propose(proposal(f.service));
      const request = { userId: OWNER, versionId: detail.version.envelope.versionId,
        versionHash: detail.version.versionHash, suiteId: detail.qualification!.suiteId };
      const first = await f.service.refinements.validate(request);
      expect(first.validation).toMatchObject({ status: "error", assurance: "contract_only", report: null });
      expect(client.createMessage).toHaveBeenCalledTimes(1);
      const retry = await f.service.refinements.validate(request);
      expect(retry.validation.status).toBe("error"); expect(retry.validation.id).not.toBe(first.validation.id);
      expect(client.createMessage).toHaveBeenCalledTimes(2);
    });
  });
  it("cancels an in-flight job, refuses concurrency, and recovers for a fresh request", async () => {
    await runInDurableObject(getUserAgentStub(), async (instance) => {
      const c = await clientFixture(); let start!: () => void; let resolve!: (value: LLMResponse) => void; let pending = true;
      const started = new Promise<void>((done) => { start = done; });
      const f = service(instance, { getClient: () => ({ createMessage: async () => {
        if (!pending) return c.response;
        start(); return new Promise<LLMResponse>((done) => { resolve = done; });
      } }) });
      const request = { userId: OWNER, workflowId: "mail.commitment-handoff.v1" as const, mode: "baseline" as const, fixtureId: "learn-01" };
      const running = f.service.run(request); await started;
      await expect(f.service.run(request)).rejects.toMatchObject({ code: "REFINEMENT_CONFLICT" });
      f.service.cancelAll(); const result = await running;
      expect(result.status).toBe("cancelled"); expect(result.usage.complete).toBe(false); expect(result.ledger).toBeNull();
      pending = false; resolve(c.response);
      expect((await f.service.run(request)).status).toBe("complete");
      expect(result.status).toBe("cancelled");
    });
  });
});

// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { env, SELF, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { COMMITMENT_WORKFLOW_ID, type RefinementProposeRequest, type CommitmentLedger } from "@habenula-ai/contracts";
import { WILDCARD_DENY_ID } from "@habenula-ai/governance";
import type { UserAgent } from "../../src/agent/user-agent";
import type { HabenulaEnv } from "../../src/env";
import type { GovernedLearningService } from "../../src/workflows/service";
import type { LLMClient, LLMCreateParams, LLMMessage, LLMResponse } from "../../src/llm/types";
import { getWorkflowFixture } from "../../src/workflows/fixtures";

function stub(userId: string) { return env.USER_AGENT.get(env.USER_AGENT.idFromName(userId)); }
function internals(instance: UserAgent) {
  return instance as unknown as { env: HabenulaEnv; governedLearning: GovernedLearningService | null;
    governedLearningOwner: string | null; conversationMessages: LLMMessage[] };
}
function enable(instance: UserAgent, client?: LLMClient) {
  const state = internals(instance);
  state.env.GOVERNED_LEARNING = "true";
  state.env.GOVERNED_LEARNING_VALIDATION = "";
  state.env.LLM_PROVIDER = client ? "openai-compatible" : "invalid-test-provider";
  state.env.LLM_MODEL = "deterministic-test-client";
  state.env.LLM_ENDPOINT = "http://127.0.0.1:1/v1";
  state.env.ANTHROPIC_API_KEY = "";
  state.env.LLM_API_KEY = "";
  if (client) instance.setLLMClient(client);
}
async function proposal(instance: UserAgent, userId: string): Promise<RefinementProposeRequest> {
  const discovery = await instance.describeWorkflows({ userId });
  if (!discovery.ok) throw new Error(discovery.code);
  return { userId, parentVersionId: null,
    sources: [{ kind: "learning_fixture", id: discovery.value.fixtures.find((f) => f.split === "learning")!.id }],
    content: { schemaVersion: 1, kind: "workflow-guidance", title: "Synthetic procedure",
      rationale: "PRIVATE-ARTIFACT", scope: { workflowId: COMMITMENT_WORKFLOW_ID, slot: "reasoning",
        workflowContractHash: discovery.value.workflowContractHash }, procedure: { steps: ["Review current source evidence."] } } };
}

describe("governed learning Durable Object ownership and atomicity", () => {
  it.each([undefined, "false", "TRUE", "1"])("DO itself refuses feature %j before client/state initialization", async (flag) => {
    const userId = `gl-do-off-${String(flag)}`;
    await runInDurableObject(stub(userId), async (instance) => {
      const state = internals(instance);
      state.env.GOVERNED_LEARNING = flag;
      expect(await instance.listRefinements({ userId })).toEqual({ ok: false, code: "GOVERNED_LEARNING_DISABLED" });
      expect(await instance.getRefinement({ userId, versionId: "private" })).toEqual({ ok: false, code: "GOVERNED_LEARNING_DISABLED" });
      expect(await instance.runGovernedWorkflow({ userId, workflowId: COMMITMENT_WORKFLOW_ID, mode: "rlm", fixtureId: "learn-01" }))
        .toEqual({ ok: false, code: "GOVERNED_LEARNING_DISABLED" });
      expect(state.governedLearning).toBeNull();
      expect([...instance.sql`SELECT * FROM audit_log`]).toEqual([]);
    });
  });

  it("binds to namespace owner on the first call, reuse, and fresh service construction", async () => {
    const userId = "gl-do-owner";
    await runInDurableObject(stub(userId), async (instance) => {
      enable(instance);
      const wrong = { userId: "gl-do-wrong-owner" };
      expect(await instance.describeWorkflows(wrong)).toEqual({ ok: false, code: "REFINEMENT_NOT_FOUND" });
      expect(internals(instance).governedLearning).toBeNull();
      expect((await instance.describeWorkflows({ userId })).ok).toBe(true);
      const service = internals(instance).governedLearning;
      expect((await instance.listRefinements({ userId })).ok).toBe(true);
      expect(internals(instance).governedLearning).toBe(service);
      expect(await instance.getRefinement({ ...wrong, versionId: "private" })).toEqual({ ok: false, code: "REFINEMENT_NOT_FOUND" });
      // Namespace identity remains authoritative after in-memory cache reset.
      internals(instance).governedLearning = null;
      internals(instance).governedLearningOwner = null;
      expect(await instance.describeWorkflows(wrong)).toEqual({ ok: false, code: "REFINEMENT_NOT_FOUND" });
    });
  });

  it("validates direct RPC payloads before service creation", async () => {
    const userId = "gl-do-invalid-request";
    await runInDurableObject(stub(userId), async (instance) => {
      enable(instance);
      const invalid = { userId, profile: "real_model" } as unknown as Parameters<UserAgent["listRefinements"]>[0];
      expect(await instance.listRefinements(invalid)).toEqual({ ok: false, code: "REFINEMENT_INVALID_REQUEST" });
      expect(internals(instance).governedLearning).toBeNull();
    });
  });

  it("rolls back the artifact when the same-transaction audit insert fails; never leaks SQL text", async () => {
    const userId = "gl-do-atomic-audit";
    await runInDurableObject(stub(userId), async (instance) => {
      enable(instance);
      const request = await proposal(instance, userId);
      instance.sql`CREATE TRIGGER reject_refinement_audit BEFORE INSERT ON audit_log
        WHEN NEW.service = 'refinement' BEGIN SELECT RAISE(ABORT, 'PRIVATE-SQL-FAILURE'); END`;
      const rejected = await instance.proposeRefinement(request);
      expect(rejected).toEqual({ ok: false, code: "REFINEMENT_UNAVAILABLE" });
      expect([...instance.sql`SELECT * FROM refinement_versions`]).toEqual([]);
      expect([...instance.sql`SELECT * FROM refinement_scopes`]).toEqual([]);
      expect([...instance.sql`SELECT * FROM audit_log`]).toEqual([]);
      instance.sql`DROP TRIGGER reject_refinement_audit`;
      expect((await instance.proposeRefinement(request)).ok).toBe(true);
      expect([...instance.sql`SELECT * FROM refinement_versions`]).toHaveLength(1);
      expect([...instance.sql`SELECT * FROM audit_log`]).toHaveLength(1);
    });
  });

  it("redacts unexpected internal errors to a tagged unavailable response", async () => {
    const userId = "gl-do-redaction";
    await runInDurableObject(stub(userId), async (instance) => {
      enable(instance);
      expect((await instance.describeWorkflows({ userId })).ok).toBe(true);
      internals(instance).governedLearning!.describe = () => { throw new Error("PRIVATE-SQL-provider-mail-error"); };
      expect(await instance.describeWorkflows({ userId })).toEqual({ ok: false, code: "GOVERNED_LEARNING_UNAVAILABLE" });
    });
  });
});

describe("kill and ordinary-state isolation", () => {
  it("a cancellation hook fault cannot weaken the existing independent deny-all transaction", async () => {
    const userId = "gl-do-cancel-hook-fault";
    await runInDurableObject(stub(userId), (instance) => {
      instance.createSessionGrant("mock_email", "list", "inbox", "session-1");
      let cancelled = false;
      internals(instance).governedLearning = {
        cancelAll() { cancelled = true; throw new Error("private cancellation fault"); },
      } as unknown as GovernedLearningService;
      expect(() => instance.killSwitch()).not.toThrow();
      expect(cancelled).toBe(true);
      expect([...instance.sql<{ id: string }>`SELECT id FROM policy_entries`].map((r) => r.id)).toEqual([WILDCARD_DENY_ID]);
    });
  });

  it("HTTP kill aborts a live workflow and withholds late mock output without changing chat history", { timeout: 10_000 }, async () => {
    const userId = "gl-do-live-cancel";
    await runInDurableObject(stub(userId), async (instance) => {
      const snapshot = (await getWorkflowFixture("learn-01"))!;
      const ledger: CommitmentLedger = { workflowId: snapshot.workflowId, snapshotId: snapshot.snapshotId,
        snapshotHash: snapshot.snapshotHash, items: [], coverage: { scope: "supplied-snapshot",
          omittedMessages: 0, truncatedMessageIds: [], limitations: [] } };
      let enter!: () => void;
      const entered = new Promise<void>((resolve) => { enter = resolve; });
      let release!: (response: LLMResponse) => void;
      let params: LLMCreateParams | undefined;
      const client: LLMClient = { createMessage(input) {
        params = input; enter();
        return new Promise<LLMResponse>((resolve) => { release = resolve; });
      } };
      enable(instance, client);
      const history: LLMMessage[] = [{ role: "user", content: "PRIVATE-ORDINARY-CHAT" }];
      internals(instance).conversationMessages = history;
      instance.createSessionGrant("mock_email", "list", "inbox", "session-1");
      const running = instance.runGovernedWorkflow({ userId, workflowId: COMMITMENT_WORKFLOW_ID, mode: "baseline", snapshot });
      await entered;
      expect(JSON.stringify(params)).not.toContain("PRIVATE-ORDINARY-CHAT");
      expect(params!.tools ?? []).toEqual([]);
      try {
        const killed = await SELF.fetch("http://localhost/api/kill", { method: "POST",
          headers: { "content-type": "application/json" }, body: JSON.stringify({ userId }) });
        expect(killed.status).toBe(200);
        expect(params!.signal?.aborted).toBe(true);
      } finally {
        release({ id: "late-synthetic-result", content: [{ type: "text", text: JSON.stringify(ledger) }],
          stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 10 } });
      }
      const reply = await running;
      expect(reply.ok).toBe(true);
      if (!reply.ok) throw new Error(reply.code);
      expect(reply.value.status).toBe("cancelled");
      expect(reply.value.ledger).toBeNull();
      expect(internals(instance).conversationMessages).toEqual(history);
      expect([...instance.sql<{ id: string }>`SELECT id FROM policy_entries`].map((r) => r.id)).toEqual([WILDCARD_DENY_ID]);
      expect([...instance.sql`SELECT * FROM held_tool_calls`]).toEqual([]);
      expect([...instance.sql`SELECT * FROM session_state`]).toEqual([]);
    });
  });
});

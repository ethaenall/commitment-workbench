// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { env, createExecutionContext, runInDurableObject, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import {
  COMMITMENT_WORKFLOW_ID, ErrorResponse, RefinementDetailResponse,
  RefinementListResponse, RefinementMutationResponse, RefinementValidationResponse,
  WorkflowDescribeResponse, WorkflowRunResult, type CommitmentLedger,
} from "@habenula-ai/contracts";
import { checkDecisionClosure, verifyChainRange } from "@habenula-ai/audit";
import worker from "../../src/index";
import type { HabenulaEnv } from "../../src/env";
import { REFINEMENT_REQUEST_MAX_BYTES, WORKFLOW_REQUEST_MAX_BYTES } from "../../src/routes/governed-learning";
import { createCommitmentSnapshot } from "../../src/workflows/commitment-handoff";
import { stubFor } from "../helpers/http";
import type { LLMClient, LLMCreateParams } from "../../src/llm/types";

const TOKEN = "synthetic-governed-learning-control-token";
const ROUTES = [
  ["GET", "/api/refinements"], ["GET", "/api/refinements/get"],
  ["POST", "/api/refinements/propose"], ["POST", "/api/refinements/validate"],
  ["POST", "/api/refinements/approve"], ["POST", "/api/refinements/activate"],
  ["POST", "/api/refinements/disable"], ["POST", "/api/refinements/rollback"],
  ["GET", "/api/workflows"], ["POST", "/api/workflows/run"],
] as const;

async function fetchWith(request: Request, overrides: Partial<HabenulaEnv> = {}): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, {
    ...env, GOVERNED_LEARNING: "true", INTERNAL_MCP_TOKEN: TOKEN, ...overrides,
  }, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}
function get(path: string, query: Record<string, string> = {}): Request {
  const url = new URL(path, "http://localhost");
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  return new Request(url, { headers: { authorization: `Bearer ${TOKEN}` } });
}
function post(path: string, body: unknown): Request {
  return new Request(`http://localhost${path}`, { method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: JSON.stringify(body) });
}
async function enable(userId: string, client?: LLMClient): Promise<void> {
  await runInDurableObject(stubFor(userId), (instance) => {
    const bound = (instance as unknown as { env: HabenulaEnv }).env;
    bound.GOVERNED_LEARNING = "true";
    bound.GOVERNED_LEARNING_VALIDATION = "";
    // Invalid on purpose for metadata-only operations. An eager client/config
    // lookup would fail these tests; no real credential/provider is present.
    bound.LLM_PROVIDER = client ? "openai-compatible" : "invalid-test-provider";
    bound.LLM_MODEL = "deterministic-test-client";
    bound.LLM_ENDPOINT = "http://127.0.0.1:1/v1";
    bound.ANTHROPIC_API_KEY = "";
    bound.LLM_API_KEY = "";
    if (client) instance.setLLMClient(client);
  });
}

async function discover(userId: string) {
  const response = await fetchWith(get("/api/workflows", { userId }));
  expect(response.status).toBe(200);
  return WorkflowDescribeResponse.parse(await response.json());
}
async function propose(userId: string) {
  const workflow = await discover(userId);
  const response = await fetchWith(post("/api/refinements/propose", {
    userId, parentVersionId: null,
    sources: [{ kind: "learning_fixture", id: workflow.fixtures.find((f) => f.split === "learning")!.id }],
    content: { schemaVersion: 1, kind: "workflow-guidance", title: "Synthetic procedure",
      rationale: "PRIVATE-RATIONALE-DO-NOT-AUDIT", scope: { workflowId: COMMITMENT_WORKFLOW_ID,
        slot: "reasoning", workflowContractHash: workflow.workflowContractHash },
      procedure: { steps: ["Check later evidence before selecting the current commitment."] } },
  }));
  expect(response.status).toBe(200);
  return RefinementDetailResponse.parse(await response.json());
}

async function syntheticInput() {
  const snapshot = await createCommitmentSnapshot({
    workflowId: COMMITMENT_WORKFLOW_ID, schemaVersion: 1, snapshotId: "http-test-fresh",
    userAddress: "sam@example.test", cutoff: "2026-10-09T23:00:00Z", timezone: "UTC",
    coverage: { scope: "supplied-snapshot", source: "synthetic-fixture", omittedMessages: 0, note: "Plumbing only" },
    messages: [{ id: "http-m1", threadId: "http-t1", sender: "sam@example.test", to: "pat@example.test",
      subject: "Synthetic case", timestamp: "2026-10-09T22:00:00Z",
      body: "PRIVATE-SNAPSHOT-BODY", truncated: false, omittedChars: 0 }],
  });
  // Deliberately empty: a contract-valid shape proves no semantic efficacy.
  const ledger: CommitmentLedger = { workflowId: snapshot.workflowId, snapshotId: snapshot.snapshotId,
    snapshotHash: snapshot.snapshotHash, items: [], coverage: { scope: "supplied-snapshot",
      omittedMessages: 0, truncatedMessageIds: [], limitations: [] } };
  const calls: LLMCreateParams[] = [];
  const client: LLMClient = { async createMessage(params) {
    calls.push(params);
    return { id: "synthetic-only", content: [{ type: "text", text: JSON.stringify(ledger) }],
      stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 20 } };
  } };
  return { snapshot, ledger, calls, client };
}

describe("governed learning HTTP admission", () => {
  it.each([undefined, "false", "TRUE", "1", " true"])("feature %j hides every read and write before auth/body/credentials", async (flag) => {
    const idFromName = vi.fn(() => { throw new Error("must not look up DO"); });
    for (const [method, path] of ROUTES) {
      const request = new Request(`http://localhost${path}`, { method,
        ...(method === "POST" ? { body: "not-json" } : {}) });
      const response = await fetchWith(request, { GOVERNED_LEARNING: flag,
        CREDENTIAL_ENCRYPTION_KEY: "", USER_AGENT: { idFromName } as unknown as HabenulaEnv["USER_AGENT"] });
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "Not found" });
      if (method === "POST") expect(request.bodyUsed).toBe(false);
    }
    expect(idFromName).not.toHaveBeenCalled();
  });

  it("missing/wrong/unconfigured tokens are identical before lookup or body parsing", async () => {
    const idFromName = vi.fn(() => { throw new Error("must not look up DO"); });
    for (const [method, path] of ROUTES) {
      for (const header of [null, "Bearer wrong", `bearer ${TOKEN}`]) {
        const request = new Request(`http://localhost${path}?versionId=private-existing-id`, { method,
          headers: header ? { authorization: header } : {}, ...(method === "POST" ? { body: "not-json" } : {}) });
        const response = await fetchWith(request, { USER_AGENT: { idFromName } as unknown as HabenulaEnv["USER_AGENT"] });
        expect(response.status).toBe(401);
        expect(await response.json()).toEqual({ error: "unauthorized" });
        if (method === "POST") expect(request.bodyUsed).toBe(false);
      }
    }
    for (const token of [undefined, ""]) {
      const response = await fetchWith(get("/api/refinements"), { INTERNAL_MCP_TOKEN: token });
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: "unauthorized" });
    }
    expect(idFromName).not.toHaveBeenCalled();
  });

  it.each([{ host: "attacker.example" }, { origin: "https://attacker.example" }, { origin: "null" }])(
    "keeps the Host/Origin guard before authenticated control requests: %j", async (headers) => {
      const request = get("/api/refinements");
      for (const [key, value] of Object.entries(headers)) request.headers.set(key, value);
      const response = await fetchWith(request);
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: "local requests only" });
    });

  it.each([
    ["/api/refinements/propose", REFINEMENT_REQUEST_MAX_BYTES],
    ["/api/workflows/run", WORKFLOW_REQUEST_MAX_BYTES],
  ])("bounds %s by actual streamed UTF-8 bytes with missing/lying lengths", async (path, cap) => {
    for (const length of [undefined, "1", String(cap + 1)]) {
      const bytes = new TextEncoder().encode("é".repeat(Math.floor(cap / 2) + 1));
      let cancelled = false;
      const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); },
        cancel() { cancelled = true; } });
      const headers = new Headers({ authorization: `Bearer ${TOKEN}` });
      if (length !== undefined) headers.set("content-length", length);
      const response = await fetchWith(new Request(`http://localhost${path}`, { method: "POST", headers, body }));
      expect(response.status).toBe(413);
      expect(ErrorResponse.parse(await response.json()).error_code).toBe("REQUEST_TOO_LARGE");
      if (length !== String(cap + 1)) expect(cancelled).toBe(true);
      else await body.cancel();
    }
  });

  it("bounds empty-chunk streams and refuses invalid JSON/encoding without reflecting content", async () => {
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({ pull(controller) { pulls++; controller.enqueue(new Uint8Array()); } });
    const request = new Request("http://localhost/api/refinements/propose", { method: "POST",
      headers: { authorization: `Bearer ${TOKEN}` }, body });
    expect((await fetchWith(request)).status).toBe(400);
    expect(pulls).toBeLessThan(4_100);
    for (const raw of ["PRIVATE-invalid-json", JSON.stringify({ profile: "real_model", token: TOKEN }), "null"]) {
      const response = await fetchWith(new Request("http://localhost/api/refinements/propose", {
        method: "POST", headers: { authorization: `Bearer ${TOKEN}` }, body: raw }));
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "Invalid governed-learning request", error_code: "REFINEMENT_INVALID_REQUEST" });
    }
  });

  it.each(["?limit=51", "?limit=1e1", "?limit=1&limit=2", "?profile=real_model", "?runner=provided"])(
    "strictly rejects unsupported or ambiguous list queries %s", async (query) => {
      expect((await fetchWith(get(`/api/refinements${query}`))).status).toBe(400);
    });
});

describe("governed learning real Worker -> DO -> SQLite wiring (no real model calls)", () => {
  it("discovers/imports/reads with no usable provider or encryption key; other routes keep their guard", async () => {
    const userId = "gl-http-metadata";
    await enable(userId);
    const response = await fetchWith(get("/api/workflows", { userId }), { CREDENTIAL_ENCRYPTION_KEY: "" });
    expect(response.status).toBe(200);
    const description = WorkflowDescribeResponse.parse(await response.json());
    expect(description.supportedModes).toEqual(["baseline", "refinements"]);
    expect(description.workflowContractHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(description)).not.toContain("oracle");
    expect(JSON.stringify(description)).not.toContain("body");
    const detail = await propose(userId);
    expect(detail.version.envelope.provenance.producerKind).toBe("operator_import");
    const list = await fetchWith(get("/api/refinements", { userId, limit: "1" }));
    expect(list.status).toBe(200);
    expect(RefinementListResponse.parse(await list.json()).refinements[0]!.versionHash).toBe(detail.version.versionHash);
    const getResponse = await fetchWith(get("/api/refinements/get", { userId, versionId: detail.version.envelope.versionId }));
    expect(getResponse.status).toBe(200);
    expect(RefinementDetailResponse.parse(await getResponse.json()).qualification?.executionKind).toBe("schema_contract");
    const denied = await fetchWith(get("/api/services", { userId }), { CREDENTIAL_ENCRYPTION_KEY: "" });
    expect(denied.status).toBe(503);
  });

  it("fails closed before respond() on malformed internal result fields", async () => {
    const userId = "gl-http-strict-result";
    await enable(userId);
    await discover(userId);
    await runInDurableObject(stubFor(userId), (instance) => {
      const service = (instance as unknown as { governedLearning: { describe: () => WorkflowDescribeResponse } }).governedLearning;
      const original = service.describe.bind(service);
      service.describe = () => ({ ...original(), privateMail: "PRIVATE-invalid-result" }) as WorkflowDescribeResponse;
    });
    const response = await fetchWith(get("/api/workflows", { userId }));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "Governed learning is unavailable", error_code: "GOVERNED_LEARNING_UNAVAILABLE" });
  });

  it("keeps caller-authored source ids out of the unauthenticated audit metadata", async () => {
    const userId = "gl-http-source-ref-privacy";
    await enable(userId);
    const description = await discover(userId);
    const privateSourceId = "PRIVATE-mail-token-rationale-in-source-id";
    const response = await fetchWith(post("/api/refinements/propose", {
      userId, parentVersionId: null, sources: [{ kind: "correction", id: privateSourceId }],
      content: { schemaVersion: 1, kind: "workflow-guidance", title: "Synthetic unresolved import",
        rationale: "PRIVATE-artifact-rationale", scope: { workflowId: COMMITMENT_WORKFLOW_ID,
          slot: "reasoning", workflowContractHash: description.workflowContractHash },
        procedure: { steps: ["Review the evidence."] } },
    }));
    expect(response.status).toBe(200);
    const detail = RefinementDetailResponse.parse(await response.json());
    expect(detail.version.envelope.provenance.sources[0]!.resolved).toBe(false);
    const audit = await runInDurableObject(stubFor(userId), (instance) => instance.listAuditEntries());
    expect(JSON.stringify(audit)).not.toContain(privateSourceId);
    expect(JSON.stringify(audit)).not.toContain("PRIVATE-artifact-rationale");
    const metadata = JSON.parse(audit.entries[0]!.parametersMetadata) as Record<string, unknown>;
    expect(metadata.sourceCount).toBe(1);
    expect(metadata).not.toHaveProperty("sourceIds");
    expect(metadata.requestHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("maps not-found and digest conflicts as fixed tagged RPC replies", async () => {
    const userId = "gl-http-errors";
    await enable(userId);
    const missing = await fetchWith(get("/api/refinements/get", { userId, versionId: "PRIVATE-missing" }));
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "Refinement not found", error_code: "REFINEMENT_NOT_FOUND" });
    const detail = await propose(userId);
    const conflict = await fetchWith(post("/api/refinements/validate", { userId,
      versionId: detail.version.envelope.versionId, versionHash: "0".repeat(64), suiteId: detail.qualification!.suiteId }));
    expect(conflict.status).toBe(409);
    expect(ErrorResponse.parse(await conflict.json()).error_code).toBe("REFINEMENT_CONFLICT");
    const otherId = "gl-http-other-owner";
    await enable(otherId);
    const foreign = await fetchWith(get("/api/refinements/get", { userId: otherId, versionId: detail.version.envelope.versionId }));
    expect(foreign.status).toBe(404);
  });

  it("validates/approves/activates/disables/rolls back and audits standalone lifecycle with no grants", async () => {
    const userId = "gl-http-lifecycle";
    const fake = await syntheticInput();
    await enable(userId, fake.client);
    const detail = await propose(userId);
    const validateResponse = await fetchWith(post("/api/refinements/validate", { userId,
      versionId: detail.version.envelope.versionId, versionHash: detail.version.versionHash,
      suiteId: detail.qualification!.suiteId }));
    expect(validateResponse.status).toBe(200);
    const validated = RefinementValidationResponse.parse(await validateResponse.json());
    expect(validated.validation.status).toBe("passed");
    expect(validated.validation.assurance).toBe("contract_only");
    expect(fake.calls).toHaveLength(0);
    const receipt = { userId, versionId: detail.version.envelope.versionId, versionHash: detail.version.versionHash,
      validationId: validated.validation.id, reportHash: validated.validation.reportHash!,
      expectedScopeGeneration: validated.scope.generation };
    const approvedResponse = await fetchWith(post("/api/refinements/approve", receipt));
    expect(approvedResponse.status).toBe(200);
    const approved = RefinementMutationResponse.parse(await approvedResponse.json());
    const activeResponse = await fetchWith(post("/api/refinements/activate", { ...receipt, approvalAuditId: approved.auditEntryId }));
    expect(activeResponse.status).toBe(200);
    const active = RefinementMutationResponse.parse(await activeResponse.json());
    const disabledResponse = await fetchWith(post("/api/refinements/disable", { userId, versionId: receipt.versionId,
      versionHash: receipt.versionHash, expectedScopeGeneration: active.scopeGeneration, reason: "PRIVATE-DISABLE-REASON" }));
    expect(disabledResponse.status).toBe(200);
    const disabled = RefinementMutationResponse.parse(await disabledResponse.json());
    // Rollback is not a generic re-enable. It requires an older approved
    // disabled revision while a newer revision in the same family is active.
    const newerResponse = await fetchWith(post("/api/refinements/propose", {
      userId, parentVersionId: receipt.versionId,
      sources: detail.version.envelope.provenance.sources.map(({ kind, id }) => ({ kind, id })),
      content: { ...detail.version.envelope.content, title: "Second synthetic procedure" },
    }));
    expect(newerResponse.status).toBe(200);
    const newer = RefinementDetailResponse.parse(await newerResponse.json());
    const newerValidationResponse = await fetchWith(post("/api/refinements/validate", {
      userId, versionId: newer.version.envelope.versionId, versionHash: newer.version.versionHash,
      suiteId: newer.qualification!.suiteId,
    }));
    expect(newerValidationResponse.status).toBe(200);
    const newerValidated = RefinementValidationResponse.parse(await newerValidationResponse.json());
    expect(newerValidated.validation.status).toBe("passed");
    const newerReceipt = { userId, versionId: newer.version.envelope.versionId, versionHash: newer.version.versionHash,
      validationId: newerValidated.validation.id, reportHash: newerValidated.validation.reportHash!,
      expectedScopeGeneration: disabled.scopeGeneration };
    const newerApproveResponse = await fetchWith(post("/api/refinements/approve", newerReceipt));
    expect(newerApproveResponse.status).toBe(200);
    const newerApproved = RefinementMutationResponse.parse(await newerApproveResponse.json());
    const newerActivateResponse = await fetchWith(post("/api/refinements/activate", {
      ...newerReceipt, approvalAuditId: newerApproved.auditEntryId,
    }));
    expect(newerActivateResponse.status).toBe(200);
    const newerActive = RefinementMutationResponse.parse(await newerActivateResponse.json());
    const rollbackResponse = await fetchWith(post("/api/refinements/rollback", { ...receipt,
      expectedScopeGeneration: newerActive.scopeGeneration, reason: "PRIVATE-ROLLBACK-REASON" }));
    expect(rollbackResponse.status).toBe(200);
    expect(RefinementMutationResponse.parse(await rollbackResponse.json()).state).toBe("active");

    const runResponse = await fetchWith(post("/api/workflows/run", { userId, mode: "refinements", snapshot: fake.snapshot }));
    expect(runResponse.status).toBe(200);
    const run = WorkflowRunResult.parse(await runResponse.json());
    expect(run.status).toBe("complete");
    expect(run.refinement?.hash).toBe(receipt.versionHash);
    expect(run.validation.semanticVerified).toBe(false);
    expect(run.usage.kind).toBe("synthetic");
    expect(fake.calls).toHaveLength(1);
    expect(JSON.stringify(fake.calls)).not.toContain(TOKEN);

    const state = await runInDurableObject(stubFor(userId), (instance) => ({
      policy: [...instance.sql<{ id: string }>`SELECT id FROM policy_entries`],
      sessions: [...instance.sql`SELECT * FROM session_state`],
      held: [...instance.sql`SELECT * FROM held_tool_calls`],
      services: [...instance.sql`SELECT * FROM connected_services`],
      audit: instance.listAuditEntries(),
    }));
    expect(state.policy.map((r) => r.id)).toEqual(["default-deny"]);
    expect(state.sessions).toEqual([]); expect(state.held).toEqual([]); expect(state.services).toEqual([]);
    const entries = state.audit.entries;
    for (const name of ["propose", "validate", "approve", "activate", "disable", "rollback", "use"]) {
      expect(entries.some((row) => row.toolName === `refinement.${name}`)).toBe(true);
    }
    expect(entries.every((row) => row.sessionId === "refinement-control" && row.decisionEntryId === null)).toBe(true);
    const rawAudit = JSON.stringify(entries);
    for (const secret of [TOKEN, "PRIVATE-RATIONALE", "PRIVATE-DISABLE-REASON", "PRIVATE-ROLLBACK-REASON", "PRIVATE-SNAPSHOT-BODY"]) {
      expect(rawAudit).not.toContain(secret);
    }
    const closure = checkDecisionClosure(entries.slice().reverse(), { upperEdgeClosed: true });
    expect(closure.decisionsChecked).toBe(0); expect(closure.unresolved).toEqual([]);
    expect(verifyChainRange(entries.slice().reverse()).breaks).toEqual([]);
  });

  it("rejects trusted-profile/model/runner fields even beside an otherwise valid workflow request", async () => {
    const userId = "gl-http-no-profile-override";
    const fake = await syntheticInput();
    await enable(userId, fake.client);
    for (const key of ["profile", "validationKind", "model", "runner", "workflowBuildHash", "validatorBuildHash"]) {
      const response = await fetchWith(post("/api/workflows/run", {
        userId, mode: "baseline", snapshot: fake.snapshot, [key]: "PRIVATE-OVERRIDE",
      }));
      expect(response.status).toBe(400);
      expect(ErrorResponse.parse(await response.json()).error_code).toBe("REFINEMENT_INVALID_REQUEST");
    }
    const badHash = await fetchWith(post("/api/workflows/run", {
      userId, mode: "baseline", snapshot: { ...fake.snapshot, snapshotHash: "0".repeat(64) },
    }));
    expect(badHash.status).toBe(400);
    const unknown = await fetchWith(post("/api/workflows/run", { userId, fixtureId: "not-a-host-fixture" }));
    expect(unknown.status).toBe(404);
    expect(fake.calls).toHaveLength(0);
  });

  it.each(["rlm", "both"])("%s returns explicit blocked, no fallback or model call", async (mode) => {
    const userId = `gl-http-blocked-${mode}`;
    const fake = await syntheticInput();
    await enable(userId, fake.client);
    const response = await fetchWith(post("/api/workflows/run", { userId, mode, snapshot: fake.snapshot }));
    expect(response.status).toBe(200);
    const result = WorkflowRunResult.parse(await response.json());
    expect(result.mode).toBe(mode); expect(result.status).toBe("blocked");
    expect(result.ledger).toBeNull(); expect(result.usage.rootCalls).toBe(0); expect(result.usage.childCalls).toBe(0);
    expect(fake.calls).toHaveLength(0);
  });
});

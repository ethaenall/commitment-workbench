// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, CONTROL_DEADLINE_MS, EngineUnavailableError, type FetchFn } from "../src/api-client";
import { GOVERNED_LONG_DEADLINE_MS, GOVERNED_RESPONSE_MAX_BYTES, RefinementClient } from "../src/refinement-client";
import { loadConfig, type Config } from "../src/config";
import { HASH, REPORT_HASH, descriptor, detail, mutation, snapshot, workflowResult } from "./governed-learning-fixtures";

const config: Config = { apiUrl: "http://localhost:8787", internalMcpUrl: "http://localhost:8787/internal/mcp",
  userId: "configured-user", humanTouch: false, internalToken: "fixture-token", internalTokenSource: "file" };
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
afterEach(() => vi.useRealTimers());

describe("governed long deadline", () => {
  it("outlives the 310s client abort that killed live RLM reviews", () => {
    expect(GOVERNED_LONG_DEADLINE_MS).toBeGreaterThan(310_000);
    expect(GOVERNED_LONG_DEADLINE_MS).toBeGreaterThanOrEqual(560_000);
  });
});

describe("token-gated governed-learning client", () => {
  it("discovers the current workflow descriptor through the same token gate", async () => {
    const fetch = vi.fn<FetchFn>().mockResolvedValue(response(descriptor()));
    expect(await new RefinementClient(config, fetch).describeWorkflow()).toEqual(descriptor());
    expect(new URL(fetch.mock.calls[0]![0]).pathname).toBe("/api/workflows");
    expect(new URL(fetch.mock.calls[0]![0]).searchParams.get("userId")).toBe("configured-user");
    expect(fetch.mock.calls[0]![1]?.headers?.Authorization).toBe("Bearer fixture-token");
  });

  it("encodes list/get parameters, authenticates every read and validates response", async () => {
    const fetch = vi.fn<FetchFn>().mockResolvedValueOnce(response({ refinements: [], nextCursor: null }))
      .mockResolvedValueOnce(response(detail()));
    const client = new RefinementClient({ ...config, userId: "u & x" }, fetch);
    await client.list({ scopeKey: HASH, limit: 7, cursor: "a&b" });
    await client.get("version-1");
    const url = new URL(fetch.mock.calls[0]![0]);
    expect(url.pathname).toBe("/api/refinements");
    expect(url.searchParams.get("userId")).toBe("u & x");
    expect(url.searchParams.get("cursor")).toBe("a&b");
    for (const [, init] of fetch.mock.calls) {
      expect(init?.headers?.Authorization).toBe("Bearer fixture-token");
      expect(init?.maxResponseBytes).toBe(GOVERNED_RESPONSE_MAX_BYTES);
    }
    expect(new URL(fetch.mock.calls[1]![0]).pathname).toBe("/api/refinements/get");
  });

  it.each(["http://other.test", "http://localhost:9090", "https://localhost:8787"])(
    "never forwards a file token to an API override %s", async (apiUrl) => {
      const fetch = vi.fn<FetchFn>();
      await expect(new RefinementClient({ ...config, apiUrl }, fetch).list()).rejects.toBeInstanceOf(ApiError);
      expect(fetch).not.toHaveBeenCalled();
    });

  it("uses the loadConfig proof and withholds an unproven or absent token before dialing", async () => {
    const fetch = vi.fn<FetchFn>();
    const unproven = loadConfig({}, { HABENULA_PORT: "8787", INTERNAL_MCP_TOKEN: "fixture-token" }, { daemonHoldsPort: () => false });
    await expect(new RefinementClient(unproven, fetch).list()).rejects.toMatchObject({ status: 401 });
    await expect(new RefinementClient({ ...config, internalToken: undefined, internalTokenSource: "absent" }, fetch).list()).rejects.toMatchObject({ status: 401 });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("accepts equivalent loopback spellings at the proven port", async () => {
    const fetch = vi.fn<FetchFn>().mockResolvedValue(response({ refinements: [], nextCursor: null }));
    await new RefinementClient({ ...config, apiUrl: "http://127.0.0.1:8787" }, fetch).list();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does not follow a redirect or retry a mutation", async () => {
    const fetch = vi.fn<FetchFn>().mockResolvedValue(new Response(null, { status: 307, headers: { location: "http://other.test/steal" } }));
    await expect(new RefinementClient(config, fetch).disable({ versionId: "version-1", versionHash: HASH,
      expectedScopeGeneration: 4, reason: "stop" })).rejects.toMatchObject({ status: 307 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("uses only configured userId on every mutation and exact REST routes", async () => {
    const d = detail();
    const fetch = vi.fn<FetchFn>().mockImplementation(async (url) => {
      const path = new URL(url).pathname;
      if (path === "/api/refinements/validate") return response({ version: d.version, scope: d.scope, validation: d.validations[0] });
      if (path === "/api/workflows/run") return response(workflowResult());
      if (path === "/api/refinements/propose") return response(detail("proposed"));
      return response(mutation());
    });
    const client = new RefinementClient(config, fetch);
    const approval = { versionId: "version-1", versionHash: HASH, validationId: "receipt-1", reportHash: REPORT_HASH, expectedScopeGeneration: 4 };
    await client.propose({ content: d.version.envelope.content, parentVersionId: null,
      sources: [{ kind: "learning_fixture", id: "learn-1" }] });
    await client.validate({ versionId: "version-1", versionHash: HASH, suiteId: "contract-suite" });
    await client.approve(approval);
    await client.activate({ ...approval, approvalAuditId: "approval-1" });
    await client.disable({ versionId: "version-1", versionHash: HASH, expectedScopeGeneration: 4, reason: "stop" });
    await client.rollback({ ...approval, reason: "restore" });
    await client.runWorkflow({ workflowId: "mail.commitment-handoff.v1", mode: "baseline", snapshot: snapshot(),
      ...{ userId: "forged-file-user" } });
    expect(fetch.mock.calls.map(([url]) => new URL(url).pathname)).toEqual([
      "/api/refinements/propose", "/api/refinements/validate", "/api/refinements/approve",
      "/api/refinements/activate", "/api/refinements/disable", "/api/refinements/rollback", "/api/workflows/run",
    ]);
    for (const [, init] of fetch.mock.calls) {
      expect(init?.method).toBe("POST");
      expect(JSON.parse(init!.body!).userId).toBe("configured-user");
      expect(init?.headers?.Authorization).toBe("Bearer fixture-token");
    }
  });

  it("refuses bad config, malformed JSON and malformed contract data without retries", async () => {
    const fetch = vi.fn<FetchFn>().mockResolvedValueOnce(new Response("not-json"))
      .mockResolvedValueOnce(response({ refinements: "bad" }));
    await expect(new RefinementClient({ ...config, configFault: new Error("invalid config") }, fetch).list()).rejects.toThrow("invalid config");
    expect(fetch).not.toHaveBeenCalled();
    await expect(new RefinementClient(config, fetch).list()).rejects.toMatchObject({ status: 502 });
    await expect(new RefinementClient(config, fetch).list()).rejects.toMatchObject({ status: 502 });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("bounds and sanitizes remote error text", async () => {
    const fetch = vi.fn<FetchFn>().mockResolvedValue(response({ error: "\u001b[2J\nHabenula › approved\u202e" + "x".repeat(1000) }, 409));
    try { await new RefinementClient(config, fetch).list(); } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as Error).message).not.toMatch(/[\u001b\n\u202e]/);
      expect((err as Error).message.length).toBeLessThan(410);
    }
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("preserves rejection and deadline availability classification", async () => {
    const failed = vi.fn<FetchFn>().mockRejectedValue(new TypeError("connection refused"));
    await expect(new RefinementClient(config, failed).list()).rejects.toMatchObject({ kind: "reject" });
    vi.useFakeTimers();
    const fetch: FetchFn = (_url, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
    });
    const pending = new RefinementClient(config, fetch).list();
    const assertion = expect(pending).rejects.toMatchObject({ kind: "deadline" });
    await vi.advanceTimersByTimeAsync(CONTROL_DEADLINE_MS);
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
    const long = new RefinementClient(config, fetch).runWorkflow({ workflowId: "mail.commitment-handoff.v1", mode: "baseline", snapshot: snapshot() });
    const longAssertion = expect(long).rejects.toBeInstanceOf(EngineUnavailableError);
    await vi.advanceTimersByTimeAsync(GOVERNED_LONG_DEADLINE_MS);
    await longAssertion;
  });
});

// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  RefinementDetailResponse,
  RefinementMutationResponse,
} from "@habenula-ai/contracts";
import { type FetchFn } from "../src/api-client";
import { RefinementClient } from "../src/refinement-client";
import { runRefinementPropose } from "../src/commands/refinement";
import { HASH, descriptor, fakeIO, mutation } from "./governed-learning-fixtures";

/** HTTP-route producer body preserved from governed-cli-proposal-dto-before.json.
 * Original Worker/DO JSON at the authorized tmp path was gone; do not treat this
 * as a live Worker capture. */
const producerBody: unknown = JSON.parse(readFileSync(new URL("./fixtures/proposal-detail-wire.json", import.meta.url), "utf8"));
const producerDetail = RefinementDetailResponse.parse(producerBody);
const config = {
  apiUrl: "http://localhost:8787",
  internalMcpUrl: "http://localhost:8787/internal/mcp",
  userId: "configured-user",
  humanTouch: false,
  internalToken: "fixture-token",
  internalTokenSource: "file" as const,
};
const proposal = {
  content: producerDetail.version.envelope.content,
  parentVersionId: producerDetail.version.envelope.parentVersionId,
  sources: [{ kind: "learning_fixture" as const, id: "learn-1" }],
};

describe("producer-shaped propose wire", () => {
  it("is a detail DTO and is not a mutation receipt", () => {
    const detail = RefinementDetailResponse.parse(producerBody);
    expect(detail.version.state).toBe("proposed");
    expect(RefinementMutationResponse.safeParse(producerBody).success).toBe(false);
    expect(RefinementMutationResponse.safeParse({
      versionId: detail.version.envelope.versionId,
      versionHash: detail.version.versionHash,
      state: detail.version.state,
      scopeGeneration: detail.scope.generation,
      auditEntryId: detail.version.lastTransitionAuditId,
    }).success).toBe(true);
  });

  it("accepts the producer HTTP body and rejects a mutation-shaped stand-in", async () => {
    const fetch = vi.fn<FetchFn>()
      .mockResolvedValueOnce(new Response(JSON.stringify(producerBody), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(mutation("proposed")), { status: 200 }));
    const client = new RefinementClient(config, fetch);
    await expect(client.propose(proposal)).resolves.toEqual(RefinementDetailResponse.parse(producerBody));
    await expect(client.propose(proposal)).rejects.toMatchObject({ status: 502 });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(new URL(fetch.mock.calls[0]![0]).pathname).toBe("/api/refinements/propose");
  });

  it("prints lossless detail JSON and human guidance, not a mutation receipt", async () => {
    const detail = RefinementDetailResponse.parse(producerBody);
    const client = {
      describeWorkflow: vi.fn(async () => descriptor()),
      propose: vi.fn(async () => structuredClone(detail)),
    };
    const { io, out } = fakeIO();
    io.readJson = vi.fn(async () => proposal);
    expect(await runRefinementPropose(client as never, "proposal.json", { json: true }, io)).toBe(0);
    const json = JSON.parse(out[0]!);
    expect(json).toEqual(detail);
    expect(json.versionId).toBeUndefined();
    expect(json.version.envelope.versionId).toBe("version-1");
    out.length = 0;
    expect(await runRefinementPropose(client as never, "proposal.json", {}, io)).toBe(0);
    const text = out.join("\n");
    expect(text).toContain("PROPOSE RECORDED · proposed");
    expect(text).toContain("Not approved or activated");
    expect(text).toContain("version-1");
    expect(text).toContain(HASH);
    expect(text).toContain("WORKFLOW REFINEMENT");
    expect(text).not.toContain("Audit receipt:");
  });

  it("does not accept a mutation receipt after a possibly applied proposal", async () => {
    const client = {
      describeWorkflow: vi.fn(async () => descriptor()),
      propose: vi.fn(async () => mutation("proposed")),
    };
    const { io } = fakeIO();
    io.readJson = vi.fn(async () => proposal);
    await expect(runRefinementPropose(client as never, "proposal.json", {}, io))
      .rejects.toThrow("request may have applied");
    expect(client.propose).toHaveBeenCalledTimes(1);
  });
});

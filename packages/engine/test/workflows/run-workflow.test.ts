// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkflowAnalysisTrace } from "@habenula-ai/contracts";
import type { LLMClient, LLMCreateParams, LLMResponse } from "../../src/llm/types";
import { RefinementError } from "../../src/refinements/errors";
import { ModelBudget } from "../../src/workflows/model-budget";
import { runCommitmentWorkflow, WORKFLOW_FIELD_CONVENTIONS, WORKFLOW_SYSTEM_PROMPT, type RunWorkflowOptions } from "../../src/workflows/run-workflow";
import { createCommitmentSourceIndex, validateCommitmentLedger } from "../../src/workflows/commitment-handoff";
import { getWorkflowFixture, type CommitmentOracle } from "../../src/workflows/fixtures";
import { oracleLedger } from "../../../../evals/governed-learning/oracle-ledger";
import learningOracle from "../../../../evals/governed-learning/oracles/learning/learn-01.json";

// Oracle replay is a deterministic plumbing fixture, never an efficacy result.
const budgets: ModelBudget[] = [];
afterEach(() => { for (const budget of budgets.splice(0)) budget.dispose(); });
async function setup(transform?: (value: LLMResponse, params: LLMCreateParams) => LLMResponse | Promise<LLMResponse>) {
  const snapshot = (await getWorkflowFixture("learn-01"))!;
  const ledger = oracleLedger(snapshot, learningOracle as CommitmentOracle);
  const value: LLMResponse = { id: "fixture-response", stop_reason: "end_turn",
    content: [{ type: "text", text: JSON.stringify(ledger) }], usage: { input_tokens: 11, output_tokens: 7, reported: true } };
  const client = { createMessage: vi.fn(async (params: LLMCreateParams) => transform ? transform(value, params) : value) };
  const budget = new ModelBudget({ client, model: "fixed-fixture" }); budgets.push(budget);
  const options: RunWorkflowOptions = { runId: crypto.randomUUID(), mode: "baseline", snapshot, budget, model: null, usageKind: "synthetic" };
  return { snapshot, ledger, client, budget, options, value };
}
function activeGuidance(assertCurrent = vi.fn()) {
  return { kind: "active" as const, revision: 2,
    pin: { versionId: "revision-two", versionHash: "a".repeat(64), validationId: "receipt-two", scopeKey: "b".repeat(64), scopeGeneration: 4 },
    content: { schemaVersion: 1 as const, kind: "workflow-guidance" as const, title: "Preserve accepted changes",
      rationale: "A deterministic test, not learned efficacy.",
      scope: { workflowId: "mail.commitment-handoff.v1", slot: "reasoning" as const, workflowContractHash: "c".repeat(64) },
      procedure: { steps: ["Distinguish a quoted old date from an accepted new commitment."] } }, assertCurrent };
}

function expectIncompleteExecution(
  result: Awaited<ReturnType<typeof runCommitmentWorkflow>>,
  status: "error" | "blocked" | "cancelled" | "budget_exceeded",
): void {
  expect(result.status).toBe(status);
  expect(result.ledger).toBeNull();
  expect(result.validation).toEqual({ level: "contract-only", valid: false, semanticVerified: false,
    issues: [{ code: "WORKFLOW_RLM_EXECUTION_INCOMPLETE", path: "workflow",
      message: "RLM execution did not complete. No partial ledger or measured output result was accepted." }] });
}

describe("fresh, action-free workflow runner", () => {
  it("runs in workerd with fresh fenced source, no tools, and explicit synthetic accounting", async () => {
    expect(navigator.userAgent).toBe("Cloudflare-Workers");
    const f = await setup();
    const before = JSON.stringify(f.snapshot);
    const result = await runCommitmentWorkflow(f.options);
    expect(result.status).toBe("complete"); expect(result.ledger).toEqual(f.ledger);
    expect(result.validation.semanticVerified).toBe(false);
    expect(result.usage).toEqual({ kind: "synthetic", inputTokens: 11, outputTokens: 7, rootCalls: 1, childCalls: 0, complete: true });
    const request = f.client.createMessage.mock.calls[0]![0];
    expect(request.tools).toEqual([]); expect(request.disableRetries).toBe(true); expect(request.signal).toBe(f.budget.signal);
    expect(request.system).toBe(WORKFLOW_SYSTEM_PROMPT); expect(request.messages).toHaveLength(1);
    expect(request.messages[0]!.content).toContain("<<habenula-untrusted-output ");
    expect(request.messages[0]!.content).toContain(f.snapshot.snapshotHash);
    expect(JSON.stringify(f.snapshot)).toBe(before); expect(result.refinement).toBeNull();
  });
  it("gives all four arms the same source-only offset aid and field conventions (synthetic plumbing)", async () => {
    const captured: unknown[] = [];
    for (const mode of ["baseline", "refinements", "rlm", "both"] as const) {
      const f = await setup();
      const expected = { snapshot: f.snapshot, sourceIndex: await createCommitmentSourceIndex(f.snapshot) };
      const refined = mode === "refinements" || mode === "both";
      const recursive = mode === "rlm" || mode === "both";
      const recordUse = vi.fn();
      const result = await runCommitmentWorkflow({ ...f.options, mode,
        guidance: refined ? { ...activeGuidance(), recordUse } : undefined,
        runtime: recursive ? { id: "source-aid-plumbing-only", run: async (input) => {
          expect(input.system).toBe(WORKFLOW_SYSTEM_PROMPT);
          expect(input.budget).toBe(f.budget); expect(input.signal).toBe(f.budget.signal);
          expect(input.maxRepairs).toBe(1);
          expect(Object.isFrozen(input.sourceIndex)).toBe(true);
          captured.push({ snapshot: input.snapshot, sourceIndex: input.sourceIndex });
          await input.budget.clientFor("root").createMessage({ model: "fixed-fixture", max_tokens: 100,
            system: input.system, messages: [{ role: "user", content: JSON.stringify({ snapshot: input.snapshot,
              sourceIndex: input.sourceIndex }) }], tools: [] });
          return { output: f.ledger };
        } } : undefined });
      // This fake measures input plumbing only. It supplies no host execution
      // evidence, so the recursive arms must refuse its otherwise valid ledger.
      if (recursive) {
        expectIncompleteExecution(result, "error");
        expect(result.analysisTrace).toBeUndefined();
      } else {
        expect(result.status).toBe("complete"); expect(result.ledger).toEqual(f.ledger);
      }
      expect(f.client.createMessage).toHaveBeenCalledTimes(1);
      expect(result.usage).toEqual({ kind: "synthetic", inputTokens: 11, outputTokens: 7,
        rootCalls: 1, childCalls: 0, complete: true });
      expect(recordUse).toHaveBeenCalledTimes(refined ? 1 : 0);
      if (!recursive) {
        const request = f.client.createMessage.mock.calls[0]![0];
        const content = request.messages[0]!.content;
        expect(typeof content).toBe("string");
        const payload = (content as string).split("\n").find((line) => line.startsWith('{"snapshot":'))!;
        const input = JSON.parse(payload);
        expect(Object.keys(input)).toEqual(["snapshot", "sourceIndex"]);
        expect(input).toEqual(expected);
        captured.push(input);
        expect(request.system).toBe(WORKFLOW_SYSTEM_PROMPT);
      }
      for (const convention of Object.values(WORKFLOW_FIELD_CONVENTIONS)) {
        expect(WORKFLOW_SYSTEM_PROMPT).toContain(convention);
      }
    }
    expect(captured).toHaveLength(4);
    for (const input of captured) expect(input).toEqual(captured[0]);
  });
  it("counts the source aid in the ordinary request byte ceiling", async () => {
    const f = await setup();
    expect((await runCommitmentWorkflow(f.options)).status).toBe("complete");
    const indexBytes = new TextEncoder().encode(JSON.stringify(await createCommitmentSourceIndex(f.snapshot))).byteLength;
    const limitWithoutAid = f.budget.snapshot().totalRequestInputBytes - indexBytes;
    expect(limitWithoutAid).toBeGreaterThan(0);
    const budget = new ModelBudget({ client: f.client, model: "fixed-fixture", limits: { maxInputBytesPerCall: limitWithoutAid } });
    budgets.push(budget); f.client.createMessage.mockClear();
    const result = await runCommitmentWorkflow({ ...f.options, budget });
    expect(result.status).toBe("budget_exceeded");
    expect(result.validation.issues[0]?.code).toBe("WORKFLOW_REQUEST_BYTES_LIMIT");
    expect(f.client.createMessage).not.toHaveBeenCalled();
  });
  it("attaches the approved reference only as task material and reports revision, not schemaVersion", async () => {
    const f = await setup(); const guidance = activeGuidance();
    const result = await runCommitmentWorkflow({ ...f.options, mode: "refinements", guidance });
    expect(result.status).toBe("complete"); expect(result.refinement?.version).toBe(2);
    expect(guidance.assertCurrent.mock.calls.length).toBeGreaterThanOrEqual(3);
    const request = f.client.createMessage.mock.calls[0]![0];
    expect(request.system).not.toContain(guidance.content.procedure.steps[0]);
    expect(request.messages[0]!.content).toContain(guidance.content.procedure.steps[0]);
  });
  it("keeps candidate validation references distinct from approved active pins", async () => {
    const f = await setup(); const active = activeGuidance();
    const result = await runCommitmentWorkflow({ ...f.options, mode: "refinements", guidance: {
      kind: "candidate", versionId: "candidate", versionHash: "d".repeat(64), revision: 3,
      content: active.content, assertCurrent: vi.fn() } });
    expect(result.status).toBe("complete"); expect(result.refinement).toMatchObject({ id: "candidate", version: 3 });
    expect(f.client.createMessage.mock.calls[0]![0].messages[0]!.content).toContain("NOT approved or active");
  });
  it("blocks a pin invalidated during inference and never falls back to baseline", async () => {
    let changed = false;
    const f = await setup((value) => { changed = true; return value; });
    const guidance = activeGuidance(vi.fn(() => { if (changed) throw new RefinementError("REFINEMENT_CHANGED"); }));
    const result = await runCommitmentWorkflow({ ...f.options, mode: "refinements", guidance });
    expect(result.status).toBe("blocked"); expect(result.ledger).toBeNull();
    expect(result.validation.issues[0]?.code).toBe("REFINEMENT_CHANGED"); expect(f.client.createMessage).toHaveBeenCalledTimes(1);
  });
  it("rejects mismatched source hashes before any inference or guidance use", async () => {
    const f = await setup(); const guidance = activeGuidance();
    const bad = JSON.parse(JSON.stringify(f.snapshot)); bad.messages[0].body += "tampered";
    const result = await runCommitmentWorkflow({ ...f.options, snapshot: bad, mode: "refinements", guidance });
    expect(result.status).toBe("blocked"); expect(f.client.createMessage).not.toHaveBeenCalled(); expect(guidance.assertCurrent).not.toHaveBeenCalled();
  });
  it.each(["gmail_send", "refinement.activate", "resolve"])("rejects named-anyway %s without dispatch or repair", async (name) => {
    const f = await setup((value) => ({ ...value, stop_reason: "tool_use", content: [{ type: "tool_use", id: "forged", name, input: { approved: true } }] }));
    const result = await runCommitmentWorkflow(f.options);
    expect(result.status).toBe("invalid_output"); expect(result.ledger).toBeNull();
    expect(result.validation.issues[0]?.code).toBe("WORKFLOW_TOOLS_FORBIDDEN"); expect(f.client.createMessage).toHaveBeenCalledTimes(1);
  });
  it("allows exactly one output repair and counts it in the same budget", async () => {
    let calls = 0;
    const f = await setup((value) => ++calls === 1 ? { ...value, content: [{ type: "text", text: "not-json" }] } : value);
    const result = await runCommitmentWorkflow(f.options);
    expect(result.status).toBe("complete"); expect(result.usage.rootCalls).toBe(2); expect(result.usage.outputTokens).toBe(14);
    const repair = f.client.createMessage.mock.calls[1]![0]; expect(repair.messages).toHaveLength(3);
    expect(repair.messages[2]!.content).not.toContain("oracle.");
    expect(repair.system).toBe(f.client.createMessage.mock.calls[0]![0].system);
  });
  it("retains two invalid outputs as failure, without an unbounded retry loop", async () => {
    const f = await setup((value) => ({ ...value, content: [{ type: "text", text: "not-json" }] }));
    const result = await runCommitmentWorkflow(f.options);
    expect(result.status).toBe("invalid_output"); expect(result.usage.rootCalls).toBe(2); expect(f.client.createMessage).toHaveBeenCalledTimes(2);
  });
  it("does not call a JSON-shaped provider truncation complete", async () => {
    const f = await setup((value) => ({ ...value, stop_reason: "max_tokens" }));
    const result = await runCommitmentWorkflow(f.options);
    expect(result.status).toBe("invalid_output"); expect(result.validation.issues[0]?.code).toBe("WORKFLOW_OUTPUT_TRUNCATED");
    expect(result.usage.rootCalls).toBe(2);
  });
  it("never promotes missing usage to a measured zero-cost result", async () => {
    const f = await setup((value) => ({ ...value, usage: { input_tokens: 0, output_tokens: 0, reported: false } }));
    const result = await runCommitmentWorkflow(f.options);
    expect(result.status).toBe("error"); expect(result.ledger).toBeNull();
    expect(result.usage).toMatchObject({ kind: "unknown", inputTokens: null, outputTokens: null, rootCalls: 1, complete: false });
  });
  it("does not leak provider exception contents", async () => {
    const f = await setup(() => { throw new Error("private-source-and-credential-sentinel"); });
    const result = await runCommitmentWorkflow(f.options);
    expect(result.status).toBe("error"); expect(JSON.stringify(result)).not.toContain("private-source-and-credential-sentinel");
  });
  it.each(["rlm", "both"] as const)("blocks unavailable %s without pretending another mode ran", async (mode) => {
    const f = await setup();
    const result = await runCommitmentWorkflow({ ...f.options, mode, ...(mode === "both" ? { guidance: activeGuidance() } : {}) });
    expect(result.status).toBe("blocked"); expect(result.mode).toBe(mode); expect(result.ledger).toBeNull();
    expect(f.client.createMessage).not.toHaveBeenCalled();
  });
  it("retains shared root/child counters but refuses a runtime without execution trace", async () => {
    const f = await setup();
    const result = await runCommitmentWorkflow({ ...f.options, mode: "rlm", runtime: { id: "deterministic-runtime-fixture", run: async (input) => {
      expect(input.maxRepairs).toBe(1); expect(input.snapshot.snapshotHash).toBe(f.snapshot.snapshotHash);
      expect(input.budget).toBe(f.budget); expect(input.signal).toBe(f.budget.signal);
      await input.budget.clientFor("root").createMessage({ model: "fixed-fixture", max_tokens: 100, messages: [], tools: [] });
      await input.budget.clientFor("child").createMessage({ model: "fixed-fixture", max_tokens: 100, messages: [], tools: [] });
      return { output: f.ledger };
    } } });
    expectIncompleteExecution(result, "error"); expect(result.analysisTrace).toBeUndefined();
    expect(result.usage).toEqual({ kind: "synthetic", rootCalls: 1, childCalls: 1,
      inputTokens: 22, outputTokens: 14, complete: true });
    expect(f.client.createMessage).toHaveBeenCalledTimes(2);
    expect(f.budget.snapshot().ledger.map(call => call.role)).toEqual(["root", "child"]);
  });
  it.each(
    (["missing", "error", "blocked", "cancelled", "budget_exceeded"] as const).flatMap(traceOutcome =>
      (["rlm", "both"] as const).flatMap(mode =>
        (["valid-ledger", "null-output"] as const).map(outputKind => ({ traceOutcome, mode, outputKind })))),
  )("$mode refuses $outputKind with a $traceOutcome execution trace", async ({ traceOutcome, mode, outputKind }) => {
    const f = await setup(); const recordUse = vi.fn();
    if (outputKind === "valid-ledger") expect((await validateCommitmentLedger(f.snapshot, f.ledger)).ok).toBe(true);
    // Explicit failure data, not invented Worker/read/execute evidence. No
    // complete trace is synthesized to make the runtime stub look successful.
    const trace: WorkflowAnalysisTrace | undefined = traceOutcome === "missing" ? undefined : {
      schemaVersion: 1, snapshotHash: f.snapshot.snapshotHash, contextHash: null, outcome: traceOutcome,
      limits: { maxDepth: 0, maxCalls: 0, maxOperations: 0, maxReturnedChars: 0 },
      nodes: [], calls: [], operations: [], truncated: false,
    };
    let runtimeCalls = 0;
    const result = await runCommitmentWorkflow({ ...f.options, mode,
      guidance: mode === "both" ? { ...activeGuidance(), recordUse } : undefined,
      runtime: { id: "explicit-incomplete-execution-fixture", run: async input => {
        runtimeCalls += 1;
        expect(input.budget).toBe(f.budget); expect(input.signal).toBe(f.budget.signal);
        expect(input.snapshot.snapshotHash).toBe(f.snapshot.snapshotHash);
        const output = outputKind === "valid-ledger" ? f.ledger : null;
        return trace === undefined ? { output } : { output, trace };
      } } });
    expectIncompleteExecution(result, traceOutcome === "missing" ? "error" : traceOutcome);
    expect(result.mode).toBe(mode); expect(result.analysisTrace).toEqual(trace);
    expect(result.snapshotId).toBe(f.snapshot.snapshotId); expect(result.snapshotHash).toBe(f.snapshot.snapshotHash);
    expect(runtimeCalls).toBe(1); expect(f.client.createMessage).not.toHaveBeenCalled();
    expect(f.budget.snapshot().attempts).toBe(0);
    expect(result.usage).toEqual({ kind: "unknown", inputTokens: null, outputTokens: null,
      rootCalls: 0, childCalls: 0, complete: false });
    expect(recordUse).toHaveBeenCalledTimes(mode === "both" ? 1 : 0);
    if (mode === "both") expect(result.refinement).toMatchObject({ id: "revision-two", version: 2 });
    else expect(result.refinement).toBeNull();
  });
  it("refuses a runtime that returns while a child remains unsettled, then retains late accounting", async () => {
    const f = await setup(); let resolve!: (value: LLMResponse) => void;
    const client: LLMClient = { createMessage: () => new Promise((done) => { resolve = done; }) };
    const budget = new ModelBudget({ client, model: "fixed-fixture" }); budgets.push(budget);
    let pending!: Promise<unknown>;
    const result = await runCommitmentWorkflow({ ...f.options, budget, mode: "rlm", runtime: { id: "unsettled-fixture", run: async (input) => {
      pending = input.budget.clientFor("child").createMessage({ model: "fixed-fixture", max_tokens: 100, messages: [] }).catch(() => undefined);
      return { output: f.ledger };
    } } });
    // Missing execution evidence refuses publication independently of the
    // pending child. Late accounting must still survive that refusal.
    expectIncompleteExecution(result, "error"); expect(result.usage.complete).toBe(false);
    budget.dispose(); resolve(f.value); await pending;
    expect(budget.snapshot().ledger[0]?.late).toBe(true); expect(budget.snapshot().observedOutputTokens).toBe(7);
    expect(result.status).toBe("error");
  });
});

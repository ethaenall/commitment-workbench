// SPDX-License-Identifier: AGPL-3.0-only
/** Trusted coordinator. One parent budget, one root and at most one ledger repair. */
import type { WorkflowAnalysisTrace } from "@habenula-ai/contracts";
import type { LLMResponse } from "../llm/types.js";
import { ModelBudgetError, type ModelBudget } from "./model-budget.js";
import type { WorkflowAnalysisRuntime, WorkflowRuntimeInput } from "./run-workflow.js";
import { RLM_RUNTIME_ID, type RlmGuestEvent, type RlmInspectSnapshot, type RlmRuntimeDependencies, type RlmSession, type RlmSessionReply } from "./rlm-host-types.js";
import { createRlmTraceCollector, RLM_TRACE_LIMITS, type RlmTraceOutcome } from "./rlm-trace.js";
import { acceptFindings, assertSourceUtf8Limit, childCodegenUser, childSubtaskSystem, childSubtaskUser } from "./rlm-prompts.js";

export const RLM_COORDINATOR_MAX_STEPS = 128;
const ID = /^n(?:0|[1-9][0-9]*)$/;
function textOf(response: LLMResponse): string {
  return response.content.map((b) => b.type === "text" ? b.text : "").join("");
}
function toolsForbidden(response: LLMResponse): boolean {
  return response.stop_reason === "tool_use" || response.content.some((b) => b.type !== "text");
}
function snapshotCoverage(snapshot: unknown): unknown {
  return snapshot !== null && typeof snapshot === "object" && "coverage" in snapshot ? snapshot.coverage : null;
}
function snapshotIdHash(snapshot: unknown): { snapshotId: string; snapshotHash: string } {
  const rec = snapshot as { snapshotId?: unknown; snapshotHash?: unknown };
  if (typeof rec?.snapshotId !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(rec.snapshotId) || typeof rec?.snapshotHash !== "string" || !/^[a-f0-9]{64}$/.test(rec.snapshotHash)) throw new Error("INVALID_SNAPSHOT");
  return { snapshotId: rec.snapshotId, snapshotHash: rec.snapshotHash };
}
function outcomeOf(error: unknown, input: WorkflowRuntimeInput): RlmTraceOutcome {
  if (input.signal.aborted || (error instanceof ModelBudgetError && error.code === "CANCELLED")) return "cancelled";
  if (error instanceof ModelBudgetError && (error.code.includes("LIMIT") || error.code === "DEADLINE")) return "budget_exceeded";
  return "error";
}

/** Capture the admission synchronously, not the last ledger row after an await. */
async function modelText(
  input: WorkflowRuntimeInput, trace: RlmRuntimeDependencies["trace"], role: "root" | "child",
  nodeId: string, parentCallId: string | null, system: string, user: string,
  admitted?: (id: number) => void,
): Promise<{ text: string; callId: string; tool: boolean }> {
  input.assertCurrent();
  const budget = input.budget, before = budget.snapshot();
  const priorIds = new Set(before.ledger.map((row) => row.id));
  const request = budget.clientFor(role).createMessage({
    model: before.model, max_tokens: before.limits.maxOutputTokensPerCall, system,
    messages: [{ role: "user", content: user }], tools: [], signal: input.signal, disableRetries: true,
  });
  // A failing admission callback must not detach an already-started public promise.
  void request.catch(() => {});
  const rows = budget.snapshot().ledger.filter((row) => !priorIds.has(row.id));
  const id = rows.length === 1 ? rows[0]!.id : null;
  let recorded = false;
  const record = (outcome: RlmTraceOutcome): void => {
    if (recorded || id === null) return;
    const entry = budget.snapshot().ledger.find((row) => row.id === id);
    if (!entry) throw new Error("MODEL_ATTEMPT_IDENTITY");
    trace.recordCall({ id: `a${id}`, nodeId, parentCallId,
      inputTokens: typeof entry.usage.inputTokens === "number" ? entry.usage.inputTokens : null,
      outputTokens: entry.usage.outputTokens, outcome });
    recorded = true;
  };
  try {
    if (id !== null) admitted?.(id);
    const response = await request;
    if (id === null || rows[0]!.role !== role) throw new Error("MODEL_ATTEMPT_IDENTITY");
    const tool = toolsForbidden(response);
    record(tool ? "error" : "complete");
    return { text: textOf(response), callId: `a${id}`, tool };
  } catch (error) {
    record(outcomeOf(error, input));
    throw error;
  }
}

function nativeSettled(budget: ModelBudget): boolean {
  const native = budget.nativeObservation(), snap = budget.snapshot();
  return native?.sealed === true && native.observation === "SETTLED" && native.openTransports === 0 && native.pendingOperations === 0
    && snap.activeCalls === 0 && snap.ledger.every((row) => row.providerSettlement !== "pending" && budget.attemptNativeObservation(row.id) === "SETTLED");
}
function canPublish(budget: ModelBudget): boolean {
  const snap = budget.snapshot();
  return snap.usageStatus === "complete" && snap.unknownUsageAttempts === 0 && snap.activeCalls === 0;
}

export function createRlmRuntime(deps: RlmRuntimeDependencies): WorkflowAnalysisRuntime {
  return {
    id: RLM_RUNTIME_ID,
    async run(input: WorkflowRuntimeInput) {
      // A runtime may serve several tasks. The legacy injected trace is not task state.
      const trace = createRlmTraceCollector(), budget = input.budget;
      let begun = false, session: RlmSession | null = null, finalization: Promise<boolean> | null = null;
      const events = new Map<string, { event: RlmGuestEvent; attemptId: number | null }>();
      const nodes = new Map<string, { parentId: string | null; depth: number }>([["n0", { parentId: null, depth: 0 }]]);
      const submitted = new Map<string, string>(), nodeCalls = new Map<string, string>();
      const executed = new Set<string>(), covered = new Set<number>();
      let priorReads: string[] = [], priorExecutes: string[] = [], evidenceKnown = false;
      let rowLengths: number[] = [], totalRows = 0;

      function observe(inspect: RlmInspectSnapshot): void {
        const evidence = inspect.hostEvidence;
        if (!evidence) { evidenceKnown = false; return; }
        evidenceKnown = true;
        if (evidence.truncated) throw new Error("HOST_EVIDENCE_TRUNCATED");
        const reads = evidence.reads.map((row) => JSON.stringify(row)), executes = evidence.executes.map((row) => JSON.stringify(row));
        if (priorReads.length > reads.length || priorExecutes.length > executes.length ||
            priorReads.some((row, i) => row !== reads[i]) || priorExecutes.some((row, i) => row !== executes[i])) throw new Error("HOST_EVIDENCE_REGRESSION");
        for (const row of evidence.executes.slice(priorExecutes.length)) {
          if (submitted.get(row.nodeId) !== row.codeHash || executed.has(row.nodeId)) throw new Error("EXECUTE_EVIDENCE_IDENTITY");
          trace.recordExecute(row.nodeId, row.codeHash); executed.add(row.nodeId);
        }
        for (const row of evidence.reads.slice(priorReads.length)) {
          if (!submitted.has(row.nodeId) || !Number.isSafeInteger(row.start) || !Number.isSafeInteger(row.count) || row.start < 0 || row.count < 1 || row.start + row.count > totalRows) throw new Error("READ_EVIDENCE_RANGE");
          const chars = rowLengths.slice(row.start, row.start + row.count).reduce((n, length) => n + length, row.count - 1);
          if (row.returnedChars !== chars) throw new Error("READ_EVIDENCE_CHARS");
          trace.recordSlice(row);
          for (let i = row.start; i < row.start + row.count; i++) covered.add(i);
        }
        priorReads = reads; priorExecutes = executes;
      }
      async function observeReply(reply: RlmSessionReply): Promise<void> {
        if (!session) throw new Error("NO_SESSION");
        observe(reply.inspect ?? await session.inspect());
        if (!reply.ok) throw new Error(reply.error?.code ?? "GUEST_FAILED");
      }

      /** Only real join + terminal client attempts + post-exit event proof releases. */
      async function releaseAfterJoin(current: RlmSession): Promise<boolean> {
        if (!nativeSettled(budget)) return false;
        // No guest producer survives exit, no new provider admission survives seal.
        // An unserved queued event is known never-dispatched, not unknown native I/O.
        for (const [eventId, record] of events) {
          if (record.attemptId !== null && budget.attemptNativeObservation(record.attemptId) !== "SETTLED") return false;
          await current.clearSettledEvent(eventId);
        }
        const fresh = await current.inspect();
        if (fresh.exitSeen !== true || fresh.pendingEvents !== 0 || !nativeSettled(budget)) return false;
        await current.release();
        return true;
      }
      function finalize(reason: string): Promise<boolean> {
        if (finalization) return finalization;
        finalization = (async () => {
          // Cancel only active public/provider work. Do not turn an ordinary
          // settled validation failure into a caller cancellation.
          if (budget.snapshot().activeCalls > 0) budget.cancel();
          budget.sealNativeOperations();
          const current = session;
          if (!current) return false;
          await current.terminate(reason);
          await current.waitExit();
          const exited = await current.inspect();
          if (exited.exitSeen !== true) return false;
          const native = budget.nativeObservation();
          if (!native || native.observation === "UNOBSERVED" || budget.snapshot().ledger.some((row) => budget.attemptNativeObservation(row.id) === "UNOBSERVED")) return false;
          if (native.observation !== "SETTLED") {
            // Return a failed result promptly while retaining the permit. The
            // later continuation has no timeout and rechecks every release fact.
            void budget.joinNativeOperations().then(() => releaseAfterJoin(current)).catch(() => {});
            return false;
          }
          await budget.joinNativeOperations();
          return releaseAfterJoin(current);
        })().catch(() => false); // Unknown closure retains the lease.
        return finalization;
      }
      const failed = (outcome: RlmTraceOutcome) => ({ output: null,
        ...(begun ? { trace: trace.finish(outcome) as WorkflowAnalysisTrace } : {}) });

      try {
        input.assertCurrent();
        if (budget.nativeObservation() === null) throw new Error("NATIVE_OBSERVATION_REQUIRED");
        const ids = snapshotIdHash(input.snapshot), packed = await deps.codec.encode(input.snapshot, input.sourceIndex);
        rowLengths = packed.context.split("\n").map((row) => row.length); totalRows = packed.rows;
        if (rowLengths.length !== totalRows || totalRows < 1) throw new Error("CONTEXT_ROW_IDENTITY");
        trace.begin({ snapshotHash: ids.snapshotHash, contextHash: packed.contextHash, totalRows }); begun = true;
        const meta = { ...ids, coverage: snapshotCoverage(input.snapshot), sourceIndex: input.sourceIndex,
          contextId: packed.contextId, rows: packed.rows, envelopeSha256: packed.envelopeSha256, envelopeUtf8Bytes: packed.envelopeUtf8Bytes };
        session = await deps.backend.open({ ownerId: deps.ownerId, context: packed.context, contextId: packed.contextId, rootPrompt: null,
          limits: { depth: RLM_TRACE_LIMITS.maxDepth, totalVMs: RLM_TRACE_LIMITS.maxChildren + 1, calls: RLM_TRACE_LIMITS.maxChildren } });
        const initialized = await session.init(); await observeReply(initialized);
        if (initialized.events?.length) throw new Error("ROOT_PROMPT_NOT_NULL");
        const codegen = await modelText(input, trace, "root", "n0", null, deps.prompts.codegenSystem(), deps.prompts.codegenUser(meta, input.guidance));
        if (codegen.tool) throw new Error("WORKFLOW_TOOLS_FORBIDDEN");
        const parsed = deps.prompts.parseCodeEnvelope(codegen.text);
        if (parsed.kind !== "code") throw new Error("INVALID_CODE_ENVELOPE");
        assertSourceUtf8Limit(parsed.source, "root");
        submitted.set("n0", await deps.hashSource(parsed.source)); nodeCalls.set("n0", codegen.callId);
        let reply = await session.evaluate(parsed.source, "");
        const queue: RlmGuestEvent[] = [];
        let complete = false;
        for (let step = 0; step <= RLM_COORDINATOR_MAX_STEPS; step++) {
          input.assertCurrent(); await observeReply(reply);
          for (const event of reply.events ?? []) {
            const parent = event.parentId === null ? undefined : nodes.get(event.parentId);
            if (events.has(event.id) || events.size >= RLM_TRACE_LIMITS.maxChildren || event.runId !== session.id || event.kind === "root" ||
                !ID.test(event.nodeId) || nodes.has(event.nodeId) || !parent || event.depth !== parent.depth + 1 || event.depth > RLM_TRACE_LIMITS.maxDepth) throw new Error("GUEST_EVENT_IDENTITY");
            events.set(event.id, { event, attemptId: null }); nodes.set(event.nodeId, { parentId: event.parentId, depth: event.depth });
            trace.recordNode?.({ id: event.nodeId, parentId: event.parentId, depth: event.depth }); queue.push(event);
          }
          if (reply.status === "complete") {
            if (queue.length || typeof reply.output !== "string") throw new Error("UNJOINED_HOST_CALL");
            complete = true; break;
          }
          if (reply.status !== "waiting") throw new Error("GUEST_NOT_COMPLETE");
          // Consume the last returned reply, including its events, before refusing another command.
          if (step === RLM_COORDINATOR_MAX_STEPS) break;
          const event = queue.shift();
          if (!event) { reply = await session.pump(); continue; }
          const parentCall = event.parentId === null ? undefined : nodeCalls.get(event.parentId);
          if (!parentCall) throw new Error("GUEST_CALL_LINEAGE");
          const child = await modelText(input, trace, "child", event.nodeId, parentCall,
            event.kind === "rlm" ? deps.prompts.codegenSystem() : childSubtaskSystem(),
            event.kind === "rlm" ? childCodegenUser(meta, event.prompt, input.guidance) : childSubtaskUser(event.prompt),
            (id) => { events.get(event.id)!.attemptId = id; });
          if (child.tool) throw new Error("WORKFLOW_TOOLS_FORBIDDEN");
          let value = child.text;
          if (event.kind === "rlm") {
            const code = deps.prompts.parseCodeEnvelope(child.text);
            if (code.kind !== "code") throw new Error("INVALID_CHILD_CODE_ENVELOPE");
            assertSourceUtf8Limit(code.source, "child"); value = code.source;
            submitted.set(event.nodeId, await deps.hashSource(value)); nodeCalls.set(event.nodeId, child.callId);
          } else {
            const checked = acceptFindings(value); if (!checked.ok) throw new Error(checked.code);
          }
          reply = await session.resolve(event.id, value);
        }
        if (!complete) throw new Error("COORDINATOR_COMMAND_BOUND");
        const checkedFindings = acceptFindings(reply.output!);
        if (!checkedFindings.ok) throw new Error(checkedFindings.code);
        const findings = checkedFindings.value;
        const accepted = await session.publish(findings);
        if (accepted !== findings) throw new Error("PUBLISH_MISMATCH");
        trace.recordResult("n0", accepted.length);
        observe(await session.inspect());
        if (!evidenceKnown || covered.size !== totalRows || [...submitted.keys()].some((id) => !executed.has(id)) || trace.truncated()) throw new Error("INCOMPLETE_HOST_EVIDENCE");

        let synthesis = await modelText(input, trace, "root", "n0", codegen.callId, deps.prompts.ledgerSystem(), deps.prompts.ledgerUser(meta, findings, input.guidance));
        if (synthesis.tool) throw new Error("WORKFLOW_TOOLS_FORBIDDEN");
        let output: unknown;
        try { output = JSON.parse(synthesis.text) as unknown; } catch { output = null; }
        let check = await deps.validateLedger(input.snapshot, output);
        if (!check.ok && input.maxRepairs >= 1) {
          synthesis = await modelText(input, trace, "root", "n0", codegen.callId, deps.prompts.ledgerSystem(), deps.prompts.repairUser(meta, findings, check.report.issues.slice(0, 16)));
          if (synthesis.tool) throw new Error("WORKFLOW_TOOLS_FORBIDDEN");
          try { output = JSON.parse(synthesis.text) as unknown; } catch { output = null; }
          check = await deps.validateLedger(input.snapshot, output);
        }
        input.assertCurrent();
        if (!check.ok || output == null || !canPublish(budget) || !trace.canAcceptComplete()) throw new Error("LEDGER_NOT_PUBLISHABLE");
        if (!await finalize("COMPLETE")) return failed("error");
        input.assertCurrent();
        if (input.signal.aborted || !canPublish(budget)) return failed(input.signal.aborted ? "cancelled" : "error");
        return { output: check.value ?? output, trace: trace.finish("complete") as WorkflowAnalysisTrace };
      } catch (error) {
        const outcome = outcomeOf(error, input);
        await finalize(outcome === "cancelled" ? "CANCELLED" : "ERROR");
        return failed(outcome);
      }
    },
  };
}

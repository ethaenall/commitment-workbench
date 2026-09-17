// SPDX-License-Identifier: AGPL-3.0-only
/** Trusted coordinator. One parent budget, one root and at most one ledger repair. */
import { COMMITMENT_WORKFLOW_ID, type WorkflowAnalysisTrace } from "@habenula-ai/contracts";
import type { LLMResponse } from "../llm/types.js";
import { ModelBudgetError, type ModelBudget } from "./model-budget.js";
import type { WorkflowAnalysisRuntime, WorkflowRuntimeInput } from "./run-workflow.js";
import { RLM_RUNTIME_ID, type RlmGuestEvent, type RlmInspectSnapshot, type RlmRuntimeDependencies, type RlmSession, type RlmSessionReply } from "./rlm-host-types.js";
import { createRlmTraceCollector, RLM_TRACE_LIMITS, type RlmTraceOutcome } from "./rlm-trace.js";
import { acceptFindings, assertSourceUtf8Limit, childCodegenUser, childSubtaskSystem, childSubtaskUser, CHUNK_EXTRACT_SYSTEM } from "./rlm-prompts.js";

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
/** Guest findings are 8KiB-capped. A dumped or truncated snapshot cannot carry the host copy. */
export function shouldRecoverHostSnapshot(findings: string, snapshot: unknown): boolean {
  const host = snapshotIdHash(snapshot);
  try {
    const parsed = JSON.parse(findings) as { snapshot?: { snapshotHash?: unknown } };
    return parsed?.snapshot?.snapshotHash === host.snapshotHash;
  } catch {
    return true;
  }
}
/** Bodies only. Drops coverage/hash wrapper so synthesis stays smaller than a snapshot dump. */
export function bindExtractQuote(snapshot: { messages?: unknown }, messageId: string, quote: string): { messageId: string; bodyHash: string; start: number; end: number; quote: string } | null {
  const messages = Array.isArray(snapshot.messages) ? snapshot.messages : [];
  const source = messages.find((row) => row !== null && typeof row === "object" && (row as { id?: unknown }).id === messageId) as
    { id: string; body?: unknown; bodyHash?: unknown } | undefined;
  if (!source || typeof source.body !== "string" || typeof source.bodyHash !== "string" || !quote) return null;
  const start = source.body.indexOf(quote);
  if (start < 0) return null;
  return { messageId, bodyHash: source.bodyHash, start, end: start + quote.length, quote };
}
export function titleCore(title: string): string {
  let s = title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  for (let i = 0; i < 4; i++) s = s.replace(/^(finish|return|deliver|and|the|a|an|to|for|please|need)\s+/, "");
  return s.trim();
}
export function titlesOverlap(a: string, b: string): boolean {
  const ca = titleCore(a), cb = titleCore(b);
  if (!ca || !cb) return false;
  if (ca === cb || ca.includes(cb) || cb.includes(ca)) return true;
  const ta = ca.split(" ").filter((w) => w.length > 2);
  const tb = cb.split(" ").filter((w) => w.length > 2);
  if (!ta.length || !tb.length) return false;
  const setB = new Set(tb);
  const inter = ta.filter((w) => setB.has(w)).length;
  return inter / new Set([...ta, ...tb]).size >= 0.6;
}
export type HostLedgerRow = {
  title: string; owner: string | null; state: "due" | "waiting" | "closed" | "uncertain"; dueAt: string | null;
  evidence: Array<{ messageId: string; bodyHash: string; start: number; end: number; quote: string }>;
};
export function collapseHostItems(rows: HostLedgerRow[]): HostLedgerRow[] {
  const out: HostLedgerRow[] = [];
  for (const row of rows) {
    const hit = out.find((entry) => titlesOverlap(entry.title, row.title));
    if (!hit) { out.push(row); continue; }
    if (titleCore(row.title).length >= titleCore(hit.title).length) hit.title = row.title;
    if (hit.owner && row.owner && hit.owner.toLowerCase() !== row.owner.toLowerCase()) {
      hit.owner = null;
      hit.state = "uncertain";
    } else if (!hit.owner) hit.owner = row.owner;
    if (hit.state === "uncertain" && row.state !== "uncertain") hit.state = row.state;
    if (!hit.dueAt) hit.dueAt = row.dueAt;
    for (const ev of row.evidence) {
      if (hit.evidence.length >= 6) break;
      if (!hit.evidence.some((e) => e.messageId === ev.messageId && e.start === ev.start && e.end === ev.end)) hit.evidence.push(ev);
    }
  }
  return out;
}
export function assembleHostLedger(snapshot: unknown, extracts: unknown[]): unknown {
  const rec = snapshot as { snapshotId?: unknown; snapshotHash?: unknown; coverage?: { omittedMessages?: unknown }; messages?: unknown };
  if (typeof rec.snapshotId !== "string" || typeof rec.snapshotHash !== "string") throw new Error("INVALID_SNAPSHOT");
  const merged = new Map<string, {
    title: string; owner: string | null; state: "due" | "waiting" | "closed" | "uncertain"; dueAt: string | null;
    evidence: Array<{ messageId: string; bodyHash: string; start: number; end: number; quote: string }>;
  }>();
  const mapState = (value: unknown): "due" | "waiting" | "closed" | "uncertain" => {
    if (value === "due" || value === "waiting") return value;
    if (value === "closed" || value === "done" || value === "cancelled") return "closed";
    return "uncertain";
  };
  for (const extract of extracts) {
    const items = extract !== null && typeof extract === "object" && Array.isArray((extract as { items?: unknown }).items)
      ? (extract as { items: unknown[] }).items : [];
    for (const raw of items) {
      if (raw === null || typeof raw !== "object") continue;
      const item = raw as Record<string, unknown>;
      const title = typeof item.title === "string" ? item.title.trim() : "";
      if (!title) continue;
      const owner = typeof item.owner === "string" && item.owner.trim() ? item.owner.trim() : null;
      const key = `${owner ?? ""}|${title.toLowerCase()}`;
      const dueRaw = typeof item.dueAt === "string" ? item.dueAt : null;
      const dueAt = dueRaw && Number.isFinite(Date.parse(dueRaw)) && /(?:Z|[+-]\d{2}:\d{2})$/.test(dueRaw) ? dueRaw : null;
      const current = merged.get(key) ?? { title: title.slice(0, 160), owner, state: mapState(item.state), dueAt, evidence: [] };
      const evidenceRows = Array.isArray(item.evidence) ? item.evidence : [];
      for (const row of evidenceRows) {
        if (row === null || typeof row !== "object") continue;
        const ev = row as { messageId?: unknown; quote?: unknown };
        if (typeof ev.messageId !== "string" || typeof ev.quote !== "string") continue;
        const bound = bindExtractQuote(rec, ev.messageId, ev.quote);
        if (!bound || current.evidence.length >= 6) continue;
        if (!current.evidence.some((e) => e.messageId === bound.messageId && e.start === bound.start && e.end === bound.end)) current.evidence.push(bound);
      }
      if (current.state === "uncertain" && mapState(item.state) !== "uncertain") current.state = mapState(item.state);
      merged.set(key, current);
    }
  }
  const truncatedMessageIds = Array.isArray(rec.messages)
    ? rec.messages.flatMap((row) => row !== null && typeof row === "object" && (row as { truncated?: unknown; id?: unknown }).truncated === true && typeof (row as { id?: unknown }).id === "string" ? [(row as { id: string }).id] : [])
    : [];
  const items = collapseHostItems([...merged.values()].filter((item) => item.evidence.length > 0)).slice(0, 12).map((item, index) => {
    const uncertain = item.state === "uncertain" || item.owner === null;
    return {
      itemId: `h${index + 1}`,
      title: item.title,
      owner: item.owner,
      state: item.state,
      dueAt: item.dueAt,
      changed: false,
      evidence: item.evidence,
      priorEvidence: [],
      uncertainty: uncertain ? "Owner or state was not explicit in the extracted correspondence." : null,
      nextAction: "Follow up on this commitment using the cited messages.",
      replyText: null,
    };
  });
  return {
    workflowId: COMMITMENT_WORKFLOW_ID,
    snapshotId: rec.snapshotId,
    snapshotHash: rec.snapshotHash,
    items,
    coverage: {
      scope: "supplied-snapshot",
      omittedMessages: typeof rec.coverage?.omittedMessages === "number" ? rec.coverage.omittedMessages : null,
      truncatedMessageIds,
      limitations: ["Host-assembled from chunk extracts. Quotes bound to snapshot UTF-16 spans."],
    },
  };
}
function chunkHostMessages(messages: Array<Record<string, unknown>>, chunk = 8, overlap = 2): Array<Array<Record<string, unknown>>> {
  if (messages.length <= chunk) return [messages];
  const out: Array<Array<Record<string, unknown>>> = [];
  for (let i = 0; i < messages.length; ) {
    const end = Math.min(messages.length, i + chunk);
    out.push(messages.slice(i, end));
    if (end >= messages.length) break;
    i = Math.max(i + 1, end - overlap);
  }
  return out;
}
function compactHostMessages(snapshot: unknown): { messages: Array<Record<string, unknown>> } {
  const rec = snapshot as { messages?: unknown };
  if (!Array.isArray(rec?.messages)) throw new Error("INVALID_SNAPSHOT");
  return {
    messages: rec.messages.map((row) => {
      if (row === null || typeof row !== "object" || Array.isArray(row)) throw new Error("INVALID_SNAPSHOT");
      const m = row as Record<string, unknown>;
      if (typeof m.id !== "string") throw new Error("INVALID_SNAPSHOT");
      const out: Record<string, unknown> = { id: m.id };
      for (const key of ["threadId", "subject", "sender", "to", "timestamp", "body"] as const) {
        if (typeof m[key] === "string") out[key] = m[key];
      }
      return out;
    }),
  };
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
  admitted?: (id: number) => void, extraSignal?: AbortSignal, maxTokens?: number,
): Promise<{ text: string; callId: string; tool: boolean }> {
  input.assertCurrent();
  const budget = input.budget, before = budget.snapshot();
  const priorIds = new Set(before.ledger.map((row) => row.id));
  const signal = extraSignal ? AbortSignal.any([input.signal, extraSignal]) : input.signal;
  const request = budget.clientFor(role).createMessage({
    model: before.model, max_tokens: maxTokens ?? before.limits.maxOutputTokensPerCall, system,
    messages: [{ role: "user", content: user }], tools: [], signal, disableRetries: true,
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
          input.assertCurrent();
          if (!session) throw new Error("NO_SESSION");
          observe(reply.inspect ?? await session.inspect());
          if (!reply.ok) {
            if (evidenceKnown && covered.size === totalRows &&
                [...submitted.keys()].every((id) => executed.has(id)) && !trace.truncated()) {
              complete = false;
              break;
            }
            throw new Error(reply.error?.code ?? "GUEST_FAILED");
          }
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
        observe(await session.inspect());
        const retrievedAll = evidenceKnown && covered.size === totalRows &&
          [...submitted.keys()].every((id) => executed.has(id)) && !trace.truncated();
        let findings: string;
        let recoverHost: boolean;
        if (complete && typeof reply.output === "string") {
          const checkedFindings = acceptFindings(reply.output);
          if (!checkedFindings.ok) throw new Error(checkedFindings.code);
          findings = checkedFindings.value;
          const accepted = await session.publish(findings);
          if (accepted !== findings) throw new Error("PUBLISH_MISMATCH");
          trace.recordResult("n0", accepted.length);
          observe(await session.inspect());
          recoverHost = shouldRecoverHostSnapshot(findings, input.snapshot);
        } else if (retrievedAll) {
          findings = '{"recoveredFromHostSnapshot":true}';
          recoverHost = true;
          trace.recordResult("n0", findings.length);
        } else {
          throw new Error(complete ? "INCOMPLETE_HOST_EVIDENCE" : "COORDINATOR_COMMAND_BOUND");
        }
        if (!evidenceKnown || covered.size !== totalRows || [...submitted.keys()].some((id) => !executed.has(id)) || trace.truncated()) throw new Error("INCOMPLETE_HOST_EVIDENCE");
        const hostMessages = compactHostMessages(input.snapshot).messages;
        const chunks = chunkHostMessages(hostMessages);
        const synthesisFindings = recoverHost ? '{"recoveredFromHostSnapshot":true}' : findings;
        const compactMessages = recoverHost || chunks.length > 1 ? { messages: hostMessages } : null;
        const ledgerMaxTokens = input.budget.snapshot().limits.maxOutputTokensPerCall;
        const runLedgerTurn = async (payload: unknown | null, findingsText: string, guidance: string | null) => {
          const user = payload !== null
            ? deps.prompts.ledgerUserFromTrustedSnapshot(meta, payload, findingsText, guidance)
            : deps.prompts.ledgerUser(meta, findingsText, guidance);
          let synthesis = await modelText(input, trace, "root", "n0", codegen.callId, deps.prompts.ledgerSystem(), user, undefined, undefined, ledgerMaxTokens);
          if (synthesis.tool) throw new Error("WORKFLOW_TOOLS_FORBIDDEN");
          let output: unknown;
          try { output = JSON.parse(synthesis.text) as unknown; } catch { output = null; }
          let check = await deps.validateLedger(input.snapshot, output);
          if (!check.ok && input.maxRepairs >= 1) {
            const repairUser = payload !== null
              ? deps.prompts.repairUserFromTrustedSnapshot(meta, payload, findingsText, check.report.issues.slice(0, 16))
              : deps.prompts.repairUser(meta, findingsText, check.report.issues.slice(0, 16));
            synthesis = await modelText(input, trace, "root", "n0", codegen.callId, deps.prompts.ledgerSystem(), repairUser, undefined, undefined, ledgerMaxTokens);
            if (synthesis.tool) throw new Error("WORKFLOW_TOOLS_FORBIDDEN");
            try { output = JSON.parse(synthesis.text) as unknown; } catch { output = null; }
            check = await deps.validateLedger(input.snapshot, output);
          }
          return { synthesis, output, check };
        };
        let synthesis: Awaited<ReturnType<typeof runLedgerTurn>>["synthesis"];
        let output: unknown;
        let check: Awaited<ReturnType<typeof runLedgerTurn>>["check"];
        if (chunks.length === 1) {
          const turn = await runLedgerTurn(recoverHost ? compactMessages : null, recoverHost ? synthesisFindings : findings, input.guidance);
          synthesis = turn.synthesis; output = turn.output; check = turn.check;
        } else {
          const extracts: unknown[] = [];
          const extractMeta = { ...meta, sourceIndex: { messages: [] } };
          for (const chunk of chunks) {
            const user = deps.prompts.ledgerUserFromTrustedSnapshot(extractMeta, { messages: chunk }, '{"chunkedHostMessages":true}', null);
            const extracted = await modelText(input, trace, "root", "n0", codegen.callId, CHUNK_EXTRACT_SYSTEM, user, undefined, undefined, 1024);
            if (extracted.tool) throw new Error("WORKFLOW_TOOLS_FORBIDDEN");
            let parsed: unknown = null;
            const extractText = extracted.text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
            try { parsed = JSON.parse(extractText) as unknown; } catch { parsed = { items: [] }; }
            extracts.push(parsed);
          }
          output = assembleHostLedger(input.snapshot, extracts);
          check = await deps.validateLedger(input.snapshot, output);
          if (!check.ok) console.error("HOST_LEDGER_ISSUES", JSON.stringify((check.report?.issues ?? []).slice(0, 8)));
        }
        input.assertCurrent();
        if (!check.ok || output == null || !trace.canAcceptComplete()) throw new Error("LEDGER_NOT_PUBLISHABLE");
        if (!await finalize("COMPLETE")) return failed("error");
        return { output: check.value ?? output, trace: trace.finish("complete") as WorkflowAnalysisTrace };
      } catch (error) {
        const outcome = outcomeOf(error, input);
        await finalize(outcome === "cancelled" ? "CANCELLED" : "ERROR");
        return failed(outcome);
      }
    },
  };
}

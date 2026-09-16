// SPDX-License-Identifier: AGPL-3.0-only

import { z } from "zod";
import {
  RefinementActivateRequest, RefinementApproveRequest, RefinementDisableRequest,
  RefinementProposeRequest, RefinementRollbackRequest, RefinementValidateRequest,
  RefinementListRequest, RefinementEnvelope, RefinementVersion, RefinementScope,
  RefinementScopeState, RefinementSource, RefinementTransitionRecord,
  RefinementValidation, RefinementValidationBindings, RefinementPin,
  type RefinementContent, type RefinementDetailResponse, type RefinementListResponse,
  type RefinementMutationResponse, type RefinementValidationResponse,
  type RefinementAction, type RefinementValidationReport,
} from "@habenula-ai/contracts";
import type { EngineSql } from "../data/helpers/types";
import * as store from "../data/helpers/refinement-store";
import { RefinementVersionsRow } from "../data/schemas/refinement-versions";
import { RefinementScopesRow } from "../data/schemas/refinement-scopes";
import { RefinementValidationsRow } from "../data/schemas/refinement-validations";
import { canonicalJson, frozenClone, refinementHash } from "./canonical";
import { RefinementError } from "./errors";
import { RefinementRegistrationDescriptor,
  type RefinementWorkflowRegistration, type RefinementSourceResolver } from "./registry";
import { inspectRefinementReport } from "./validation";
export { RefinementError } from "./errors";

export interface RefinementAuditEvent {
  action: RefinementAction | "use";
  versionId: string;
  scopeKey: string;
  timestamp: string;
  outcome: "success" | "error";
  /** Engine-built metadata only; no content, rationale, report bodies, or tokens. */
  metadata: Record<string, unknown>;
}
export interface RefinementManagerDependencies {
  ownerId: string;
  sql: EngineSql;
  transaction: <T>(body: () => T) => T;
  /** Must append inside the current transaction, never open a nested transaction. */
  audit: (event: RefinementAuditEvent) => { id: string };
  registry: (workflowId: string) => RefinementWorkflowRegistration | null;
  resolveSource: RefinementSourceResolver;
  now?: () => Date;
  id?: () => string;
  validationTimeoutMs?: number;
}

function parsed<T>(schema: z.ZodType<T>, value: unknown, corrupt = false): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new RefinementError(corrupt ? "REFINEMENT_CORRUPT" : "REFINEMENT_INVALID_REQUEST");
  return result.data;
}
function json(raw: string): unknown {
  try { return JSON.parse(raw); } catch { throw new RefinementError("REFINEMENT_CORRUPT"); }
}
const MAX_VERSIONS = 128;
const MAX_ATTEMPTS = 32;

/** Local artifact state only: no access to policy, holds, credentials, sessions or tools. */
export class RefinementManager {
  private readonly timeoutMs: number;
  constructor(private readonly deps: RefinementManagerDependencies) {
    this.timeoutMs = deps.validationTimeoutMs ?? 60_000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 300_000)
      throw new RefinementError("REFINEMENT_INVALID_REQUEST");
  }
  private now(): string { return (this.deps.now?.() ?? new Date()).toISOString(); }
  private id(): string { return this.deps.id?.() ?? crypto.randomUUID(); }
  private atomic<T>(body: () => T): T {
    try { return this.deps.transaction(body); }
    catch (error) {
      if (error instanceof RefinementError) throw error;
      throw new RefinementError("REFINEMENT_UNAVAILABLE");
    }
  }
  private owner(userId: string): void {
    if (userId !== this.deps.ownerId) throw new RefinementError("REFINEMENT_NOT_FOUND");
  }
  private registration(workflowId: string, requireRunner = true): RefinementWorkflowRegistration {
    let raw: RefinementWorkflowRegistration | null;
    try { raw = this.deps.registry(workflowId); } catch { throw new RefinementError("REFINEMENT_UNAVAILABLE"); }
    if (!raw) throw new RefinementError("REFINEMENT_UNAVAILABLE");
    const { runValidation, ...descriptor } = raw;
    const checked = RefinementRegistrationDescriptor.safeParse(descriptor);
    if (!checked.success || checked.data.workflowId !== workflowId ||
        (requireRunner && typeof runValidation !== "function"))
      throw new RefinementError("REFINEMENT_UNAVAILABLE");
    return { ...frozenClone(checked.data), runValidation };
  }
  private bindings(version: RefinementVersion, requireRunner = true): RefinementValidationBindings {
    const r = this.registration(version.envelope.content.scope.workflowId, requireRunner);
    if (r.workflowContractHash !== version.envelope.content.scope.workflowContractHash)
      throw new RefinementError("REFINEMENT_INELIGIBLE");
    return {
      versionId: version.envelope.versionId, versionHash: version.versionHash,
      scopeKey: version.scopeKey, workflowContractHash: r.workflowContractHash,
      workflowBuildHash: r.workflowBuildHash, validatorBuildHash: r.validatorBuildHash,
      qualification: r.qualification,
    };
  }
  private compatible(version: RefinementVersion, attempt?: RefinementValidation): boolean {
    try {
      const binding = this.bindings(version);
      return !attempt || canonicalJson(binding) === canonicalJson(attempt.bindings);
    } catch { return false; }
  }
  private decodeVersion(raw: RefinementVersionsRow): { row: RefinementVersionsRow; view: RefinementVersion } {
    const row = parsed(RefinementVersionsRow, raw, true);
    const envelope = parsed(RefinementEnvelope, json(row.envelope_json), true);
    const transition = parsed(RefinementTransitionRecord, json(row.last_transition_json), true);
    const view = parsed(RefinementVersion, {
      envelope, versionHash: row.version_hash, scopeKey: row.scope_key, state: row.state,
      latestAttemptId: row.latest_attempt_id, validatedAttemptId: row.validated_attempt_id,
      approvalAuditId: row.approval_audit_id, lastTransitionAuditId: row.last_transition_audit_id,
      updatedAt: row.updated_at,
    }, true);
    if (envelope.versionId !== row.id || envelope.familyId !== row.family_id || envelope.revision !== row.revision ||
        envelope.parentVersionId !== row.parent_id || envelope.provenance.createdAt !== row.created_at ||
        refinementHash(envelope) !== row.version_hash || refinementHash(envelope.content.scope) !== row.scope_key ||
        transition.response.versionId !== row.id || transition.response.versionHash !== row.version_hash ||
        transition.response.state !== row.state || transition.response.auditEntryId !== row.last_transition_audit_id ||
        (row.validated_attempt_id !== null && row.latest_attempt_id !== row.validated_attempt_id) ||
        (row.approval_audit_id !== null && row.validated_attempt_id === null) ||
        ((row.state === "approved" || row.state === "active") && row.approval_audit_id === null) ||
        (row.state === "validated" && (row.validated_attempt_id === null || row.approval_audit_id !== null)) ||
        (row.state === "proposed" && (row.validated_attempt_id !== null || row.approval_audit_id !== null)))
      throw new RefinementError("REFINEMENT_CORRUPT");
    return { row, view };
  }
  private version(id: string): { row: RefinementVersionsRow; view: RefinementVersion } {
    const row = store.readVersion(this.deps.sql, id);
    if (!row) throw new RefinementError("REFINEMENT_NOT_FOUND");
    return this.decodeVersion(row);
  }
  private scope(key: string): { row: RefinementScopesRow; view: RefinementScopeState } {
    const raw = store.readScope(this.deps.sql, key);
    if (!raw) throw new RefinementError("REFINEMENT_CORRUPT");
    const row = parsed(RefinementScopesRow, raw, true);
    const view = parsed(RefinementScopeState, {
      scopeKey: row.scope_key, activeVersionId: row.active_version_id, generation: row.generation,
      lastTransitionAuditId: row.last_transition_audit_id,
    }, true);
    if ((row.last_transition_json === null) !== (row.last_transition_audit_id === null))
      throw new RefinementError("REFINEMENT_CORRUPT");
    if (row.last_transition_json !== null) {
      const record = parsed(RefinementTransitionRecord, json(row.last_transition_json), true);
      if (record.response.scopeGeneration !== row.generation || record.response.auditEntryId !== row.last_transition_audit_id)
        throw new RefinementError("REFINEMENT_CORRUPT");
    }
    if (row.active_version_id !== null) {
      const active = this.version(row.active_version_id).view;
      if (active.state !== "active" || active.scopeKey !== key) throw new RefinementError("REFINEMENT_CORRUPT");
    }
    return { row, view };
  }
  private decodeValidation(raw: RefinementValidationsRow): RefinementValidation {
    const row = parsed(RefinementValidationsRow, raw, true);
    const attempt = parsed(RefinementValidation, {
      id: row.id, bindings: json(row.bindings_json), status: row.status, assurance: row.assurance,
      report: row.report_json === null ? null : json(row.report_json), reportHash: row.report_hash,
      reason: row.reason, startedAt: row.started_at, deadlineAt: row.deadline_at, completedAt: row.completed_at,
    }, true);
    if (attempt.bindings.versionId !== row.version_id || attempt.bindings.versionHash !== row.version_hash ||
        attempt.assurance !== (attempt.report !== null && attempt.bindings.qualification.executionKind === "real_model" ? "behavior_measured" : "contract_only") ||
        Date.parse(attempt.deadlineAt) <= Date.parse(attempt.startedAt) ||
        Date.parse(attempt.deadlineAt) - Date.parse(attempt.startedAt) > 300_000 ||
        ((attempt.status === "running") !== (attempt.completedAt === null)) ||
        (attempt.status === "running" && (attempt.report !== null || attempt.reportHash !== null || attempt.reason !== null)) ||
        (attempt.status === "error" && (attempt.reason === null || attempt.report !== null || attempt.reportHash !== null)))
      throw new RefinementError("REFINEMENT_CORRUPT");
    if (attempt.status === "passed" || attempt.status === "failed") {
      const checked = inspectRefinementReport(attempt.bindings, attempt.report);
      if (!checked.valid || refinementHash(attempt.report) !== attempt.reportHash ||
          checked.passed !== (attempt.status === "passed") ||
          (attempt.status === "passed" ? attempt.reason !== null : attempt.reason !== "CHECK_FAILED"))
        throw new RefinementError("REFINEMENT_CORRUPT");
    }
    return attempt;
  }
  private attempt(id: string): RefinementValidation {
    const raw = store.readValidation(this.deps.sql, id);
    if (!raw) throw new RefinementError("REFINEMENT_CORRUPT");
    return this.decodeValidation(raw);
  }
  private emit(action: RefinementAuditEvent["action"], version: RefinementVersion, metadata: Record<string, unknown>,
    outcome: "success" | "error" = "success"): string {
    const result = this.deps.audit({ action, versionId: version.envelope.versionId, scopeKey: version.scopeKey,
      timestamp: this.now(), outcome, metadata: { versionHash: version.versionHash, ...metadata } });
    if (typeof result.id !== "string" || result.id.length === 0) throw new RefinementError("REFINEMENT_UNAVAILABLE");
    return result.id;
  }
  private transition(row: RefinementVersionsRow, generation: number, action: RefinementAction,
    requestHash: string, auditId: string): RefinementMutationResponse {
    row.last_transition_audit_id = auditId;
    row.updated_at = this.now();
    const response: RefinementMutationResponse = { versionId: row.id, versionHash: row.version_hash,
      state: row.state, scopeGeneration: generation, auditEntryId: auditId };
    row.last_transition_json = canonicalJson({ action, requestHash, response });
    return response;
  }
  private repeated(row: RefinementVersionsRow, scope: RefinementScopesRow, action: RefinementAction,
    requestHash: string): RefinementMutationResponse | null {
    const record = parsed(RefinementTransitionRecord, json(row.last_transition_json), true);
    return record.action === action && record.requestHash === requestHash &&
      record.response.scopeGeneration === scope.generation ? record.response : null;
  }
  private boundVersion(request: { versionId: string; versionHash: string }): ReturnType<RefinementManager["version"]> {
    const version = this.version(request.versionId);
    if (version.view.versionHash !== request.versionHash) throw new RefinementError("REFINEMENT_CONFLICT");
    return version;
  }
  private expectGeneration(scope: RefinementScopesRow, expected: number): void {
    if (scope.generation !== expected) throw new RefinementError("REFINEMENT_CONFLICT");
  }
  private passed(version: RefinementVersion, id: string, hash: string): RefinementValidation {
    if (version.validatedAttemptId !== id || version.latestAttemptId !== id)
      throw new RefinementError("REFINEMENT_INELIGIBLE");
    const attempt = this.attempt(id);
    if (attempt.status !== "passed" || attempt.reportHash !== hash ||
        attempt.bindings.versionId !== version.envelope.versionId || attempt.bindings.versionHash !== version.versionHash ||
        !this.compatible(version, attempt)) throw new RefinementError("REFINEMENT_INELIGIBLE");
    return attempt;
  }

  async propose(input: RefinementProposeRequest): Promise<RefinementDetailResponse> {
    const request = parsed(RefinementProposeRequest, input);
    this.owner(request.userId);
    const r = this.registration(request.content.scope.workflowId, false);
    if (r.workflowContractHash !== request.content.scope.workflowContractHash) throw new RefinementError("REFINEMENT_INELIGIBLE");
    if (new Set(request.sources.map((s) => canonicalJson(s))).size !== request.sources.length)
      throw new RefinementError("REFINEMENT_INVALID_REQUEST");
    const sources = await Promise.all(request.sources.map(async (reference) => {
      let resolved;
      try { resolved = await this.deps.resolveSource(frozenClone(reference), this.deps.ownerId); }
      catch { throw new RefinementError("REFINEMENT_UNAVAILABLE"); }
      return parsed(RefinementSource, { ...reference, sha256: resolved?.sha256 ?? null,
        auditEntryId: resolved?.auditEntryId ?? null, resolved: resolved !== null });
    }));
    const requestHash = refinementHash({ request, sources });
    return this.atomic(() => {
      // Source resolution may await. Recheck registration before committing.
      if (this.registration(request.content.scope.workflowId, false).workflowContractHash !== r.workflowContractHash)
        throw new RefinementError("REFINEMENT_CONFLICT");
      const prior = store.readProposal(this.deps.sql, requestHash);
      if (prior) { this.recover(prior.id); return this.detail(prior.id); }
      if (store.versionCount(this.deps.sql) >= MAX_VERSIONS) throw new RefinementError("REFINEMENT_CAPACITY");
      const scopeKey = refinementHash(request.content.scope);
      const parent = request.parentVersionId === null ? null : this.version(request.parentVersionId).view;
      if (parent && parent.scopeKey !== scopeKey) throw new RefinementError("REFINEMENT_INELIGIBLE");
      const familyId = parent?.envelope.familyId ?? this.id();
      const envelope = parsed(RefinementEnvelope, { versionId: this.id(), familyId,
        revision: store.nextRevision(this.deps.sql, familyId), parentVersionId: request.parentVersionId,
        content: request.content, provenance: { createdAt: this.now(), producerKind: "operator_import",
          producerRunId: null, modelConfigHash: null, sources } });
      store.insertScope(this.deps.sql, scopeKey);
      const scope = this.scope(scopeKey).row;
      const version: RefinementVersion = { envelope, versionHash: refinementHash(envelope), scopeKey,
        state: "proposed", latestAttemptId: null, validatedAttemptId: null, approvalAuditId: null,
        lastTransitionAuditId: "pending", updatedAt: envelope.provenance.createdAt };
      const auditId = this.emit("propose", version, { requestHash, scopeGeneration: scope.generation,
        sourceCount: sources.length, parentVersionId: request.parentVersionId });
      const row: RefinementVersionsRow = { id: envelope.versionId, family_id: familyId,
        revision: envelope.revision, parent_id: request.parentVersionId, scope_key: scopeKey,
        version_hash: version.versionHash, proposal_request_hash: requestHash, envelope_json: canonicalJson(envelope), state: "proposed",
        latest_attempt_id: null, validated_attempt_id: null, approval_audit_id: null,
        last_transition_audit_id: auditId, last_transition_json: "", created_at: envelope.provenance.createdAt,
        updated_at: version.updatedAt };
      this.transition(row, scope.generation, "propose", requestHash, auditId);
      store.insertVersion(this.deps.sql, row);
      return this.detail(row.id);
    });
  }

  private detail(id: string): RefinementDetailResponse {
    const version = this.version(id).view;
    const validations = store.listValidations(this.deps.sql, id).map((row) => this.decodeValidation(row));
    if (validations.length > MAX_ATTEMPTS) throw new RefinementError("REFINEMENT_CORRUPT");
    const latest = version.latestAttemptId === null ? undefined : this.attempt(version.latestAttemptId);
    if (latest && (latest.bindings.versionId !== id || latest.bindings.versionHash !== version.versionHash))
      throw new RefinementError("REFINEMENT_CORRUPT");
    let qualification = null;
    try { qualification = this.registration(version.envelope.content.scope.workflowId, false).qualification; } catch { /* Archived/unknown workflow: inspectable, not eligible. */ }
    return { version, scope: this.scope(version.scopeKey).view, validations,
      compatible: this.compatible(version, latest), qualification };
  }
  get(versionId: string): RefinementDetailResponse {
    return this.atomic(() => { this.recover(versionId); return this.detail(versionId); });
  }
  list(input: RefinementListRequest): RefinementListResponse {
    const request = parsed(RefinementListRequest, input);
    this.owner(request.userId);
    return this.atomic(() => {
      const cursor = request.cursor ? this.version(request.cursor).row : null;
      if (cursor && request.scopeKey && cursor.scope_key !== request.scopeKey) throw new RefinementError("REFINEMENT_INVALID_REQUEST");
      const limit = request.limit ?? 20;
      const rows = store.listVersions(this.deps.sql, limit + 1, request.scopeKey ?? null,
        cursor ? { createdAt: cursor.created_at, id: cursor.id } : null);
      const page = rows.slice(0, limit).map((row) => { this.recover(row.id); return this.version(row.id).view; });
      return { refinements: page, nextCursor: rows.length > limit ? page.at(-1)!.envelope.versionId : null };
    });
  }

  async validate(input: RefinementValidateRequest): Promise<RefinementValidationResponse> {
    const request = parsed(RefinementValidateRequest, input);
    this.owner(request.userId);
    const admission = this.atomic(() => {
      this.recover(request.versionId);
      const version = this.boundVersion(request);
      const bindings = this.bindings(version.view);
      if (bindings.qualification.suiteId !== request.suiteId) throw new RefinementError("REFINEMENT_INELIGIBLE");
      if (version.view.state === "active" || version.view.state === "approved") throw new RefinementError("REFINEMENT_INELIGIBLE");
      const previous = version.view.latestAttemptId ? this.attempt(version.view.latestAttemptId) : null;
      if (previous && canonicalJson(previous.bindings) === canonicalJson(bindings) &&
          (previous.status === "running" || (version.view.state !== "disabled" && (previous.status === "passed" || previous.status === "failed"))))
        return { existing: previous.id };
      if (previous?.status === "running") throw new RefinementError("REFINEMENT_CONFLICT");
      if (store.listValidations(this.deps.sql, request.versionId).length >= MAX_ATTEMPTS) throw new RefinementError("REFINEMENT_CAPACITY");
      const startedAt = this.now();
      const attempt: RefinementValidation = { id: this.id(), bindings, status: "running",
        assurance: "contract_only",
        report: null, reportHash: null, reason: null, startedAt,
        deadlineAt: new Date(Date.parse(startedAt) + this.timeoutMs).toISOString(), completedAt: null };
      store.insertValidation(this.deps.sql, this.attemptRow(attempt));
      version.row.latest_attempt_id = attempt.id;
      version.row.validated_attempt_id = null;
      version.row.approval_audit_id = null;
      if (version.row.state !== "disabled") version.row.state = "proposed";
      const generation = this.scope(version.view.scopeKey).row.generation;
      const audit = this.emit("validate", version.view, { attemptId: attempt.id, phase: "started", requestHash: refinementHash(request) });
      this.transition(version.row, generation, "validate", refinementHash(request), audit);
      store.updateVersionState(this.deps.sql, version.row);
      return { attempt, version: frozenClone(version.view.envelope),
        runner: this.registration(version.view.envelope.content.scope.workflowId).runValidation! };
    });
    if ("existing" in admission) return this.validationResponse(request.versionId, admission.existing!);
    const { attempt, version, runner } = admission;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    let report: unknown;
    let failure: RefinementValidation["reason"] = null;
    try {
      if (version.provenance.sources.some((s) => !s.resolved)) failure = "PROVENANCE_UNRESOLVED";
      else if (version.provenance.sources.some((s) => attempt.bindings.qualification.caseIds.includes(s.id)))
        failure = "EVALUATION_OVERLAP";
      else {
        report = await Promise.race([
          Promise.resolve().then(() => runner({ version, bindings: frozenClone(attempt.bindings), signal: controller.signal })),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => { timedOut = true; controller.abort(); reject(new Error("timeout")); }, this.timeoutMs);
          }),
        ]);
      }
    } catch { failure = timedOut ? "VALIDATOR_TIMEOUT" : "VALIDATOR_ERROR"; }
    finally { if (timer !== undefined) clearTimeout(timer); }
    this.atomic(() => this.complete(attempt.id, report, failure));
    return this.validationResponse(request.versionId, attempt.id);
  }
  private attemptRow(a: RefinementValidation): RefinementValidationsRow {
    return { id: a.id, version_id: a.bindings.versionId, version_hash: a.bindings.versionHash, status: a.status,
      assurance: a.assurance, bindings_json: canonicalJson(a.bindings),
      report_json: a.report === null ? null : canonicalJson(a.report), report_hash: a.reportHash,
      reason: a.reason, started_at: a.startedAt, deadline_at: a.deadlineAt, completed_at: a.completedAt };
  }
  private complete(id: string, raw: unknown, failure: RefinementValidation["reason"]): void {
    const a = this.attempt(id);
    if (a.status !== "running") return;
    const version = this.version(a.bindings.versionId);
    if (version.row.latest_attempt_id !== id || version.view.versionHash !== a.bindings.versionHash)
      throw new RefinementError("REFINEMENT_CORRUPT");
    if (Date.parse(this.now()) >= Date.parse(a.deadlineAt)) failure = "VALIDATOR_TIMEOUT";
    if (!this.compatible(version.view, a)) failure = "INCOMPATIBLE";
    const checked = failure === null ? inspectRefinementReport(a.bindings, raw) : null;
    if (checked && !checked.valid) failure = "REPORT_INVALID";
    const report: RefinementValidationReport | null = checked?.valid ? checked.report : null;
    const passed = checked?.valid === true && checked.passed;
    const completed: RefinementValidation = { ...a, report,
      assurance: report !== null && a.bindings.qualification.executionKind === "real_model" ? "behavior_measured" : "contract_only",
      reportHash: report === null ? null : refinementHash(report),
      status: failure !== null ? "error" : passed ? "passed" : "failed",
      reason: failure ?? (passed ? null : "CHECK_FAILED"), completedAt: this.now() };
    if (!store.finishValidation(this.deps.sql, this.attemptRow(completed))) return;
    if (passed && failure === null) { version.row.state = "validated"; version.row.validated_attempt_id = id; }
    else { if (version.row.state !== "disabled") version.row.state = "proposed"; version.row.validated_attempt_id = null; }
    version.row.approval_audit_id = null;
    const scope = this.scope(version.view.scopeKey).row;
    const requestHash = refinementHash({ attemptId: id, reportHash: completed.reportHash, status: completed.status });
    const audit = this.emit("validate", version.view, { phase: "completed", attemptId: id,
      reportHash: completed.reportHash, status: completed.status, reason: completed.reason, requestHash },
      completed.status === "passed" ? "success" : "error");
    this.transition(version.row, scope.generation, "validate", requestHash, audit);
    store.updateVersionState(this.deps.sql, version.row);
  }
  private recover(versionId: string): void {
    const version = this.version(versionId).view;
    if (version.latestAttemptId) {
      const attempt = this.attempt(version.latestAttemptId);
      if (attempt.status === "running" && Date.parse(attempt.deadlineAt) <= Date.parse(this.now()))
        this.complete(attempt.id, undefined, "VALIDATOR_TIMEOUT");
    }
  }
  private validationResponse(versionId: string, attemptId: string): RefinementValidationResponse {
    return this.atomic(() => ({ validation: this.attempt(attemptId), version: this.version(versionId).view,
      scope: this.scope(this.version(versionId).view.scopeKey).view }));
  }

  approve(input: RefinementApproveRequest): RefinementMutationResponse {
    const request = parsed(RefinementApproveRequest, input);
    this.owner(request.userId);
    return this.atomic(() => {
      const { row, view } = this.boundVersion(request);
      const scope = this.scope(view.scopeKey).row;
      const digest = refinementHash(request);
      const repeated = this.repeated(row, scope, "approve", digest);
      if (repeated) return repeated;
      this.expectGeneration(scope, request.expectedScopeGeneration);
      if (view.state !== "validated") throw new RefinementError("REFINEMENT_INELIGIBLE");
      this.passed(view, request.validationId, request.reportHash);
      const audit = this.emit("approve", view, { requestHash: digest, validationId: request.validationId,
        reportHash: request.reportHash, scopeGeneration: scope.generation, actorKind: "local_token_holder" });
      row.state = "approved";
      row.approval_audit_id = audit;
      const response = this.transition(row, scope.generation, "approve", digest, audit);
      store.updateVersionState(this.deps.sql, row);
      return response;
    });
  }
  activate(input: RefinementActivateRequest): RefinementMutationResponse {
    const request = parsed(RefinementActivateRequest, input);
    this.owner(request.userId);
    return this.atomic(() => this.switchVersion(request, "activate"));
  }
  rollback(input: RefinementRollbackRequest): RefinementMutationResponse {
    const request = parsed(RefinementRollbackRequest, input);
    this.owner(request.userId);
    return this.atomic(() => this.switchVersion(request, "rollback"));
  }
  private switchVersion(request: RefinementActivateRequest | RefinementRollbackRequest,
    action: "activate" | "rollback"): RefinementMutationResponse {
    const { row, view } = this.boundVersion(request);
    const scope = this.scope(view.scopeKey).row;
    const digest = refinementHash(request);
    const repeated = this.repeated(row, scope, action, digest);
    if (repeated) return repeated;
    this.expectGeneration(scope, request.expectedScopeGeneration);
    this.passed(view, request.validationId, request.reportHash);
    if (action === "activate") {
      if (row.state !== "approved" || !("approvalAuditId" in request) || row.approval_audit_id !== request.approvalAuditId)
        throw new RefinementError("REFINEMENT_INELIGIBLE");
    } else {
      if (row.state !== "disabled" || row.approval_audit_id === null || scope.active_version_id === null)
        throw new RefinementError("REFINEMENT_INELIGIBLE");
      const current = this.version(scope.active_version_id).view;
      if (current.envelope.familyId !== view.envelope.familyId || current.envelope.revision <= view.envelope.revision)
        throw new RefinementError("REFINEMENT_INELIGIBLE");
      row.approval_audit_id = this.emit("approve", view, { rollback: true, requestHash: digest,
        validationId: request.validationId, reportHash: request.reportHash, scopeGeneration: scope.generation,
        actorKind: "local_token_holder" });
    }
    const generation = scope.generation + 1;
    if (!Number.isSafeInteger(generation)) throw new RefinementError("REFINEMENT_CAPACITY");
    if (scope.active_version_id !== null) {
      const prior = this.version(scope.active_version_id);
      prior.row.state = "disabled";
      const audit = this.emit("disable", prior.view, { reason: "superseded", replacementVersionId: row.id,
        scopeGeneration: generation, requestHash: digest });
      this.transition(prior.row, generation, "disable", digest, audit);
      store.updateVersionState(this.deps.sql, prior.row);
    }
    row.state = "active";
    const audit = this.emit(action, view, { requestHash: digest, validationId: request.validationId,
      reportHash: request.reportHash, approvalAuditId: row.approval_audit_id, scopeGeneration: generation });
    const response = this.transition(row, generation, action, digest, audit);
    store.updateVersionState(this.deps.sql, row);
    scope.active_version_id = row.id;
    scope.generation = generation;
    scope.last_transition_audit_id = audit;
    scope.last_transition_json = row.last_transition_json;
    store.updateScope(this.deps.sql, scope);
    return response;
  }
  disable(input: RefinementDisableRequest): RefinementMutationResponse {
    const request = parsed(RefinementDisableRequest, input);
    this.owner(request.userId);
    return this.atomic(() => {
      const { row, view } = this.boundVersion(request);
      const scope = this.scope(view.scopeKey).row;
      const digest = refinementHash(request);
      const repeated = this.repeated(row, scope, "disable", digest);
      if (repeated) return repeated;
      this.expectGeneration(scope, request.expectedScopeGeneration);
      if (view.state !== "active" && view.state !== "approved") throw new RefinementError("REFINEMENT_INELIGIBLE");
      row.state = "disabled";
      scope.generation++;
      if (!Number.isSafeInteger(scope.generation)) throw new RefinementError("REFINEMENT_CAPACITY");
      if (scope.active_version_id === row.id) scope.active_version_id = null;
      const audit = this.emit("disable", view, { requestHash: digest, reasonHash: refinementHash(request.reason),
        scopeGeneration: scope.generation });
      const response = this.transition(row, scope.generation, "disable", digest, audit);
      store.updateVersionState(this.deps.sql, row);
      scope.last_transition_audit_id = audit;
      scope.last_transition_json = row.last_transition_json;
      store.updateScope(this.deps.sql, scope);
      return response;
    });
  }

  select(input: RefinementScope): RefinementPin | null {
    const scope = parsed(RefinementScope, input);
    return this.atomic(() => {
      const key = refinementHash(scope);
      if (!store.readScope(this.deps.sql, key)) return null;
      const current = this.scope(key).view;
      if (current.activeVersionId === null) return null;
      const active = this.version(current.activeVersionId).view;
      if (active.validatedAttemptId === null) throw new RefinementError("REFINEMENT_CORRUPT");
      const attempt = this.attempt(active.validatedAttemptId);
      this.passed(active, attempt.id, attempt.reportHash ?? "");
      return { versionId: active.envelope.versionId, versionHash: active.versionHash,
        validationId: attempt.id, scopeKey: key, scopeGeneration: current.generation };
    });
  }
  private readPin(pin: RefinementPin): RefinementContent {
      const current = this.scope(pin.scopeKey).view;
      if (current.generation !== pin.scopeGeneration || current.activeVersionId !== pin.versionId)
        throw new RefinementError("REFINEMENT_CHANGED");
      const version = this.version(pin.versionId).view;
      if (version.versionHash !== pin.versionHash || version.state !== "active" || version.validatedAttemptId !== pin.validationId)
        throw new RefinementError("REFINEMENT_CHANGED");
      const attempt = this.attempt(pin.validationId);
      this.passed(version, pin.validationId, attempt.reportHash ?? "");
      return frozenClone(version.envelope.content);
  }
  assertPin(input: RefinementPin): RefinementContent {
    const pin = parsed(RefinementPin, input);
    return this.atomic(() => this.readPin(pin));
  }
  /** Call only at actual analysis admission, after source authorization; no session is created. */
  recordUse(pin: RefinementPin, runId: string): string {
    return this.atomic(() => {
      this.readPin(parsed(RefinementPin, pin));
      const version = this.version(pin.versionId).view;
      return this.emit("use", version, { runId, validationId: pin.validationId, scopeGeneration: pin.scopeGeneration });
    });
  }
}

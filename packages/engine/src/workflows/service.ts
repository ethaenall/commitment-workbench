// SPDX-License-Identifier: AGPL-3.0-only

import {
  RefinementContent, WorkflowRunRequest,
  type RefinementQualification, type RefinementScope,
  type RefinementValidationReport, type WorkflowDescribeResponse, type WorkflowRunResult,
} from "@habenula-ai/contracts";
import type { EngineSql } from "../data/helpers/types";
import type { LLMClient } from "../llm/types";
import type { LLMConfig } from "../llm/create-llm-client";
import { RefinementManager, type RefinementAuditEvent } from "../refinements/manager";
import { RefinementError } from "../refinements/errors";
import { refinementHash } from "../refinements/canonical";
import type { RefinementWorkflowRegistration } from "../refinements/registry";
import { COMMITMENT_WORKFLOW, validateCommitmentSnapshot } from "./commitment-handoff";
import { listWorkflowFixtures, getWorkflowFixture, WORKFLOW_VALIDATION_SUITE, evaluateWorkflowSuite } from "./fixtures";
import { COMMITMENT_CONTRACT_HASH, WORKFLOW_BUILD_HASH, REFINEMENT_VALIDATOR_BUILD_HASH } from "./build-identity";
import { ModelBudget, ModelBudgetError, MODEL_BUDGET_DEFAULTS } from "./model-budget";
import { createNativeOperationScope } from "../llm/native-operation-scope";
import { runCommitmentWorkflow, workflowFailure, WORKFLOW_MAX_REPAIRS,
  type WorkflowAnalysisRuntime, type WorkflowGuidance, type WorkflowRunModel } from "./run-workflow";

type ValidationKind = RefinementQualification["executionKind"];
export interface GovernedLearningDependencies {
  ownerId: string;
  sql: EngineSql;
  transaction: <T>(body: () => T) => T;
  audit: (event: RefinementAuditEvent) => { id: string };
  getClient: () => LLMClient;
  getModelConfig: () => LLMConfig;
  /** Trusted deployment selection, never a request/artifact field. */
  validationKind?: ValidationKind;
  usageKind?: "synthetic" | "provider-reported";
  /** Only a host adapter with outbound-setting evidence may fill known effort. */
  modelMetadata?: () => WorkflowRunModel;
  /** Absent until the runtime's actual containment/resource gate is accepted. */
  runtime?: WorkflowAnalysisRuntime;
}
const STATIC_CHECKS = ["guidance.contract", "guidance.scope", "source.contract"];
const STATIC_SUITE_ID = "commitment-guidance-contract.v1";

/** One owner's explicit feature state; never the chat history or authority kernel. */
export class GovernedLearningService {
  readonly refinements: RefinementManager;
  readonly scope: RefinementScope = Object.freeze({ workflowId: COMMITMENT_WORKFLOW.id,
    slot: "reasoning", workflowContractHash: COMMITMENT_CONTRACT_HASH });
  private readonly jobs = new Set<AbortController>();
  private readonly kind: ValidationKind;
  private readonly usageKind: "synthetic" | "provider-reported";

  constructor(private readonly deps: GovernedLearningDependencies) {
    this.kind = deps.validationKind ?? "schema_contract";
    this.usageKind = deps.usageKind ?? (this.kind === "deterministic_mock" ? "synthetic" : "provider-reported");
    if ((this.kind === "real_model" && this.usageKind !== "provider-reported") ||
        (this.kind === "deterministic_mock" && this.usageKind !== "synthetic")) {
      throw new RefinementError("REFINEMENT_INVALID_REQUEST");
    }
    this.refinements = new RefinementManager({ ownerId: deps.ownerId, sql: deps.sql,
      transaction: deps.transaction, audit: deps.audit,
      validationTimeoutMs: MODEL_BUDGET_DEFAULTS.wallTimeMs,
      registry: (id) => this.registration(id),
      resolveSource: async (reference, ownerId) => {
        if (ownerId !== deps.ownerId || reference.kind !== "learning_fixture" ||
            !listWorkflowFixtures().some((fixture) => fixture.id === reference.id && fixture.split === "learning")) return null;
        const snapshot = await getWorkflowFixture(reference.id);
        return snapshot ? { sha256: snapshot.snapshotHash, auditEntryId: null } : null;
      },
    });
  }

  describe(): WorkflowDescribeResponse {
    return { workflowId: COMMITMENT_WORKFLOW.id, workflowContractHash: COMMITMENT_CONTRACT_HASH,
      schemaVersion: 1, supportedModes: this.deps.runtime ? ["baseline", "refinements", "rlm", "both"] : ["baseline", "refinements"],
      fixtures: listWorkflowFixtures().map((fixture) => ({ ...fixture })) };
  }
  cancelAll(): void { for (const job of this.jobs) job.abort(); }

  private model(): WorkflowRunModel {
    const config = this.deps.getModelConfig();
    // A deployment's requested model is not independent server attestation.
    return this.deps.modelMetadata?.() ?? { provider: config.provider, model: config.model, effort: null };
  }
  private modelHash(): string {
    const config = this.deps.getModelConfig();
    // Never persist a key/token, including hashed credentials. Endpoint is hashed with the tuple.
    return refinementHash({ provider: config.provider, model: config.model, endpoint: config.endpoint ?? null,
      observedModelSettings: this.model(), budget: MODEL_BUDGET_DEFAULTS, repairs: WORKFLOW_MAX_REPAIRS,
      analysisMode: "ordinary-tool-free", executionKind: this.kind });
  }
  private registration(workflowId: string): RefinementWorkflowRegistration | null {
    if (workflowId !== COMMITMENT_WORKFLOW.id) return null;
    const source = WORKFLOW_VALIDATION_SUITE;
    const qualification: RefinementQualification = this.kind === "schema_contract" ? {
      suiteId: STATIC_SUITE_ID, suiteHash: refinementHash({ id: STATIC_SUITE_ID, sourceSuiteHash: source.suiteHash, checks: STATIC_CHECKS }),
      learningManifestHash: source.learningManifestHash, validationManifestHash: source.validationManifestHash,
      caseIds: [...source.caseIds], checkIds: [...STATIC_CHECKS], executionKind: "schema_contract", modelConfigHash: null,
    } : {
      suiteId: source.id, suiteHash: source.suiteHash,
      learningManifestHash: source.learningManifestHash, validationManifestHash: source.validationManifestHash,
      caseIds: [...source.caseIds], checkIds: [...source.checkIds], executionKind: this.kind, modelConfigHash: this.modelHash(),
    };
    return { workflowId, workflowContractHash: COMMITMENT_CONTRACT_HASH, workflowBuildHash: WORKFLOW_BUILD_HASH,
      validatorBuildHash: REFINEMENT_VALIDATOR_BUILD_HASH, qualification,
      runValidation: (input) => this.validateCandidate(input) };
  }
  private async withJob<T>(signal: AbortSignal | undefined, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    // Synchronous reservation before any await. This is per owner/service, not the WASM module-global lease.
    if (this.jobs.size !== 0) throw new RefinementError("REFINEMENT_CONFLICT");
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) controller.abort();
    this.jobs.add(controller);
    try { return await run(controller.signal); }
    finally { controller.abort(); this.jobs.delete(controller); signal?.removeEventListener("abort", abort); }
  }
  private live(signal: AbortSignal): void { if (signal.aborted) throw new ModelBudgetError("CANCELLED"); }

  async run(raw: WorkflowRunRequest, signal?: AbortSignal): Promise<WorkflowRunResult> {
    const parsed = WorkflowRunRequest.safeParse(raw);
    if (!parsed.success) throw new RefinementError("REFINEMENT_INVALID_REQUEST");
    const request = parsed.data;
    if (request.userId !== this.deps.ownerId) throw new RefinementError("REFINEMENT_NOT_FOUND");
    return await this.withJob(signal, async (jobSignal) => {
      this.live(jobSignal);
      const supplied = request.snapshot ?? await getWorkflowFixture(request.fixtureId!);
      if (!supplied) throw new RefinementError("REFINEMENT_NOT_FOUND");
      const checked = await validateCommitmentSnapshot(supplied);
      if (!checked.ok) throw new RefinementError("REFINEMENT_INVALID_REQUEST");
      this.live(jobSignal);
      const runId = crypto.randomUUID();
      if ((request.mode === "rlm" || request.mode === "both") && !this.deps.runtime) {
        return { runId, workflowId: COMMITMENT_WORKFLOW.id, mode: request.mode,
          snapshotId: checked.value.snapshotId, snapshotHash: checked.value.snapshotHash,
          status: "blocked", ledger: null,
          validation: workflowFailure("WORKFLOW_RLM_UNAVAILABLE", "No reviewed RLM runtime is configured. No fallback was used."),
          usage: { kind: "unknown", inputTokens: null, outputTokens: null, rootCalls: 0, childCalls: 0, complete: false },
          refinement: null, model: null, elapsedMs: 0,
          notices: ["No model call ran. No service was changed.", "RLM remains disabled until the runtime's actual safety and resource limits pass review."] };
      }
      let guidance: WorkflowGuidance | undefined;
      if (request.mode === "refinements" || request.mode === "both") {
        const pin = this.refinements.select(this.scope);
        if (!pin) throw new RefinementError("REFINEMENT_UNAVAILABLE");
        const content = this.refinements.assertPin(pin);
        const revision = this.refinements.get(pin.versionId).version.envelope.revision;
        guidance = { kind: "active", pin, content, revision,
          assertCurrent: () => { this.refinements.assertPin(pin); },
          recordUse: () => { this.refinements.recordUse(pin, runId); } };
      }
      // Acquiring/validating source precedes attaching approved guidance or starting inference.
      const config = this.deps.getModelConfig();
      const rlm = request.mode === "rlm" || request.mode === "both";
      const budget = new ModelBudget({ client: this.deps.getClient(), model: config.model, signal: jobSignal,
        ...(rlm ? { nativeOperations: createNativeOperationScope() } : {}) });
      try {
        return await runCommitmentWorkflow({ runId, mode: request.mode, snapshot: checked.value, budget,
          model: this.model(), usageKind: this.usageKind, guidance, runtime: this.deps.runtime });
      } finally { budget.dispose(); }
    });
  }

  private async validateCandidate(input: Parameters<NonNullable<RefinementWorkflowRegistration["runValidation"]>>[0]): Promise<RefinementValidationReport> {
    return await this.withJob(input.signal, async (signal) => {
      const started = Date.now();
      const { version, bindings } = input;
      const assertCurrent = (): void => {
        this.live(signal);
        const current = this.registration(version.content.scope.workflowId);
        if (!current || refinementHash(current.qualification) !== refinementHash(bindings.qualification) ||
            current.workflowBuildHash !== bindings.workflowBuildHash || current.validatorBuildHash !== bindings.validatorBuildHash) {
          throw new RefinementError("REFINEMENT_CHANGED");
        }
      };
      assertCurrent();
      if (bindings.qualification.executionKind === "schema_contract") {
        // Static checks ONLY: no candidate execution, mock output, oracle PASS, or inferred efficacy.
        const cases: RefinementValidationReport["cases"] = [];
        for (const caseId of bindings.qualification.caseIds) {
          const fixture = await getWorkflowFixture(caseId);
          const snapshot = fixture ? await validateCommitmentSnapshot(fixture) : null;
          assertCurrent();
          const checks = [
            { checkId: "guidance.contract", passed: RefinementContent.safeParse(version.content).success },
            { checkId: "guidance.scope", passed: refinementHash(version.content.scope) === refinementHash(this.scope) },
            { checkId: "source.contract", passed: snapshot?.ok === true },
          ];
          cases.push({ caseId, inputHash: fixture?.snapshotHash ?? refinementHash({ missingFixture: caseId }),
            outputHash: refinementHash({ kind: "static-check-result", contentHash: refinementHash(version.content), checks }), checks });
        }
        return { cases, elapsedMs: Math.max(0, Date.now() - started),
          usage: { accounting: "none", calls: [], inputTokens: 0, outputTokens: 0 } };
      }
      const config = this.deps.getModelConfig();
      const budget = new ModelBudget({ client: this.deps.getClient(), model: config.model, signal });
      const runId = crypto.randomUUID();
      try {
        const suite = await evaluateWorkflowSuite(bindings.qualification.suiteId, async (snapshot, caseId) => {
          assertCurrent();
          const result = await runCommitmentWorkflow({ runId: `${runId}.${caseId}`, mode: "refinements", snapshot, budget,
            model: this.model(), usageKind: this.usageKind,
            guidance: { kind: "candidate", versionId: version.versionId, versionHash: bindings.versionHash,
              revision: version.revision, content: version.content, assertCurrent } });
          if (result.status !== "complete" && result.status !== "invalid_output") {
            // An execution refusal is not measured answer quality. The suite
            // retains callback failures, and the bridge rejects them below.
            throw new RefinementError("REFINEMENT_UNAVAILABLE");
          }
          return result.status === "complete" ? result.ledger : null;
        });
        assertCurrent();
        const usage = budget.snapshot();
        if (suite.cases.some((entry) => entry.error !== null) || usage.closedReason !== null ||
            usage.usageStatus !== "complete" || usage.activeCalls !== 0 || usage.attempts === 0 ||
            typeof usage.observedInputTokens !== "number" || typeof usage.observedOutputTokens !== "number") {
          throw new RefinementError("REFINEMENT_UNAVAILABLE");
        }
        const calls = usage.ledger.map((call) => {
          if (call.usageStatus !== "reported" || typeof call.usage.inputTokens !== "number" || call.usage.outputTokens === null) {
            throw new RefinementError("REFINEMENT_UNAVAILABLE");
          }
          // v1 qualification is ordinary root inference, not recursive runtime qualification.
          if (call.role !== "root") throw new RefinementError("REFINEMENT_UNAVAILABLE");
          return { callId: `${runId}.call-${call.id}`, parentCallId: null, role: "root" as const,
            inputTokens: call.usage.inputTokens, outputTokens: call.usage.outputTokens };
        });
        return { cases: suite.cases.map(({ caseId, inputHash, outputHash, checks }) => ({ caseId, inputHash, outputHash, checks })),
          elapsedMs: Math.max(0, Date.now() - started), usage: {
            accounting: this.kind === "deterministic_mock" ? "synthetic" : "provider_reported",
            calls, inputTokens: usage.observedInputTokens, outputTokens: usage.observedOutputTokens } };
      } finally { budget.dispose(); }
    });
  }
}

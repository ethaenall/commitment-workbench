// SPDX-License-Identifier: AGPL-3.0-only
/** Trusted DO-side composition. Never selected by request content or a public URL. */
import type { CommitmentSnapshot } from "@habenula-ai/contracts";
import { validateCommitmentLedger } from "./commitment-handoff";
import { createRlmBackendPort, type RlmBackendBinding } from "./rlm-backend-client";
import { createRlmRuntime } from "./rlm-runtime";
import { createPromptPort } from "./rlm-prompts";
import { createContextCodecPort } from "./rlm-context-codec";
import { createRlmTraceCollector, hashGeneratedSource } from "./rlm-trace";
import { RLM_RUNTIME_ID } from "./rlm-host-types";
import type { WorkflowAnalysisRuntime } from "./run-workflow";

export interface GovernedRlmEnvironment {
  GOVERNED_RLM?: string;
  RLM_BACKEND?: RlmBackendBinding;
}

/** Disabled means absent, never a fallback to a different backend. */
export function createGovernedRlmRuntime(env: GovernedRlmEnvironment, ownerId: string): WorkflowAnalysisRuntime | undefined {
  if (env.GOVERNED_RLM !== "true" || typeof env.RLM_BACKEND?.fetch !== "function") return undefined;
  const binding = env.RLM_BACKEND;
  return {
    id: RLM_RUNTIME_ID,
    async run(input) {
      // The service supplies its ONE ModelBudget. No client, budget, audit,
      // validator, provider settings, or native scope crosses the DATA binding.
      const backend = createRlmBackendPort({ binding, taskId: crypto.randomUUID() });
      const runtime = createRlmRuntime({
        backend,
        prompts: createPromptPort(),
        codec: createContextCodecPort(),
        trace: createRlmTraceCollector(),
        hashSource: hashGeneratedSource,
        validateLedger: (snapshot, output) => validateCommitmentLedger(snapshot as CommitmentSnapshot, output),
        ownerId,
      });
      return await runtime.run(input);
    },
  };
}

// SPDX-License-Identifier: AGPL-3.0-only

import { z } from "zod";
import {
  RefinementHash, RefinementId, RefinementQualification,
  type RefinementEnvelope, type RefinementSourceRef,
  type RefinementValidationBindings, type RefinementValidationReport,
} from "@habenula-ai/contracts";

export const RefinementRegistrationDescriptor = z.strictObject({
  workflowId: RefinementId, workflowContractHash: RefinementHash,
  workflowBuildHash: RefinementHash, validatorBuildHash: RefinementHash,
  qualification: RefinementQualification,
});
export interface RefinementWorkflowRegistration extends z.infer<typeof RefinementRegistrationDescriptor> {
  /** Trusted engine code only. Never populated from a request or stored artifact. */
  runValidation?: (input: {
    version: RefinementEnvelope;
    bindings: RefinementValidationBindings;
    signal: AbortSignal;
  }) => Promise<RefinementValidationReport>;
}
export interface ResolvedRefinementSource { sha256: string; auditEntryId: string | null }
export type RefinementSourceResolver = (
  reference: RefinementSourceRef, ownerId: string,
) => ResolvedRefinementSource | null | Promise<ResolvedRefinementSource | null>;

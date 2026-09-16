// SPDX-License-Identifier: AGPL-3.0-only

export type RefinementErrorCode =
  | "REFINEMENT_INVALID_REQUEST" | "REFINEMENT_NOT_FOUND" | "REFINEMENT_CONFLICT"
  | "REFINEMENT_INELIGIBLE" | "REFINEMENT_UNAVAILABLE" | "REFINEMENT_CORRUPT"
  | "REFINEMENT_CHANGED" | "REFINEMENT_CAPACITY";

/** Fixed messages only: persistence/validator errors may contain private content. */
export class RefinementError extends Error {
  constructor(readonly code: RefinementErrorCode) {
    super(code);
    this.name = "RefinementError";
  }
}

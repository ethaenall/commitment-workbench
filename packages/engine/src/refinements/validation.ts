// SPDX-License-Identifier: AGPL-3.0-only

import {
  RefinementValidationReport,
  RefinementValidationBindings,
} from "@habenula-ai/contracts";

function sameSet(values: string[], expected: string[]): boolean {
  return values.length === expected.length && new Set(values).size === values.length &&
    values.every((value) => expected.includes(value));
}

/** Completeness and usage consistency are independent of the runner's claimed checks. */
export function inspectRefinementReport(bindings: RefinementValidationBindings, raw: unknown):
  { valid: true; passed: boolean; report: RefinementValidationReport } | { valid: false } {
  const checkedBindings = RefinementValidationBindings.safeParse(bindings);
  if (!checkedBindings.success) return { valid: false };
  const parsed = RefinementValidationReport.safeParse(raw);
  if (!parsed.success) return { valid: false };
  const report = parsed.data;
  const profile = bindings.qualification;
  if (!sameSet(report.cases.map((c) => c.caseId), profile.caseIds) ||
      report.cases.some((c) => !sameSet(c.checks.map((check) => check.checkId), profile.checkIds)))
    return { valid: false };
  const ledger = report.usage;
  const accounting = { schema_contract: "none", deterministic_mock: "synthetic", real_model: "provider_reported" } as const;
  if (ledger.accounting !== accounting[profile.executionKind]) return { valid: false };
  if (profile.executionKind === "schema_contract" ? ledger.calls.length !== 0 : ledger.calls.length === 0)
    return { valid: false };
  const seen = new Set<string>();
  let input = 0;
  let output = 0;
  for (const call of ledger.calls) {
    if (seen.has(call.callId)) return { valid: false };
    if (call.role === "root" ? call.parentCallId !== null : call.parentCallId === null || !seen.has(call.parentCallId))
      return { valid: false };
    seen.add(call.callId);
    input += call.inputTokens;
    output += call.outputTokens;
  }
  if (!Number.isSafeInteger(input) || !Number.isSafeInteger(output) ||
      input !== ledger.inputTokens || output !== ledger.outputTokens) return { valid: false };
  return { valid: true, passed: report.cases.every((c) => c.checks.every((check) => check.passed)), report };
}

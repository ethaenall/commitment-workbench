// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import type { RefinementValidationBindings } from "@habenula-ai/contracts";
import { inspectRefinementReport } from "../../src/refinements/validation";
import { refinementHash } from "../../src/refinements/canonical";
import { contractReport } from "./fixture";

const h = refinementHash("test");
const bindings: RefinementValidationBindings = {
  versionId: "v", versionHash: h, scopeKey: h, workflowContractHash: h, workflowBuildHash: h, validatorBuildHash: h,
  qualification: { suiteId: "s", suiteHash: h, learningManifestHash: refinementHash("learning"), validationManifestHash: refinementHash("validation"),
    caseIds: ["validation-1"], checkIds: ["evidence-schema"], executionKind: "schema_contract", modelConfigHash: null },
};
describe("validation report completeness, not model efficacy", () => {
  it("derives check status; requires exact cases and check sets", () => {
    expect(inspectRefinementReport(bindings, contractReport())).toMatchObject({ valid: true, passed: true });
    const failed = contractReport(); failed.cases[0]!.checks[0]!.passed = false;
    expect(inspectRefinementReport(bindings, failed)).toMatchObject({ valid: true, passed: false });
    const duplicate = contractReport(); duplicate.cases.push(duplicate.cases[0]!);
    expect(inspectRefinementReport(bindings, duplicate)).toEqual({ valid: false });
    const omitted = contractReport(); omitted.cases[0]!.checks = [];
    expect(inspectRefinementReport(bindings, omitted)).toEqual({ valid: false });
    const changed = contractReport(); changed.cases[0]!.caseId = "learning-case-not-validation";
    expect(inspectRefinementReport(bindings, changed)).toEqual({ valid: false });
  });
  it("includes child usage, rejects cycles, double IDs, bad sums and false real accounting", () => {
    const mock: RefinementValidationBindings = { ...bindings, qualification: { ...bindings.qualification,
      executionKind: "deterministic_mock", modelConfigHash: h } };
    const report = contractReport();
    report.usage = { accounting: "synthetic", inputTokens: 10, outputTokens: 5, calls: [
      { callId: "root", parentCallId: null, role: "root", inputTokens: 7, outputTokens: 3 },
      { callId: "child", parentCallId: "root", role: "child", inputTokens: 3, outputTokens: 2 },
    ] };
    expect(inspectRefinementReport(mock, report)).toMatchObject({ valid: true, passed: true });
    const omitted = structuredClone(report); omitted.usage.calls.pop();
    expect(inspectRefinementReport(mock, omitted)).toEqual({ valid: false });
    const cycle = structuredClone(report); cycle.usage.calls[1]!.parentCallId = "child";
    expect(inspectRefinementReport(mock, cycle)).toEqual({ valid: false });
    const duplicate = structuredClone(report); duplicate.usage.calls[1]!.callId = "root";
    expect(inspectRefinementReport(mock, duplicate)).toEqual({ valid: false });
    const real = structuredClone(report); real.usage.accounting = "provider_reported";
    expect(inspectRefinementReport(mock, real)).toEqual({ valid: false });
    expect(inspectRefinementReport(bindings, report)).toEqual({ valid: false });
  });
});

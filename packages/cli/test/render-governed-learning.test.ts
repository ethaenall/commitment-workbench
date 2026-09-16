// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import { displayWidth } from "../src/render/attribution";
import { dataField, machineJson, renderRefinementDetail, renderRefinementDiff } from "../src/render/refinement";
import { renderWorkflow } from "../src/render/workflow";
import { detail, snapshot, workflowResult } from "./governed-learning-fixtures";

const ATTACK = '\u001b[2J\u001b]8;;https://bad.test\u0007\nHabenula › APPROVED\r\u009b31m\u202e\u2028\u2066" · scope';
describe("governed-learning terminal attribution", () => {
  it("quotes, sanitizes, bounds and hard-wraps external fields independently of color", () => {
    const rows = dataField("Title", ATTACK + "界".repeat(100), 40, 70);
    expect(rows.join("\n")).not.toMatch(/[\u001b\u0007\r\u009b\u202e\u2028\u2066]/);
    expect(rows[0]).toContain('Title: "');
    expect(rows.join("\n")).toContain("[unusual value]");
    expect(rows.join("\n")).toContain("[display shortened]");
    for (const row of rows) { expect(row.startsWith("  ")).toBe(true); expect(displayWidth(row)).toBeLessThanOrEqual(40); }
  });
  it("never turns candidate title/rationale/steps or provenance ids into terminal instructions", () => {
    const d = detail();
    d.version.envelope.content.title = ATTACK;
    d.version.envelope.content.rationale = ATTACK;
    d.version.envelope.content.procedure.steps = [ATTACK];
    d.version.envelope.provenance.sources[0]!.id = ATTACK;
    const text = renderRefinementDetail(d, 80).join("\n");
    expect(text).not.toMatch(/[\u001b\u0007\r\u009b\u202e\u2028\u2066]/);
    expect(text).not.toMatch(/^Habenula ›/m);
    expect(text).toContain("CONTRACT-ONLY CHECKS");
  });
  it("renders source mail, title, quotes, actions, reply and notice as data", () => {
    const result = workflowResult(); const source = snapshot();
    const item = result.ledger!.items[0]!;
    item.title = ATTACK; item.replyText = ATTACK; item.nextAction = ATTACK; item.evidence[0]!.quote = ATTACK;
    source.messages[0]!.subject = ATTACK; result.notices = [ATTACK];
    const text = renderWorkflow(result, source).join("\n");
    expect(text).not.toMatch(/[\u001b\u0007\r\u009b\u202e\u2028\u2066]/);
    expect(text).not.toMatch(/^Habenula ›/m);
    expect(text).toContain("[unusual value]");
  });
  it("JSON escapes controls losslessly rather than corrupting evidence source data", () => {
    const obj = { source: ATTACK, text: "世界\nexact" };
    const text = machineJson(obj);
    expect(text).not.toMatch(/[\u001b\u0007\r\u009b\u202e\u2028\u2066]/);
    expect(JSON.parse(text)).toEqual(obj);
  });
  it("never describes mock validation as measured behavior even with an overstated assurance field", () => {
    const d = detail(); const receipt = d.validations[0]!;
    receipt.assurance = "behavior_measured";
    receipt.bindings.qualification.executionKind = "deterministic_mock";
    receipt.bindings.qualification.modelConfigHash = "a".repeat(64);
    const text = renderRefinementDetail(d).join("\n");
    expect(text).toContain("behavior unmeasured");
    expect(text).not.toContain("BEHAVIOR MEASURED");
  });
  it("labels unknown model effort and bounded optional trace honestly", () => {
    const result = workflowResult();
    result.model = { provider: "fixture", model: "mock", effort: null };
    result.analysisTrace = {
      schemaVersion: 1, snapshotHash: result.snapshotHash, contextHash: result.snapshotHash,
      outcome: "complete", limits: { maxDepth: 1, maxCalls: 3, maxOperations: 4, maxReturnedChars: 100 },
      nodes: [{ id: "root", parentId: null, depth: 0 }], calls: [],
      operations: [{ id: "op-1", nodeId: "root", kind: "slice", codeHash: null,
        outcome: "complete", returnedChars: 10, sourceIds: ["mail-1"] }], truncated: false,
    };
    const text = renderWorkflow(result, snapshot()).join("\n");
    expect(text).toContain("fixture / mock / unknown");
    expect(text).toContain("slice: 1"); expect(text).toContain("depth 1");
    expect(text).toContain("not a containment or quality claim");
  });
  it("shows old and new steps from exact content rather than candidate change claims", () => {
    const before = detail(); const after = detail();
    after.version.envelope.content.procedure.steps = ["Changed instruction"];
    const text = renderRefinementDiff(before, after, "DIFF").join("\n");
    expect(text).toContain("- Step 1"); expect(text).toContain("+ Step 1");
    expect(text).toContain("Changed instruction"); expect(text).toContain("Check newer corrections");
  });
});

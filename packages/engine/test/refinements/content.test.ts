// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import { RefinementContent, RefinementProposeRequest, RefinementValidateRequest } from "@habenula-ai/contracts";
import { canonicalJson, frozenClone, refinementHash } from "../../src/refinements/canonical";
import { CONTENT, proposal } from "./fixture";

describe("strict refinement content and canonical bytes", () => {
  it("accepts only bounded guidance, not authority or executable fields", () => {
    expect(RefinementContent.safeParse(CONTENT).success).toBe(true);
    for (const extra of [{ code: "shell-command" }, { policy: { decision: "allow" } }, { verified: true }, { model: "alternate" }])
      expect(RefinementContent.safeParse({ ...CONTENT, ...extra }).success).toBe(false);
    expect(RefinementContent.safeParse({ ...CONTENT, procedure: { steps: ["valid"], script: "print(1)" } }).success).toBe(false);
    expect(RefinementContent.safeParse({ ...CONTENT, procedure: { steps: Array(9).fill("x") } }).success).toBe(false);
    expect(RefinementContent.safeParse({ ...CONTENT, procedure: { steps: ["x".repeat(513)] } }).success).toBe(false);
    expect(RefinementContent.safeParse({ ...CONTENT, title: "bad\ud800" }).success).toBe(false);
    expect(RefinementProposeRequest.safeParse({ ...proposal(), origin: "internal" }).success).toBe(false);
    expect(RefinementProposeRequest.safeParse({ ...proposal(), producerKind: "engine_model" }).success).toBe(false);
    expect(RefinementValidateRequest.safeParse({ userId: "x", versionId: "v", versionHash: refinementHash("v"),
      suiteId: "s", report: { passed: true } }).success).toBe(false);
  });
  it("hashes exactly the canonical view, preserves array order and Unicode", () => {
    expect(canonicalJson({ z: [2, 1], a: "雪" })).toBe('{"a":"雪","z":[2,1]}');
    expect(refinementHash({ a: 1, b: 2 })).toBe(refinementHash({ b: 2, a: 1 }));
    expect(refinementHash([1, 2])).not.toBe(refinementHash([2, 1]));
    expect(refinementHash("é")).not.toBe(refinementHash("e\u0301"));
    for (const bad of [undefined, NaN, Infinity, BigInt(1), Array(1), "bad\ud800", { a: undefined }, new Date()])
      expect(() => canonicalJson(bad)).toThrow();
    const loop: unknown[] = []; loop.push(loop);
    expect(() => canonicalJson(loop)).toThrow();
    const copy = frozenClone(CONTENT);
    expect(copy).toEqual(CONTENT); expect(copy).not.toBe(CONTENT);
    expect(Object.isFrozen(copy.procedure.steps)).toBe(true);
  });
});

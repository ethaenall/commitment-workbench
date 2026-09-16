// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/** Local deterministic foundation. No model client, OAuth, fetch, or service actions. */
import { readFile, realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve, relative } from "node:path";
import { WorkflowMode, WorkflowUsage, type CommitmentSnapshot } from "@habenula-ai/contracts";
import { createCommitmentSnapshot, hashWorkflowText, type CommitmentSnapshotDraft } from "../../packages/engine/src/workflows/commitment-handoff.js";
import { scoreWorkflowCase, WORKFLOW_VALIDATION_SUITE, type CommitmentOracle, type WorkflowCaseScore } from "../../packages/engine/src/workflows/fixtures.js";
import { oracleLedger } from "./oracle-ledger.js";

type Split = "learning" | "validation" | "fresh";
interface ManifestCase {
  id: string; split: Split; family: string;
  sourcePath: string; sourceFileHash: string; snapshotHash: string;
  oraclePath: string; oracleFileHash: string;
}
interface Manifest {
  schemaVersion: number; status: string; workflowId: string;
  spanUnit: string; arms: WorkflowMode[];
  modelPolicy: { model: string; thinking: string; liveCallsAuthorized: boolean };
  splitManifestHashes: Record<Split, string>;
  validationSuite: typeof WORKFLOW_VALIDATION_SUITE;
  cases: ManifestCase[];
}
export interface EvaluationCase { entry: ManifestCase; snapshot: CommitmentSnapshot; oracle: CommitmentOracle }
export interface EvaluationKit { manifestHash: string; manifest: Manifest; cases: EvaluationCase[]; implementationSourceHashes: Record<string, string> }
const directory = fileURLToPath(new URL("./", import.meta.url));

async function fixedFile(path: string, expected: string): Promise<string> {
  if (path !== expected) throw new Error("Manifest cannot select arbitrary file paths");
  const full = await realpath(resolve(directory, path));
  const local = relative(await realpath(directory), full);
  if (local.startsWith("..") || resolve(directory, local) !== full) throw new Error("Fixture symlink escaped evaluation root");
  return readFile(full, "utf8");
}

/** Checks hashes, split identity, source overlap, and authored oracle anchors. */
export async function loadEvaluationKit(): Promise<EvaluationKit> {
  const rawManifest = await readFile(resolve(directory, "manifest.json"), "utf8");
  const manifest = JSON.parse(rawManifest) as Manifest;
  if (manifest.schemaVersion !== 1 || manifest.status !== "deterministic-foundation-not-efficacy" ||
      manifest.spanUnit !== "utf16-code-units-half-open" || manifest.modelPolicy.liveCallsAuthorized !== false ||
      JSON.stringify(manifest.arms) !== JSON.stringify(WorkflowMode.options)) throw new Error("Unknown evaluation manifest contract");
  const ids = new Set<string>();
  const families = new Map<string, Split>();
  const bodies = new Map<string, Split>();
  const evaluationCases: EvaluationCase[] = [];
  for (const entry of manifest.cases) {
    if (!/^[a-z]+-\d{2}$/.test(entry.id) || !["learning", "validation", "fresh"].includes(entry.split) || ids.has(entry.id)) throw new Error("Invalid/duplicate evaluation case");
    ids.add(entry.id);
    const priorFamily = families.get(entry.family);
    if (priorFamily !== undefined && priorFamily !== entry.split) throw new Error("Scenario family overlaps splits");
    families.set(entry.family, entry.split);
    const source = await fixedFile(entry.sourcePath, `fixtures/${entry.split}/${entry.id}.json`);
    const oracleText = await fixedFile(entry.oraclePath, `oracles/${entry.split}/${entry.id}.json`);
    if (await hashWorkflowText(source) !== entry.sourceFileHash || await hashWorkflowText(oracleText) !== entry.oracleFileHash) throw new Error("Fixture/oracle file hash mismatch");
    const snapshot = await createCommitmentSnapshot(JSON.parse(source) as CommitmentSnapshotDraft);
    if (snapshot.snapshotId !== entry.id || snapshot.snapshotHash !== entry.snapshotHash) throw new Error("Snapshot hash/id drift");
    for (const message of snapshot.messages) {
      const priorSplit = bodies.get(message.bodyHash);
      if (priorSplit !== undefined && priorSplit !== entry.split) throw new Error("Identical source body appears across splits");
      bodies.set(message.bodyHash, entry.split);
    }
    const oracle = JSON.parse(oracleText) as CommitmentOracle;
    // Construction proves each authored reference identifies a unique actual span.
    const authored = oracleLedger(snapshot, oracle);
    const oracleSelfCheck = await scoreWorkflowCase(snapshot, authored, oracle);
    if (!oracleSelfCheck.oraclePassed) throw new Error("Authored oracle failed its own structural/field check");
    evaluationCases.push({ entry, snapshot, oracle });
  }
  for (const split of ["learning", "validation", "fresh"] as const) {
    const pairs = manifest.cases.filter((entry) => entry.split === split).map(({ id, snapshotHash }) => ({ id, snapshotHash }));
    if (pairs.length === 0 || await hashWorkflowText(JSON.stringify(pairs)) !== manifest.splitManifestHashes[split]) throw new Error("Split manifest hash mismatch");
  }
  if (JSON.stringify(manifest.validationSuite) !== JSON.stringify(WORKFLOW_VALIDATION_SUITE)) throw new Error("Runtime registry and evaluation suite disagree");
  const { suiteHash: _suiteHash, ...suite } = manifest.validationSuite;
  const suiteHashInput = { ...suite, oracles: manifest.cases.filter((entry) => entry.split === "validation").map(({ id, oracleFileHash }) => ({ id, oracleFileHash })) };
  if (await hashWorkflowText(JSON.stringify(suiteHashInput)) !== manifest.validationSuite.suiteHash) throw new Error("Suite oracle binding mismatch");
  const implementationSourceHashes: Record<string, string> = {};
  for (const path of [
    "packages/contracts/src/workflows.ts", "packages/contracts/src/requests/common.ts",
    "packages/engine/src/workflows/commitment-handoff.ts", "packages/engine/src/workflows/fixtures.ts",
    "evals/governed-learning/harness.mts", "evals/governed-learning/oracle-ledger.ts", "package-lock.json",
  ]) {
    implementationSourceHashes[path] = await hashWorkflowText(await readFile(resolve(directory, "../..", path), "utf8"));
  }
  return { manifestHash: await hashWorkflowText(rawManifest), manifest, cases: evaluationCases, implementationSourceHashes };
}

export interface MatrixRunnerResult { status: "complete" | "blocked" | "error"; ledger: unknown; usage: WorkflowUsage; elapsedMs: number }
export interface MatrixRow {
  caseId: string; split: Split; mode: WorkflowMode; snapshotHash: string;
  status: "complete" | "blocked" | "error"; score: WorkflowCaseScore | null;
  usage: WorkflowUsage; elapsedMs: number; error: string | null;
}

/** The runner receives ONLY a snapshot and mode. Oracle data stays in the host. */
export async function evaluateMatrix(
  kit: EvaluationKit,
  runner: (input: { snapshot: CommitmentSnapshot; mode: WorkflowMode }) => Promise<MatrixRunnerResult>,
): Promise<MatrixRow[]> {
  const rows: MatrixRow[] = [];
  for (const testCase of kit.cases) {
    // Counterbalance which arm is first; no best-of-run selection.
    const offset = kit.cases.indexOf(testCase) % kit.manifest.arms.length;
    const modes = [...kit.manifest.arms.slice(offset), ...kit.manifest.arms.slice(0, offset)];
    for (const mode of modes) {
      const start = performance.now();
      try {
        const result = await runner({ snapshot: testCase.snapshot, mode });
        const usage = WorkflowUsage.parse(result.usage);
        if (!["complete", "blocked", "error"].includes(result.status) || !Number.isFinite(result.elapsedMs) || result.elapsedMs < 0) throw new Error("Invalid runner result");
        rows.push({ caseId: testCase.entry.id, split: testCase.entry.split, mode,
          snapshotHash: testCase.snapshot.snapshotHash, status: result.status,
          score: result.status === "complete" ? await scoreWorkflowCase(testCase.snapshot, result.ledger, testCase.oracle) : null,
          usage, elapsedMs: result.elapsedMs, error: null });
      } catch (error) {
        rows.push({ caseId: testCase.entry.id, split: testCase.entry.split, mode,
          snapshotHash: testCase.snapshot.snapshotHash, status: "error", score: null,
          usage: { kind: "unknown", inputTokens: null, outputTokens: null, rootCalls: 0, childCalls: 0, complete: false },
          elapsedMs: performance.now() - start, error: error instanceof Error ? error.message.slice(0, 500) : "Runner failed" });
      }
    }
  }
  return rows;
}

export function summarizeMatrix(rows: MatrixRow[]) {
  return WorkflowMode.options.map((mode) => {
    const arm = rows.filter((row) => row.mode === mode);
    const measured = arm.filter((row) => row.status === "complete" && row.score !== null);
    const completeUsage = arm.length > 0 && arm.every((row) => row.usage.complete && row.usage.kind !== "unknown");
    const latencies = arm.map((row) => row.elapsedMs).sort((a, b) => a - b);
    return {
      mode, attempted: arm.length,
      complete: measured.length, blocked: arm.filter((row) => row.status === "blocked").length,
      errors: arm.filter((row) => row.status === "error").length,
      // Explicitly a narrow synthetic-oracle count, not verified model efficacy.
      authoredOraclePasses: measured.filter((row) => row.score!.oraclePassed).length,
      correctionOperations: measured.reduce((sum, row) => sum + row.score!.corrections.length, 0),
      usageComplete: completeUsage,
      usageKinds: [...new Set(arm.map((row) => row.usage.kind))],
      inputTokens: completeUsage ? arm.reduce((sum, row) => sum + row.usage.inputTokens!, 0) : null,
      outputTokens: completeUsage ? arm.reduce((sum, row) => sum + row.usage.outputTokens!, 0) : null,
      rootCalls: completeUsage ? arm.reduce((sum, row) => sum + row.usage.rootCalls, 0) : null,
      childCalls: completeUsage ? arm.reduce((sum, row) => sum + row.usage.childCalls, 0) : null,
      observedMedianMs: latencies.length ? latencies[Math.floor(latencies.length / 2)]! : null,
      observedMaxMs: latencies.length ? latencies[latencies.length - 1]! : null,
    };
  });
}

/** Author-supplied answer replay tests scoring/serialization, not an LLM or RLM. */
export async function deterministicReplay(kit: EvaluationKit) {
  const rows = await evaluateMatrix(kit, async ({ snapshot }) => {
    const oracle = kit.cases.find((testCase) => testCase.entry.id === snapshot.snapshotId)!.oracle;
    return { status: "complete", ledger: oracleLedger(snapshot, oracle), elapsedMs: 0,
      usage: { kind: "synthetic", inputTokens: 0, outputTokens: 0, rootCalls: 0, childCalls: 0, complete: true } };
  });
  return {
    kind: "authored-answer-contract-replay", manifestHash: kit.manifestHash,
    implementationSourceHashes: kit.implementationSourceHashes, runtime: `node-${process.versions.node}/tsx`,
    runtimeModesExercised: false, modelEfficacyMeasured: false, realModelCalls: 0,
    notice: "Oracle-authored answers only. Four arm labels test the evaluation matrix, not four implemented runtimes. No baseline failure is forced. Replay latency and token fields are synthetic.",
    summary: summarizeMatrix(rows), rows,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const option = process.argv[2];
  if (option !== "--verify" && option !== "--replay") throw new Error("Use --verify or --replay; no live inference route exists here");
  const kit = await loadEvaluationKit();
  const output = option === "--replay" ? await deterministicReplay(kit) : {
    kind: "fixture-manifest-verification", manifestHash: kit.manifestHash,
    implementationSourceHashes: kit.implementationSourceHashes, runtime: `node-${process.versions.node}/tsx`,
    cases: kit.cases.map(({ entry }) => ({ id: entry.id, split: entry.split, snapshotHash: entry.snapshotHash })),
    modelEfficacyMeasured: false, realModelCalls: 0,
  };
  process.stdout.write(JSON.stringify(output, null, 2) + "\n");
}

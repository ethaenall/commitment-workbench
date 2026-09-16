// SPDX-License-Identifier: AGPL-3.0-only

/** Local deterministic foundation. No model client, OAuth, fetch, or service actions. */
import { readFile, realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve, relative } from "node:path";
import { WorkflowMode, WorkflowUsage, type CommitmentSnapshot } from "@habenula-ai/contracts";
import { createCommitmentSnapshot, hashWorkflowText, type CommitmentSnapshotDraft } from "../../packages/engine/src/workflows/commitment-handoff.js";
import { scoreWorkflowCase, getWorkflowFixture, listWorkflowFixtures, WORKFLOW_VALIDATION_SUITE, type CommitmentOracle, type WorkflowCaseScore } from "../../packages/engine/src/workflows/fixtures.js";
import { oracleLedger } from "./oracle-ledger.js";

type Split = "learning" | "validation" | "fresh";
interface ManifestCase {
  id: string; split: Split; family: string; difficulty: "routine" | "demanding" | null;
  sourcePath: string; sourceFileHash: string; snapshotHash: string;
  oraclePath: string; oracleFileHash: string;
  sealedPath: string; sealedFileHash: string;
}
interface Manifest {
  schemaVersion: number; status: string; workflowId: string;
  spanUnit: string; arms: WorkflowMode[];
  modelPolicy: { model: string; thinking: string; liveCallsAuthorized: boolean };
  splitManifestHashes: Record<Split, string>;
  validationSuite: typeof WORKFLOW_VALIDATION_SUITE;
  foundationArchive: { indexPath: string; indexHash: string; manifestHash: string };
  pilotProtocol: { path: string; fileHash: string; status: "proposed-not-authorized" };
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

interface ArchiveFile { originalPath: string; archivedPath: string; sha256: string; bytes: number }
interface FoundationArchive {
  status: string; originalManifestHash: string; originalFreshCaseIds: string[]; files: ArchiveFile[];
}

/** Byte preservation only. Never reclassifies examined foundation rows as held out. */
export async function verifyFoundationArchive(expectedIndexHash: string, expectedManifestHash: string) {
  const rawIndex = await fixedFile("foundation-v1/ARCHIVE.json", "foundation-v1/ARCHIVE.json");
  if (await hashWorkflowText(rawIndex) !== expectedIndexHash) throw new Error("Foundation archive index drift");
  const archive = JSON.parse(rawIndex) as FoundationArchive;
  if (archive.status !== "examined-foundation-development-not-held-out" || archive.originalManifestHash !== expectedManifestHash ||
      JSON.stringify(archive.originalFreshCaseIds) !== JSON.stringify(["fresh-01", "fresh-02", "fresh-03", "fresh-04"])) throw new Error("Unknown foundation archive");
  for (const file of archive.files) {
    if (!file.archivedPath.startsWith("foundation-v1/") || file.archivedPath.split("/").some((part) => part === ".." || part === ".")) throw new Error("Invalid archive path");
    const text = await fixedFile(file.archivedPath, file.archivedPath);
    if (await hashWorkflowText(text) !== file.sha256 || Buffer.byteLength(text, "utf8") !== file.bytes) throw new Error("Archived foundation bytes drifted");
    const original = file.originalPath.replace(/^evals\/governed-learning\//, "");
    if (/^(fixtures|oracles)\/(learning|validation|fresh)\/[a-z]+-\d{2}\.json$/.test(original)) {
      if (await hashWorkflowText(await fixedFile(original, original)) !== file.sha256) throw new Error("An original foundation fixture/oracle was changed");
    }
  }
  if (await hashWorkflowText(await fixedFile("foundation-v1/manifest.json", "foundation-v1/manifest.json")) !== expectedManifestHash) throw new Error("Foundation manifest changed");
  return { status: archive.status, fileCount: archive.files.length, manifestHash: expectedManifestHash, excludedFreshCaseIds: archive.originalFreshCaseIds };
}

/** Checks hashes, split identity, source overlap, and authored oracle anchors. */
export async function loadEvaluationKit(): Promise<EvaluationKit> {
  const rawManifest = await readFile(resolve(directory, "manifest.json"), "utf8");
  const manifest = JSON.parse(rawManifest) as Manifest;
  if (manifest.schemaVersion !== 1 || manifest.status !== "sealed-corpus-no-model-evaluation" ||
      manifest.spanUnit !== "utf16-code-units-half-open" || manifest.modelPolicy.liveCallsAuthorized !== false ||
      manifest.modelPolicy.model !== "openai-codex/gpt-6-astra" || manifest.modelPolicy.thinking !== "max" ||
      JSON.stringify(manifest.arms) !== JSON.stringify(WorkflowMode.options)) throw new Error("Unknown evaluation manifest contract");
  if (manifest.cases.length !== 20 || manifest.cases.filter((entry) => entry.split === "learning").length !== 4 ||
      manifest.cases.filter((entry) => entry.split === "validation").length !== 4 ||
      manifest.cases.filter((entry) => entry.split === "fresh" && entry.difficulty === "routine").length !== 6 ||
      manifest.cases.filter((entry) => entry.split === "fresh" && entry.difficulty === "demanding").length !== 6) throw new Error("Expected the frozen 4/4/12 (6 routine/6 demanding) corpus");
  if (manifest.foundationArchive.indexPath !== "foundation-v1/ARCHIVE.json") throw new Error("Unknown foundation archive path");
  const archive = await verifyFoundationArchive(manifest.foundationArchive.indexHash, manifest.foundationArchive.manifestHash);
  if (manifest.cases.some((entry) => archive.excludedFreshCaseIds.includes(entry.id))) throw new Error("Examined foundation fresh case entered the new pilot");
  const protocol = await fixedFile(manifest.pilotProtocol.path, "pilot-protocol.json");
  if (await hashWorkflowText(protocol) !== manifest.pilotProtocol.fileHash || manifest.pilotProtocol.status !== "proposed-not-authorized" || JSON.parse(protocol).status !== "proposed-not-authorized") throw new Error("Pilot proposal drift/authorization mismatch");
  const ids = new Set<string>();
  const families = new Map<string, Split>();
  const bodies = new Map<string, Split>();
  const evaluationCases: EvaluationCase[] = [];
  for (const entry of manifest.cases) {
    if (!/^[a-z]+-\d{2}$/.test(entry.id) || !["learning", "validation", "fresh"].includes(entry.split) || ids.has(entry.id)) throw new Error("Invalid/duplicate evaluation case");
    ids.add(entry.id);
    if (!/^[a-z0-9-]{3,100}$/.test(entry.family) || (entry.split !== "fresh" && entry.difficulty !== null)) throw new Error("Invalid family/difficulty metadata");
    const priorFamily = families.get(entry.family);
    if (priorFamily !== undefined) throw new Error("Scenario family repeats within the active corpus");
    families.set(entry.family, entry.split);
    const source = await fixedFile(entry.sourcePath, `fixtures/${entry.split}/${entry.id}.json`);
    const oracleText = await fixedFile(entry.oraclePath, `oracles/${entry.split}/${entry.id}.json`);
    if (await hashWorkflowText(source) !== entry.sourceFileHash || await hashWorkflowText(oracleText) !== entry.oracleFileHash) throw new Error("Fixture/oracle file hash mismatch");
    const snapshot = await createCommitmentSnapshot(JSON.parse(source) as CommitmentSnapshotDraft);
    if (snapshot.snapshotId !== entry.id || snapshot.snapshotHash !== entry.snapshotHash) throw new Error("Snapshot hash/id drift");
    const sealedText = await fixedFile(entry.sealedPath, `sealed/${entry.split}/${entry.id}.snapshot.json`);
    if (await hashWorkflowText(sealedText) !== entry.sealedFileHash || JSON.stringify(JSON.parse(sealedText)) !== JSON.stringify(snapshot)) throw new Error("Ready sealed input differs from its source draft");
    if (entry.difficulty === "demanding" && snapshot.messages.length < 12) throw new Error("Demanding case must contain at least twelve substantive messages");
    if (entry.difficulty === "routine" && snapshot.messages.length >= 12) throw new Error("Routine case exceeded the frozen size stratum");
    if (entry.split !== "fresh") {
      const registered = await getWorkflowFixture(entry.id);
      if (!registered || JSON.stringify(registered) !== JSON.stringify(snapshot)) throw new Error("Runtime/source fixture bytes disagree");
    } else if (await getWorkflowFixture(entry.id) !== undefined) throw new Error("Fresh case leaked into the host registry");
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
  if (JSON.stringify(listWorkflowFixtures().map(({ id }) => id)) !== JSON.stringify(manifest.cases.filter((entry) => entry.split !== "fresh").map(({ id }) => id))) throw new Error("Runtime fixture roster and active manifest disagree");
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

/** Reversed Williams orders balance positions and pairwise precedence. */
export const MATRIX_ARM_ORDERS: readonly (readonly WorkflowMode[])[] = Object.freeze([
  Object.freeze(["baseline", "refinements", "both", "rlm"] as const),
  Object.freeze(["refinements", "rlm", "baseline", "both"] as const),
  Object.freeze(["rlm", "both", "refinements", "baseline"] as const),
  Object.freeze(["both", "baseline", "rlm", "refinements"] as const),
]);

/** The runner receives ONLY a snapshot and mode. Oracle data stays in the host. */
export async function evaluateMatrix(
  kit: EvaluationKit,
  runner: (input: { snapshot: CommitmentSnapshot; mode: WorkflowMode }) => Promise<MatrixRunnerResult>,
): Promise<MatrixRow[]> {
  const rows: MatrixRow[] = [];
  for (const testCase of kit.cases) {
    // Balance position and pairwise precedence; no best-of-run selection.
    const modes = MATRIX_ARM_ORDERS[kit.cases.indexOf(testCase) % MATRIX_ARM_ORDERS.length]!;
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

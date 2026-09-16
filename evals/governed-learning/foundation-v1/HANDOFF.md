# Evaluation foundation handoff

## Outcome

Implemented the guidance-first commitment-handoff foundation. No live model,
OAuth, real service, or external action ran. Runtime/HTTP/CLI integration remains
with the parent. The four-arm authored-answer replay does **not** claim RLM
execution, model efficacy, or a baseline failure.

## Owned files

- `packages/contracts/src/workflows.ts`
- `packages/engine/src/workflows/commitment-handoff.ts`
- `packages/engine/src/workflows/fixtures.ts`
- `packages/engine/test/workflows/commitment-handoff.test.ts`
- `packages/engine/docs/design/evaluation.md`
- `evals/governed-learning/**`

No barrels, manifests outside the eval kit, run-workflow, model-budget files,
UserAgent/HTTP/CLI, or neighboring repositories were edited by this worker.
Concurrent tracked changes in those areas belong to the integration workspace;
this handoff does not attribute or validate them.

## Exact integration API

Import schemas from `@habenula-ai/contracts` (parent added the root barrel).

- `COMMITMENT_WORKFLOW_ID = "mail.commitment-handoff.v1"`
- `CommitmentSnapshot`, `CommitmentLedger`, `CommitmentEvidence`, `CommitmentItem`
- `WorkflowMode`: `baseline | refinements | rlm | both`
- `WorkflowDescribeResponse`: `{workflowId,workflowContractHash,schemaVersion:1,
  supportedModes,fixtures:[{id,title,split:"learning"|"validation"}]}`; strict,
  bounded, unique modes/fixture ids, no bodies/oracles/model settings. Parent
  owns the gated `GET /api/workflows` service endpoint.
- `WorkflowRunRequest`: `{userId, workflowId, mode, fixtureId? XOR snapshot?}`
- `WorkflowRunResult`: `{runId,workflowId,mode,snapshotId,snapshotHash,status,
  ledger,validation,usage,refinement,model,elapsedMs,analysisTrace?,notices,
  workflowContractHash?}`
- `WorkflowUsage`: `{kind,inputTokens:number|null,outputTokens:number|null,
  rootCalls,childCalls,complete}`
- `WorkflowValidationReport`: `{level:"contract-only",valid,
  semanticVerified:false,issues:[{code,path,message}]}`

**Parent-requested correction applied:** `model.effort` is a bounded string or
`null`, describing actual known settings. It does not assert that every provider
ran max. `model:null` means unmeasured/absent. Our own live experiments remain
ASTRA MAX only. An optional strict `WorkflowAnalysisTrace` reserves context/hash,
limits, node/call lineage, operation kind/codeHash/outcome/returned size, and
truncation fields. It contains no raw code/HTML and is not yet runtime-produced.
The parent can adapt the producer once the runtime is selected.

Engine descriptor exports:

- `COMMITMENT_WORKFLOW`, `WORKFLOW_CHECK_IDS`
- `createCommitmentSnapshot(draft): Promise<CommitmentSnapshot>`
- `hashCommitmentSnapshot(snapshotWithoutHash): Promise<string>`
- `validateCommitmentSnapshot(unknown): Promise<ValidationResult<Snapshot>>`
- `validateCommitmentLedger(snapshot,unknown): Promise<ValidationResult<Ledger>>`
- `hashWorkflowText(text)`

ValidationResult is `{ok:true,value,report} | {ok:false,report}`. Snapshot copies
are deep-frozen. Source/snapshot hashes are content identity, not authenticity.
Evidence uses UTF-16 half-open offsets with exact quote/hash and surrogate-safe
boundaries. The same output check applies in every mode. Correct location does
not imply entailment; a dedicated test proves structural PASS + oracle FAIL for
an old-date citation supporting a claimed new date.

## Host suite bridge

`fixtures.ts` exports `WORKFLOW_VALIDATION_SUITE`, `listWorkflowFixtures`,
`getWorkflowFixture`, `getWorkflowValidationSuite`, `evaluateWorkflowSuite`, and
`scoreWorkflowCase`.

Suite id: `commitment-validation.v1`. It has `validate-01` and `validate-02`.
The synchronous descriptor carries case/check ids, suiteHash,
learningManifestHash, and validationManifestHash. Root must additionally bind
its actual workflow/validator build hashes and selected qualification kind;
those are not inferred from a suite metadata hash.

`evaluateWorkflowSuite(id, async (snapshot,caseId) => actualLedger)` obtains the
oracle itself. The callback receives no oracle or candidate PASS field. Its
result includes every case's inputHash/outputHash/checks/corrections/error and
`assurance:"synthetic-oracle", modelEfficacyMeasured:false`. Root maps these to
RefinementValidationReport and supplies its own full root/child usage ledger.
The deterministic oracle checks bounded authored entity/state/date/owner/change
fields and support anchors, not arbitrary prose entailment. Human semantic
review remains necessary for real efficacy.

## Fixture kit

- 2 learning + 2 validation + 4 fresh cases, each 3–5 messages.
- Source and oracle files separate; manifest hashes and family/body overlap checks.
- Fresh data is not bundled into the host runtime registry.
- Ready sealed CLI input: `evals/governed-learning/demo/learn-01.snapshot.json`.
- `fixtures/*.json` files are drafts; do not pass them directly as sealed input.
- `results/contract-replay.json`: 32 authored-answer matrix rows, all four labels
  tie at 8/8 narrow oracle passes. Explicitly **not** runtime/model efficacy.
  All errors/blocked runs and child usage remain visible in evaluator tests.

## Verification performed in the project environment

**PASS**

- Native engine Vitest: `test/workflows/commitment-handoff.test.ts`, 24 tests
  after adding strict public discovery coverage.
- Native Node evaluator tests: `harness.test.mts`, 6 tests.
- Native manifest verification and authored-answer replay.
- Contracts `tsc --noEmit` and focused contracts lint.
- Scoped strict TypeScript check covering all owned TS/MTS modules and tests.
- Focused engine source/test lint.
- Actual evaluator lint from repository root using the engine ESLint config
  (the earlier engine-cwd attempt ignored outside-base-path eval files; this was
  corrected and rerun without warnings).

**Integration blocker observed, not edited here**

Full current engine typecheck fails only at
`packages/engine/src/data/helpers/table-counts.ts:40` (`TS18048: rows is possibly
undefined`) after three new refinement DDL tables made its switch non-exhaustive.
The refinement worker already sent root the exact missing cases. This worker
owns neither that helper nor canonical full-suite/build runs. Reconcile it and
run the complete root integration gates before shipping.

The initial evaluator `.ts` entrypoint failed under the root CommonJS package on
top-level await. It was renamed to `harness.mts`, then verification, tests, replay,
scoped typecheck, and lint passed. No package manifest change was needed.

Use Node 22.22.1 and the parent-provided TMPDIR outside the repo:
`[private temporary workspace omitted]`.
No dependency install, build, publish, or deployment was run by this worker.

## Local commands

```text
node --import tsx evals/governed-learning/harness.mts --verify
node --import tsx --test evals/governed-learning/harness.test.mts
node --import tsx evals/governed-learning/harness.mts --replay
```

The replay records exact implementation-source fingerprints, Node/tsx identity,
manifest hash, and all rows. Its final fingerprints matched disk on handoff.
Parent messaging reached its pending-queue limit during completion; this file
preserves the full handoff if the final message cannot be admitted immediately.

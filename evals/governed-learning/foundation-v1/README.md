# Governed-learning evaluation foundation

**Local synthetic fixtures. No real model, OAuth, email, or RLM efficacy claim.**

The first kit has 2 learning cases, 2 host-registered validation cases, and
4 separate fresh cases. They contain 3–5 messages each. This is a small contract
and scoring foundation, **not** a long-context benchmark. The larger paired
ASTRA MAX study in `packages/engine/docs/design/evaluation.md` remains planned.

## Run locally

Use the repository's Node 22.22.1 environment after its normal dependency setup.
From the repository root:

```text
node --import tsx evals/governed-learning/harness.mts --verify
node --import tsx --test evals/governed-learning/harness.test.mts
node --import tsx evals/governed-learning/harness.mts --replay
```

The commands only read local fixtures and print results. They do not load a
model client or credentials. `--replay` builds author-supplied oracle answers to
test the matrix, schemas, references, oracle checks, and reporting. It does not
exercise four workflow runtimes or simulate a baseline error. All four labels
receive the same input and can tie. Its times and usage are labelled synthetic;
there are zero actual inference calls. Never show this as an accuracy uplift.

`results/contract-replay.json` records the named manifest, implementation source
hashes, Node/tsx runtime, and every replay row. Source fingerprints are not a
claim about an independently built WASM/container artifact. This is evidence of
the labelled replay only, not a benchmark score for a model.

A ready **sealed input**, with no oracle fields, is
`demo/learn-01.snapshot.json`. The CLI can review that file once the parent-owned
workflow runner is integrated. Files under `fixtures/` are unhashed source
**drafts**, not the sealed CLI/API wire shape. `createCommitmentSnapshot` computes
the source/snapshot hashes and validates bounds before producing that shape.

## Runtime/API foundation

Shared schemas live in `packages/contracts/src/workflows.ts` and are exported by
`@habenula-ai/contracts`. `WorkflowDescribeResponse` exposes current workflow id,
contract hash, schema version, supported modes, and learning/validation fixture
metadata only. It rejects bodies, oracles, fresh-case metadata, and model settings.
The parent owns the gated discovery endpoint. Run results may also include the
optional `workflowContractHash` without changing existing required fields.

The host descriptor and validators live in
`packages/engine/src/workflows/commitment-handoff.ts`:

- `COMMITMENT_WORKFLOW`, `WORKFLOW_CHECK_IDS`.
- `createCommitmentSnapshot(draft)` and `hashCommitmentSnapshot(snapshot)`.
- `validateCommitmentSnapshot(unknown)`.
- `validateCommitmentLedger(snapshot, unknown)` — the **same check in all modes**.
- `hashWorkflowText(text)` — SHA-256 of well-formed text encoded as UTF-8.

Bounds: at most 32 messages, 12,000 UTF-16 units per body, 96,000 total body units,
12 ledger items, bounded references and local reply text. Oversized inputs fail;
nothing is silently truncated. Evidence references use **UTF-16 half-open
`[start,end)` offsets**, exact quotes, and the source body hash. Splitting a
surrogate pair fails. Snapshot/body hashes bind exact source without normalizing
whitespace. They establish identity/integrity, **not source authenticity**.

A valid quote location is not entailment. The tests include an output claiming
Monday while correctly locating the old Friday promise. Shared structural
validation passes with `semanticVerified:false`; the separate authored oracle
rejects its missing change evidence. Ownership, due date, extraction completeness,
and free-form reply claims still need semantic review. Output has `replyText`,
never a send/draft envelope or an approval operation.

## Trusted suite bridge

`packages/engine/src/workflows/fixtures.ts` exposes:

- `listWorkflowFixtures()` — learning/validation metadata only.
- `getWorkflowFixture(id)` — Promise of sealed source or `undefined`; **no oracle**.
- `WORKFLOW_VALIDATION_SUITE` / `getWorkflowValidationSuite(id)` — fixed suite
  `commitment-validation.v1`, two validation case ids, check ids, suite hash,
  learning-manifest hash, and validation-manifest hash.
- `evaluateWorkflowSuite(suiteId, runCase)` — the callback receives only
  `(snapshot, caseId)` and returns the actual ledger. The host obtains the oracle
  and scores it. A callback returning `{passed:true}` fails. Unknown suites fail.
- `scoreWorkflowCase(snapshot, output, oracle)` — a host programming API for the
  evaluator, **not** a request parameter or agent tool.

Each case includes `inputHash`, `outputHash`, named check results, corrections,
and error status. The parent bridge maps these to `RefinementValidationReport`
and supplies real/synthetic usage from its own LLM wrapper. It must also bind
actual workflow/validator **build hashes**; the suite hash does not claim to hash
arbitrary future validator source code. The trusted manager derives acceptance,
not the proposal or callback. Candidate guidance cannot upload its own oracle,
checks, schema, reference URL, or PASS result.

The deterministic oracle checks authored entity-name alternatives, owner,
state, date, change flag, and required evidence locations. This is deliberately
narrow. Valid paraphrases outside the declared alternatives may need human
adjudication, and passing free-form prose is not automatically entailed. Results
say `assurance:"synthetic-oracle"` and `semanticVerified:false`, never general
semantic correctness or model efficacy. Real evaluation needs blinded review.

## Splits and reporting

`manifest.json` binds source-file, sealed-snapshot, and separate oracle-file
hashes. Learning, validation, and fresh sources have separate paths and scenario
families. The loader checks ids, family overlap, exact duplicate bodies across
splits, file hashes, source hashes, oracle anchors, and the runtime suite binding.
Fresh files are **not imported into the production fixture registry**.

`harness.mts` exports `loadEvaluationKit`, `evaluateMatrix`, `summarizeMatrix`, and
`deterministicReplay`. An injected matrix runner receives only `{snapshot,mode}`.
All errors/blocked cases remain in the output. Summaries preserve root **and**
child usage. Any missing usage makes aggregate totals unknown (`null`), not zero.
Model settings, receipts, provider traces, recursive operations, and actual
budget enforcement belong to the parent-owned runner; this module cannot claim
those checks passed just because an arm label exists.

Predeclared foundation gates: every registered validation case/check must pass;
zero critical safety failures; keep all rows; no required baseline failure.
This 4-fresh-case kit does not support a broad efficacy claim. Freeze a larger
set and numeric quality/latency/usage thresholds before real paired runs. Do not
use fresh outputs to revise guidance and then call them held out again.

Only `openai-codex/gpt-6-astra` with `thinking=max` is allowed for any later real
run. The local commands above have **no live inference route**. Paid access,
real credentials, public publishing, service writes, and account connections
are outside this foundation.

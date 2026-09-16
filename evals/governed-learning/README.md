# Governed-learning sealed corpus

**Local synthetic fixtures. No live evaluation or RLM efficacy claim.**

The active kit has **4 learning, 4 host-registered validation, and 12 new fresh
cases**. Six fresh cases are routine (5–6 messages, 1–2 obligations). Six are
demanding (18–20 substantive messages, 5 obligations). They require thread,
participant, acceptance, receipt, quotation, Unicode, and coverage reconciliation.
They stay within the same 32-message / 12-item contract for every arm. These are
bounded synthetic reasoning cases, **not** a long-context capacity benchmark.

`foundation-v1/ARCHIVE.json` preserves the initial manifest, sources, oracles,
32-row replay, and source fingerprints byte-for-byte. Original fresh-01 through
fresh-04 remain at their old paths for historical references but are **excluded**
from the active manifest. They are examined foundation evidence, not new pilot
cases. The new fresh IDs are fresh-05 through fresh-16.

`pilot-protocol.json` proposes exact settings, order, field conventions, thresholds,
and stop gates. Its hash is pinned by the manifest. It is **not authorization** to
run inference. Root must first approve the exact transport/runtime, common
source-only offset aid, and shared output-field conventions.

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

All twenty ready **sealed inputs**, with no oracle fields, are under
`sealed/{learning,validation,fresh}/{id}.snapshot.json`. Each was exported through
the native sealer and is byte/hash-bound in the manifest. The original
`demo/learn-01.snapshot.json` is also unchanged. These files suit the parent-owned
workflow runner; this corpus task does not certify route/CLI integration.
Files under `fixtures/` are unhashed source **drafts**, not the sealed CLI/API
wire shape. `createCommitmentSnapshot` computes
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
- `createCommitmentSourceIndex(snapshot)` — frozen source-only full-body/line
  UTF16 offsets, no duplicated body/semantic content. Exact shape and bounds:
  `SOURCE-INDEX.md`. Root applies the same aid and counts its bytes in every arm.

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
  `commitment-validation.v1`, revision 2, four validation case ids, check ids,
  suite hash, learning-manifest hash, and validation-manifest hash. This is not
  the separate `commitment-guidance-contract.v1` schema-qualification suite.
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
narrow. Valid alternative names or citations may need predeclared mode-blinded
human adjudication; preserve the automatic failure separately, never rewrite an
oracle after seeing outputs. Registered qualification still uses its strict
all-check gate. Passing free-form prose is not automatically entailed. Results
say `assurance:"synthetic-oracle"` and `semanticVerified:false`, never general
semantic correctness or model efficacy. Real evaluation needs blinded review.

## Splits and reporting

`manifest.json` binds source-file, sealed-snapshot, and separate oracle-file
hashes. Learning, validation, and fresh sources have separate paths and scenario
families. The loader checks 4/4/12 counts, 6/6 size strata, distinct families,
exact duplicate bodies across splits, file/source hashes, oracle anchors, archive
bytes, the pinned pilot proposal, and exact runtime/source fixture equality.
Fresh files are **not imported into the production fixture registry**. Family,
difficulty, authoring notes, and oracle fields never enter matrix callbacks.
Only the four learning cases may inform candidate generation. Validation is an
accept/reject gate; it is not another generation set. Fresh outputs cannot be
used to revise the candidate or thresholds while keeping the held-out claim.

`harness.mts` exports `loadEvaluationKit`, `verifyFoundationArchive`,
`evaluateMatrix`, `summarizeMatrix`, and `deterministicReplay`. An injected matrix runner receives only `{snapshot,mode}`.
All errors/blocked cases remain in the output. Summaries preserve root **and**
child usage. Any missing usage makes aggregate totals unknown (`null`), not zero.
Model settings, receipts, provider traces, recursive operations, and actual
budget enforcement belong to the parent-owned runner; this module cannot claim
those checks passed just because an arm label exists.

Predeclared gates: every registered validation case/check must pass; zero critical
safety failures; keep all rows; no required baseline failure. The four validation
cases use 3–4 messages each. Two attempts per case leave a maximum of eight calls
inside the shared ten-attempt qualification envelope. Tests measure the repeated
source-byte component only; root enforces the full 2 MiB serialized-request cap.

The deterministic replay now has **80 rows**, covering all 20 cases under four
labels. This does not pool learning/validation into a real efficacy score. A
future pilot uses only the twelve new fresh cases: **48 actual task runs**, if
separately authorized. F must gain at least two usable handoffs/12 and reduce
corrections without critical regression. On six demanding cases, FR must gain
two handoffs over F or preserve quality with at least 25% lower total tokens;
median latency must stay within 2×, with complete usage. Ties, saturated baselines,
and negative results are valid. Full definitions and stop gates are in the
pinned protocol, not inferred from the authored-answer replay.

Only `openai-codex/gpt-6-astra` with `thinking=max` is allowed for any later real
run. The local commands above have **no live inference route**. Paid access,
real credentials, public publishing, service writes, and account connections
are outside this corpus task. Cross-author read-only fixture review is recorded
under `authoring/`; it is source/oracle authoring QA, not a model-output score.

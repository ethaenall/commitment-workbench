# Sealed commitment-handoff corpus handoff

## COMPLETE — corpus and deterministic checks only

The active corpus is **4 learning + 4 validation + 12 new fresh cases**.
The new fresh split has six routine cases (5–6 messages, 1–2 obligations) and
six demanding cases (18–20 substantive messages, 5 obligations). All arms keep
identical source bytes, the existing 32-message/96,000-body-unit/12-item bounds,
and the same shared output checks. No evaluation transport/model call, OAuth,
service action, install, build, publish, or deployment ran in this corpus task.

Total: 176 messages and 51 authored obligations across 20 active cases.
Fresh: 41 obligations across fresh-05 through fresh-16. No baseline failure is
required. Saturated, tied, and negative outcomes remain valid.

## Preservation and ready inputs

- `foundation-v1/ARCHIVE.json`: 27 original files verified byte-for-byte, including
  the old manifest, all eight source/oracle pairs, original 32-row replay, and
  implementation source fingerprints. Old manifest SHA-256:
  `7caf81e7a9df37441755738f7935a4525da6779196ff2008e72f13b55e3ebb93`.
- Existing learn-01/02 and validate-01/02 IDs and source/oracle bytes are unchanged.
- Old fresh-01–04 also remain unchanged at their original paths, but are absent
  from the active manifest and new pilot denominator. They are examined
  foundation/development evidence, not fresh results.
- All twenty ready source-only CLI/API inputs are in
  `sealed/{learning,validation,fresh}/{id}.snapshot.json`, generated through
  the native sealer and byte/hash-bound in the manifest. `fixtures/` files are
  source drafts. `demo/learn-01.snapshot.json` remains unchanged.
- Oracles, family/difficulty metadata, and authoring notes stay evaluator-only.
  Matrix callbacks receive exactly `{snapshot,mode}`; host suite callbacks
  receive `(snapshot,caseId)`. Fresh cases are not in the production registry.
- Cross-author read-only source/oracle review: `authoring/review.md`. This is
  authoring QA, not a blinded evaluation of model outputs.

## Frozen identity

- Active manifest: `cd1f2c1802cb4ff0da50019d9af17ac3185a74f2361999753a70f0e1fd853e57`
- Pilot proposal: `a836418b37deaad273746ee04baf7c04c01f978338e33a1688b2ca4b77012597`
- Model-validation suite: `commitment-validation.v1`, **revision 2**, four cases.
- Suite hash: `379c8f74e8d9a7a5faf23ce7d38e677660e9cfa34d79f33bc9d81f55dc885705`
- Learning manifest: `848ca8ffb5817992ea08a5ad08b1bac1954d5f266b56027fef49ec8475820307`
- Validation manifest: `2b7d0c037771ea43e61d1de2a27a91ba9ed2fc0c93ab1fa2bd3497e79b892b95`

This does not change the parent-owned static schema suite
`commitment-guidance-contract.v1`. The registry descriptor automatically exposes
new model-validation hashes. Old qualification receipts must not be relabelled
as revision-2 evidence.

## Verification actually run

**PASS**

- Focused native engine workflow tests: **28/28**.
- Native Node evaluator tests: **10/10**, including full archive preservation,
  new fresh exclusion, 6/6 strata, Unicode spans, identical callback inputs, and
  equal pairwise arm precedence within each difficulty stratum.
- Native manifest verification, including every ready sealed input's equality
  with its draft and the exact runtime/source learning/validation registry.
- Authored-answer replay: **80 retained rows**, all four labels tie at 20/20
  narrow oracle passes. `results/contract-replay.json` records the final manifest
  and exact implementation source fingerprints. **Not four runtime executions,
  actual RLM use, model efficacy, or 80 fresh observations.**
- Contracts `tsc --noEmit` and focused lint.
- Scoped strict TypeScript check covering all owned TS/MTS and tests.
- Focused engine source/test lint and actual evaluator lint without ignored-file
  warnings.
- **Full current engine `tsc --noEmit`: PASS.** The parent fixed the previous
  `table-counts.ts` blocker; this worker did not edit it.

The source component for two attempts on every validation case is **15,502 UTF8
bytes**. Four cases × two attempts = eight, under the shared ten-attempt ceiling.
This proves source headroom only; the parent still enforces the complete 2 MiB
serialized-request envelope and all root/child usage.

No canonical full-suite/build/route/CLI/runtime proof is claimed by this worker.
Those gates remain with the parent. Final replay fingerprints matched disk.

## Exact proposed pilot — not authorized

`pilot-protocol.json` freezes the proposal, including the exact alternating
fresh-case order and reversed Williams four-arm orders. It calls for twelve fresh cases ×
four arms = 48 runs, one task at a time. Per task: 10 total attempts, 2 MiB total
serialized requests, 120k input/12k output tokens, 5 minutes, max one output
repair, depth 1, up to 3 children and 2 concurrent children. Every retry, failed
call and cancelled call counts. Unknown usage is never zero.

Only ASTRA MAX; no provider/model fallback. Generate at most one candidate from
learn-01–04 in an isolated learning-only request, not the authoring transcript.
Qualify once on validate-01–04 in nonrecursive F mode, with at most one mechanical
output repair per case and no oracle-label feedback. Do not revise the candidate
from validation/fresh labels or failed fresh outputs.

- F versus B: net +2 usable handoffs/12, fewer material corrections, no critical
  regression, complete usage.
- FR versus F on six demanding: net +2 handoffs OR equal quality with >=25% fewer
  total tokens. Median latency <=2× the simpler arm; complete usage and genuine
  bounded recursive provenance are mandatory.
- Report R versus B even when inconvenient. Tie/negative: keep the simpler arm.
- A usable-handoff claim requires mode-blinded semantic review. Authored alias/
  field/evidence checks alone do not certify prose, partial dates, or materiality.

Before qualification, root must approve the exact transport/runtime and apply
**the same answer-free full-body/line UTF16 offset aid and explicit output-field
conventions to all arms**. This prevents character-count arithmetic or hidden
email/date/change conventions from being mistaken for refinement/RLM value.
These are proposed shared requirements; this task did not change the root
formatter, task prompt, runtime, or transport. No live evaluation is authorized.
Stop on source/config/hash drift, oracle leakage, missing usage, unavailable
modes, budget breaches, unsafe service/control effects, or incomplete provenance.
Retain every blocked/error/partial row. Do not retune thresholds after outputs.

## Changed ownership and integration API

This expansion changed only `engine/src/workflows/fixtures.ts`, the owned
`commitment-handoff.test.ts`, `evals/governed-learning/**`, and `evaluation.md`.
The existing core contracts/sealer were read and verified, not modified for this
expansion. No root service, model-budget, RLM runtime, UserAgent/HTTP/CLI, barrels,
package metadata, neighboring repository, or other worker's test was edited.

Existing API names remain documented in README: `listWorkflowFixtures`,
`getWorkflowFixture`, `getWorkflowValidationSuite`, `evaluateWorkflowSuite`,
`scoreWorkflowCase`, snapshot/ledger validators, `WorkflowDescribeResponse` and
optional result metadata. Both contracts root and explicit subpath exports work.
Informational model effort stays actual string|null; it does not falsely claim
all configured providers use MAX. The optional structured trace stays bounded.

Local commands:

```text
node --import tsx evals/governed-learning/harness.mts --verify
node --import tsx --test evals/governed-learning/harness.test.mts
node --import tsx evals/governed-learning/harness.mts --replay
```

Parent-message queue limits previously blocked progress reports. This file is
the complete handoff if the final coalesced message cannot be admitted.


## Source-offset aid follow-up — implemented, root wiring still separate

`createCommitmentSourceIndex(snapshot)` and `CommitmentSourceIndex` are now
exported by the owned `commitment-handoff.ts`. See `SOURCE-INDEX.md` for the exact
shape and delimiter/cap semantics. It returns no body/quote/semantic content,
validates source hashes, and is immutable/deterministic. All twenty corpus cases
are completely indexed (max eight lines/message); max aid is 3,883 bytes and max
snapshot+aid payload is 15,650 bytes before request overhead. Fixed bounds:
256 indexed lines/message and 128 KiB serialized aid; cap omissions are explicit
and never remove source/full-body bounds. Root still counts aid bytes under its
512 KiB per-call budget and must apply the same aid in all arms.

Follow-up PASS: 33 focused workflow tests, 10 evaluator tests, full engine tsc,
scoped strict TS and focused lint. The initial new test tried to mutate a frozen
fixture coverage object; its setup now copies that object, and all focused tests
were rerun. No fixture/oracle/manifest/protocol/contract or other main path changed.
The recorded authored replay now has the helper's current implementation hash.

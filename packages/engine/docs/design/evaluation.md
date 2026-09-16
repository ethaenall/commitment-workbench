> **Historical scoped design document.** Retained for design history; proposals and stage-specific acceptance statements below are not current runtime or benchmark status. For this independent fork, read the [current architecture](../../../../docs/ARCHITECTURE.md) and [live pilot report](../../../../docs/BENCHMARKS.md). Fork context added 2026-09-16.

# Evaluation: promises, not just messages

**Status: 4/4/12 corpus sealed; live qualification/evaluation remains unauthorized.**

The active kit is in `evals/governed-learning/README.md`: 4 learning cases,
4 host-registered validation cases, and 12 new fresh cases (6 routine/6 demanding).
The original four fresh cases and 32-row replay are byte-preserved under
`foundation-v1/` and excluded from the new pilot. The current 80-row replay tests
all twenty cases under four labels; it is not an RLM run or accuracy comparison.
`pilot-protocol.json` pins an exact proposed 48-run fresh pilot and stop gates.
The full governed source-acquisition path below is still proposed; this corpus
uses sealed supplied snapshots. Runtime, transport, workflow/API/CLI integration,
and their canonical proof remain parent-owned.

Based on upstream `eb5b9462f514a10a1312a76d7e09bb07c9598609` and
[governed-learning.md](governed-learning.md). This document defines one bounded
hiring sample, not a new integration platform. It does not certify the parent’s
selected RLM runtime or authorize inference.

## 1. Select the recurring job before the implementation

| Candidate | Useful result | Fit to shipped tools | Decision |
| --- | --- | --- | --- |
| Weekly commitment handoff | Reconcile what I promised, what changed, and what still needs my reply; cite the evidence | `gmail_search` returns message ids; `gmail_read` returns bodies and thread ids. Requires one local fixture boundary, not a new production service. | **Select.** State changes across correspondence give refinements and optional recursive analysis a real job. |
| Tomorrow's meeting preparation | Identify conflicts, changed meetings, and missing preparation | Calendar already has list/read/search and mutation tools. Read-only fixture preparation is feasible. | Useful follow-up. Most first-slice value is date arithmetic and ordinary retrieval; it does not justify recursion yet. |
| Repository release-risk brief | Explain unresolved issues, risky changes, and review gaps | `github_list` returns repository metadata only. No shipped issue, PR, diff, or file reader. | Reject for this sample. Do not invent these services or add them to make the benchmark work. |

### Code constraints that shape the choice

- `packages/tools/src/services/mock/mock-email-data.ts` contains **10 inbox,
  5 sent, and 3 draft records**, with subject, sender, and timestamp only.
  `mock-email.ts` registers list/search/send, not read. This is enough for the
  existing onboarding/governance demo, not evidence of body-level reasoning.
- `packages/tools/src/services/google/gmail-client.ts` exposes an id on search
  results. List deliberately strips ids. Read returns
  `{id, threadId, subject, sender, to, timestamp, body}`. Use search then read;
  do not assume list can supply ids or read can supply every mail header.
- `packages/tools/src/services/shared/email.ts` caps list/search at **20**.
  The Gmail client does not consume `nextPageToken` or report search completeness.
  `shared/email-read.ts` caps each decoded body at **25,000 characters** with a
  truncation marker. Attachments are not readable documents through this tool.
  The new snapshot workflow deliberately has a smaller bound: 32 messages,
  12,000 UTF-16 units per body, and 96,000 total body units. It rejects overflow;
  it does not silently clip a Gmail read or claim to improve the upstream cap.
- `packages/engine/src/llm/conversation.ts` has a ten-iteration root loop. Multiple
  tool-use blocks can occur within an iteration. Do not assume unlimited serial
  discovery or quietly raise only an enhanced arm's limits.

**Important comparison rule:** do not compare baseline's small metadata-only
mock inbox with enhanced mode's rich message bodies. All four evaluation arms
get the same authorized source bytes and the same task.

## 2. The two-minute demo

**User job:** "Make my Friday handoff. Within this supplied correspondence
snapshot, what do I still owe, what changed, and where do I need clarification?
Cite the evidence. Give me reply text to review, but do not send or save anything
in a service."

A demanding demo can use a fixed cutoff and timezone, a declared user address,
and one of the 18–20-message synthetic snapshots across several threads. Select
its case before seeing model outputs; a learning snapshot is safer for rehearsal. The report is a small ledger, not a
chronological inbox summary:

- Commitment and responsible person.
- Current state: `due`, `waiting`, `closed`, or `uncertain`.
- Due date and timezone, or explicit unknown; what changed from the prior state.
- Source references for the claim and any state-changing evidence.
- The next useful action and, where appropriate, **local reply text**, not a
  Gmail draft or send result.
- Coverage: exactly the supplied snapshot; omitted/truncated evidence disclosed.

A memorable authored example has three visible outcomes:

| Correspondence | Intended handoff |
| --- | --- |
| I promise a design pack for Friday, then explicitly accept Monday instead. A later message quotes the old Friday promise. | Monday, with the accepted change and original promise linked; the quote does not silently restore Friday. |
| A separate checklist is explicitly cancelled, with acknowledgement. | Closed, with the closing evidence; no needless follow-up. |
| Rollout notes mention a dependency but never settle the owner or date. | Uncertain; ask a precise question rather than invent a promise. |

These are **authored fixture outcomes**, not measured model results.
Other cases must include multiple obligations in one thread, same-subject
unrelated threads, and later messages that do *not* supersede earlier agreements.
"Newest wins" and "one thread equals one task" are wrong solutions.

### Visible sequence

1. Show the source snapshot and the ordinary agent's actual report or a clearly
   labelled deterministic replay. An unenhanced agent may already get it right.
2. Inspect one proposed refinement: the demonstrated correction, exact procedure,
   source provenance, validation receipt, and scope. Explicitly accept it through
   the trusted user path. No service grant changes.
3. Run a different week's snapshot. Show the review packet and final ledger next
   to its sources, including uncertainty. Show the active immutable version.
4. Disable the refinement and show that the next run no longer applies it.
   Demonstrate version rollback in the lifecycle fixture, not by silently
   rewriting the accepted artifact.
5. Only if runtime proof succeeds, open the demanding example's analysis trace:
   a context handle, executed slice/transform operations, bounded child calls,
   and usage summed over the entire tree. Otherwise mark RLM **not integrated**.

The value hypothesis is a reviewable change ledger with fewer stale obligations
and fewer corrections. A busy subagent graph, a saved paragraph, or a scripted
before/after failure is not evidence of that value. Keep the demo case fixed
before seeing model output; never replace a correct baseline with a worse take.

### Improvement and regression must be visible, not narrated

For an actual improvement claim, show a fresh paired case's original reports,
source-linked corrections, accepted artifact hash, and independent result. The
after report must fix a real error without introducing another. If there is no
measured gain yet, show the actual applied procedure and evidence-check trace,
and label the model-value claim **not yet measured**.

For regression handling, first show a deliberately invalid candidate failing
validation while the active version remains unchanged. Separately, use two
fixture-validated versions to exercise explicit rollback, verify the restored
hash, rerun identical input, and preserve the old audit trail. Fault injection
or scripted output-check failure in this lifecycle test is labelled as such.
Once a real accepted version regresses on new correspondence, retain that trace,
disable/roll back through the trusted path, and rerun against the prior version.
Do not claim rollback restored quality until the rerun is independently checked;
do not fabricate a bad accepted version just to tell a learning-success story.

## 3. The smallest useful refinement artifact

The smallest v1 candidate is **specific scoped workflow guidance plus a
host-owned evidence/output contract**, not a new interpreter. The parent
integration decision remains authoritative. Every arm uses the same host
validator; stronger output checks are not secretly reserved for refined mode.

For workflow `mail.commitment-handoff.v1`, the refinement records a concrete
recipe with inputs, decisions, and deliverables. A correction seed might be:
"The handoff repeated a Friday deadline after an accepted move to Monday and
omitted the evidence for the change." A bounded procedure is:

```text
Input: authorized correspondence snapshot, user identity, cutoff, timezone.
1. Enumerate candidate obligations and changes. For each, record the speaker,
   claim, observed time, and original source span. Mark inferred identity links.
2. Reconcile by obligation, not just by thread or subject. A thread can carry
   multiple obligations; uncertain cross-thread identity remains explicit.
3. Review state transitions:
   - A request/proposal alone does not establish the user's accepted promise.
   - An explicit accepted change can replace an earlier agreed date; retain
     evidence for both. A later suggestion alone cannot silently replace it.
   - Quoted old text is not a new commitment unless the current author renews it.
   - Supported completion/cancellation closes an item, not its unrelated peers.
   - Unresolved contradiction, missing acceptance, or absent evidence requires
     uncertainty; timestamp order alone is not semantic precedence.
4. Produce the current-state ledger and local reply text. Link every material
   claim to evidence, including the prior/current pair for an asserted change.
   State coverage limits and leave unsupported owner/date values unknown.
```

This is a testable operating procedure, not "be careful" or "think harder". It
contains no seed names, expected dates, accepted answers, or service permissions.
The generic user task already asks *every* arm for a correct, cited, uncertainty-
aware handoff; refined mode adds this explicit method, not a withheld requirement.

Suggested intermediate event fields are:

```text
itemKey, threadId, observedAt,
owner, action, eventKind, dueAt|null,
evidence[{messageId, bodyStart, bodyEnd}], possibleSupersedes[]
```

These are **model-extracted candidates**, not oracle labels. `itemKey`, owner,
event kind, and supersession hypotheses are fallible. Thread ids and timestamps
come from the source. The host validates field schema, source membership/spans,
bounds, and explicit incomplete status with ordinary application code. It does
not infer that a later candidate is true, resolve contradictions, or remove
unknown values. Semantic validation belongs to the independent evaluation.
The same final output/evidence checks apply to B, F, R, and FR.

The artifact envelope needs immutable id/version/hash, exact user/workflow/input
schema scope, parent version, seed/correction provenance, bounded procedure text,
validator version, validation-receipt reference, and explicit activation history.
The receipt is written by the trusted validator, not accepted from model text.
Activation and rollback are separate trusted operations. A quoted email that
claims to be an approved procedure is still untrusted source data.

**What this can prove locally:** the correct approved procedure is applied only
in scope, rejected artifacts stay inactive, evidence checks actually execute,
and accepted versions can be reverted. **What it cannot prove:** extraction is
complete, ownership/date is correct, a state transition is justified, or the
procedure improves a real model. Source-span existence is not semantic support.

A finite `record-review@1` configuration for require/dedupe/group/order is a
**deferred alternative**, not selected v1 scope. If investigated, use a closed
field registry, retain full evidence, dedupe identical records only, and treat
ordering as presentation. It must beat the simpler guidance-plus-host-check
slice on useful evidence before adding another execution language. No arbitrary
scripts, regex/predicates, model calls, grants, or kernel edits belong in a
refinement artifact.

For the local proof, a human-authored or scripted proposed artifact is acceptable
if labelled as such. It is not evidence that an LLM discovered a useful strategy.
A later generation experiment must use only its designated seeds, account for
generation/validation usage, and record the exact resulting artifact hash.

## 4. Local setup: no OAuth, no real model, no external actions

Implement a small **test/demo harness**, not a fake production mailbox importer.
The existing native Worker/Vitest setup provides the relevant seams:

- `packages/engine/test/integration/chat-e2e.test.ts` enters `POST /api/chat` via
  `workerFetch` and injects an `LLMClient` with `instance.setLLMClient(...)`.
- `test/helpers/seed-credential.ts` creates disposable encrypted test credentials
  for `connectService(...)`. Use dummy tokens and a test encryption key only.
- `test/integration/services/gmail.test.ts` demonstrates Gmail response injection
  at `globalThis.fetch`; Gmail client functions also accept `fetchFn` directly.
- `test/helpers/llm.ts` provides deterministic and controllable LLM doubles.
  Scripted `usage` numbers are test inputs, not real token measurements.

Required harness behavior:

1. Load Gmail-format fixture responses. Intercept every fetch with a strict
   allowlist of fixture routes; throw on unknown URLs, OAuth refresh, or mutation
   endpoints. Never fall back to real fetch or load the user's secret files.
2. Seed only identical, explicitly declared read grants and dummy credentials
   for the four arms in isolated test state. Record setup separately from task
   actions. Exercise governance, source dispatch, and response serialization;
   do not merely call a formatter with precomputed answers.
3. Build a shared immutable snapshot from those governed reads. A modest fixture
   uses queries with fewer than 20 hits. A demanding fixture can use declared,
   non-overlapping fixture windows, each below the cap. The fixture manifest
   knows its finite set; this is **not** evidence of live mailbox completeness.
4. Store the source hash and acquisition trace. Give every analysis arm the same
   snapshot and metadata-only index. The baseline/refinement-only arms can read
   the raw snapshot normally; RLM arms receive an authorized context handle and
   programmatic access. No arm gets labels, expected states, or selected answers.
5. End with a local report. Reject service draft/send/label/archive/trash calls.
   A separate confirmation regression may use existing `mock_email_send` and a
   trusted fixture driver for resolve; no real provider dispatch is allowed.

Separate **source/governance contract replay** from **snapshot-to-report
analysis** in the results. The latter does not measure the agent discovering all
relevant mail in a live account. A scripted LLM can test both pipelines, but
cannot establish reasoning quality or an accuracy lift. Prefer assertions on
actual artifact selection/application, common evidence checks, and captured
traces, not two scripts that simply return a bad answer and a good answer.

A fetch stub is not sandbox containment. The untrusted interpreter must not
reach local REST, including `POST /api/resolve`, credentials, host networking,
or other users' context. Current loopback approval reachability is a release
limitation, not a boundary to waive for the demo. Runtime proof must establish
its narrower isolation claim before RLM is integrated; do not claim protection
against host compromise or prompt-injection immunity.

## 5. Four arms, one fair budget

| Arm | Active refinement | Recursive context analysis |
| --- | --- | --- |
| B: baseline | None | None; ordinary governed agent |
| F: refinements only | Frozen accepted version | None |
| R: RLM only | None | Bounded programmatic context + recursive calls |
| FR: both | Same version as F | Same runtime and limits as R |

Keep task wording, source bytes, cutoff/timezone, user identity, read grants,
tool schemas, output contract, oracle, model, and provider settings fixed.
Baseline has the same complete accessible evidence; do not shorten its context
just to create a recursive-analysis win. If an input exceeds the actual model
limit, classify it as a separate capacity experiment, not an accuracy comparison.
Use fresh state per arm/case/repeat. No accepted artifact, prior report, child
scratch state, or hidden conversation history may leak between arms.

### Model gate for later efficacy runs

Only `openai-codex/gpt-6-astra`, **thinking=max**, is allowed for generation,
root inference, children, and any model-assisted review. No cheaper child model,
Grok, lower effort, or silent provider fallback. No real inference is allowed
in a proof spike. Later inference requires a separately authorized route and
budget; this document authorizes neither paid access nor credentials.

A configuration field or endpoint label is not proof of ASTRA MAX. The parent
reports a native runtime under independent review and an experimental observed-
token client tested offline only. That is not authorization or live efficacy
evidence. Adapter checks must capture actual model/effort settings and fail
closed if MAX cannot be verified. Informational WorkflowRunResult metadata must
still report actual known settings or null/unknown for ordinary configured
providers; it must not falsely assert every Habenula user ran MAX. Our pilot
policy remains ASTRA MAX only, with no fallback. Until route, settings, budgets,
and approval are proven, efficacy is **BLOCKED**.

Freeze a run manifest before opening fresh cases. Include model/provider
revision, effort, sampling settings or explicit provider defaults, context
limit, per-call output limit, global token/call/time limits, tool limits, artifact
hash, runtime version, and fixture/oracle revisions. Any uniform output-limit
change needed for a compact ledger must happen before the comparison, not only
in enhanced arms.

Initial ceilings for a later pilot: **10 total model calls including retries and
children, depth 1, at most 3 child calls, at most 2 concurrent children, 120,000
total input tokens, 12,000 total output tokens, 2 MiB cumulative serialized
request bytes, and 5 minutes per task**. At most one shared-output-contract repair
is allowed per task; all attempts still count. Task concurrency is one, with
counterbalanced arm order. These are proposed ceilings, not a claim that this
evaluator enforces the runtime or provider capability.
Use lower limits if the authorized route requires them; freeze that change on
validation cases. Account for reasoning tokens according to the provider's
actual usage definition, without double counting. If MAX cannot fit, stop and
report the constraint; never reduce effort to fit the budget.

Baseline may spend the same global budget on ordinary reasoning/retries. RLM
cannot receive ten root calls *plus* three uncounted child calls. Acquisition,
procedure execution, retries, failed calls, and cancellation settlement are also
part of the run. A separate unequal-budget product preset, if ever reported,
must disclose the extra resources and cannot establish a budget-matched win.

### What qualifies as genuine RLM evidence

- Raw corpus text remains outside the root prompt, including hidden tool-result
  replay. Root-visible handles and indexes contain no answer annotations.
- The root executes programmatic slices/transforms against that context and can
  choose subsequent inspection based on intermediate results.
- It issues bounded recursive model queries over selected data. Those results
  can change later inspection or synthesis. Children remain untrusted analysis,
  not approval authorities or integration clients.
- The trace links context hash, operations, returned references, parent/child
  calls, usage, cancellation, and final evidence. Static chunk-summary fan-out
  alone does not satisfy this requirement.

A deterministic fake can prove these control/data paths, including a child
response changing the next slice. It cannot prove that the model chooses useful
slices. Apply the same acceptance tests to the native interpreter and isolated
Python candidate. Select on demonstrated boundaries, lifecycle, and fit, not on
language preference or claimed originality.

## 6. Separate seeds, validation, and fresh evaluation

The active corpus has **4 learning cases, 4 model-validation cases, and 12 new
fresh cases**. Initial learn-01/02 and validate-01/02 sources/oracles remain
byte-identical. The initial fresh-01 through fresh-04 are preserved as examined
foundation evidence, not counted again. New fresh IDs are fresh-05 through
fresh-16. The manifest binds all source/oracle hashes, the archive index and the
proposed pilot protocol. Families and full source bodies do not span splits.
No thread, rewritten answer, or paraphrased seed template may span them either.
The four model-validation cases stay at 3–4 messages; at most two attempts each
fits the shared ten-attempt envelope. Root must enforce full request-byte usage;
the native corpus test establishes source-byte headroom, not transport proof.

- **Seeds:** disclose the original report, specific correction, and resulting
  candidate procedure. Development may inspect these freely.
- **Promotion validation:** different scenarios used to accept/reject the
  candidate and freeze limits. Repeatedly tuning on them makes them development
  data; record that fact and replace the promotion set before a new claim.
- **Fresh evaluation:** 6 routine snapshots with 5–6 messages and 1–2 obligations;
  6 demanding snapshots with 18–20 substantive messages and 5 obligations. They
  use distinct participants/threads, genuine conflicts, quotations, multilingual
  text, and material correspondence—not filler added until baseline breaks.
  All remain under the same 32-message / 12-item bounds. Corpus size alone is not
  task difficulty, and this set is not a model-capacity benchmark.

Include clear commitments, proposals that never become commitments, completed
work, old quoted text, several tasks per thread, aliases, unrelated matching
subjects, explicit date changes, unresolved contradictions, timezones, missing
bodies/attachments, and truncation. Include no-update and easy-control cases so
aggressive "correction" has a visible cost. Injection-bearing source is one
stress category, not the whole benchmark. Do not enrich source fixtures with
`isActionable`, expected state, authoritative supersedes links, or similar labels.

### Oracle boundary

Keep expected items, accepted equivalent wording, source support sets, ambiguity
rules, and expected coverage limits in a separate evaluator-only artifact. The
agent, refinement generator, child runtime, and demo source index cannot read it.
An opaque case id and source hash are allowed; answer-bearing filenames are not.

The oracle judges only what the supplied source can establish at the fixed
cutoff. It cannot assume access to an absent attachment, infer an unstated owner,
or know that no newer mail exists outside the snapshot. Correct uncertainty is
a success when required by the source. An explicit accepted change is different
from a later suggestion. Register these rules before evaluating output.

Deterministic checks verify schema, source identity/spans, valid timestamps,
bounds, procedure behavior, and governance/usage traces. Semantic correctness
requires blinded human review of the report and original source. Use two
independent reviews with adjudication for a publishable efficacy claim; do not
hide disagreements. A single review is a labelled pilot. ASTRA MAX review, if
separately allowed, may flag candidates but is not an independent oracle for
its own answer. Never use a model's self-awarded score as validation.

Before qualification, root must freeze the same answer-free full-body/line
UTF-16 offset aid in every arm. It may enumerate all source boundaries and hashes,
not oracle-selected spans or answers. Otherwise mental Unicode counting risks
becoming the treatment instead of reconciliation. The proposed protocol also
makes owner-email, closed/date-only dueAt:null, changed-as-live-term-revision,
and inclusion conventions explicit for every arm. These are shared requirements,
not learned secrets reserved for F/FR. No such formatter or prompt change is
claimed by this corpus task.

The implemented span convention is UTF-16 code-unit, half-open `[start,end)`
offsets into the exact decoded source body. References include an exact quote
and body hash. Both endpoints must avoid splitting surrogate pairs. SHA-256 uses
the well-formed text's UTF-8 encoding; hashes establish content identity, not
source authenticity. Transformations retain original-source references rather
than offsets into reformatted excerpts. A valid span still may not support the
claimed inference; the test suite explicitly demonstrates this distinction.

### Avoid teaching to the test

Freeze the accepted artifact before opening fresh outputs. Share generic task
requirements, including citations and uncertainty, with **every** arm. Keep
refinement-specific operations as the experimental treatment, not hidden basic
instructions that the baseline should reasonably have received. Have fresh
scenarios authored/reviewed independently of the artifact's particular rules.
Track near-duplicate scenario families, not just text hashes.

Report all cases and failures. Never tune an artifact or runtime after seeing
fresh answers and re-label the same set "held out". A revised system needs a new
untouched evaluation set; retain the old results as development evidence. A
useful result here supports this bounded workflow, not general personal-agent
learning or open-ended mailbox reliability.

## 7. Metrics with an auditable denominator

| Metric | Definition and limits |
| --- | --- |
| **Verified usable handoff** (primary) | Per-case binary: all oracle-required items, current owner/state/date or required uncertainty, supported changes and citations, honest coverage, and no unauthorized action. Any critical stale/closed-as-open/false-completion error fails the case. This is not "the agent finished talking." |
| Item precision/recall | Match predicted obligations to the oracle's semantic item identities, not thread count. A correct item must have the required state and temporal interpretation. Report per-case results and macro averages; do not let a large easy inbox dominate. |
| Unsupported claim rate | Unsupported material owner/state/date/action claims divided by all such claims. Validate semantic support separately from reference existence. Record stale-deadline, fabricated-promise, false-completion, and wrong-recipient counts explicitly. |
| Correction burden | Blinded reviewer records add/remove item or correct owner/state/date/evidence/next-action operations, once per item-field. Sum operations per case; show the corrections. Do not count copyediting or necessary confirmation clicks as reasoning errors. Actual user turns, if tested, are a separate observed measure. |
| Source coverage | Source records made available/read, omitted or truncated records, and whether the report admits its limits. A large read count is not an accuracy score. |
| Latency | Monotonic time from accepted task to final report, including acquisition, parsing, procedure, all child work and retries. Report per-case values, median, and observed tail/max; human approval wait is separate. A small pilot cannot estimate production p95 reliably. |
| Total usage | Sum provider-reported input/output over root, all descendants, retries, failures, and cancelled calls. Report calls by role, peak root-visible context, tool operations, and known/unknown usage. Synthetic usage is labelled synthetic. Missing usage is unknown, never zero. |
| Safety/reliability | Out-of-scope reads, service mutations, attempted/executed approval writes, cross-user/context leakage, budget overruns, orphan children, and invalid activation/rollback events. Report attempts and completed effects separately. |

Store each result with case/source/arm/artifact/runtime hashes, exact settings,
full allowed trace, errors and terminal status, usage ledger, report, and
reviewer decisions. Do not put raw private correspondence or tokens in an audit
log to make evaluation convenient; this local kit uses synthetic source only.

Report refinement construction and validation cost separately from task cost.
If claiming amortized savings, state the task count and include that fixed cost;
show the break-even count only when measured per-task savings are positive.
Do not hide refinement generation as "free learning" or ignore RLM children.

A first real pilot is **12 paired cases × 4 arms = 48 task runs**, with arm order
counterbalanced. This is exploratory. If separately approved and affordable,
repeat all arms three times for variability, not best-of-three selection. Treat
case, not each correlated repeat or message, as the unit of comparison. Report
paired outcomes and uncertainty; do not turn 12 cases into a broad statistical
claim by counting hundreds of messages as independent samples.

## 8. Promotion, failure, and stop rules

### Local proof gates — not efficacy gates

- All four arm configurations are explicit; disabled mode has no artifact reads
  or child calls. Unavailable R/FR arms are **BLOCKED**, never passed as fakes.
- Contract replay covers activation, scope mismatch, unknown procedure fields,
  failed validation, immutable version checks, disable, rollback, and in-flight
  version pinning. Approval does not widen service grants.
- Runtime replay covers budget exhaustion, error, cancellation, restart, and
  context deletion. Include malformed and injection-bearing data. Every child
  terminates or is accounted for; no silent continuation after cancellation.
- The proposed artifact passes declared scope/lifecycle/output checks on
  validation fixtures without deleting uncertainty or source evidence. Scripted
  reports do not prove that its guidance fixes semantic errors. This supports a
  **fixture-validated local activation**, not a real-model improvement claim.

Stop immediately on any executed unauthorized service/control-plane action,
credential exposure, cross-user data access, interpreter access to local approval
REST, unvalidated activation, altered accepted bytes, or unbounded/orphaned work.
Stop at the declared budget. A timeout or incomplete usage record remains in the
results; it is not removed as an inconvenient outlier. Quarantine the candidate
or disable RLM, preserve the trace, and require a fresh passing validation before
re-enabling. Artifact rollback cannot undo an external effect already executed.

### Predeclared exploratory product gates

For the first 12-case real pilot, use deliberately visible, case-level hurdles:

- **Refinement value:** F must produce a net gain of at least two verified usable
  handoffs out of twelve versus B, introduce no critical semantic regression,
  and reduce total correction operations. If not, report "no demonstrated refinement benefit"
  and keep it optional; do not invent a success rate from contract tests.
- **Incremental RLM value:** on the six demanding cases, FR versus F must produce
  a net gain of at least two usable handoffs, **or** preserve completion/correction
  quality while lowering total input-plus-output tokens by at least 25%. No critical
  semantic or safety regression is allowed. Report R versus B as well, even if
  it contradicts the combination result.
- **Practical overhead:** for the relevant paired comparison, median latency
  must be no more than twice the simpler arm, with every run within the time
  ceiling and complete usage. These are pilot product thresholds, not universal
  scientific constants. A quality/latency tradeoff outside them is reported, not
  hidden. Routine work stays on the nonrecursive path by default.

If baseline is already excellent, report the tie. If FR does not beat F under
the declared constraints, ship the useful refinement slice without enabled RLM.
Do not add artificial noise, restrict baseline evidence, spend uncounted calls,
or choose another model until the desired graph appears. Fixing a system after
fresh evaluation retires that set from future held-out claims.

## 9. Bounded delivery and claim labels

The minimum local submission kit is:

1. One workflow and its read-only Gmail-format fixture harness.
2. One real refinement procedure with inspect/accept/disable/rollback evidence.
3. A two-minute replay that makes the evidence and local-only effects obvious.
4. Four-arm configuration and result manifests, separate source/oracle splits,
   deterministic contract checks, and a concise failure table.
5. Optional shallow RLM only after its runtime proof. No new GitHub services,
   calendar writes, OAuth setup, scheduler, general import platform, or public
   deployment is needed.

Use these labels consistently:

- **PASS — deterministic contracts:** exercised plumbing/invariants in the named
  fixture/runtime revision. No model-efficacy implication.
- **OBSERVED — ASTRA MAX pilot:** exact authorized configuration, full usage,
  fresh cases, independent oracle, and actual results attached.
- **BLOCKED / NOT RUN:** unavailable model-effort proof, missing runtime boundary,
  failed tests, unapproved inference, or absent evidence. Never substitute a
  staged after-shot for the missing result.

The implementation has focused native workflow and evaluator checks. See the
kit README and recorded replay for their exact scope. No real model calls,
account connections, or external actions were used. Canonical integration,
full builds, transport proof, and live efficacy evidence remain separate gates.

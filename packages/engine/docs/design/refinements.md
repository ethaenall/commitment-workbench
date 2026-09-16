> **Historical scoped design document.** Retained for design history; proposals and stage-specific acceptance statements below are not current runtime or benchmark status. For this independent fork, read the [current architecture](../../../../docs/ARCHITECTURE.md) and [live pilot report](../../../../docs/BENCHMARKS.md). Fork context added 2026-09-16.

# Verified workflow refinements

**Status: accepted for the local, read-only workflow slice. Core implementation is present; route/CLI integration has separate gates.**

This contract extends [governed learning](governed-learning.md). It is based on
source at `eb5b9462f514a10a1312a76d7e09bb07c9598609`. The parent accepted
guidance-first with a common host-owned output/evidence contract. Implementation
uses native Workers tests and deterministic fixtures. No real model call or
mail/integration action is part of this proof slice.

## 1. Accepted design and release slice

A refinement is versioned, scoped workflow guidance/procedure, not a grant,
policy entry, root system instruction, generated host script, or model-weight update.
**Use strict workflow guidance bound to a host-owned output/evidence
contract for this implementation.** The integrated evaluation still decides
whether it improves model behavior. Do not build a general memory store or a query interpreter
merely to make the artifact look more executable.

| Candidate | Useful property | Limitation | Recommendation |
| --- | --- | --- | --- |
| Unscoped saved prose | Cheap to write | No binding to a task, evidence, validation, approval, or rollback | Reject as the feature |
| Strict workflow guidance + registered output/evidence contract | Small change to the ordinary loop; can address semantic mistakes; independently versioned and measured | Model may ignore or misapply it; structural checks do not establish truth | **Selected v1** |
| Finite structured data procedure | Deterministic transforms, bounded work, replayable tests | Extra runtime/schema surface; grouping/sorting cannot decide semantic supersession | Defer unless a frozen recurrence case needs a specific transform |
| Generated Python/JavaScript procedure | Rich transforms and possible recursive inference | Requires separately proven isolation, cancellation, budgets, and recovery | Not stored or executed as a refinement in v1 |

The proposed first workflow is `mail.commitment-handoff.v1`: a local commitment
ledger and reply **text**, not a service draft or send, from authorized mail
snapshots. The model must reconcile promises, replies, changes, cancellations,
and uncertainty with source evidence. A refinement can remind the ordinary
loop to inspect prior/current evidence before choosing a state. It must not
assert that the newest timestamp wins or that a thread has only one obligation.
See [evaluation.md](evaluation.md).

The contribution is the demonstrated **validation → exact-version approval →
fresh improvement → rollback** loop, not the fact that instructions persist.
All four evaluation arms get the same workflow, machine-checkable output/evidence
contract, and repair budget. Only the refinement arm gets the accepted guidance.
Otherwise stricter validation could be mistaken for a guidance improvement.
A negative improvement result is valid and must remain visible.

The refinement is not RLM and must work in the ordinary, nonrecursive loop.
Either RLM runtime candidate may later read the same active version at admission.
Context storage, programmatic slicing/transforms, and recursive model calls
remain the separate RLM contract. This recommendation chooses neither an
interpreter nor a Python sidecar and creates no dependency on recursive execution.

## 2. Existing seams and boundaries

The source, rather than older architecture prose, controls these observations:

- `src/data/ddl.ts` is canonical DDL. `UserAgent.migrate()` executes it.
  `src/data/codegen/generate.ts` emits committed row schemas; never hand-edit
  `src/data/schemas/*`. Additive migrations belong in `migrate()`.
- `UserAgent.withTurnGate()` serializes loop-owning work across origins. Sessions
  are engine-derived, with one active session and a 90-minute lifetime.
  Commissions now use their own conversation buffer; human chat uses the
  instance's `conversationMessages`. Held turns carry durable continuation state.
- `chat()`, `commissionGoal()`, `provideTaskInput()`, and `resumeHeldTurn()` are
  distinct admission/resume paths. A feature wired only into chat is incomplete.
- `src/llm/control-plane.ts` admits control-plane **model tool calls** only for
  `RunOrigin = internal`. Offer and dispatch both enforce this. The held resolve
  path rechecks persisted origin. `human` is an audit attribution, not proof of
  identity or human presence.
- `/internal/mcp` checks `INTERNAL_MCP_TOKEN` and exposes exactly `send`,
  `resolve`, `status`. `/mcp` exposes the six commission/input/own-task verbs.
  Neither needs a new refinement management tool.
- Existing `/api/resolve` accepts local callers without that token. It can mint
  task/session grants. Never reuse it, its choices, or `held_tool_calls` for
  refinement approval. Local processes that can reach it can still approve
  ordinary tool holds. This proposal does not repair that release-wide weakness.
- `respond()` checks response contracts but **logs and passes** violations after
  side effects. It is not a mutation guard. Parse and verify all inputs and
  state preconditions before changing state.

## 3. Exact v1 content shape

The following TypeScript notation describes strict JSON, not executable code.
Every object rejects unknown fields. All strings must be well-formed Unicode.
`Sha256` is lowercase 64-hex. `Id` is an engine-issued opaque identifier.

```ts
type RefinementContentV1 = {
  schemaVersion: 1;
  kind: "workflow-guidance";
  title: string;                       // 1..80 characters; review only
  rationale: string;                   // 1..1024 characters; review only
  scope: {
    workflowId: string;                // exact registered ID, <=64 characters
    slot: "reasoning";
    workflowContractHash: Sha256;
  };
  procedure: {
    steps: string[];                   // 1..8 steps, 1..512 characters each
  };
};
```

Canonical content is at most 16 KiB. The engine's workflow registry supplies
the input schema, output schema, source/evidence rules, allowed effects, and
limits. `workflowContractHash` binds that descriptor. The artifact cannot
supply or replace a validator, schema, output destination, tool name, model
settings, runtime limits, code module, network target, or permissions. V1 has
no Python/JavaScript/shell/source-code field or execution path. The proposer and
reviewer must reject host-execution instructions rather than preserve generated
scripts as memory. Text screening is not the security boundary: the analysis
stage has no such capability regardless of what the text says.

Example step text, **illustrative and not validated evidence**:

> Compare each obligation's proposed state with its prior and later explicit
> updates. Cite evidence for both a changed value and the value it replaced.
> Treat quoted history as history unless the sender restates the commitment.
> Keep competing interpretations uncertain when the source does not resolve them.

A registered output contract checks typed due/waiting/closed/uncertain items,
source membership, evidence spans, unknown values, and local-only reply text.
Exact fields and semantic scoring belong to the integrated evaluation design.
For mail bodies, specify half-open offsets as JavaScript UTF-16 indices; reject
split surrogate pairs and preserve source text unchanged. Valid spans prove
location, **not semantic entailment**. Unknown owner/date/state remains explicit;
no validator may invent missing facts. Schema-invalid output gets a bounded
repair attempt or an explicit failure, never a silent fabricated success.

The same workflow contract and repair budget apply with refinements off.
Model-extracted candidate/event labels must never be prefilled from fixture
truth. Guidance effectiveness requires fresh model evaluation, not a mock that
returns the intended answer when it sees a particular step.

### Structured-procedure alternative, not selected

The narrow alternative discussed with evaluation is a finite record review
config: `require`, exact-record `dedupe`, `groupBy`, and typed `orderBy`, executed
in that fixed order. It is smaller than a general opcode AST and could later be
a separately versioned artifact kind. Each field must be registered by the
workflow; no expression, property traversal, regex, arbitrary predicate,
network operation, or embedded model call.

Its possible value is evidence-preserving processing: group per-event candidates
by `(threadId, itemKey)`, sort `observedAt` for presentation, merge only identical
canonical candidate rows while retaining occurrence/source references, and route
missing fields to `needs_review` instead of dropping rows. It must preserve all
conflicts and unresolved records. It cannot infer semantic supersession, choose
newest-per-thread, or claim that all obligations were extracted. Do not add
filter/projection/state-label opcodes to force an impressive fixture result.

If the guidance-first fresh evaluation finds a mechanical processing failure,
compare this bounded extension against doing that one transform in ordinary
host workflow code. Prefer the latter unless versioning the transform itself
adds measured value. No new interpreter is justified by code volume or novelty.

## 4. Version, provenance, and source trust

A family has one immutable scope. Changing scope creates a new family, not a
revision that quietly reaches more tasks. A version has an engine-assigned
`versionId`, `familyId`, monotonic integer `revision`, and nullable
`parentVersionId`. Parent and child must share owner, family, and exact scope.
DO ownership is inherited from the coordinator; a content object cannot set it.

The immutable version envelope contains the content and engine-stamped provenance:

- `createdAt`: ISO-8601 UTC, engine clock.
- `producerKind`: `operator_import | engine_model | deterministic_mock`.
  The import endpoint always stamps `operator_import`; a caller-supplied model
  name is a claim, not an engine model-run receipt.
- `producerRunId` and `modelConfigHash`: nullable, populated only from a recorded
  engine invocation. Generation usage is recorded separately from evaluation.
- `sources`: 1..16 `{ kind, id, sha256, auditEntryId, resolved }` records.
  `kind` is `learning_fixture | correction | run_outcome`; `auditEntryId` is
  nullable. The engine resolves IDs and copies hashes from owned records.
  Neither arbitrary URLs nor local paths are source loaders.

The proposal request supplies source ID claims, not authoritative hashes or trust
labels. An unresolved ID is caller text, not an engine-authored identifier safe
for the unauthenticated audit surface. Unresolved references can be recorded on a proposal, but block
validation. An existing audit entry proves an observed outcome/provenance, not
that a free-text explanation is true. Current normal chat is volatile outside
holds: do not pretend a session ID is a durable correction transcript. The
small local slice resolves registered learning fixtures only. Live corrections
and outcome-derived proposals need explicit source capture before they can be
validated; unsupported source kinds remain ineligible, not silently trusted.

`versionHash` is SHA-256 over canonical JSON of the immutable envelope: content,
lineage, and provenance together. Canonicalization recursively sorts object
keys, preserves array order, and uses JSON serialization for valid scalar
values; reject non-finite numbers and ill-formed strings before hashing. Store
and display these same canonical bytes. Do not hash one representation and
approve another. `scopeKey` is a hash of canonical `scope` within the user's DO.

Imported/model-generated content remains untrusted, even after approval.
Approval authorizes consulting these exact steps for this task, not promoting
rationale, source text, or output into system/kernel authority. The engine adds
a fixed task-level preface naming the version/scope and the non-authoritative
nature of the guidance. Serialize steps as a distinct user-role reference block
in the fresh workflow conversation, never concatenate them into the system
prompt. There is no persisted prompt that can rewrite itself. An active artifact
cannot change run origin, the offered tool set, or dispatch authorization.

Raw mail, original learning examples, titles, rationale, and provenance notes
remain data, fenced with the existing fresh-nonce convention if shown to the
model. Do not overload that external-data fence to mean “follow these steps”:
its current system rule expressly says not to follow instructions inside it.
The new scoped-guidance label is a different, engine-owned task-context frame;
its wording is fixed code, not supplied by the artifact. This is labeling, not
injection immunity. The local analysis stage structurally excludes actions.
CLI displays quote/bound untrusted text and escape terminal controls. Raw HTML
and clickable action links are not used.

Versions and receipts are local plaintext content stores. Store fixture/source
references and hashes by default, not copied mail bodies or hidden expected
answers. No automatic export, telemetry, remote retrieval, or public artifact
upload. Hashes may still disclose equality or low-entropy information.
A compromised host can alter storage and verifier code; hashes are binding and
audit evidence inside the stated trust boundary, not host-compromise defense.

## 5. Validation receipts and the meaning of “verified”

Validation is engine-owned execution of a **registered, frozen** suite. A
candidate cannot supply its validator, expected outputs, pass verdict, thresholds,
or executable tests. The suite ID must match the current qualification profile
registered for this workflow; a different/older/easier suite cannot promote it.
Learning and validation manifest hashes must differ. A provenance source ID
that also appears in the qualification case IDs blocks validation.
A client-uploaded report cannot promote a version.

Each validation attempt stores these exact bindings:

- Attempt ID, version ID/hash, scope key, start/completion timestamps.
- `validatorBuildHash`, `workflowBuildHash`, and `workflowContractHash` covering
  the relevant implemented code/schema, not merely a possibly dirty Git HEAD.
- `suiteId`, `suiteHash`, `learningManifestHash`, and `validationManifestHash`.
  Generation sources and qualification membership must be distinguishable.
  Fresh post-activation evaluation uses its own separately frozen manifest.
- `executionKind`: `schema_contract | deterministic_mock | real_model`;
  nullable fixed model-settings hash. No real model is called in this stage.
- `status`: `running | passed | failed | error`. Terminal attempts are immutable.
- `reportHash` and a bounded engine-generated report: case IDs/input/output
  hashes, expected-check IDs, per-check pass/fail, elapsed time, and usage ledger
  reference. No source bodies, hidden answers, or model's self-verdict in audit.

The report's mandatory gates are schema/bounds, complete resolved provenance,
compatibility, source/evidence integrity, validator positive/negative fixtures,
adversarial malformed input, and the frozen regression checks. A missing case,
interrupted attempt, unknown check, or missing usage record does not pass.
All failing attempts remain visible. Do not keep retrying a held-out suite and
then present the winning version as evaluated on untouched cases.

**“Fixture-verified” means only:** this exact version passed these named checks
under this exact implementation and fixture manifest. For schema/mock-only
attempts display **“contract-checked; behavior unmeasured”**, not an unqualified
verified badge. The UI must display that
qualifier, attempt ID, and scope. `validated` is not a claim of safety for all
inputs, semantic correctness, model efficacy, or future generalization.

Schema/validator tests can establish rejection and evidence-location behavior.
Mock LLM runs establish plumbing only, including activation/use and error paths.
Neither establishes Astra Max extraction or overall task improvement. Human
approval is a separate decision, not validation evidence. If real-model
assessment is later authorized, hold root/child model settings fixed and compare
baseline, refinements-only, RLM-only, and both on fresh cases. Include all child
usage, failures, corrections, latency, and extra generation work. The separate
evaluation design owns scoring and promotion thresholds for stronger claims.

## 6. Transitions and concurrency

Externally visible states are `proposed`, `validated`, `approved`, `active`,
`disabled`. Rejection/validation failure is recorded as a failed attempt or a
disable reason; do not mutate a rejected payload into another version.

| Operation | Preconditions | Atomic result |
| --- | --- | --- |
| Propose | Strict bounded content; registered exact scope; valid lineage | New immutable version in `proposed`; never selected |
| Validate | `proposed`, `validated`, or `disabled`; no active validation attempt | Record `running` attempt; successful current result makes `validated`; failure leaves `proposed` (or `disabled` if previously disabled) |
| Approve | `validated`; exact passed current receipt and version hash; explicit control request | `approved` plus approval audit receipt; still not selected |
| Activate | `approved`; exact approval/validation binding and current compatibility; expected scope generation | Previous active version becomes `disabled` (`superseded`); target `active`; pointer/generation change together |
| Disable | `approved` or `active`; exact version/hash and expected generation | `disabled`; clear pointer if it names this version; increment generation; preserve history |
| Rollback | Explicit target disabled same-scope/same-family version with lower revision than current active; previously approved; still-compatible passed receipt; expected generation | Fresh rollback approval record, then one atomic switch to target; current version becomes disabled |

Editing anything in content/provenance creates a new revision in `proposed`.
Neither an approval nor a receipt transfers to it. Revalidating an approved or
active version requires disabling it first, so a new test run cannot silently
change the evidence beneath a live approval. A disabled version needs new
explicit approval before ordinary activation. Rollback is that explicit
re-approval and activation combined, not a bypass of validation. If the old
receipt is stale or missing, rollback refuses and requires revalidation.

All state transitions, active-pointer changes, and audit events commit in one
`transactionSync`, with no `await` between precondition reads and writes.
Hashing/expensive work happens outside that transaction against immutable bytes;
commit rechecks exact IDs/hashes and expected generations. A stale request gets
`409 REFINEMENT_CONFLICT`; it cannot replace a newer choice. Repeating the exact
already-completed desired operation returns the existing receipt with no extra
activation or approval only if the current last-transition audit record matches
the request digest and result generation. Store that audit ID on the affected
version/scope. Otherwise a stale generation remains a conflict, even if a later
rollback happens to point at the same version. Competing versions have at most
one winner per scope.

Validation may run outside the transaction, but admission writes the attempt
first and clears current receipt/approval eligibility. Old receipts remain
history and cannot be selected for rollback while a newer attempt is unfinished
or failed. Completion uses compare-and-set on that attempt and version state.
A lost worker/restart makes an unfinished attempt `error` on inspection or
bounded expiry; no durable busy flag may wedge the feature. A late result
cannot approve, activate, or revive a disabled version.

## 7. Selection, sessions, and rollback effect

- Selection requires an explicitly named registered workflow and exact slot,
  schema/contract match, feature enabled, active pointer, and compatible current
  receipt. No semantic search, “use everywhere,” wildcard scope, or prompt-text
  match. At most one version applies to a slot.
- Management must not create, renew, or end a governance session. Active
  refinements persist across session expiry and DO eviction; grants do not.
  Each actual input/tool acquisition still uses current governance.
- The local slice takes an already-authorized immutable fixture snapshot. It
  performs no real mail/integration action. Snapshot acquisition is outside the
  artifact and common to all evaluation arms. At analysis admission pin `{versionId, versionHash, validationId,
  scopeKey, scopeGeneration}` or explicit `none`. Do not switch versions inside
  a run, after a hold, or after a model reply. Record the pin in the run receipt.
  Baseline and RLM-only pin `none` and must not consume a prior refined buffer.
- The first workflow has its own fresh context, not hidden additions to the
  shared human `conversationMessages`. Its ordinary analysis can use
  `runConversationLoop` without recursive calls. Acquire the authorized snapshot
  before attaching guidance. The analysis stage offers no service/control tools
  and also refuses named-anyway calls at dispatch; withholding the tool list
  alone is not enough. The fixed workflow, output/evidence validator, repair
  budget, and local-only effect bound are identical in all ablation arms.
- Before guidance is attached and before a result is published/consumed, recheck
  the pin and generation. Disable/rollback invalidates a not-yet-published result.
  Report `REFINEMENT_CHANGED`; do not silently continue with baseline or the new
  version. Active-use failure is visible and yields no “verified” output. If the
  owning run/session ended while analysis was pending, discard the late result;
  do not create a fresh session merely to publish it.
- Work already delivered cannot be unlearned from a model or recalled from a
  user. Rollback affects subsequent selection; it cannot undo external effects.
  V1 emits local review/draft text only, so it creates no new send/draft hold.
- If integration permits a hold after refinement admission, including a source
  read hold, hold state must persist its own version pin. Resume rechecks it
  **before grant minting or dispatch**. Stale work must not be reinterpreted under
  a new version. Design that cancellation/terminal-audit path before enabling
  such a combined flow; accepting an already-authorized snapshot avoids it in
  the smallest local slice. Existing unrelated holds are not approved, denied,
  amended, or cancelled by a refinement transition.

Unknown stored schema/artifact kinds, malformed rows, absent receipts, and
changed implementation hashes fail selection closed. Do not quietly use an
older “close enough” recipe. A normal unselected task keeps baseline behavior.
If a user requested the refined workflow and its active version is ineligible,
return the reason rather than presenting a hidden fallback as refined success.

## 8. Local management API and CLI

Propose new `/api/refinements/*` management routes. **Every new route, including
reads, requires the existing internal caller-token check**, in addition to the
existing loopback and credential-key gates. Reuse the predicate, not model
origin supplied in a body. Leave existing REST/MCP semantics unchanged.

| Route | Request purpose |
| --- | --- |
| `GET /api/refinements` | Bounded keyset list: `userId`, optional scope, limit, cursor |
| `GET /api/refinements/get` | Exact version and current evidence: `userId`, `versionId` |
| `POST /api/refinements/propose` | `userId`, content, nullable parent version, source IDs |
| `POST /api/refinements/validate` | `userId`, version ID/hash, registered suite ID |
| `POST /api/refinements/approve` | `userId`, version ID/hash, validation ID/report hash, expected scope generation |
| `POST /api/refinements/activate` | Same binding plus approval audit ID |
| `POST /api/refinements/disable` | `userId`, version ID/hash, expected scope generation, bounded reason |
| `POST /api/refinements/rollback` | Exact older target version/hash, validation ID/report hash, expected generation, bounded reason |

No request accepts `verified`, `status`, `origin`, grants, test results, model
settings, tokens inside JSON, arbitrary source paths, or an engine script.
New mutation envelopes are strict; this is an intentional stricter contract
for new routes, not a change to legacy requests' unknown-key strip behavior.
Use shared contract schemas and `ErrorResponse`: 400 bad input, 401 missing/wrong
caller token, 404 unknown ID or disabled feature, 409 conflict/ineligible state.
Validation failures are informative results with their attempt receipt, not
transport success relabeled as test success. Lists cap at 50; details bound
content/receipts. HTTP clients cannot choose another session or audit identity.
`userId` remains routing, not tenant authentication; the token is deployment-wide.

Add explicit `habenula refinement list|show|propose|validate|approve|activate|
disable|rollback` commands. Read local proposal JSON as **data**, never import
or execute it. Before approve/activate/rollback, render exact version/diff,
scope, provenance, check failures/limits, and the fixture-only qualification;
then obtain an explicit affirmative choice. There is no chat-text auto-accept
or model-callable management verb. Optional Human Touch can run immediately
before sending the choice, with the same documented CLI-only limitations.

An approval record says **“a token-holding local caller submitted this explicit
choice for these digests”**, not “the engine proved the user read it.” The engine
cannot verify the CLI prompt or biometric presence. A caller with the token can
invoke new routes directly; other local REST weaknesses remain. An RLM runtime
must receive neither the token nor any network/host route to `/api/resolve`,
`/internal/mcp`, or these endpoints. A same-host process/container without a
proven such restriction is not sufficient. No host-compromise containment claim.

The new client must use the same config-proven local engine origin/token rules
as `InternalClient`. Do not forward a file-resolved token to an arbitrary
`apiUrl`, redirects, or a model-selected URL. No token enters error messages,
version content, validation reports, audit metadata, or model context.

## 9. Storage and audit contract

Use three new tables in the existing per-user SQLite coordinator:

| Table | Required columns / constraints |
| --- | --- |
| `refinement_versions` | `id` PK, `family_id`, `revision` positive integer, nullable `parent_id`, `scope_key`, `version_hash`, unique `proposal_request_hash`, `envelope_json`, `state` closed enum above, nullable `latest_attempt_id`, nullable `validated_attempt_id`, nullable `approval_audit_id`, `last_transition_audit_id`, `last_transition_json`, `created_at`, `updated_at`; unique `(family_id, revision)` and partial unique active `(scope_key)` |
| `refinement_validations` | `id` PK, `version_id`, `version_hash`, `status` enum, `bindings_json`, nullable `report_json`/`report_hash`, `started_at`, nullable `completed_at`; one running attempt per version; index on `(version_id, started_at)` |
| `refinement_scopes` | `scope_key` PK, nullable `active_version_id`, nonnegative integer `generation`, nullable `last_transition_audit_id`/`last_transition_json`; no null/default-allow ambiguity for generation |

`envelope_json` is immutable. Lifecycle state/pointers are the only mutable
parts of a version row. Terminal receipts are immutable. Helpers expose narrow
named operations, not arbitrary SQL. Validate nested JSON against the shared
schema on read as well as write; generated row Zod types alone only validate
`TEXT`, not a recipe. Enforce cross-table agreement in coordinator transactions
and fail-closed reads; do not assume unproven SQLite foreign-key enforcement.
No destructive migration of old content or automatic activation seeds.

Use the existing `insertAuditEntryInTxn` helper in the same transaction as each
transition. Event names are `refinement.propose`, `.validate`, `.approve`,
`.activate`, `.disable`, `.rollback`, and `.use`. Use fixed service `refinement`
and an engine-issued version ID as noun. Metadata contains hashes, scope,
state/generation changes, request digest, source count, engine-issued attempt IDs,
and `surface`/`actorKind` (for
management: `refinement_control`/`local_token_holder`), not free-text rationale,
mail content, raw source ID claims, or candidate code. Preserve existing audit origin vocabulary;
use initiating run origin for use events, and `human` plus the explicit caller
qualification for local management. Management events use a documented
`refinement-control` audit session sentinel; use events name the actual run's
session. Do not derive/reap/renew a session merely to manage an artifact.

These are standalone lifecycle events, not held tool decisions. Never set
`decision_entry_id` or add a new grant choice for them. The event's `allow`
means the control transition passed its preconditions, not that a service action
is permitted. A failed validation has `outcome: error` with fixed reason code;
its full bounded evidence belongs in the receipt. Audit entries retain history
when active pointers change. No change to the audit hash algorithm is required.

## 10. Exact implementation map

Paths below are relative to the repository root; **new** means proposed.
This is a work map, not a claim these modules exist today.

| Area | Files and change |
| --- | --- |
| Shared schema | **New** `packages/contracts/src/refinements.ts`, `src/requests/refinements.ts`, `src/responses/refinements.ts`; export through the corresponding `packages/contracts/src/*/index.ts` and root barrel. Zod v4, strict nested JSON, exact request/result contracts |
| Persistence | `packages/engine/src/data/ddl.ts`; generate **new** `src/data/schemas/refinement-versions.ts`, `refinement-validations.ts`, `refinement-scopes.ts` with `just engine-codegen`; **new** `src/data/helpers/refinement-store.ts` with single-table helpers; `src/agent/user-agent.ts::migrate()` only if later additive changes need it |
| Feature core | **New** `packages/engine/src/refinements/canonical.ts`, `registry.ts`, `context.ts`, `validation.ts`, `manager.ts`, `errors.ts`; scoped context assembly and validators separate from coordinator state. `UserAgent` owns transactions/RPC and narrow callbacks, not another monolithic interpreter |
| Workflow hook | **New** `packages/engine/src/workflows/commitment-handoff.ts` after evaluation integration. Wire an explicit fresh-context workflow admission and use pin in `UserAgent`; not a global system-prompt concatenation. Exact trigger/API is owned by the evaluation/integration plan |
| HTTP | `packages/engine/src/index.ts` for token guard + route dispatch; handlers may live in **new** `src/refinements/http.ts`. `src/dev-model/contract-descriptors.ts` must list every new route. `src/env.ts`, daemon binding allowlist, examples only if a feature toggle is added |
| CLI | **New** `packages/cli/src/refinement-client.ts`, `src/commands/refinement.ts`; extend `src/index.ts` runner/command registration. Reuse `config.ts`, `transport.ts`, error/deadline and token-origin conventions; no SDK or global dependency install |
| Any future held continuation | `packages/engine/src/llm/conversation.ts::HeldTurnState`, `src/llm/canonical.ts`, `UserAgent` persist/resume/resolve sites if a refined run may hold after admission, including source reads. Validate the new pin shape; legacy absent pin means no refinement, never choose today's active version |
| Docs/observability | `packages/engine/docs/INDEX.md`, architecture HTTP/session/privacy docs, `docs/public/guides/cli-reference.md`; disclose plaintext artifacts and fixture-only verification. Add bounded refinement metadata to read models only with matching contracts/tests |

Do **not** extend `policy_entries`, `createTaskGrant`, `createSessionGrant`,
`consumeTaskGrant`, `executeGovernancePipeline`, credential resolution, the
policy evaluator, or audit hashing to make a refinement “work.” Keep
`src/mcp/internal-server.ts`'s exact drive verb set and
`src/mcp/commission-server.ts`'s external set unchanged. Model output naming a
management function must still be unknown/refused, never parked for approval.

## 11. Smallest invariant/test gate

New tests must use the real Workers pool and DO SQLite where state matters,
with the existing deterministic `LLMClient` seam. No mock SQLite/DO/auth proof.
The focused core test evidence is recorded in the integration note. The HTTP,
CLI, full workflow, and repository-wide gates remain separate.

1. **Schema and language:** new `packages/engine/test/refinements/content.test.ts` and `context.test.ts`.
   Reject unknown/executable fields, unknown contracts, invalid types, overlong
   steps, and ill-formed text. Assert only an active, approved exact-scope version enters
   the task-level block, no dynamic system changes, and no source/provenance
   text is promoted. Workflow validator tests reject invalid evidence spans,
   source IDs, huge inputs and outputs. Semantically invalid but structurally
   valid evidence remains outside structural assurance, not a false PASS.
2. **Transitions/storage:** new `test/data/refinements.test.ts` and
   `test/agent/refinement-lifecycle.test.ts`. Version immutability, source
   resolution, failed/missing/stale receipt rejection, repeated-request
   idempotency, competing activation CAS, atomic pointer/audit rollback on an
   injected write failure, interrupted validation recovery, disable/rollback,
   runtime incompatibility, and no implicit session creation.
3. **DDL/codegen:** extend `test/data/parity.test.ts` with every new table and
   hand-maintained CHECK enums; update `test/codegen/generate.test.ts` fixtures
   if necessary. Run generated-schema freshness and DO parity, including an
   existing-database migration test. Generated types alone are insufficient.
4. **Two-request API boundary:** new `test/contract/refinements-http.test.ts`.
   Propose → validate → approve → activate → read across real Worker requests.
   Missing/wrong/unset token must fail identically before mutation. Tampered
   receipt/version hash, stale generation, other-user source ID, and unknown
   outer authority fields fail. Shared token is not per-user auth: test and
   document that distinction rather than claim tenant isolation.
5. **No permission creation:** snapshot `policy_entries`, held calls,
   credentials, spend ledger, and sessions before/after each lifecycle command.
   They are unchanged. `/api/resolve` with a refinement ID cannot activate it.
   Assert MCP tool lists unchanged and named-anyway management calls do not hold
   or execute. Extend `test/mcp/internal-boundary.test.ts` and the existing
   grant/credential isolation regression gates without weakening their asserts.
6. **Use/lifecycle:** new `test/agent/refinement-use.test.ts`. A later session can
   use the same approved version only under fresh input authorization; disabled
   or incompatible versions cannot. A paused workflow result is rejected after
   disable/rollback, never published late. Eviction restores active selection
   from SQLite. Feature-off and scope miss preserve baseline. Separate fresh
   buffers prove there is no cross-arm refinement leakage.
7. **CLI/wire contracts:** new `packages/cli/test/refinement-client.test.ts` and
   `test/commands/refinement.test.ts`; extend `test/cli.test.ts` and
   `test/cli-doc-drift.test.ts`. Explicit prompt → exact digest request, no
   approval on EOF/negative choice, bounded escaped untrusted rendering, no
   token forwarding across origins/redirects, no hidden mutation retry, existing
   availability exit codes. Update engine contract-descriptor tests/guard.
8. **Evidence honesty:** a forged uploaded PASS cannot become an engine receipt.
   Missing cases/child usage fail report completeness. Learning and fresh eval
   overlap is detected against frozen manifests. Scripted LLM success remains
   labeled mock plumbing; no overall efficacy number is invented from it.

Parent-owned final gates remain the repository's native `just pre-commit`,
relevant build/codegen/descriptor checks, four-way evaluation, and independent
semantic/security review. A focused contract test is not a canonical suite pass.

## 12. Integration decisions still requiring agreement

- **Artifact efficacy:** guidance-first is accepted; it is not a runtime choice
  or an efficacy result. It may improve semantic review but cannot enforce
  model reasoning. A finite transform is more deterministic but cannot solve
  semantic supersession either. Use the frozen evaluation to measure the accepted design;
  a saved-text feature without fresh measured benefit does not meet the goal.
- **Management authentication:** new token-gated REST endpoints deliberately
  avoid widening the MCP/model surface. This is a local refinement control
  boundary, not release-wide API authentication or proof of human approval.
- **Workflow entry and retention:** settle the explicit named-workflow trigger,
  receipt export, and source-capture lifetime with the evaluation plan. No
  automatic learning from volatile conversations or retained private mail.
- **Held continuation:** the v1 deliverable accepts an authorized snapshot and
  emits local output only. Any later combined acquisition/action flow that holds
  after refinement admission needs pinned cancellation and late-result rejection,
  including read holds. Ordinary grant safety cannot substitute for that design.
- **RLM/runtime and efficacy:** no runtime is selected here, no real provider
  calls are authorized, and no mock trace establishes recursive-model efficacy.

## 13. Core integration interface

`src/refinements/manager.ts` exports `RefinementManager` and fixed-code
`RefinementError`. Dependencies are the owner ID, bound `EngineSql`, synchronous
transaction and in-transaction audit callbacks, a trusted registry lookup,
source resolver, and optional clock/ID/timeout test seams. No default validator
or successful fallback exists. `propose` and `validate` are async; other lifecycle
methods are synchronous. All inputs use public `Refinement*` schemas exported
from `@habenula-ai/contracts`.

`get` returns current `qualification` metadata (or null), so the CLI can discover
the correct suite before a first validation. Find a receipt by
`version.validatedAttemptId` or `latestAttemptId`, not by array position. The
source resolver may be async. Approval does not activate. Rollback uses a still
valid prior receipt and fresh explicit approval; a revalidated version instead
uses ordinary approve → activate.

`select(scope)` yields an exact pin or null. A requested refinements/both mode
must refuse a null/incompatible pin, not silently turn into baseline.
`assertPin(pin)` returns immutable content after rechecking current evidence,
build compatibility, pointer, and generation. Call it at admission and before
publishing results. `recordUse` only adds a fixed audit event. The context builder
returns task-level reference text; it does not change the system prompt or tools.

The three new tables are capped at 128 versions per owner and 32 validation
attempts per version for this bounded local slice. Terminal attempts cannot be
rewritten. Repeated proposal input plus identical resolved provenance returns
the original version, using the immutable proposal request hash. Validation
has an abort signal and a bounded timeout; a lost or late runner cannot promote
its attempt. An errored/incomplete attempt without a valid report has no measured-behavior
assurance. A complete real-model report with failed checks still measures a
failure; it is not an efficacy claim. Neither schema nor deterministic mock
receipts receive the measured-behavior label.

The three new cases in `src/data/helpers/table-counts.ts` are implemented.
Root integration must classify the seven `refinement.*` lifecycle event names in
`packages/audit/src/decision-closure.ts::LIFECYCLE_TOOLS` and the dev-model inline
copy; otherwise standalone audit events look like unresolved service decisions.
The lifecycle classification changes do not alter the hash algorithm and remain
outside the core worker's write ownership, along with REST/auth, CLI, and
UserAgent wiring.

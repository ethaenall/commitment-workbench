# Refinement core integration

The accepted artifact is bounded workflow guidance. It has no permission, model
configuration, test implementation, or executable-code field.

## Composition root

Import `RefinementManager` / `RefinementManagerDependencies` / `RefinementError`
from `./manager`. Public request/response/domain schemas are exported by
`@habenula-ai/contracts`. The core imports no UserAgent, credential, policy, tool,
MCP, or Cloudflare primitive. Runtime tests use the real UserAgent DO SQLite.

Supply:
- ownerId and bound EngineSql;
- transaction(body), mapped to storage.transactionSync;
- audit(event), mapped to insertAuditEntryInTxn, without opening another txn;
- registry(workflowId), with an exact host-owned qualification profile and runner;
- resolveSource(reference, ownerId), sync or async, returning resolved hashes;
- optional clock, ID and bounded timeout overrides for deterministic tests.

`propose` / `validate` are async. `get`, `list`, `approve`, `activate`, `disable`,
`rollback`, `select`, `assertPin`, `recordUse` are synchronous. Routes own token
checks. Never expose these methods as model/MCP tools or reuse /api/resolve.

## Key bindings

- get() returns current qualification for pre-validation suite discovery.
- Find historical receipts by latestAttemptId/validatedAttemptId, not array order.
- approve does not activate. activate requires the approval audit ID as well as
  exact version/validation/report hashes and expected scope generation.
- rollback targets a disabled, previously approved lower revision in the same
  family/scope. It makes a fresh approval and switch atomically. Revalidation
  clears old eligibility; a newly validated target needs approve then activate.
- select(scope) may return null. Requested refinement modes must refuse this,
  not silently run baseline. Assert pins before attaching guidance and again
  before publishing. Session/run cancellation is the workflow owner's guard.
- The runner receives frozen version and bindings plus AbortSignal. No default
  runner exists. Its report must cover every registered case/check and include
  the complete root/child usage ledger (parents before children, summed totals).
  Input/output hashes and boolean checks are engine-runner results, not uploads.
- Registry build hashes must identify relevant code, not merely fixture hashes.
  No real-model efficacy is established by the core's schema/mock tests.

## Integration gates owned by root

1. The three CountableTable switch cases are now implemented, with a dedicated
   count test added in the narrow follow-up ownership expansion.
2. Add refinement.propose/validate/approve/activate/disable/rollback/use to the
   audit LIFECYCLE_TOOLS classification and dev-model inline copy. These are
   standalone events and must not owe service-decision closers.
3. Wire routes, descriptors, token checks, CLI and the fresh read-only workflow.
4. Run full native tests/builds and HTTP-level approval/use/rollback regressions.

Focused test command:
`vitest run test/refinements test/data/refinements.test.ts test/data/parity.test.ts`

No real model/provider or mail action is exercised by these focused tests.

## Focused verification (2026-09-10)

- PASS: 43 real-Workers tests across `test/refinements`,
  `test/data/refinements.test.ts`, and `test/data/parity.test.ts` (21 new core
  tests plus 22 parity tests), including the count and audit-source privacy regressions.
- PASS: focused engine ESLint for the core, store, DDL, and owned tests.
- PASS: contracts package `tsc --noEmit` and ESLint for `src/refinements.ts`.
- PASS: engine `tsc --noEmit` after the count cases and integration wiring
  landed. Full repository/HTTP/CLI gates remain the integrator's responsibility
  against its final source snapshot.
- `just engine-codegen` completed normally. All three new row-schema files are
  generated, not hand-edited. The Git-index freshness guard will require these
  new untracked schemas to be staged by the integrator; this worker did not stage.

This is not a full repository/HTTP/CLI gate or a model efficacy result. No real
model calls, real mail actions, or service credentials were used.

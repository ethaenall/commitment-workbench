> **Historical scoped design document.** Retained for design history; proposals and stage-specific acceptance statements below are not current runtime or benchmark status. For this independent fork, read the [current architecture](../../../../docs/ARCHITECTURE.md) and [live pilot report](../../../../docs/BENCHMARKS.md). Fork context added 2026-09-16.

# Governed learning and optional recursive analysis

**Status: local implementation in progress. Not released. RLM remains disabled pending runtime acceptance.**

## Product objective

Make repeated, demanding personal-agent work more reliable without turning a
learned procedure into permission. A successful contribution must show a clear
new user capability, not merely extra model calls, saved prompts, or controls.

The ordinary governed agent remains the default. An optional recursive analysis
mode may inspect large authorized datasets outside the root model's prompt.
Validated, explicitly approved workflow refinements may persist across tasks.
Consequential actions still use the existing governance and confirmation path.

## Fixed boundaries

- Learned artifacts are not policy entries and do not mint, renew, or widen grants.
- The governance evaluator, credential custody, existing approval semantics,
  and audit integrity remain authoritative.
- Generated analysis code receives no service credentials or uncontrolled host
  access. A container or process is not isolation evidence by itself.
- This release's loopback trust boundary remains an explicit limitation.
- No claims of prompt-injection immunity, model-weight learning, guaranteed
  generalization, or retroactive cancellation of external effects.
- Existing simple-task behavior remains supported with the feature disabled.

## Execution sequence

1. Capture the baseline. Specify a concrete user demo and representative task
   fixtures before selecting implementation details.
2. Build provenance-bearing, scoped, versioned workflow refinements with
   validation, explicit acceptance, disable, and rollback.
3. Compare bounded feasibility spikes for a restricted Python analysis sidecar
   and an in-runtime interpreter. Select on demonstrated fit and containment,
   not originality of the implementation language.
4. Integrate a shallow optional RLM only if isolation, budget, lifecycle,
   cancellation, and recovery checks pass. Store context outside the root prompt;
   ordinary fan-out summaries are not a substitute for programmatic RLM.
5. Evaluate baseline, refinements-only, RLM-only, and both on fresh cases.
   Keep model settings fixed and account for every child call. Report verified
   task completion, corrections, latency, total usage, and negative results.
6. Complete native lint, typecheck, tests, builds, independent semantic/security
   review, a reproducible demo, and evidence-bound documentation.

## Candidate runtime choices — not selected

- A restricted self-host Python sidecar may reuse the authors' MIT-licensed
  `alexzhang13/rlm` library. Its stock Docker adapter enables host connectivity;
  it is not a proven no-host-access boundary for this integration.
- A restricted interpreter inside workerd could avoid an additional Python
  service, but loading, interruption, persistence, and resource limits need
  native-runtime evidence.
- Prime Agent's RLM and continual-harness design is an explicit inspiration.
  Its unrestricted Python/shell runtime is not a drop-in fit. Any reused code
  requires file-level license review, preserved notices, and clear attribution.

## Evaluation honesty

Infrastructure fakes prove contracts, not model efficacy. A model asserting that
an update worked is not a validation result. Refinement-generation cases and
fresh evaluation cases must be distinguishable. Results must not conceal failed
runs, child usage, regressions, or unsupported runtime modes.

## Remaining acceptance gates

The commitment-handoff workflow, scoped guidance format, separated fixture/oracle
registry, immutable lifecycle, fresh-context runner, and token-gated management
surface are implemented locally. Focused deterministic tests are infrastructure
evidence, not proof that a model learned or improved.

- Finish the full post-integration lint, typecheck, test, build, and packaging gates.
- Demonstrate a model-proposed refinement, trusted qualification, explicit approval,
  fresh-case use, disable, and rollback with complete evaluation records.
- Select an RLM runtime only after native resource, ownership, cancellation,
  fidelity, cleanup, and independent review gates pass.
- Keep all four evaluation conditions fixed and retain unknown cost, failed runs,
  ties, regressions, and unsupported modes. Never manufacture an RLM win.
- Complete attribution and an independent semantic/security/claim review.

Public release, deployment, service-account connections, and real outbound
actions are outside this local implementation stage.

## Accepted first implementation slice

- Workflow: `mail.commitment-handoff.v1` over an explicit bounded, immutable
  correspondence snapshot. Output is an evidence-linked local ledger and reply
  text, never a service draft or send.
- Refinements: strict workflow guidance (bounded steps) bound to a host-owned
  output/evidence contract. No new query DSL or stored executable scripts.
- Lifecycle: immutable versions and provenance, engine-owned validation
  receipts, exact-digest user approval, atomic activation/disable/rollback,
  and scope-generation checks before late results are published.
- Entry: an explicit fresh-context read-only workflow, not a hidden change to
  ordinary chat. Feature-off and existing chat/commission/hold paths retain
  their behavior. Inputs are sealed user-supplied snapshots or host-registered
  synthetic fixtures. This workflow does not acquire a mailbox or connect a service.
- Management: new token-gated local routes, not model/MCP management tools.
  The token proves a local caller holds it, not human presence.
- All four evaluation modes share source bytes, output/evidence checks, and
  budgets. Refinements do not depend on recursive mode.
- Runtime choice remains conditional on completed proof-spike evidence.

The baseline `just pre-commit` passed with Node 22.22.1 and just 1.46.0.
The baseline tracked source remained unchanged. `just oss-build` also passed.
Tests use a separate temporary directory because fixtures placed beneath the
repository can accidentally resolve workspace packages through Node ancestors.
These baseline results are not feature or efficacy results.

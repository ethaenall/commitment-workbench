# Reviewer guide

## Five minutes

1. Read the [README](../README.md) for the product boundary and upstream credit.
2. Follow [one task](ARCHITECTURE.md#3-follow-one-task): code generation, real guest execution, optional bounded children, synthesis, validation, and finalization.
3. Inspect [the prompt contract regression](../packages/engine/test-node/rlm/prompt-contract.test.mjs). The small-context template runs in the real VM; child prompt caps are tested before event admission.
4. Read [the benchmark](BENCHMARKS.md), including failed and unrun observations. Stock versus modified is a product-default comparison. Baseline versus RLM is the cleaner treatment comparison.
5. Check [AI-assistance disclosure](DEVELOPMENT.md), [limits](LIMITS.md), and [source provenance](FORK_PROVENANCE.md).

For the file-by-file starting points, see [the contribution map](CONTRIBUTIONS.md). To practise explaining the boundaries, use [the interview exercises](WALKTHROUGH.md).

## Questions worth asking

- Can a child escape the shared task budget? Trace the [service budget](../packages/engine/src/workflows/model-budget.ts) and [coordinator](../packages/engine/src/workflows/rlm-runtime.ts).
- What if a provider ignores abort? Read [native-operation tracking](../packages/engine/src/llm/native-operation-scope.ts) and [SDK lifecycle tests](../packages/engine/test-node/rlm/sdk-lifecycle.test.ts).
- What makes a result publishable? Compare [source validation](../packages/engine/src/workflows/commitment-handoff.ts), [trace collection](../packages/engine/src/workflows/rlm-trace.ts), and [full-path tests](../packages/engine/test-node/rlm/full-path.test.mjs).
- Is the actual compiled-daemon path exercised? Inspect [the compiled-daemon test](../packages/engine/test-node/rlm/daemon-full-path.test.mjs). Its provider replies are authored fixtures; the Node/QuickJS and application path are real.
- Can the model activate its own guidance? Start with [refinement management](../packages/engine/src/refinements/manager.ts), then the route/CLI consent and generation checks.

## Suggested review scope

This is an exploratory independent fork, not a claim that the whole change set should be merged. Review the output contract, lifecycle/budget invariants, and evaluation evidence first. A prospective upstream contribution should be split with the maintainers' agreement; no upstream acceptance or CLA signature is implied.

[Run from source](QUICKSTART.md). The fork keeps existing package namespaces for compatibility; use the local built CLI, not the published upstream package, to exercise the new workflow.

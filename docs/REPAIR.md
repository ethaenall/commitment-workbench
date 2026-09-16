# Failure → observation → bounded repair

The first live comparison did not establish an RLM win. It exposed failures that remained in the record.

## What failed

The original 12-row cohort stopped after four attempted rows. Stock `fresh-05` returned invalid/truncated output at its native 1,024-token output cap. The modified baseline completed but passed 7/8 authored checks. The old RLM path returned an execution error without a ledger. A demanding baseline case then hit its five-minute native deadline, with usage unknown. Eight rows remain unrun. [Retained outcomes](../evidence/historical/paused-comparison.json).

A separate diagnostic ran the old RLM path on another synthetic case. It observed successful code generation, context reading, a child model response, and guest completion—then a deadline during final synthesis. It also exposed duplicated large source/analysis payloads. **That did not prove the exact cause of the earlier execution error.**

## What changed

The prompt contract did not make the real guest constraints clear enough. The repair:

- states the 4,096-byte per-child and 8,192-byte aggregate prompt limits;
- states the 8,192-byte guest completion limit and explains UTF-8 bytes versus JavaScript string length;
- lists unavailable globals such as `Buffer`, `TextEncoder`, `fetch`, `require`, and `process`;
- supplies a tested, Unicode-preserving retrieval expression for small contexts;
- asks the model to retrieve source rather than duplicate a full analysis in a child before final synthesis;
- permits exact retrieved source bodies/excerpts in the final synthesis findings, still treated as untrusted data.

The model still chooses and emits code. It is executed in real QuickJS and must produce host-observed execution/read evidence. There is no hardcoded ordinary-JSON answer bypass.

**Unchanged:** runtime caps, native wall-time budget, shared model budget, validator, baseline ledger rules, one-repair policy, model route, and no-fallback behavior.

Read [the prompt](../packages/engine/src/workflows/rlm-prompts.ts) and [five regression tests](../packages/engine/test-node/rlm/prompt-contract.test.mjs). The tests verify the actual VM rejects a 4,097-byte child prompt before admitting an event and that the exact small-context template preserves Unicode/source content without a child call.

## What passed afterward

One separately scoped live repaired `fresh-05` run completed in 230,274 ms with two root calls, zero child calls, and 8/8 authored synthetic checks. Observed token accounting is not distributed. Worker/backend/local process cleanup was observed. [Machine-readable result](../evidence/historical/repair-regression.json).

That is one real-model regression, not a completed benchmark, human semantic verification, billing proof, or successful live recursion. Its later date/build prevents pooling it into the interrupted cohort. The subsequent [fresh comparison](BENCHMARKS.md) was frozen separately on four previously unrun authored cases.

The later fresh pilot also records an RLM execution failure on a demanding case. The repair resolved the tested regression; it did not prove that every bounded input succeeds.

## The lesson

Do not fix a boundary failure by silently raising its limit, adding retries, or accepting an incomplete result. First make the boundary observable. Give the model an accurate capability contract. Test both the rejected case and the valid path. Then verify the real application path without rewriting the historical failure.

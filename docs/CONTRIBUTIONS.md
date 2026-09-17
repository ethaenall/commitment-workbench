# What this fork changes

Habenula already provides the agent, action governance, credential custody, audit, integrations, CLI/MCP, and runtime foundation. This fork extends that product. It does not claim those systems as new work.

This is a feature map, not a human-authorship percentage. AI assistants contributed substantially to implementation and review; see [AI-assistance disclosure](DEVELOPMENT.md).

| Area | Extension | Start reading | Evidence |
|---|---|---|---|
| Commitment handoff | Bounded snapshot and ledger schemas; owners, states, due dates, exact source spans, optional reply text | [Contracts](../packages/contracts/src/workflows.ts), [validator/source index](../packages/engine/src/workflows/commitment-handoff.ts) | [Workflow tests](../packages/engine/test/workflows/commitment-handoff.test.ts) |
| Governed guidance | Immutable versions, qualification, explicit approval/activation, generation checks, disable and compatible rollback | [Refinement contracts](../packages/contracts/src/refinements.ts), [manager](../packages/engine/src/refinements/manager.ts) | [Lifecycle tests](../packages/engine/test/refinements/lifecycle.test.ts) |
| Programmatic context | Model-generated code runs in QuickJS over packed snapshot/source data; optional bounded model subtasks; separate synthesis | [Coordinator](../packages/engine/src/workflows/rlm-runtime.ts), [prompts](../packages/engine/src/workflows/rlm-prompts.ts) | [Real-VM/full-path tests](../packages/engine/test-node/rlm/full-path.test.mjs) |
| Review survival | CLI long-deadline above the RLM wall (a 310s abort killed live reviews); 8KiB findings recovery; short extracts + host UTF-16 span binding for large snapshots | [CLI client](../packages/cli/src/refinement-client.ts), [host ledger](../packages/engine/src/workflows/rlm-runtime.ts) | [Deadline test](../packages/cli/test/refinement-client.test.ts), [host-ledger tests](../packages/engine/test-node/rlm/host-ledger.test.mjs) |
| Local native bridge | Opt-in daemon-owned backend, private DATA binding, Worker supervision and host-observed execution/read evidence | [Daemon binding](../packages/engine/src/daemon/rlm-binding.ts), [Node backend](../packages/engine/src/rlm/node-backend.mjs) | [Compiled-daemon fixture](../packages/engine/test-node/rlm/daemon-full-path.test.mjs) |
| Budget and lifecycle | One task budget across root/child/repair calls; native transport tracking; publication and resource settlement kept separate | [Model budget](../packages/engine/src/workflows/model-budget.ts), [native scope](../packages/engine/src/llm/native-operation-scope.ts) | [Cancellation](../packages/engine/test-node/rlm/native-cancel.test.ts), [SDK lifecycle](../packages/engine/test-node/rlm/sdk-lifecycle.test.ts) |
| User controls | Local `review` modes and explicit refinement controls; no automatic approval bypass | [CLI entry](../packages/cli/src/index.ts), [workflow service](../packages/engine/src/workflows/service.ts) | [Source quickstart](QUICKSTART.md) |
| Evaluation and packaging | Authored fixtures/oracles, frozen live-driver inputs, retained negative outcomes, runtime assets/notices and consumer-boundary checks | [Evaluation harness](../evals/governed-learning/harness.mts), [runtime stager](../packages/engine/scripts/stage-rlm-runtime.mjs) | [Staged checks](../evidence/verification.json), [incomplete live pilot](BENCHMARKS.md) |

## What is not being claimed

This is not a new base model, model-weight training, a replacement for Habenula's policy engine, an automatic mailbox/sending workflow, or a generally proven faster agent. Recursive Language Models and QuickJS are credited prior work. The live pilot does not establish complete live child-recursion success.

The source changes are an exploratory fork, not an upstream-approved patch set. A maintainable upstream contribution would need agreed scope, smaller reviewable changes, and the upstream contribution process. No acceptance or CLA signature is implied.

Read [the architecture lesson](ARCHITECTURE.md), then use [the interview exercises](WALKTHROUGH.md) to check your understanding rather than treating a generated repository as evidence of personal expertise.

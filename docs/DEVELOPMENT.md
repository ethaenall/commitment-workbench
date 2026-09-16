# How this was built

The starting point was Habenula's governed-agent foundation. The question was narrower: can a correspondence-review workflow use model-generated computation without handing that computation the host's authority?

## From contracts to execution

The first layer defined snapshots, source-linked commitment ledgers, and versioned guidance. The next added an actual Node Worker/QuickJS path—not a renamed prompt chain. Generated code reads stored context; the host brokers model subtasks and owns the shared budget.

The most consequential work was lifecycle handling. Rejecting a promise does not prove a request stopped. The implementation tracks underlying transport, Worker exit, pending operations, and the evidence needed to return a result.

## What the experiments changed

Early live attempts failed to produce an acceptable result. A prompt-contract repair clarified the VM's real byte limits, missing globals, and context-retrieval interface. It did not increase the budget or add a fallback. One separate synthetic regression then passed all eight authored checks.

The later comparison remained mixed: one routine RLM pass, a demanding-case failure, and an interrupted run. The frozen protocol stopped rather than filling gaps with retries. The current publication's native suite also has unresolved failures. Those outcomes remain in the [report](BENCHMARKS.md) and [verification record](../evidence/verification.json).

## AI assistance

Development used Prime Agent with Astra and Grok assistants for implementation, tests, investigation, review, and documentation. The application itself uses TypeScript, Node, and QuickJS; the development harness is not a production dependency. Reviewers included prior contributors, so review is not claimed independent of authorship.

This is a substantially AI-assisted project, not a claim of unaided implementation. Upstream contributions and third-party work remain credited. Credentials, raw sessions, private account configuration, and personal correspondence stay outside the repository.

[Contribution map](CONTRIBUTIONS.md) · [Architecture](ARCHITECTURE.md) · [Failure and repair](REPAIR.md)

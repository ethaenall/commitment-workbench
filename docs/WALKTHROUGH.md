# Technical walkthrough and review questions

A source-guided study route, not evidence that the presenter already understands every component. Use [the architecture](ARCHITECTURE.md), [benchmark report](BENCHMARKS.md), and [AI-assistance disclosure](DEVELOPMENT.md). Do not memorize ownership claims you cannot substantiate.

## Short project summary

> This is an AI-assisted fork of Habenula, not a system I built from scratch. Upstream supplies the governed-agent foundation. The fork adds a bounded review workflow and a shallow recursive-analysis path. The interesting systems work is keeping model-generated computation separate from authority, sharing one budget across calls, and refusing success until execution evidence and cleanup agree. A repaired live case works. The later pilot has one oracle-passing RLM case, a demanding RLM failure, and an infrastructure interruption. Provider-account details are not public.

## Five-minute whiteboard walkthrough

**Minute 1 — product and credit.** Draw the existing upstream governance/credentials/audit system. Add a separate analysis-only path. Explain why a `CommitmentLedger`, an audit log, and a model-attempt ledger are three different things.

**Minute 2 — one request.** CLI → local token gate → UserAgent DO → service → one ModelBudget. Explain what a sealed snapshot means: hash-bound data, not a cryptographic signature from a trusted correspondent or proof that content is true.

**Minute 3 — generated computation.** Show the code envelope, packed `{i,c}` rows, a context slice, and root/child events. A QuickJS child is not a Node Worker. Current application depth is one and the guest-request cap is three; primitive ceilings are not selected policy.

**Minute 4 — failure and cleanup.** Draw public promise, underlying transport, and Worker exit as separate facts. `Promise.race` can end the wait without ending the work. Explain seal → terminate → wait for exit → native join → settle events → fresh inspect → release.

**Minute 5 — evidence.** State exactly what the one repaired live run showed. Explain why 8/8 authored checks is not 100% general accuracy, why zero child calls is still genuine generated-code execution, and why it does not establish live child recursion. Discuss the stopped comparison, including its demanding-case failure and unknown/unrun rows, rather than inventing a win.

## Questions a reviewer should be able to ask

| Question | A technically correct answer must include |
|---|---|
| What did upstream already solve? | Governance, credential custody, audit integrity, ordinary agent/CLI/MCP and integrations. Do not relabel them as fork inventions. |
| What is RLM here, rather than just another LLM call? | A required code envelope, actual QuickJS execution over externalized context, host observations, and optional model events before separate synthesis. Ordinary answer JSON at codegen is an error. |
| Why use a separate Node Worker? | The owner can supervise/terminate generated computation separately from DO work; generated code remains in QuickJS. This does not make Node/WASM an invulnerable security boundary. |
| Does every recursive child have its own process or memory cap? | No. Child QuickJS runtimes share one Worker/WASM memory instance. The 32 MiB maximum is linear memory, not Node process RSS. |
| How does a child avoid multiplying the budget? | Root and children call `clientFor(role)` on the same task ModelBudget; each admission/usage row is counted. The current event loop is sequential despite a concurrency ceiling of two. |
| Why not give the generated code a Fetcher or provider client? | Those carry authority and capabilities. Only DATA crosses; the host dispatches bounded model requests. No direct service actions are available in this workflow. |
| What does source coverage prove? | Host-observed delivery of rows plus executed-source identity. Not understanding, entailment, completeness of the source mailbox, or answer correctness. |
| Why count both bytes and characters? | UTF-8 is the transport bound; UTF-16 code units define exact JS source offsets. An emoji can use four UTF-8 bytes but two UTF-16 units. Neither count is token usage. |
| Why can a failed task retain a permit? | A wrapper rejection or timeout is not proof of settled native I/O. Keeping the permit prevents reuse while cleanup is unknown; a later tracked join can recheck. Availability is sacrificed rather than manufacturing settlement. |
| Why can unknown usage block the answer but not all cleanup? | Billing/accounting evidence and native liveness are different axes. Settled resources may be releasable even when complete answer publication is refused. |
| What stops a refinement from granting permissions? | It is scoped guidance, not policy or executable authority. Immutable versions, qualification, explicit approval, activation and generation/pin rechecks surround its use. |
| Does “validated” mean it improved a real model? | No. Qualification distinguishes schema-contract, deterministic-mock and real-model execution. A result only supports its actual evidence level. |
| What did the live repair change? | Prompt/guest-interface alignment: disclose byte caps and unavailable globals, give the real NDJSON retrieval shape, avoid redundant small-input child analysis, allow retrieved source in synthesis. Limits/retry/fallback were not raised. |
| Why did small-input repair use zero children? | Retrieval plus final synthesis was sufficient. Extra child calls are not inherently better; zero children does not mean guest execution was skipped. |
| Why can source typechecks pass but packaging fail? | Source resolution can find `.ts` files absent from `dist`. A staged `.d.mts` imported a missing daemon declaration; emission/consumer verification is a separate boundary. |
| Can this be exposed publicly? | Not safely under the stated posture. The local shared token is not general user authentication; Host headers are spoofable. Read the upstream loopback/security limitations. |
| What would prove it outperforms baseline? | A fresh, comparable cohort with fixed model/settings, retained failures, measured quality/latency/usage, and semantic adjudication where needed. Not one repaired case or selected successful examples. |

## Three paper exercises

1. **Budget exercise.** Trace a run with one codegen call, two child calls, one synthesis and one repair. Which shared ledger records five attempts? Which guest counter records only two requests? Where would a fourth guest request be refused?
2. **Abort exercise.** A public provider promise rejects while a stream cancel is still pending. Mark answer status, producer state, Worker state, and permit state independently. Show the event that permits later release; a timer alone is not it.
3. **Unicode exercise.** In a source body containing `A😃B`, mark the emoji's UTF-16 range and its UTF-8 byte length. Then explain why a row in the packed context is not a body-offset interval.

Answer checks: (1) five model attempts, two guest requests; the app selects three guest requests total. (2) failure can return while the permit stays held; tracked native settlement plus fresh exit/event checks are required. (3) emoji offsets `[1,3)` in UTF-16; four UTF-8 bytes. Packing preserves the source but changes the surrounding representation.

## Tradeoffs to discuss, not hide

- Extra codegen/synthesis and bridge work can cost more latency and tokens than baseline; benefit must be measured on suitable tasks.
- One daemon-wide active backend lease simplifies ownership but limits throughput and can quarantine subsequent work after unknown cleanup.
- Shallow depth and hard caps trade capability for bounded behavior. A schema-valid input can still fail a later context, trace, or byte cap.
- Mechanical citation checks are useful but cannot prove semantic truth. Do not sell a contract validator as an oracle.
- AI delegation helped produce/review code but also created integration risk: parallel components still need one agreed API, source identity and end-to-end tests.

## Honest AI and benchmark accounting

Separate **development-agent usage**, **local test/fake-provider runs**, and **live workflow model usage**. Do not add repeated or incomplete records into a confident total. Do not turn provider-reported tokens into verified billing. Use [the partial usage audit](DEVELOPMENT.md) for scope, overlap, unknowns, and recorded totals.

The retained repair receipt ([sanitized result](../evidence/historical/repair-regression.json)) records the separate live-model case `fresh-05`, 230,274 ms, 8/8 authored synthetic checks, two root calls and zero child calls. It explicitly does not establish general efficacy, verified billing, or live recursive-child execution. The paused 4/12 comparison is not a completed benchmark; the repaired case is not one of its rows. Use [the fresh-cohort report](BENCHMARKS.md) for the separately frozen, incomplete comparison.

A strong interview answer names what remains unknown and shows how to test it. No performance numbers, token totals, authorship percentages, team roles, or competitor claims should be supplied from memory.

## Debugging questions (intern-scale)

- The CLI aborted a review at 310s while the engine wall was longer. Where is that deadline, and why must it outlive the budget timer?
- Guest findings are 8KiB. What happens if the model dumps a 13KiB snapshot? What is *not* allowed: trimming findings.
- Why is a short extract prompt plus host span-binding safer than asking the model to emit the full ledger schema on a 19-message snapshot?
- `collapseHostItems` kept a short title and missed an oracle key. What should it keep, and which test locks that?


# Limits and assurance boundaries

This is an experimental, opt-in local analysis feature. Passing tests does not establish universal safety or production readiness.

| Evidence or mechanism | What it does **not** establish |
|---|---|
| Exact snapshot hashes and source spans | That a claim is semantically entailed by the cited text |
| Host-recorded successful guest execution and reads | That the model understood or used every delivered character |
| QuickJS without guest Node/browser capabilities | Immunity to VM/native bugs or a whole-process/RSS containment guarantee |
| Local caller token | General account authentication or proof of a human's physical presence |
| Local abort, settled native operations, and confirmed Worker exit | That remote provider computation or billing stopped |
| Provider/app-reported token counters | Complete billing, hidden-token accounting, or subscription entitlement |
| Authored synthetic-oracle checks | Human semantic verification or real-mailbox performance |
| Recursive fake-provider integration tests | Successful live-model recursive-child execution |
| One successful repaired live case | General speedup, long-context capacity, or a benchmark win |

## Current app bounds

One task shares a 300,000 ms model budget across root calls, child calls, synthesis, and a possible repair. The current app policy permits at most three guest requests, maximum depth one, and at most four guest VMs. Primitive protocol ceilings are not the app's admission policy. See the [architecture lesson](ARCHITECTURE.md) for the separate byte, memory, context, response, and timing limits.

Snapshots are deliberately bounded: at most 32 messages, 12,000 UTF-16 code units per body, and 96,000 body code units in total. This is not an unbounded-context benchmark. UTF-8 byte caps and UTF-16 source offsets are different units.

## Workflow boundaries

- The workflow consumes supplied snapshots. It does not acquire a mailbox or send/save a reply.
- RLM requires both `GOVERNED_LEARNING=true` and `GOVERNED_RLM=true` on the local Node daemon. Standalone Wrangler has no private Node backend.
- Ordinary chat remains unchanged. There is no automatic baseline fallback when RLM fails.
- Incomplete RLM execution cannot be published as a valid-looking ledger.
- Refinements are versioned local guidance, not weight training or a permission grant. Activation/disable/rollback are explicit controls; local state and audit records can change through those controls.

Preserve the upstream [security posture](../SECURITY.md) and [engine warnings](../packages/engine/SECURITY.md). Do not expose this local prototype as a public authenticated service merely because its new review routes have a caller-token check.

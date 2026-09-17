# Live comparison: results, failures, and a stopped run

**Status: incomplete.** The frozen plan contained 12 runs across four authored synthetic cases. Five runs produced recorded outcomes. The sixth was admitted, but no result or native shutdown receipt was recovered after a development-session interruption. The protocol therefore stopped: six later rows were not run. Nothing was replayed or retuned.

A later local recovery path is **not** a row of this frozen table. After the 310s CLI abort, 8KiB findings cap, and full-schema hang were diagnosed, guest retrieve plus short extracts plus host span-binding produced a contract-valid ledger on a demanding snapshot where stock returned no packet. Oracle matching on that recovery was not clean (duplicate or shortened titles, state mismatches). Treat it as debugging evidence, not a replacement for the frozen cohort.

This is evidence about a small experimental workflow—not a claim that RLM generally outperforms Habenula or any competing submission.

## Results

| Case | Arm | Outcome | Authored checks | Task seconds |
|---|---|---|---|---:|
| fresh-07 · routine | Stock | Invalid output | Not scorable | 179.683 |
| fresh-07 · routine | Baseline | Complete, contract-valid | 7 / 8 | 257.589 |
| fresh-07 · routine | RLM | Complete, contract-valid | **8 / 8** | **177.205** |
| fresh-13 · demanding | Baseline | Native deadline/cancelled | Not scorable | 300.162 |
| fresh-13 · demanding | RLM | Execution incomplete; no ledger | Not scorable | 101.452 |
| fresh-13 · demanding | Stock | **Interrupted; outcome unknown** | Unknown | Unknown |
| fresh-08 · routine | All three arms | Not run | — | — |
| fresh-14 · demanding | All three arms | Not run | — | — |

Observed token usage and provider-account details are withheld for privacy. This is not evidence of zero usage or cost.

On the one case with all three recorded outcomes, RLM passed all eight authored checks. Baseline missed required evidence for the `overlay` item. Both modified paths produced structurally valid ledgers. Stock failed the exact-JSON parser at its native 1,024-output-token cap.

The demanding RLM case returned `WORKFLOW_RLM_EXECUTION_INCOMPLETE`. Its non-truncated trace has outcome `error` and records one successful root model call, but does not establish successful guest completion. No partial ledger was accepted. The exact guest failure cause was not diagnosed in this cohort. **Its shorter failed-attempt time is not a speedup.** The earlier prompt repair did not solve every RLM case.

The completed routine RLM run used real QuickJS execution and context reads, with **zero child model calls**. It is not evidence of a successful complete live recursive-child workflow.

## What was compared

- **Stock:** upstream commit `eb5b9462f514a10a1312a76d7e09bb07c9598609`, actual compiled original daemon and original `ApiClient.chat` over internal MCP. The shared task/schema and answer-free snapshot/source index were supplied as user input. Its ordinary-agent system, tools, and native 1,024-token output cap stayed intact. No extra repair turn was added.
- **Baseline:** this fork's compiled daemon and local CLI, `review --mode baseline`, without active refinement.
- **RLM:** the same fork/snapshot/validator/model budget, `review --mode rlm`, without active refinement. Both local opt-in flags were enabled. No direct-JSON bypass or baseline fallback.

**Stock versus modified is a product-default comparison, not an isolated RLM experiment.** Baseline versus RLM is better matched, but it is still a tiny, non-blind pilot with different internal call roles and possible output repair.

The historical benchmark workflow source identity is `cca40381b1090f8399de8e1443538cd87f2ab4c84d9b6b62e7de6904dd45d2a0`. The source/build/tool/data pins were frozen before inference and remained unchanged through recovery. This publication is a later privacy-normalized projection: comments, examples, metadata and documentation differ. No new live outcome is attributed to those later bytes.

## Frozen method

Four previously unrun cases were selected from the existing authored corpus: two routine (`fresh-07`, `fresh-08`) and two demanding (`fresh-13`, `fresh-14`). This was not a blind or representative sample. One run per arm/case was planned, sequentially, in the predeclared rotated order. Each run started a cold daemon with fresh private state. The golden oracles were used only for offline scoring, never supplied to the model.

The same configured model route was used across the recorded arms. Provider/model identity and account routing are withheld in this public projection, limiting independent reproduction of historical provider conditions. Temperature and effort were unspecified. No provider-weight, billing, or remote-compute closure claim is made.

The modified task budget remained 300,000 ms, ten shared model attempts, two concurrent calls, at most one output repair, and 4,096 requested output tokens per call. Code generation, synthesis, and children share that budget. The app's guest policy remains three requests, depth one, and four total VMs. Outer task wait was 330,000 ms; native supervision was 370 seconds. No cap or retry was raised after observing a result.

Task latency is monotonic submit-to-result time, excluding cold startup/shutdown. A successful-task median uses only oracle-passing runs; here only RLM has one such observation. The incomplete design does not support aggregate efficiency or general ranking claims. Planned-arm token totals remain unknown where runs/usage are missing.

## Why stop after the interruption?

The first five observations have confirmed child closure, absent local process groups, and required backend cleanup. The sixth has an admission marker but no saved result or supervision packet. A later presence check found its expected local PID/group absent. That does not recover the missing historical wait/exit proof or establish whether an upstream model request occurred.

The frozen protocol explicitly stops further admission on a missing native packet. The published row is `INTERRUPTED_UNKNOWN`, not success, application failure, zero usage, or `NOT_RUN`. The original offline scorer treated all absent result files as `NOT_RUN`; the public export distinguishes admission state without altering its frozen source. The six genuinely unadmitted rows remain `NOT_RUN`.

## Inspect and reproduce offline

- [Sanitized protocol and relative source/tool pins](../evidence/comparison-02/protocol.json)
- [All 12 planned rows, including unknown/unrun outcomes](../evidence/comparison-02/results.json)
- [Baseline ledger](../evidence/comparison-02/ledgers/02-fresh-07-baseline.json) · [RLM ledger](../evidence/comparison-02/ledgers/03-fresh-07-rlm.json)
- [Exact synthetic stock response](../evidence/comparison-02/stock-response.txt)

After [building from source](QUICKSTART.md), run:

```sh
node --import tsx tools/recheck-evidence.mjs
```

This checks the published projection source hashes, row accounting, saved response parsing, and both published ledgers using the actual validator/oracle scorer. It does not equate the later privacy-normalized tree with the original benchmark source or verify a historical build identity. **It makes no model request and does not attest that historical execution occurred.** A hash is an identity, not an independent witness.

The public files are sanitized projections with their own bytes/hashes, not byte-identical private protocols or raw session logs. Private control tokens, state databases, developer paths, and transcripts are not distributed. The recorded native environment was macOS arm64 / Node 22.22.1 with existing locked dependencies; fresh network installation, another OS, and byte-identical builds across different dependency layouts are not claimed verified.

## Earlier evidence is separate

The [old cohort](../evidence/historical/paused-comparison.json) remains paused after four attempted rows and eight unrun rows. The [separate repaired fresh-05 regression](REPAIR.md) passed 8/8 checks in 230.274 seconds with two root/zero child calls. Different source/data/run scopes are not pooled into this cohort, and later passes do not erase prior failures.

No competing submission has been identified or reviewed. There is no superiority or hiring claim.

# CLI Reference

The Habenula CLI (`habenula`) governs your agents from the terminal — start a conversation, connect services, inspect policy, and hit the kill switch.

This reference covers the **launch** release. Commands planned for later are listed separately under [Planned](#planned-later) so you can tell what runs today from what is coming.

## Commands

| Command | Description |
|---------|-------------|
| `habenula` | Start a conversation with your agent in the interactive shell (the REPL). If a session is already active, the launch attaches to it with a notice — this release runs one session at a time |
| `habenula chat` | Same as `habenula` — start the conversation |
| `habenula up` | Start the local engine if it is not already running. On a first run, `up` generates the shared secrets. It starts the engine, waits for it to serve, and reports the URL. It finds the engine through `HABENULA_ENGINE_CMD`, an engine path in `HABENULA_ENGINE_BIN` (the unscoped `habenula` package sets this to the engine inside its own install), a `habenula-engine` on `PATH`, or npx at the exact version this CLI was built with. It does not install an engine and does not manage a container. If it finds an engine already serving, it reports that engine rather than replacing it. `--visual-model` starts the engine with the read-only visual model page served, and reports the page URL. The engine reads that setting at start, so the flag applies to an engine `up` starts. Against an engine that is already serving, `up` reports the page when that engine has it and says how to restart when it does not. The choice is not recorded, so pass the flag on each run that wants the page |
| `habenula down` | Stop the engine this CLI started. Before it signals, `down` proves the recorded process is that engine — it never signals a process it cannot prove. It does not end the session or clear grants; use `quit` or `kill` for governance. The session keeps aging on its wall clock. If the engine returns inside the window, the session resumes. Stopping is idempotent: when nothing is running, `down` exits 0 |
| `habenula status` | Show the active session (id, age, remaining time), connected services, and default policy |
| `habenula kill` | Emergency stop: halt all agents by clearing every grant to the deny-all floor. Connected services and credentials are preserved by default (unusable without a grant), so you resume without re-running OAuth. If the engine is unavailable (e.g. mid-restart), kill retries over a bounded window (~30s) so it lands the moment the engine is back |
| `habenula quit` | End the active session: session grants expire and the slot frees for a new session. Connections and credentials are untouched. Inside the REPL, `:quit` does the same. `:exit` detaches the REPL and leaves the session running |
| `habenula connect [service]` | Connect a service from the catalog. Where the service needs OAuth, the connect runs the flow; a credential-less service connects directly. Run without a service to list the catalog. An unknown name is rejected server-side, and the catalog is shown |
| `habenula disconnect <service>` | Remove a service connection and clear its stored credential. This is local only: the token stays valid at the provider until it expires, and this release has no provider-side revocation on any path. If the service is not connected, the command errors with `not connected: <service>` |
| `habenula policy list` | List all policy entries (read-only) |
| `habenula cap` | Show the spending caps — monthly and per-session, in dollars — with the amount already spent in each window. A cap still on its shipped default is marked. `--monthly <dollars>` / `--session <dollars>` set them; values are stored as integer cents, and a lowered cap binds the next spend check |
| `habenula task list` | List the tasks your agents are working on (newest first): id, origin (you or an inbound agent), status, a short label, and age. Shows the newest page and says so when more exist; `--all` pages through the rest, `--limit <n>` sizes a page |
| `habenula task show <id>` | Show one task's full record — its goal, per-action breakdown (`service · verb · noun → outcome`), and, for a task waiting on input, the value key(s) it awaits |
| `habenula task cancel <id>` | Cancel a queued or parked task of any origin — including a runaway inbound commission — sweeping any pending confirmation it holds. A task mid-turn cannot be cancelled — wait for it to pause, or use `habenula kill` |
| `habenula task watch` | Live-poll the task queue, re-rendering on an interval until interrupted (Ctrl-C). Pull-based, like `status` — no push notifications at launch |
| `habenula log` | Show the newest audit-log entries — the governed tuple, outcome, entry id, and recorded parameter metadata, newest first. A decision carrying two or more closing entries is marked `conflicted`, with every closer listed. A conflict is labelled `contradictory` when the closers' records differ, and `duplicated` when they match. A decision with no closing entry reads `unresolved` when its call dispatched. It reads `awaiting` when a confirmation prompt is simply open. Shows page one only; `--limit <n>` sizes it (server-clamped). Reach older entries with `log dump` and a search tool until query filters ship |
| `habenula log dump <path>` | Write the complete audit chain to `<path>` as JSONL, newest first — a file `log verify --file` can check offline. Pass `-` to write to stdout (progress stays on stderr, so piping is safe). Expect a large file: a long history can run to hundreds of megabytes. A dump the run could not complete is reported as partial and exits 4 |
| `habenula log verify` | Recompute every hash locally and verify the chain's integrity — against the live engine by default, or a dump file with `--file <path>` (`-` reads stdin). Reports the range it covered and locates every break it finds. A broken chain exits 3. A range with an unchecked edge exits 4. Also checks decision closure: a decision carrying two or more closers exits 5, on both paths. An open decision is reported as text without moving the exit code |
| `habenula refinement describe` | Discover the current workflow id, exact contract hash, supported modes and learning/validation fixture references before authoring a proposal |
| `habenula refinement list` | List one bounded page of immutable guidance versions. `--scope-key <sha256>` filters a scope, `--limit <n>` accepts 1–50, and `--cursor <cursor>` continues a page. A remaining cursor is disclosed |
| `habenula refinement show <id>` | Show the exact version hash, scope, procedure, provenance, validation qualification, audit receipts and content diff from its parent |
| `habenula refinement propose <file>` | Read bounded UTF-8 JSON proposal data. Create a proposed version only; file-supplied user ids, status, validation and approval claims are rejected |
| `habenula refinement validate <id>` | Validate the exact server version with the registered suite. `--suite <id>` must match the offered engine suite; otherwise use the current server qualification. Validation alone does not approve or activate guidance |
| `habenula refinement approve <id>` | Preview the exact validated version, then require interactive `yes` to record consent. Approval does not activate it |
| `habenula refinement activate <id>` | Preview the selection diff and exact approval receipt, then require interactive `yes` to select the approved version in its scope |
| `habenula refinement disable <id>` | Show the change and disable an approved or active version. Requires `--reason <text>`. Clears the active selection only when this version is selected; does not change grants |
| `habenula refinement rollback <id>` | Preview and require interactive `yes` to restore a previously approved, disabled version in the same family as a newer active version. Requires `--reason <text>` and a current compatible validation receipt |
| `habenula review <snapshot.json>` | Review a sealed correspondence snapshot for `mail.commitment-handoff.v1`. Requires `--mode baseline`, `refinements`, `rlm` or `both`. Displays an evidence-linked due/waiting/closed/uncertain ledger, changes, coverage, usage and local reply text; never sends a message or creates a service draft |

## Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | Command failed — the engine was reachable and returned an error, the arguments were invalid, or the operation failed locally (e.g. a denied or timed-out OAuth wait, or an unreadable dump file) |
| 2 | Engine unavailable — the engine was not reachable at the configured URL (default `http://localhost:8787`; override with `HABENULA_API_URL`), or a request outlived its deadline. Start the engine with `habenula up` and rerun. For `habenula up` itself, it means the engine was spawned and had not answered by the readiness bound — the one `up` outcome a second run can change |
| 3 | Broken chain — `log verify` located at least one break; the output names the oldest one it reached |
| 4 | Range not fully covered — every link checked is intact, but an edge of the range is unchecked. Returned by `log verify` and `log dump` alike (a partial dump exits 4 when written, and again when verified) |
| 5 | Conflicted closers — `log verify` found a decision entry carrying two or more closing entries. The output labels a finding `contradictory` when the closers' records differ, and `duplicated` when they match. Both exit 5, because one decision is only ever closed once. The chain itself is intact — a broken chain reports 3, which outranks this. The finding is about the log's content. Returned on the live-engine path and the `--file` path alike |
| 130 | Cancelled — a `log dump` or `log verify` run was interrupted (Ctrl-C) before it covered the chain, and no finding had been located. A cancel that already found a break reports 3, and one that already found a conflict reports 5: cancelling withdraws a coverage claim, not a finding |

Exit 2 is reserved for the availability state, so a script can tell "engine down" from "command failed". One-shot commands fail fast with it. `habenula kill` alone retries over its bounded window first; if the window elapses with the engine still unavailable, kill exits 2. The REPL never exits on availability — it enters an offline state, probes the engine's health endpoint, and announces recovery once the engine is back.

## Governed workflow review

The `refinement` and `review` commands are explicit local workflow entry points.
They do not alter ordinary chat, governance policy, grants or kernel code. All
new reads and writes require the internal bearer token. A token proves caller
possession, not human presence or protection from a compromised local process.
The config file's token is never forwarded to an unrelated API origin or a
redirect. An unavailable or unsupported runner fails; modes do not silently
fall back to another arm.

```sh
habenula refinement describe
habenula refinement list
habenula refinement show <version-id>
habenula refinement propose proposal.json
habenula refinement validate <version-id>
habenula refinement approve <version-id>
habenula refinement activate <version-id>
habenula review snapshot.json --mode baseline
habenula review snapshot.json --mode refinements --json
habenula refinement disable <version-id> --reason "Pause for review"
habenula refinement rollback <older-version-id> --reason "Observed regression"
```

**Input is data, never imported or executed.** Proposal files are regular UTF-8
JSON files, at most 128 KiB, containing only `content`, `parentVersionId` and
`sources`. Content is bounded workflow guidance with an exact workflow contract
hash. `refinement describe` retrieves the current contract from the engine; a
stale or mismatched file hash is rejected, never silently rewritten. Sources are references; the engine resolves their provenance and owns
validation receipts. Snapshot files are regular UTF-8 JSON files, at most 1 MiB,
matching `CommitmentSnapshot`, including exact message body hashes and the sealed
snapshot hash. A request envelope, unhashed fixture draft or oracle file is not
a snapshot. Both file limits are checked before reading the full file. The
configured user id remains authoritative; no input file selects another user.

**Consent is exact and default-no.** Approval, activation and rollback display
the version, hashes, receipts and changes before asking for the literal `yes`.
There is no `--yes` bypass. Blank input, EOF, Ctrl-C or non-interactive input
withholds the mutation and exits 130. The configured Human Touch gate also runs
before these affirmative requests, with its existing availability limitations.
Disable is immediate after its preview and requires a reason of at most 512
characters. Workflow review and validation wait at most 310 seconds (the engine ceiling is
300 seconds); ordinary requests keep their short deadlines. Timeout or Ctrl-C
cannot retract inference already dispatched. Requests are not silently retried. If a scope changes while a
preview is open, inspect the fresh detail and make a new decision.

**Qualification is limited.** Contract checks verify the output/evidence
contract, not the meaning of a quote, completeness of commitments or model
efficacy. Deterministic mock calls prove plumbing only. The review shows the
snapshot cutoff, supplied-source scope, omissions, truncated messages, changed
current/prior evidence and all reported root/child usage. Check dates and meaning
against the source. `replyText` is local review text, not a sent message or a
saved service draft. Optional analysis traces show bounded host metadata, not
proof of containment or quality. These commands do not select or change model
settings; the engine owns them.

All new commands accept `--json`. It writes one full contract response to stdout;
confirmation previews and prompts stay on stderr. JSON escapes terminal controls
without changing the decoded data. All new response bodies, including errors,
are capped at 8 MiB and decoded as strict UTF-8. Stream-work bounds also stop
non-progressing or excessively fragmented injected responses. Human-readable
fields are quoted, sanitized, bounded and width-wrapped. A blocked, invalid or incomplete review exits 1 and
does not present an accepted ledger. Missing authentication is an error, not an
unavailable-engine result. Existing exit 2 behavior applies to connection and
request-deadline failures.

## Planned (later)

These commands are part of the product vision but are **not implemented at launch**. Running one today fails with an error — `unknown command` or `too many arguments`, depending on the command.

| Command | Description |
|---------|-------------|
| `habenula agent start <name>` / `agent stop <name>` | Start or stop a named agent (multi-agent lands with the coordinator/worker split) |
| `habenula kill <agent-name>` | Scoped per-agent kill (planned); today `kill` stops all agents |
| `habenula log` filters | Time/agent/service/action query filters for the audit log. Today `habenula log` shows the newest page only; reach older entries with `log dump` |
| `habenula policy edit` / `habenula policy check` | Author the YAML policy in `$EDITOR` and validate it before apply |
| `habenula digest` | Generate and display an activity digest on demand |

## Policy Files

Governance policy is expressed as verb/noun grants with optional modifiers (spending caps, rate limits, confirmation requirements). At launch the CLI is **read-only** for policy — `habenula policy list` shows the active entries. Authoring policy from a YAML file (`habenula policy edit` / `habenula policy check`) and immediate cloud sync are [planned](#planned-later).

The planned file format:

```yaml
# Example: habenula-policy.yaml
version: 1
agents:
  default:
    services:
      gmail:
        list:
          nouns: ["INBOX"]         # one mailbox per noun
        send:
          nouns: ["*@company.com"] # send only to company addresses
          confirm: true            # require confirmation before sending
        delete: deny
    spending:
      monthly_limit_usd: 50
    rate_limits:
      tool_calls_per_hour: 200
```

Two constraints hold in that format. A noun pattern such as `*@company.com` needs pattern matching, which is planned and not built — at launch a noun is matched exactly. And a bare `*` is never valid on an allow: the evaluator reserves the wildcard for deny entries.

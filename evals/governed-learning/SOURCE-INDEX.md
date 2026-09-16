# Common source-only offset aid

Exported from `packages/engine/src/workflows/commitment-handoff.ts`:

```ts
createCommitmentSourceIndex(snapshot: CommitmentSnapshot): Promise<CommitmentSourceIndex>
```

It validates source/snapshot hashes first, preserves message order, and returns
frozen deterministic data. No mode/options parameter, oracle, semantic labels,
body text, quotes, subjects, model settings, tools, or service calls are used.

Exact shape:

```text
{
  schemaVersion: 1,
  kind: "source-offset-index",
  snapshotId, snapshotHash,
  spanUnit: "utf16-code-units-half-open",
  lineBreaks: "CRLF|CR|LF|NEL|LS|PS",
  lineLimitPerMessage: 256,
  lineIndexComplete: boolean,
  messages: [{
    messageId, bodyHash,
    fullBody: [0, body.length],
    lineCount,
    lines: [[start, end], ...],
    omittedLineCount
  }]
}
```

Line numbers are their one-based array positions. CRLF is one delimiter;
CR, LF, U+0085, U+2028 and U+2029 are also delimiters. Ranges exclude delimiters.
Empty and trailing empty lines remain indexed as zero-width ranges. A location
is not a valid citation or semantic support: ordinary quote bounds and source
checks still apply. Source Unicode and line endings are never normalized.

Fixed `COMMITMENT_SOURCE_INDEX_BOUNDS`: first 256 lines per message and at most
131,072 serialized UTF8 bytes for the aid. Omitted counts refer only to known
lines beyond the aid cap, not omitted mail or truncated source. Every message
always retains its full-body bound, and the original snapshot remains intact.
`lineIndexComplete` never claims complete mailbox/source coverage.

All twenty sealed corpus inputs are fully indexed; their maximum is eight lines
per message. Largest aid: 3,883 bytes. Largest serialized `{snapshot,sourceIndex}`
payload: 15,650 bytes, excluding prompt/transport overhead. Root must attach the
same aid for ordinary/refined requests and make it available to RLM context.
Root must include it in the 512 KiB per-call and aggregate request-byte budgets.
No root formatter/runtime/transport path was changed by this helper task.

Verification: 33 focused workflow tests and 10 evaluator tests PASS; full engine
typecheck, focused lint and scoped strict TS passed. Initial test setup attempted
to mutate a frozen coverage object; the test was fixed to copy it and the full
focused suite reran. Corpus/protocol/source/oracle hashes were not changed. The
authored replay's implementation fingerprints were refreshed for the helper.

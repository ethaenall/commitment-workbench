// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/** Authored synthetic learning/validation fixtures. Fresh oracles are NOT bundled. */
import type { CommitmentEvidence, CommitmentSnapshot } from "@habenula-ai/contracts";
import { createCommitmentSnapshot, hashWorkflowText, validateCommitmentLedger, type CommitmentSnapshotDraft } from "./commitment-handoff.js";

export interface WorkflowFixtureMetadata { id: string; split: "learning" | "validation"; title: string }
export interface OracleAnchor { messageId: string; quote: string }
export interface CommitmentOracleItem {
  key: string;
  /** Narrow authored-name matching, not an automatic semantic judge. */
  titleTerms: string[];
  owner: string | null;
  state: "due" | "waiting" | "closed" | "uncertain";
  dueAt: string | null;
  changed: boolean;
  evidence: OracleAnchor[];
  priorEvidence: OracleAnchor[];
}
export interface CommitmentOracle { caseId: string; items: CommitmentOracleItem[] }
interface FixtureRecord {
  metadata: WorkflowFixtureMetadata;
  draft: CommitmentSnapshotDraft;
  snapshotHash: string;
  oracle: CommitmentOracle;
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

// Only host-side evaluator functions below may read oracle fields. The getter
// for model input returns a separately parsed/frozen snapshot with no oracle.
const FIXTURES: Readonly<Record<string, FixtureRecord>> = freeze({
  "learn-01": {
    "metadata": {
      "id": "learn-01",
      "split": "learning",
      "title": "Studio correspondence"
    },
    "draft": {
      "workflowId": "mail.commitment-handoff.v1",
      "schemaVersion": 1,
      "snapshotId": "learn-01",
      "userAddress": "sam@example.test",
      "cutoff": "2026-10-09T23:00:00Z",
      "timezone": "America/Los_Angeles",
      "coverage": {
        "scope": "supplied-snapshot",
        "source": "synthetic-fixture",
        "omittedMessages": 0,
        "note": "Authored synthetic correspondence. Not a live mailbox or a complete account export."
      },
      "messages": [
        {
          "id": "learn-01-m1",
          "threadId": "learn-01-t1",
          "subject": "Weekly correspondence",
          "sender": "sam@example.test",
          "to": "team@example.test",
          "timestamp": "2026-10-05T10:00:00Z",
          "body": "Design pack: I will send the final files by Friday 9 October at 17:00 UTC.",
          "truncated": false,
          "omittedChars": 0
        },
        {
          "id": "learn-01-m2",
          "threadId": "learn-01-t1",
          "subject": "Weekly correspondence",
          "sender": "pat@example.test",
          "to": "sam@example.test",
          "timestamp": "2026-10-06T10:00:00Z",
          "body": "The review is moving. Would Monday work for the design pack?",
          "truncated": false,
          "omittedChars": 0
        },
        {
          "id": "learn-01-m3",
          "threadId": "learn-01-t1",
          "subject": "Weekly correspondence",
          "sender": "sam@example.test",
          "to": "team@example.test",
          "timestamp": "2026-10-07T10:00:00Z",
          "body": "Confirmed: I will send the design pack on Monday 12 October at 17:00 UTC instead of Friday.",
          "truncated": false,
          "omittedChars": 0
        },
        {
          "id": "learn-01-m4",
          "threadId": "learn-01-t1",
          "subject": "Weekly correspondence",
          "sender": "pat@example.test",
          "to": "sam@example.test",
          "timestamp": "2026-10-08T10:00:00Z",
          "body": "Thanks. Quoting the original for the archive, not changing our new agreement:\n> Design pack: I will send the final files by Friday 9 October at 17:00 UTC.",
          "truncated": false,
          "omittedChars": 0
        }
      ]
    },
    "snapshotHash": "70c2036353adaf45fe21d077d5f784b63cb219247aa64f98a65dd0b962ec7f48",
    "oracle": {
      "caseId": "learn-01",
      "items": [
        {
          "key": "design",
          "titleTerms": [
            "design pack",
            "design files"
          ],
          "owner": "sam@example.test",
          "state": "due",
          "dueAt": "2026-10-12T17:00:00Z",
          "changed": true,
          "evidence": [
            {
              "messageId": "learn-01-m3",
              "quote": "Confirmed: I will send the design pack on Monday 12 October at 17:00 UTC instead of Friday."
            }
          ],
          "priorEvidence": [
            {
              "messageId": "learn-01-m1",
              "quote": "Design pack: I will send the final files by Friday 9 October at 17:00 UTC."
            }
          ]
        }
      ]
    }
  },
  "learn-02": {
    "metadata": {
      "id": "learn-02",
      "split": "learning",
      "title": "Vendor correspondence"
    },
    "draft": {
      "workflowId": "mail.commitment-handoff.v1",
      "schemaVersion": 1,
      "snapshotId": "learn-02",
      "userAddress": "sam@example.test",
      "cutoff": "2026-10-09T23:00:00Z",
      "timezone": "America/Los_Angeles",
      "coverage": {
        "scope": "supplied-snapshot",
        "source": "synthetic-fixture",
        "omittedMessages": 0,
        "note": "Authored synthetic correspondence. Not a live mailbox or a complete account export."
      },
      "messages": [
        {
          "id": "learn-02-m1",
          "threadId": "learn-02-t1",
          "subject": "Weekly correspondence",
          "sender": "sam@example.test",
          "to": "team@example.test",
          "timestamp": "2026-10-05T10:00:00Z",
          "body": "I own the renewal checklist and will finish it on 8 October at 12:00 UTC.",
          "truncated": false,
          "omittedChars": 0
        },
        {
          "id": "learn-02-m2",
          "threadId": "learn-02-t1",
          "subject": "Weekly correspondence",
          "sender": "lee@example.test",
          "to": "sam@example.test",
          "timestamp": "2026-10-06T10:00:00Z",
          "body": "We are not renewing this service. Please cancel the renewal checklist; no replacement is needed.",
          "truncated": false,
          "omittedChars": 0
        },
        {
          "id": "learn-02-m3",
          "threadId": "learn-02-t1",
          "subject": "Weekly correspondence",
          "sender": "sam@example.test",
          "to": "team@example.test",
          "timestamp": "2026-10-07T10:00:00Z",
          "body": "Acknowledged. The renewal checklist is cancelled and I have no remaining action on it.",
          "truncated": false,
          "omittedChars": 0
        }
      ]
    },
    "snapshotHash": "46dc841d6504317a083e0742fad08d70d1750f4048c2a39eae7cb17d064a1c36",
    "oracle": {
      "caseId": "learn-02",
      "items": [
        {
          "key": "renewal",
          "titleTerms": [
            "renewal checklist"
          ],
          "owner": "sam@example.test",
          "state": "closed",
          "dueAt": null,
          "changed": false,
          "evidence": [
            {
              "messageId": "learn-02-m3",
              "quote": "The renewal checklist is cancelled and I have no remaining action on it."
            }
          ],
          "priorEvidence": []
        }
      ]
    }
  },
  "validate-01": {
    "metadata": {
      "id": "validate-01",
      "split": "validation",
      "title": "Workshop correspondence"
    },
    "draft": {
      "workflowId": "mail.commitment-handoff.v1",
      "schemaVersion": 1,
      "snapshotId": "validate-01",
      "userAddress": "sam@example.test",
      "cutoff": "2026-10-09T23:00:00Z",
      "timezone": "America/Los_Angeles",
      "coverage": {
        "scope": "supplied-snapshot",
        "source": "synthetic-fixture",
        "omittedMessages": 0,
        "note": "Authored synthetic correspondence. Not a live mailbox or a complete account export."
      },
      "messages": [
        {
          "id": "validate-01-m1",
          "threadId": "validate-01-t1",
          "subject": "Weekly correspondence",
          "sender": "sam@example.test",
          "to": "team@example.test",
          "timestamp": "2026-10-05T10:00:00Z",
          "body": "Workshop assignments: I will deliver the venue sheet by 9 October at 18:00 UTC. The guest list belongs to Jo, not me.",
          "truncated": false,
          "omittedChars": 0
        },
        {
          "id": "validate-01-m2",
          "threadId": "validate-01-t1",
          "subject": "Weekly correspondence",
          "sender": "jo@example.test",
          "to": "sam@example.test",
          "timestamp": "2026-10-06T10:00:00Z",
          "body": "The guest list is complete. That says nothing about the venue sheet, which Sam is still preparing.",
          "truncated": false,
          "omittedChars": 0
        },
        {
          "id": "validate-01-m3",
          "threadId": "validate-01-t1",
          "subject": "Weekly correspondence",
          "sender": "sam@example.test",
          "to": "team@example.test",
          "timestamp": "2026-10-07T10:00:00Z",
          "body": "Venue sheet is still in progress; my Friday 18:00 UTC commitment stands.",
          "truncated": false,
          "omittedChars": 0
        },
        {
          "id": "validate-01-m4",
          "threadId": "validate-01-t2",
          "subject": "Venue sheet",
          "sender": "news@example.test",
          "to": "sam@example.test",
          "timestamp": "2026-10-08T10:00:00Z",
          "body": "Venue sheet templates are now available in the product newsletter.",
          "truncated": false,
          "omittedChars": 0
        }
      ]
    },
    "snapshotHash": "b3bbaa5da804d0a11cd1801a8c9274055e533c988d622fdffa291c21b2940c7b",
    "oracle": {
      "caseId": "validate-01",
      "items": [
        {
          "key": "venue",
          "titleTerms": [
            "venue sheet"
          ],
          "owner": "sam@example.test",
          "state": "due",
          "dueAt": "2026-10-09T18:00:00Z",
          "changed": false,
          "evidence": [
            {
              "messageId": "validate-01-m1",
              "quote": "I will deliver the venue sheet by 9 October at 18:00 UTC."
            },
            {
              "messageId": "validate-01-m3",
              "quote": "Venue sheet is still in progress; my Friday 18:00 UTC commitment stands."
            }
          ],
          "priorEvidence": []
        }
      ]
    }
  },
  "validate-02": {
    "metadata": {
      "id": "validate-02",
      "split": "validation",
      "title": "Access correspondence"
    },
    "draft": {
      "workflowId": "mail.commitment-handoff.v1",
      "schemaVersion": 1,
      "snapshotId": "validate-02",
      "userAddress": "sam@example.test",
      "cutoff": "2026-10-09T23:00:00Z",
      "timezone": "America/Los_Angeles",
      "coverage": {
        "scope": "supplied-snapshot",
        "source": "synthetic-fixture",
        "omittedMessages": 0,
        "note": "Authored synthetic correspondence. Not a live mailbox or a complete account export."
      },
      "messages": [
        {
          "id": "validate-02-m1",
          "threadId": "validate-02-t1",
          "subject": "Weekly correspondence",
          "sender": "sam@example.test",
          "to": "team@example.test",
          "timestamp": "2026-10-05T10:00:00Z",
          "body": "I will deliver the access guide by 9 October at 09:00 UTC.",
          "truncated": false,
          "omittedChars": 0
        },
        {
          "id": "validate-02-m2",
          "threadId": "validate-02-t1",
          "subject": "Weekly correspondence",
          "sender": "kim@example.test",
          "to": "sam@example.test",
          "timestamp": "2026-10-06T10:00:00Z",
          "body": "Could we move the access guide to next week? This is a suggestion, not an agreed change.",
          "truncated": false,
          "omittedChars": 0
        },
        {
          "id": "validate-02-m3",
          "threadId": "validate-02-t1",
          "subject": "Weekly correspondence",
          "sender": "sam@example.test",
          "to": "team@example.test",
          "timestamp": "2026-10-07T10:00:00Z",
          "body": "I have not agreed to change the access guide deadline. My existing commitment remains 9 October at 09:00 UTC.",
          "truncated": false,
          "omittedChars": 0
        }
      ]
    },
    "snapshotHash": "cc55d62b0392a365c9d78272e80666aea954eaf3a70645eb300ee2692524ba9a",
    "oracle": {
      "caseId": "validate-02",
      "items": [
        {
          "key": "guide",
          "titleTerms": [
            "access guide"
          ],
          "owner": "sam@example.test",
          "state": "due",
          "dueAt": "2026-10-09T09:00:00Z",
          "changed": false,
          "evidence": [
            {
              "messageId": "validate-02-m1",
              "quote": "I will deliver the access guide by 9 October at 09:00 UTC."
            },
            {
              "messageId": "validate-02-m3",
              "quote": "My existing commitment remains 9 October at 09:00 UTC."
            }
          ],
          "priorEvidence": []
        }
      ]
    }
  }
});

export const WORKFLOW_VALIDATION_SUITE = freeze({
  "id": "commitment-validation.v1",
  "workflowId": "mail.commitment-handoff.v1",
  "revision": "1",
  "split": "validation",
  "caseIds": [
    "validate-01",
    "validate-02"
  ],
  "checkIds": [
    "contract.valid",
    "oracle.items",
    "oracle.state",
    "oracle.owner",
    "oracle.due",
    "oracle.change",
    "oracle.evidence",
    "oracle.prior-evidence"
  ],
  "learningManifestHash": "133d6eea31bd111e0ac0a84fc21e98a360a028cadc90515aa443bc3f1bf8ebca",
  "validationManifestHash": "a342395607ba5ce235200154e0c0f9570e4772bd6aa0862dac16c98fd70ae8f8",
  "suiteHash": "cd1a8becafc43c93599c968cb2ec6674d93395dfde9a7b16b4d852a1760692c2"
});

export interface WorkflowCaseScore {
  caseId: string;
  inputHash: string;
  outputHash: string;
  assurance: "synthetic-oracle";
  semanticVerified: false;
  oraclePassed: boolean;
  contractValid: boolean;
  expectedItems: number;
  matchedItems: number;
  checks: Array<{ checkId: string; passed: boolean }>;
  corrections: Array<{ itemKey: string; field: string; reason: string }>;
  error: string | null;
}
export interface WorkflowSuiteResult {
  suiteId: string;
  suiteHash: string;
  assurance: "synthetic-oracle";
  modelEfficacyMeasured: false;
  passed: boolean;
  cases: WorkflowCaseScore[];
}

export function listWorkflowFixtures(): readonly WorkflowFixtureMetadata[] {
  return freeze(Object.values(FIXTURES).map(({ metadata }) => ({ ...metadata })));
}

export async function getWorkflowFixture(id: string): Promise<CommitmentSnapshot | undefined> {
  if (!Object.hasOwn(FIXTURES, id)) return undefined;
  const fixture = FIXTURES[id]!;
  const snapshot = await createCommitmentSnapshot(fixture.draft);
  if (snapshot.snapshotHash !== fixture.snapshotHash) throw new Error("Host fixture hash drift");
  return snapshot;
}

export function getWorkflowValidationSuite(id: string): typeof WORKFLOW_VALIDATION_SUITE | undefined {
  return id === WORKFLOW_VALIDATION_SUITE.id ? WORKFLOW_VALIDATION_SUITE : undefined;
}

function covered(snapshot: CommitmentSnapshot, evidence: CommitmentEvidence[], anchor: OracleAnchor): boolean {
  const source = snapshot.messages.find((message) => message.id === anchor.messageId);
  if (!source || anchor.quote.length === 0) return false;
  const start = source.body.indexOf(anchor.quote);
  // The oracle must identify one unambiguous location, not a word occurring twice.
  if (start < 0 || source.body.indexOf(anchor.quote, start + 1) !== -1) return false;
  return evidence.some((ref) => ref.messageId === anchor.messageId && ref.start <= start && ref.end >= start + anchor.quote.length);
}
function sameOwner(actual: string | null, expected: string | null, snapshot: CommitmentSnapshot): boolean {
  if (actual === null || expected === null) return actual === expected;
  const normalized = actual.trim().toLowerCase();
  return normalized === expected.toLowerCase() ||
    (expected.toLowerCase() === snapshot.userAddress.toLowerCase() && (normalized === "me" || normalized === "the user"));
}
function sameInstant(actual: string | null, expected: string | null): boolean {
  return actual === null || expected === null ? actual === expected : Date.parse(actual) === Date.parse(expected);
}

/**
 * Deterministic authored-field oracle. It checks real output, not candidate PASS.
 * It does NOT judge free-form prose/entailment; real efficacy needs blinded review.
 * This accepts an oracle only as a host programming API, never a wire parameter.
 */
export async function scoreWorkflowCase(
  snapshot: CommitmentSnapshot,
  raw: unknown,
  oracle: CommitmentOracle,
): Promise<WorkflowCaseScore> {
  if (oracle.caseId !== snapshot.snapshotId) throw new Error("Oracle/snapshot mismatch");
  const validated = await validateCommitmentLedger(snapshot, raw);
  const outputHash = await hashWorkflowText(JSON.stringify(raw) ?? "null");
  const corrections: WorkflowCaseScore["corrections"] = [];
  const checks = new Map<string, boolean>(WORKFLOW_VALIDATION_SUITE.checkIds.map((id) => [id, true]));
  checks.set("contract.valid", validated.ok);
  if (!validated.ok) {
    for (const id of checks.keys()) checks.set(id, false);
    corrections.push({ itemKey: "report", field: "contract", reason: "Output failed shared schema/source/coverage checks" });
    return freeze({ caseId: oracle.caseId, inputHash: snapshot.snapshotHash, outputHash,
      assurance: "synthetic-oracle", semanticVerified: false, oraclePassed: false, contractValid: false,
      expectedItems: oracle.items.length, matchedItems: 0,
      checks: [...checks].map(([checkId, passed]) => ({ checkId, passed })), corrections, error: null });
  }
  const ledger = validated.value;
  const used = new Set<number>();
  for (const expected of oracle.items) {
    const matches = ledger.items.map((item, index) => ({ item, index })).filter(({ item }) =>
      expected.titleTerms.some((term) => item.title.toLowerCase().includes(term.toLowerCase())));
    if (matches.length !== 1 || used.has(matches[0]!.index)) {
      checks.set("oracle.items", false);
      corrections.push({ itemKey: expected.key, field: "item", reason: matches.length === 0 ? "Missing item or unmatched authored title" : "Ambiguous/duplicate item match" });
      continue;
    }
    const { item, index } = matches[0]!;
    used.add(index);
    const conditions: Array<[string, string, boolean]> = [
      ["oracle.state", "state", item.state === expected.state],
      ["oracle.owner", "owner", sameOwner(item.owner, expected.owner, snapshot)],
      ["oracle.due", "dueAt", sameInstant(item.dueAt, expected.dueAt)],
      ["oracle.change", "changed", item.changed === expected.changed],
      ["oracle.evidence", "evidence", expected.evidence.every((ref) => covered(snapshot, item.evidence, ref))],
      ["oracle.prior-evidence", "priorEvidence", expected.priorEvidence.every((ref) => covered(snapshot, item.priorEvidence, ref))],
    ];
    for (const [checkId, field, passed] of conditions) {
      if (!passed) {
        checks.set(checkId, false);
        corrections.push({ itemKey: expected.key, field, reason: "Does not satisfy the pre-authored fixture oracle" });
      }
    }
  }
  for (const [index, item] of ledger.items.entries()) {
    if (!used.has(index)) {
      checks.set("oracle.items", false);
      corrections.push({ itemKey: item.itemId, field: "item", reason: "Spurious or unmatched item" });
    }
  }
  return freeze({ caseId: oracle.caseId, inputHash: snapshot.snapshotHash, outputHash,
    assurance: "synthetic-oracle", semanticVerified: false, oraclePassed: [...checks.values()].every(Boolean),
    contractValid: true, expectedItems: oracle.items.length, matchedItems: used.size,
    checks: [...checks].map(([checkId, passed]) => ({ checkId, passed })), corrections, error: null });
}

/** Host-selected suite. The callback sees source input/case id, never the oracle. */
export async function evaluateWorkflowSuite(
  suiteId: string,
  runCase: (snapshot: CommitmentSnapshot, caseId: string) => Promise<unknown>,
): Promise<WorkflowSuiteResult> {
  const suite = getWorkflowValidationSuite(suiteId);
  if (!suite) throw new Error("Unknown host-registered workflow validation suite");
  const scores: WorkflowCaseScore[] = [];
  for (const caseId of suite.caseIds) {
    const record = FIXTURES[caseId]!;
    const snapshot = await getWorkflowFixture(caseId);
    if (!snapshot) throw new Error("Registered suite source is missing");
    try {
      scores.push(await scoreWorkflowCase(snapshot, await runCase(snapshot, caseId), record.oracle));
    } catch (error) {
      scores.push(freeze({ caseId, inputHash: snapshot.snapshotHash,
        outputHash: await hashWorkflowText("workflow-case-error"), assurance: "synthetic-oracle", semanticVerified: false,
        oraclePassed: false, contractValid: false, expectedItems: record.oracle.items.length, matchedItems: 0,
        checks: suite.checkIds.map((checkId) => ({ checkId, passed: false })),
        corrections: [], error: error instanceof Error ? error.message.slice(0, 500) : "Case callback failed" }));
    }
  }
  return freeze({ suiteId: suite.id, suiteHash: suite.suiteHash, assurance: "synthetic-oracle",
    modelEfficacyMeasured: false, passed: scores.length === suite.caseIds.length && scores.every((score) => score.oraclePassed), cases: scores });
}

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
  "learn-03": {
    "metadata": {
      "id": "learn-03",
      "split": "learning",
      "title": "Field visit correspondence"
    },
    "draft": {
      "workflowId": "mail.commitment-handoff.v1",
      "schemaVersion": 1,
      "snapshotId": "learn-03",
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
          "id": "learn-03-m1",
          "threadId": "learn-03-t1",
          "subject": "Field visit preparation",
          "sender": "sam@example.test",
          "to": "team@example.test",
          "timestamp": "2026-10-05T10:00:00Z",
          "body": "I will deliver the trail briefing on Wednesday 14 October. We have not set a time of day.",
          "truncated": false,
          "omittedChars": 0
        },
        {
          "id": "learn-03-m2",
          "threadId": "learn-03-t2",
          "subject": "Route survey",
          "sender": "taylor@example.test",
          "to": "sam@example.test",
          "timestamp": "2026-10-06T10:00:00Z",
          "body": "I will send you the route survey by 13 October at 16:00 UTC so you can finish the trail briefing.",
          "truncated": false,
          "omittedChars": 0
        },
        {
          "id": "learn-03-m3",
          "threadId": "learn-03-t1",
          "subject": "Field visit preparation",
          "sender": "ren@example.test",
          "to": "sam@example.test",
          "timestamp": "2026-10-07T10:00:00Z",
          "body": "Could the trail briefing be ready at 09:00 on the Wednesday? The visit team would prefer morning.",
          "truncated": false,
          "omittedChars": 0
        },
        {
          "id": "learn-03-m4",
          "threadId": "learn-03-t1",
          "subject": "Field visit preparation",
          "sender": "sam@example.test",
          "to": "team@example.test",
          "timestamp": "2026-10-08T10:00:00Z",
          "body": "Wednesday 14 October still works for the trail briefing, but I cannot promise 09:00. Let us leave the time open; the route survey has not arrived yet.",
          "truncated": false,
          "omittedChars": 0
        }
      ]
    },
    "snapshotHash": "901c225afbd615125fe24d57b8b4679e3ba8c6e302f34d68bbd14bd617bb159b",
    "oracle": {
      "caseId": "learn-03",
      "items": [
        {
          "key": "briefing",
          "titleTerms": [
            "trail briefing"
          ],
          "owner": "sam@example.test",
          "state": "due",
          "dueAt": null,
          "changed": false,
          "evidence": [
            {
              "messageId": "learn-03-m1",
              "quote": "I will deliver the trail briefing on Wednesday 14 October. We have not set a time of day."
            },
            {
              "messageId": "learn-03-m4",
              "quote": "Wednesday 14 October still works for the trail briefing, but I cannot promise 09:00. Let us leave the time open;"
            }
          ],
          "priorEvidence": []
        },
        {
          "key": "survey",
          "titleTerms": [
            "route survey"
          ],
          "owner": "taylor@example.test",
          "state": "waiting",
          "dueAt": "2026-10-13T16:00:00Z",
          "changed": false,
          "evidence": [
            {
              "messageId": "learn-03-m2",
              "quote": "I will send you the route survey by 13 October at 16:00 UTC so you can finish the trail briefing."
            }
          ],
          "priorEvidence": []
        }
      ]
    }
  },
  "learn-04": {
    "metadata": {
      "id": "learn-04",
      "split": "learning",
      "title": "Archive correspondence"
    },
    "draft": {
      "workflowId": "mail.commitment-handoff.v1",
      "schemaVersion": 1,
      "snapshotId": "learn-04",
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
          "id": "learn-04-m1",
          "threadId": "learn-04-t1",
          "subject": "Repository archive",
          "sender": "sam@example.test",
          "to": "team@example.test",
          "timestamp": "2026-10-05T10:00:00Z",
          "body": "I will prepare the migration note by 13 October at 14:00 UTC.",
          "truncated": false,
          "omittedChars": 0
        },
        {
          "id": "learn-04-m2",
          "threadId": "learn-04-t2",
          "subject": "Archive index",
          "sender": "sam@example.test",
          "to": "team@example.test",
          "timestamp": "2026-10-06T10:00:00Z",
          "body": "Forwarding Devon’s message for our archive:\nFrom: devon@example.test\n> I will send Sam the archive index by 12 October at 11:00 UTC.\nI need that index for our records; the quoted promise is Devon’s.",
          "truncated": false,
          "omittedChars": 0
        },
        {
          "id": "learn-04-m3",
          "threadId": "learn-04-t2",
          "subject": "Archive index",
          "sender": "devon@example.test",
          "to": "sam@example.test",
          "timestamp": "2026-10-07T10:00:00Z",
          "body": "Yes, the archive index is mine. I will send it to you on 12 October at 11:00 UTC.",
          "truncated": false,
          "omittedChars": 0
        },
        {
          "id": "learn-04-m4",
          "threadId": "learn-04-t1",
          "subject": "Repository archive",
          "sender": "sam@example.test",
          "to": "team@example.test",
          "timestamp": "2026-10-08T10:00:00Z",
          "body": "The migration note has been delivered and accepted. I have no remaining work on that note.",
          "truncated": false,
          "omittedChars": 0
        },
        {
          "id": "learn-04-m5",
          "threadId": "learn-04-t1",
          "subject": "Repository archive",
          "sender": "archive-receipts@example.test",
          "to": "sam@example.test",
          "timestamp": "2026-10-09T08:00:00Z",
          "body": "Receipt 714 records the accepted migration note. The archive index was not part of this receipt.",
          "truncated": false,
          "omittedChars": 0
        }
      ]
    },
    "snapshotHash": "833c20edd50529b602d2cdafc8ebe31b3f2bdae477112f4248ec5d5a3d0155e3",
    "oracle": {
      "caseId": "learn-04",
      "items": [
        {
          "key": "migration",
          "titleTerms": [
            "migration note"
          ],
          "owner": "sam@example.test",
          "state": "closed",
          "dueAt": null,
          "changed": false,
          "evidence": [
            {
              "messageId": "learn-04-m4",
              "quote": "The migration note has been delivered and accepted. I have no remaining work on that note."
            }
          ],
          "priorEvidence": []
        },
        {
          "key": "index",
          "titleTerms": [
            "archive index"
          ],
          "owner": "devon@example.test",
          "state": "waiting",
          "dueAt": "2026-10-12T11:00:00Z",
          "changed": false,
          "evidence": [
            {
              "messageId": "learn-04-m3",
              "quote": "Yes, the archive index is mine. I will send it to you on 12 October at 11:00 UTC."
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
  },
  "validate-03": {
    "metadata": {
      "id": "validate-03",
      "split": "validation",
      "title": "Radio correspondence"
    },
    "draft": {
      "workflowId": "mail.commitment-handoff.v1",
      "schemaVersion": 1,
      "snapshotId": "validate-03",
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
          "id": "validate-03-m1",
          "threadId": "validate-03-t1",
          "subject": "Community radio handover",
          "sender": "sam@example.test",
          "to": "team@example.test",
          "timestamp": "2026-10-05T10:00:00Z",
          "body": "I will hand over the sound-check log by 12 October at 18:00 UTC.",
          "truncated": false,
          "omittedChars": 0
        },
        {
          "id": "validate-03-m2",
          "threadId": "validate-03-t1",
          "subject": "Community radio handover",
          "sender": "robin@example.test",
          "to": "sam@example.test",
          "timestamp": "2026-10-06T10:00:00Z",
          "body": "I can take over the sound-check log if you confirm. The Monday deadline is workable for me.",
          "truncated": false,
          "omittedChars": 0
        },
        {
          "id": "validate-03-m3",
          "threadId": "validate-03-t1",
          "subject": "Community radio handover",
          "sender": "sam@example.test",
          "to": "team@example.test",
          "timestamp": "2026-10-07T10:00:00Z",
          "body": "Robin, please take over the sound-check log and send it to me for the station records. Once you accept, I will no longer be its owner.",
          "truncated": false,
          "omittedChars": 0
        },
        {
          "id": "validate-03-m4",
          "threadId": "validate-03-t1",
          "subject": "Community radio handover",
          "sender": "robin@example.test",
          "to": "sam@example.test",
          "timestamp": "2026-10-08T10:00:00Z",
          "body": "Accepted. The sound-check log is mine, and I will deliver it to you by 12 October at 18:00 UTC.",
          "truncated": false,
          "omittedChars": 0
        }
      ]
    },
    "snapshotHash": "cd025a31c972fb3478fab9aba4707d48443613353c1dc84318ad269f36802320",
    "oracle": {
      "caseId": "validate-03",
      "items": [
        {
          "key": "log",
          "titleTerms": [
            "sound-check log",
            "sound check log"
          ],
          "owner": "robin@example.test",
          "state": "waiting",
          "dueAt": "2026-10-12T18:00:00Z",
          "changed": true,
          "evidence": [
            {
              "messageId": "validate-03-m4",
              "quote": "Accepted. The sound-check log is mine, and I will deliver it to you by 12 October at 18:00 UTC."
            }
          ],
          "priorEvidence": [
            {
              "messageId": "validate-03-m1",
              "quote": "I will hand over the sound-check log by 12 October at 18:00 UTC."
            }
          ]
        }
      ]
    }
  },
  "validate-04": {
    "metadata": {
      "id": "validate-04",
      "split": "validation",
      "title": "Tasting correspondence"
    },
    "draft": {
      "workflowId": "mail.commitment-handoff.v1",
      "schemaVersion": 1,
      "snapshotId": "validate-04",
      "userAddress": "sam@example.test",
      "cutoff": "2026-10-09T23:00:00Z",
      "timezone": "America/Los_Angeles",
      "coverage": {
        "scope": "supplied-snapshot",
        "source": "synthetic-fixture",
        "omittedMessages": 1,
        "note": "Authored synthetic correspondence. Not a live mailbox or a complete account export."
      },
      "messages": [
        {
          "id": "validate-04-m1",
          "threadId": "validate-04-t1",
          "subject": "Tasting preparation",
          "sender": "sam@example.test",
          "to": "team@example.test",
          "timestamp": "2026-10-05T10:00:00Z",
          "body": "I need the allergy matrix before the tasting. Could one of you prepare it? We have not assigned an owner or agreed a delivery time.",
          "truncated": false,
          "omittedChars": 0
        },
        {
          "id": "validate-04-m2",
          "threadId": "validate-04-t1",
          "subject": "Tasting preparation",
          "sender": "jo@example.test",
          "to": "sam@example.test",
          "timestamp": "2026-10-06T10:00:00Z",
          "body": "I could take the allergy matrix if the kitchen can first confirm",
          "truncated": true,
          "omittedChars": 143
        },
        {
          "id": "validate-04-m3",
          "threadId": "validate-04-t2",
          "subject": "Kitchen price list",
          "sender": "rowan@example.test",
          "to": "sam@example.test",
          "timestamp": "2026-10-07T10:00:00Z",
          "body": "The snack price list is already complete in the kitchen account. That list does not identify allergens; the allergy matrix is a separate document.",
          "truncated": false,
          "omittedChars": 0
        },
        {
          "id": "validate-04-m4",
          "threadId": "validate-04-t1",
          "subject": "Tasting preparation",
          "sender": "sam@example.test",
          "to": "team@example.test",
          "timestamp": "2026-10-08T10:00:00Z",
          "body": "No acceptance for the allergy matrix has reached me. I still need someone to confirm ownership and a delivery time.",
          "truncated": false,
          "omittedChars": 0
        }
      ]
    },
    "snapshotHash": "534a79003bd9b5b8306be4108d16fdca18e7b5cbbeccae3fb0b219ab1dd27ac0",
    "oracle": {
      "caseId": "validate-04",
      "items": [
        {
          "key": "matrix",
          "titleTerms": [
            "allergy matrix",
            "allergen matrix"
          ],
          "owner": null,
          "state": "uncertain",
          "dueAt": null,
          "changed": false,
          "evidence": [
            {
              "messageId": "validate-04-m1",
              "quote": "I need the allergy matrix before the tasting. Could one of you prepare it? We have not assigned an owner or agreed a delivery time."
            },
            {
              "messageId": "validate-04-m4",
              "quote": "No acceptance for the allergy matrix has reached me. I still need someone to confirm ownership and a delivery time."
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
  "revision": "2",
  "split": "validation",
  "caseIds": [
    "validate-01",
    "validate-02",
    "validate-03",
    "validate-04"
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
  "learningManifestHash": "848ca8ffb5817992ea08a5ad08b1bac1954d5f266b56027fef49ec8475820307",
  "validationManifestHash": "2b7d0c037771ea43e61d1de2a27a91ba9ed2fc0c93ab1fa2bd3497e79b892b95",
  "suiteHash": "379c8f74e8d9a7a5faf23ce7d38e677660e9cfa34d79f33bc9d81f55dc885705"
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

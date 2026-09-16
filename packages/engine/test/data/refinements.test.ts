// SPDX-License-Identifier: AGPL-3.0-only

import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { getUserAgentStub } from "../helpers/do-sql";
import { fixture, activate, CONTENT, proposal, OWNER } from "../refinements/fixture";
import * as store from "../../src/data/helpers/refinement-store";
import { countRows } from "../../src/data/helpers/table-counts";

describe("refinement storage invariants on real DO SQLite", () => {
  it("updates only lifecycle fields, never the immutable envelope/hash/lineage", async () => {
    await runInDurableObject(getUserAgentStub(), async (instance) => {
      const f = fixture(instance);
      const p = await f.manager.propose(proposal());
      const row = store.readVersion(f.sql, p.version.envelope.versionId)!;
      f.deps.transaction(() => store.updateVersionState(f.sql, { ...row, envelope_json: "mutated", version_hash: "mutated",
        family_id: "mutated", revision: 900, proposal_request_hash: "mutated" }));
      expect(store.readVersion(f.sql, row.id)).toEqual(row);
    });
  });
  it("enforces closed states, integer generation/revision, and one active version", async () => {
    await runInDurableObject(getUserAgentStub(), async (instance) => {
      const f = fixture(instance);
      const a = await activate(f.manager);
      const other = await f.manager.propose(proposal({ ...CONTENT, title: "Other" }));
      const id = other.version.envelope.versionId;
      expect(() => f.sql`UPDATE refinement_versions SET state = 'active' WHERE id = ${id}`).toThrow();
      expect(() => f.sql`UPDATE refinement_versions SET state = 'surprise' WHERE id = ${id}`).toThrow();
      expect(() => f.sql`UPDATE refinement_versions SET revision = 0 WHERE id = ${id}`).toThrow();
      expect(() => f.sql`UPDATE refinement_scopes SET generation = 1.5 WHERE scope_key = ${a.detail.version.scopeKey}`).toThrow();
      expect(() => f.sql`UPDATE refinement_scopes SET generation = -1 WHERE scope_key = ${a.detail.version.scopeKey}`).toThrow();
    });
  });
  it("has bounded keyset pages and restores version state in a fresh manager", async () => {
    const stub = getUserAgentStub();
    const ids = await runInDurableObject(stub, async (instance) => {
      const f = fixture(instance);
      const ids: string[] = [];
      for (let i = 0; i < 4; i++) {
        f.advance(1);
        ids.push((await f.manager.propose(proposal({ ...CONTENT, title: `Version ${i}` }))).version.envelope.versionId);
      }
      return ids;
    });
    await runInDurableObject(stub, (instance) => {
      const { manager } = fixture(instance);
      const first = manager.list({ userId: OWNER, limit: 2 });
      const next = manager.list({ userId: OWNER, limit: 2, cursor: first.nextCursor! });
      expect([...first.refinements, ...next.refinements].map((v) => v.envelope.versionId)).toEqual([...ids].reverse());
      expect(next.nextCursor).toBeNull();
      expect(() => manager.list({ userId: OWNER, limit: 51 })).toThrow();
      expect(manager.get(ids[0]!).version.state).toBe("proposed");
    });
  });

  it("counts all new tables without changing existing table counts", async () => {
    await runInDurableObject(getUserAgentStub(), async (instance) => {
      const f = fixture(instance);
      for (const table of ["refinement_versions", "refinement_validations", "refinement_scopes"] as const)
        expect(countRows(f.sql, table)).toBe(0);
      const policyBefore = countRows(f.sql, "policy_entries");
      const sessionsBefore = countRows(f.sql, "session_state");
      const first = await activate(f.manager);
      expect(countRows(f.sql, "refinement_versions")).toBe(1);
      expect(countRows(f.sql, "refinement_validations")).toBe(1);
      expect(countRows(f.sql, "refinement_scopes")).toBe(1);
      await f.manager.propose(proposal({ ...CONTENT, title: "New revision" }, first.activated.versionId));
      expect(countRows(f.sql, "refinement_versions")).toBe(2);
      expect(countRows(f.sql, "refinement_validations")).toBe(1);
      expect(countRows(f.sql, "refinement_scopes")).toBe(1);
      expect(countRows(f.sql, "policy_entries")).toBe(policyBefore);
      expect(countRows(f.sql, "session_state")).toBe(sessionsBefore);
    });
  });
});

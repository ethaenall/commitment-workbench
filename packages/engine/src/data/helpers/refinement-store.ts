// SPDX-License-Identifier: AGPL-3.0-only

/** Single-table, bound SQL only. The manager owns transactions and JSON validation. */
import type { EngineSql } from "./types";
import type { RefinementVersionsRow } from "../schemas/refinement-versions";
import type { RefinementValidationsRow } from "../schemas/refinement-validations";
import type { RefinementScopesRow } from "../schemas/refinement-scopes";

export function readVersion(sql: EngineSql, id: string): RefinementVersionsRow | null {
  return sql<RefinementVersionsRow>`SELECT * FROM refinement_versions WHERE id = ${id}`[0] ?? null;
}
export function readProposal(sql: EngineSql, hash: string): RefinementVersionsRow | null {
  return sql<RefinementVersionsRow>`SELECT * FROM refinement_versions WHERE proposal_request_hash = ${hash}`[0] ?? null;
}
export function versionCount(sql: EngineSql): number {
  return sql<{ n: number }>`SELECT COUNT(*) AS n FROM refinement_versions`[0]?.n ?? 0;
}
export function nextRevision(sql: EngineSql, familyId: string): number {
  return (sql<{ n: number }>`SELECT MAX(revision) AS n FROM refinement_versions WHERE family_id = ${familyId}`[0]?.n ?? 0) + 1;
}
export function insertVersion(sql: EngineSql, row: RefinementVersionsRow): void {
  sql`INSERT INTO refinement_versions
    (id, family_id, revision, parent_id, scope_key, version_hash, proposal_request_hash, envelope_json, state,
     latest_attempt_id, validated_attempt_id, approval_audit_id, last_transition_audit_id,
     last_transition_json, created_at, updated_at)
    VALUES (${row.id}, ${row.family_id}, ${row.revision}, ${row.parent_id}, ${row.scope_key},
     ${row.version_hash}, ${row.proposal_request_hash}, ${row.envelope_json}, ${row.state}, ${row.latest_attempt_id},
     ${row.validated_attempt_id}, ${row.approval_audit_id}, ${row.last_transition_audit_id},
     ${row.last_transition_json}, ${row.created_at}, ${row.updated_at})`;
}
export function updateVersionState(sql: EngineSql, row: RefinementVersionsRow): void {
  // Immutable identity, content, provenance and hash are deliberately absent.
  sql`UPDATE refinement_versions SET state = ${row.state}, latest_attempt_id = ${row.latest_attempt_id},
    validated_attempt_id = ${row.validated_attempt_id}, approval_audit_id = ${row.approval_audit_id},
    last_transition_audit_id = ${row.last_transition_audit_id}, last_transition_json = ${row.last_transition_json},
    updated_at = ${row.updated_at} WHERE id = ${row.id}`;
}
export function listVersions(sql: EngineSql, limit: number, scopeKey: string | null,
  cursor: { createdAt: string; id: string } | null): RefinementVersionsRow[] {
  const date = cursor?.createdAt ?? null;
  const id = cursor?.id ?? null;
  return sql<RefinementVersionsRow>`SELECT * FROM refinement_versions
    WHERE (${scopeKey} IS NULL OR scope_key = ${scopeKey})
    AND (${date} IS NULL OR created_at < ${date} OR (created_at = ${date} AND id < ${id}))
    ORDER BY created_at DESC, id DESC LIMIT ${limit}`;
}
export function readScope(sql: EngineSql, key: string): RefinementScopesRow | null {
  return sql<RefinementScopesRow>`SELECT * FROM refinement_scopes WHERE scope_key = ${key}`[0] ?? null;
}
export function insertScope(sql: EngineSql, key: string): void {
  sql`INSERT OR IGNORE INTO refinement_scopes (scope_key, active_version_id, generation,
    last_transition_audit_id, last_transition_json) VALUES (${key}, NULL, 0, NULL, NULL)`;
}
export function updateScope(sql: EngineSql, row: RefinementScopesRow): void {
  sql`UPDATE refinement_scopes SET active_version_id = ${row.active_version_id}, generation = ${row.generation},
    last_transition_audit_id = ${row.last_transition_audit_id}, last_transition_json = ${row.last_transition_json}
    WHERE scope_key = ${row.scope_key}`;
}
export function readValidation(sql: EngineSql, id: string): RefinementValidationsRow | null {
  return sql<RefinementValidationsRow>`SELECT * FROM refinement_validations WHERE id = ${id}`[0] ?? null;
}
export function listValidations(sql: EngineSql, versionId: string): RefinementValidationsRow[] {
  return sql<RefinementValidationsRow>`SELECT * FROM refinement_validations WHERE version_id = ${versionId}
    ORDER BY started_at DESC, id DESC LIMIT 33`;
}
export function insertValidation(sql: EngineSql, row: RefinementValidationsRow): void {
  sql`INSERT INTO refinement_validations
    (id, version_id, version_hash, status, assurance, bindings_json, report_json, report_hash,
     reason, started_at, deadline_at, completed_at)
    VALUES (${row.id}, ${row.version_id}, ${row.version_hash}, ${row.status}, ${row.assurance},
     ${row.bindings_json}, ${row.report_json}, ${row.report_hash}, ${row.reason}, ${row.started_at},
     ${row.deadline_at}, ${row.completed_at})`;
}
export function finishValidation(sql: EngineSql, row: RefinementValidationsRow): boolean {
  // Terminal receipts cannot be rewritten, including by a late timed-out runner.
  return sql<{ id: string }>`UPDATE refinement_validations SET status = ${row.status}, assurance = ${row.assurance},
    report_json = ${row.report_json}, report_hash = ${row.report_hash}, reason = ${row.reason},
    completed_at = ${row.completed_at} WHERE id = ${row.id} AND status = 'running' RETURNING id`.length === 1;
}

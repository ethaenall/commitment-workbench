// SPDX-License-Identifier: AGPL-3.0-only

import { createHash } from "node:crypto";
import { RefinementError } from "./errors";

/** Canonical JSON v1: sorted own keys, ordered arrays, no coercion or custom toJSON. */
export function canonicalJson(value: unknown): string {
  const seen = new Set<object>();
  const walk = (v: unknown, depth: number): string => {
    if (depth > 32) throw new RefinementError("REFINEMENT_INVALID_REQUEST");
    if (v === null) return "null";
    if (typeof v === "string") {
      if (!v.isWellFormed()) throw new RefinementError("REFINEMENT_INVALID_REQUEST");
      return JSON.stringify(v);
    }
    if (typeof v === "boolean") return String(v);
    if (typeof v === "number" && Number.isFinite(v)) return JSON.stringify(v);
    if (typeof v !== "object" || seen.has(v)) throw new RefinementError("REFINEMENT_INVALID_REQUEST");
    seen.add(v);
    try {
      if (Array.isArray(v)) {
        if (Object.keys(v).length !== v.length) throw new RefinementError("REFINEMENT_INVALID_REQUEST");
        return "[" + v.map((item) => walk(item, depth + 1)).join(",") + "]";
      }
      if (Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null)
        throw new RefinementError("REFINEMENT_INVALID_REQUEST");
      const obj = v as Record<string, unknown>;
      return "{" + Object.keys(obj).sort().map((key) => walk(key, depth + 1) + ":" + walk(obj[key], depth + 1)).join(",") + "}";
    } finally { seen.delete(v); }
  };
  return walk(value, 0);
}

export function refinementHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

/** A clone prevents a trusted runner accidentally editing the caller's live objects. */
export function frozenClone<T>(value: T): T {
  const clone = JSON.parse(canonicalJson(value)) as T;
  const freeze = (v: unknown): void => {
    if (v !== null && typeof v === "object") {
      for (const item of Object.values(v)) freeze(item);
      Object.freeze(v);
    }
  };
  freeze(clone);
  return clone;
}

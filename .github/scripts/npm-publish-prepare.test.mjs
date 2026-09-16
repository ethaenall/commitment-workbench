// SPDX-License-Identifier: AGPL-3.0-only
// File-only coverage for the published-manifest contract. Do not import or
// execute the publish/smoke drivers: packing, installation and registry access
// are separate gates. Staged manifests below use task-owned temporary paths.

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { ADDED_ENTRIES, ENTRY_TABLE, transformManifest } from "./npm-publish-prepare.mjs";

const packagesRoot = fileURLToPath(new URL("../../packages/", import.meta.url));
const packages = readdirSync(packagesRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && existsSync(join(packagesRoot, entry.name, "package.json")))
  .map((entry) => entry.name)
  .sort();
const manifests = Object.fromEntries(packages.map((pkg) => [
  pkg, JSON.parse(readFileSync(join(packagesRoot, pkg, "package.json"), "utf8")),
]));

function entryNames(manifest) {
  const exports = manifest.exports ?? {};
  assert.equal(typeof exports, "object", "conditional/string exports need an explicit coverage rule");
  assert.ok(!Array.isArray(exports), "exports must be a subpath map");
  for (const key of Object.keys(exports)) {
    assert.ok(key === "." || key.startsWith("./"), `not a subpath export: ${key}`);
  }
  return [
    ...["main", "types"].filter((key) => Object.hasOwn(manifest, key)),
    ...Object.keys(exports),
  ].sort();
}

function stageManifest(t, manifest) {
  const dir = mkdtempSync(join(tmpdir(), "habenula-publish-prepare-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "package.json"), JSON.stringify(manifest, null, 2) + "\n");
  return dir;
}

test("entry-table rows match all workspace package manifests", () => {
  assert.ok(packages.length > 0, "workspace inventory must not be empty");
  assert.deepEqual(Object.keys(ENTRY_TABLE).sort(), packages);
  for (const pkg of Object.keys(ADDED_ENTRIES)) {
    assert.ok(Object.hasOwn(ENTRY_TABLE, pkg), `addition for an unknown package: ${pkg}`);
  }
});

for (const pkg of packages) {
  test(`${pkg}: published entries exactly cover committed entries and deliberate additions`, () => {
    const manifest = manifests[pkg];
    const row = ENTRY_TABLE[pkg];
    assert.ok(row, `missing entry-table row: ${pkg}`);
    assert.ok(Object.keys(row).every((key) => ["main", "types", "exports"].includes(key)));
    const committed = entryNames(manifest);
    const additions = ADDED_ENTRIES[pkg] ?? [];
    assert.equal(new Set(additions).size, additions.length, "duplicate declared addition");
    for (const key of additions) {
      assert.ok(!committed.includes(key), `${key} is committed, not a deliberate addition`);
    }
    assert.deepEqual(entryNames(row), [...committed, ...additions].sort());
    for (const [subpath, target] of Object.entries(manifest.exports ?? {})) {
      assert.equal(typeof target, "string");
      assert.match(target, /^\.\/src\/.+\.ts$/, "new source-target shapes require explicit review");
      const distTarget = target.replace(/^\.\/src\//, "./dist/").replace(/\.ts$/, ".js");
      assert.equal(row.exports[subpath], distTarget, `${pkg}${subpath}: wrong dist target`);
    }
  });
}

test("contracts retain the refinements and workflows published subpaths", () => {
  assert.equal(ENTRY_TABLE.contracts.exports["./refinements"], "./dist/refinements.js");
  assert.equal(ENTRY_TABLE.contracts.exports["./workflows"], "./dist/workflows.js");
  assert.deepEqual(ADDED_ENTRIES.contracts, ["main", "types"]);
});

for (const pkg of packages) {
  test(`${pkg}: transform only changes private, scripts and declared entry fields`, (t) => {
    const original = structuredClone(manifests[pkg]);
    const dir = stageManifest(t, original);
    const expected = { ...original, ...ENTRY_TABLE[pkg], private: false };
    delete expected.scripts;
    const actual = transformManifest(dir, pkg);
    assert.deepEqual(actual, expected);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, "package.json"), "utf8")), expected);
    assert.deepEqual(original, manifests[pkg], "source manifest was mutated");
    assert.deepEqual(transformManifest(dir, pkg), expected, "transform must be idempotent");
  });
}

test("unknown package refuses before changing its staged manifest", (t) => {
  const dir = stageManifest(t, { name: "synthetic-unknown", version: "0.0.0", private: true });
  const path = join(dir, "package.json");
  const before = readFileSync(path, "utf8");
  assert.throws(() => transformManifest(dir, "synthetic-unknown"), /no entry-table row/);
  assert.equal(readFileSync(path, "utf8"), before);
});

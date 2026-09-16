#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Stage the reviewed local runtime. Never installs, downloads, or runs a Worker.
import { createHash } from "node:crypto";
import { copyFileSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const RLM_RUNTIME_FILES = Object.freeze(["worker.mjs", "read-evidence.mjs", "protocol.mjs", "timing-policy.mjs", "node-backend.mjs"]);
export const RLM_DECLARATION_FILES = Object.freeze(["protocol.d.mts", "timing-policy.d.mts", "node-backend.d.mts"]);
// Exact existing 0.31.0 ESM/wasm distribution. The hashes are reviewed cache
// inputs, not a claim that this build downloaded or audited upstream releases.
export const RLM_VENDOR_PINS = Object.freeze({
  "@jitl/quickjs-ffi-types/LICENSE": {
    "bytes": 1102,
    "sha256": "3c6040aa318612a234cc951609b640c0c63d85ae5a98a9330d3116f1553a79db"
  },
  "@jitl/quickjs-ffi-types/dist/index.mjs": {
    "bytes": 1113,
    "sha256": "5b6ccfe50a0d0066411135c66964b0c15c05167f5324df2e8066493da807efbe"
  },
  "@jitl/quickjs-ffi-types/package.json": {
    "bytes": 768,
    "sha256": "475f8922fe1c05fe72e45b522435e454ada00c4fb30f314f6b046e3b8019be1e"
  },
  "@jitl/quickjs-wasmfile-release-sync/LICENSE": {
    "bytes": 2263,
    "sha256": "446a69ae534aa8612d8b16d3bfc670c5a5050597dca3ce9820441a60d5d04fbb"
  },
  "@jitl/quickjs-wasmfile-release-sync/dist/emscripten-module.mjs": {
    "bytes": 13855,
    "sha256": "6bf1809753d4ac49c92dd0d83f526144918e8ec9d8d54c4fedc6149d065c3636"
  },
  "@jitl/quickjs-wasmfile-release-sync/dist/emscripten-module.wasm": {
    "bytes": 518880,
    "sha256": "0c031dd404df00f2d1ed9491a6590d014e88a50424996e5fd70feff1c931c045"
  },
  "@jitl/quickjs-wasmfile-release-sync/dist/ffi.mjs": {
    "bytes": 6185,
    "sha256": "f2b8db0c8ae5c4ef466ab0479fb3a6c236aa4dd822dba1b806de3407fa25dd67"
  },
  "@jitl/quickjs-wasmfile-release-sync/dist/index.mjs": {
    "bytes": 282,
    "sha256": "334f0e7eec1af1be0737f6bcaaa430656686843e29b91aa5e74c661708094538"
  },
  "@jitl/quickjs-wasmfile-release-sync/package.json": {
    "bytes": 1783,
    "sha256": "0bef43f23b3edecfb73d48a522d899b2c432542466ffcf8b101447bc67f1b2fa"
  },
  "quickjs-emscripten-core/LICENSE": {
    "bytes": 1102,
    "sha256": "3c6040aa318612a234cc951609b640c0c63d85ae5a98a9330d3116f1553a79db"
  },
  "quickjs-emscripten-core/dist/chunk-JTKJZQYV.mjs": {
    "bytes": 42271,
    "sha256": "291bc4ae003612f15b0a03ecbe3ab564f0afc165e6a68ebc953d302a29fb34e8"
  },
  "quickjs-emscripten-core/dist/chunk-PEXOKBOE.mjs": {
    "bytes": 3052,
    "sha256": "e0ec4b24bfaca56286b018c95051365646f319e1c6bbf7e350ba700fae0855c3"
  },
  "quickjs-emscripten-core/dist/index.mjs": {
    "bytes": 7103,
    "sha256": "7a2318b1483b9b5141df33b2b0609524fde413a63d60582dd6d7ec5a1eb0acff"
  },
  "quickjs-emscripten-core/dist/module-6F3E5H7Y.mjs": {
    "bytes": 277,
    "sha256": "45773fba6cf160d03b5a6769ba4ed46584e17c4b5a8d630d7b45a32bf4d9a087"
  },
  "quickjs-emscripten-core/package.json": {
    "bytes": 955,
    "sha256": "437440c7de6b21f3d560de033eb2ddc906db554e95708e1d44ee6c2716c5debc"
  }
});
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const engineRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function regularBytes(path) {
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`RLM_STAGE_INPUT_KIND: ${path}`);
  return readFileSync(path);
}
function contained(path, root) {
  const rel = relative(root, path);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}
function outputPath(root, rel) {
  const path = resolve(root, rel);
  if (!contained(path, root)) throw new Error("RLM_STAGE_OUTPUT_PATH");
  let current = root;
  for (const segment of relative(root, path).split(sep)) {
    try {
      if (lstatSync(current).isSymbolicLink()) throw new Error("RLM_STAGE_OUTPUT_SYMLINK");
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    current = join(current, segment);
  }
  try {
    const info = lstatSync(path);
    if (info.isSymbolicLink() || (info.isFile() && info.nlink !== 1)) throw new Error("RLM_STAGE_OUTPUT_LINK");
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  return path;
}

/** Read-only validation; callers can inspect the exact layout before staging. */
export function planRlmRuntimeStage(root = engineRoot) {
  root = realpathSync(root);
  const vendorRoot = resolve(root, "../../node_modules");
  const files = [...RLM_RUNTIME_FILES, ...RLM_DECLARATION_FILES].map((name) => {
    const source = join(root, "src/rlm", name);
    const bytes = regularBytes(source);
    return { source, path: `dist/rlm/${name}`, bytes: bytes.length, sha256: sha256(bytes) };
  });
  for (const [name, expected] of Object.entries(RLM_VENDOR_PINS)) {
    const source = join(vendorRoot, name);
    const bytes = regularBytes(source);
    if (bytes.length !== expected.bytes || sha256(bytes) !== expected.sha256) {
      throw new Error(`RLM_STAGE_VENDOR_IDENTITY: ${name}`);
    }
    files.push({ source, path: `dist/rlm/node_modules/${name}`, bytes: bytes.length, sha256: expected.sha256 });
  }
  const packages = ["quickjs-emscripten-core", "@jitl/quickjs-ffi-types", "@jitl/quickjs-wasmfile-release-sync"];
  const notice = "Habenula local RLM runtime — AGPL-3.0-only.\n" +
    "The following unmodified vendored packages are version 0.31.0.\n" +
    "These are their included license notices.\n\n" + packages.map((name) =>
      `===== ${name} 0.31.0 =====\n` + regularBytes(join(vendorRoot, name, "LICENSE")).toString("utf8")).join("\n\n");
  files.push({ source: null, path: "dist/rlm/NOTICE", bytes: Buffer.byteLength(notice), sha256: sha256(notice), content: notice });
  return { root, files };
}

export function stageRlmRuntime(root = engineRoot) {
  const plan = planRlmRuntimeStage(root); // All inputs checked before the first write.
  const outputs = plan.files.map((file) => ({ ...file, destination: outputPath(plan.root, file.path) }));
  for (const file of outputs) {
    mkdirSync(dirname(file.destination), { recursive: true });
    outputPath(plan.root, file.path);
    if (file.source === null) writeFileSync(file.destination, file.content, { flag: "w" });
    else {
      // Source identity is checked again before/after delivery, not inferred
      // from successful copy or from a stale plan.
      const before = regularBytes(file.source);
      if (before.length !== file.bytes || sha256(before) !== file.sha256) throw new Error("RLM_STAGE_SOURCE_DRIFT");
      copyFileSync(file.source, file.destination);
      const after = regularBytes(file.source);
      if (after.length !== file.bytes || sha256(after) !== file.sha256) throw new Error("RLM_STAGE_SOURCE_DRIFT");
    }
    const delivered = regularBytes(file.destination);
    if (delivered.length !== file.bytes || sha256(delivered) !== file.sha256) throw new Error("RLM_STAGE_OUTPUT_IDENTITY");
  }
  return outputs.map(({ path, bytes, sha256: hash }) => ({ path, bytes, sha256: hash }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const files = stageRlmRuntime();
  console.log(`[rlm-stage] ${files.length} files: 5 runtime MJS, 3 declaration sidecars, 15 pinned vendor assets, combined NOTICE`);
}

// SPDX-License-Identifier: AGPL-3.0-only
/** Private local function binding. This module creates no HTTP/TCP route. */
import { Worker as NodeWorker } from "node:worker_threads";
import { createRlmBindingHandler, type BindingBackend, type RlmBindingHandler } from "./rlm-binding.js";
import { createRlmNodeBackend, type RlmNodeOptions } from "../rlm/node-backend.mjs";
import * as protocol from "../rlm/protocol.mjs";

export interface RlmWorkerOptions { env: Record<string, string>; execArgv: string[]; }
/** Trusted local test/embedding dependencies; never read from a request. */
export type RlmHostDependencies<Timer = unknown> = Partial<RlmNodeOptions<Timer>>;

class LocalRlmWorker extends NodeWorker {
  constructor(_options: RlmWorkerOptions) {
    // Do not inherit loader arguments, secrets, provider environment, or a
    // HABENULA_RLM_WASM override. The staged private package resolves its WASM.
    super(new URL("../rlm/worker.mjs", import.meta.url), {
      env: {}, execArgv: [], stdout: true, stderr: true,
    });
  }
}

export function createRlmServiceBindings<Timer = unknown>(
  env: { GOVERNED_RLM?: string },
  dependencies: RlmHostDependencies<Timer> = {},
): { RLM_BACKEND?: RlmBindingHandler } {
  if (env.GOVERNED_RLM !== "true") return {};
  const backend: BindingBackend = createRlmNodeBackend({
    Worker: dependencies.Worker ?? LocalRlmWorker,
    ...(dependencies.clock === undefined ? {} : { clock: dependencies.clock }),
  });
  // Only the function becomes a Miniflare serviceBinding. No model/native
  // objects are serialized and Node has no final ledger/audit authority.
  return { RLM_BACKEND: createRlmBindingHandler({ backend, protocol }) };
}

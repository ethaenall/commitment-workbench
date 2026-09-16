// SPDX-License-Identifier: AGPL-3.0-only
// Local host factories only; these interfaces never become wire DTOs.
import type { BindingBackend, BindingSession } from "../daemon/rlm-binding.js";
import type { Limits, BindingTiming } from "./binding-protocol.js";
export interface RlmNodeWorker {
  postMessage(value: string): void;
  terminate(): Promise<unknown>;
  on(event: "message", listener: (value: unknown) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  on(event: "exit", listener: (code: number) => void): this;
}
export interface RlmNodeClock<Timer> {
  now(): number;
  setTimeout(callback: () => void, milliseconds: number): Timer;
  clearTimeout(timer: Timer): void;
}
export interface RlmNodeOptions<Timer = unknown> {
  Worker: new (options: { env: Record<string, string>; execArgv: string[] }) => RlmNodeWorker;
  clock?: RlmNodeClock<Timer>;
}
export interface RlmNodeBackendStatus {
  activeRunId: string | null;
  state: string;
  admissions: number;
  exits: number;
  liveWorkers: number;
  peakWorkers: number;
  history: unknown[];
}
export function backendStatus(): RlmNodeBackendStatus;
export function createRlmNodeBackend<Timer = unknown>(options: RlmNodeOptions<Timer>): BindingBackend & { backendStatus(): RlmNodeBackendStatus };
export function openSession<Timer = unknown>(options: RlmNodeOptions<Timer> & {
  context: string; limits?: Partial<Limits>; timing?: Partial<BindingTiming>; rootPrompt?: string | null;
}): BindingSession;
export { LIMITS } from "./protocol.mjs";
export { TIMING_CEILINGS } from "./timing-policy.mjs";

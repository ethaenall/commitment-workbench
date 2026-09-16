// SPDX-License-Identifier: AGPL-3.0-only
// Declarations for the checked DATA boundary. JSON/unchecked metrics stay unknown.
import type { Limits, BindingCommand, BindingIdentity, BindingTiming, WorkerCommand, InnerCommand,
  EventId, NodeId, ContextId, WorkerOp, BindingOp, WorkerReply } from "./binding-protocol.js";
import type { RlmHostEvidenceSnapshot } from "../workflows/rlm-host-types.js";
export const LIMITS: Readonly<Limits>;
export const PRIMITIVE_LIMITS: typeof LIMITS;
export const PRODUCTION_POLICY: typeof import("./binding-protocol.js").PRODUCTION_POLICY;
export class BoundaryError extends Error { readonly code: string; constructor(code: string); }
export function fail(code: string): never;
export function textBytes(value: unknown, cap: number, code?: string): number;
export function integer(value: unknown, min: number, max: number, code?: string): number;
export function keys(value: unknown, wanted: readonly string[]): void;
export function wire(value: unknown, cap?: number): string;
export function parseWire(value: string, cap?: number): unknown;
export function lowerLimits(value?: Readonly<Record<string, unknown>>): Readonly<Limits>;
export function fixedCode(error: unknown, fallback?: string): string;
export function validateHostEvidence(value: unknown, limits?: Readonly<Limits>): RlmHostEvidenceSnapshot;
export function readEvidenceHostSnapshot(value: unknown, limits?: Readonly<Limits>): RlmHostEvidenceSnapshot;
export const WORKER_OPS: readonly WorkerOp[];
export const BINDING_OPS: readonly BindingOp[];
export const BINDING_TIMING_KEYS: readonly (keyof BindingTiming)[];
export const INNER_COMMAND_OPS: readonly InnerCommand["op"][];
export const WORKER_COMMAND_KEYS: Readonly<Record<WorkerOp, readonly string[]>>;
export const WORKER_REPLY_OK_KEYS: readonly string[];
export const WORKER_REPLY_ERR_KEYS: readonly string[];
export const WORKER_READY_KEYS: readonly string[];
export const HOST_EVENT_KEYS: readonly string[];
export const BINDING_IDENTITY_KEYS: readonly (keyof BindingIdentity)[];
export const BINDING_HEADERS: typeof import("./binding-protocol.js").BINDING_HEADERS;
export function capForWorkerOp(op: string): number;
export function capForBindingOp(op: string): number;
export function implementableProductionLowers(): Readonly<Limits>;
export function assertPlainData<T>(value: T): T;
export function assertRunId(value: unknown): string;
export function assertEventId(value: unknown): EventId;
export function assertNodeId(value: unknown): NodeId;
export function assertContextId(value: unknown): ContextId;
export function identityToken(value: unknown, cap?: number): string;
export function encodeWorkerCommand(value: unknown): string;
export function parseWorkerCommand(value: string, cap: number): WorkerCommand;
export function encodeWorkerReply(value: unknown): string;
// Preserve the shared envelope union without claiming unchecked metric fields.
type UnknownMetrics<T> = T extends unknown ? { [Key in keyof T]: Key extends "metrics" ? unknown : T[Key] } : never;
export type ParsedWorkerReply = UnknownMetrics<WorkerReply>;
export function parseWorkerReply(value: string, cap?: number): ParsedWorkerReply;
export function encodeInnerCommand(value: unknown): InnerCommand;
export function encodeBindingCommand(value: unknown): string;
export function parseBindingCommand(value: string, cap: number): BindingCommand;
export function assertBindingHeaderIdentity<T extends BindingIdentity>(getHeader: (name: string) => string | null, command: T): T;

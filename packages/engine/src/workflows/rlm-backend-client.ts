// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Trusted Durable Object client for the private RLM backend binding.
 *
 * Consumes wire encodeBindingCommand (REV02). Does not fork BindingCommand.
 * Injected Fetcher only. Sentinel URL is not a listener. Provider/pin/audit/
 * ModelBudget/callbacks never go on the wire. deadlineMs is not sent.
 */

import {
  BINDING_HEADERS,
  BoundaryError,
  encodeBindingCommand,
  identityToken,
  LIMITS,
  lowerLimits,
  assertContextId,
  assertEventId,
  parseWorkerReply,
  assertPlainData,
  validateHostEvidence,
  readEvidenceHostSnapshot,
  textBytes,
} from "../rlm/protocol.mjs";
import type {
  BindingCommand,
  BindingTiming,
  InnerCommand,
} from "../rlm/binding-protocol.js";
import { lowerTiming } from "../rlm/timing-policy.mjs";
import type { RlmBackendPort, RlmSession, RlmOpenSessionRequest, RlmSessionReply, RlmInspectSnapshot, RlmHostEvidenceSnapshot } from "./rlm-host-types.js";

export const RLM_BACKEND_BINDING_URL = "https://rlm-backend.invalid/binding";
export type { BindingTiming };

export type RlmBackendClientState =
  | "idle"
  | "opening"
  | "live"
  | "terminating"
  | "joining"
  | "released"
  | "quarantined";

export type RlmBackendClientErrorCode =
  | "PROTOCOL"
  | "WIRE_BYTES"
  | "STRING_REQUIRED"
  | "NUL_REJECTED"
  | "SURROGATE_REJECTED"
  | "IDENTITY_REQUIRED"
  | "BINDING_REQUIRED"
  | "REFUSED_HOST_OBJECT"
  | "INVALID_LIMIT"
  | "INVALID_RANGE"
  | "IDLE"
  | "NOT_LIVE"
  | "ADMISSION_BUSY"
  | "CANCELLED"
  | "RELEASED"
  | "LEASE_QUARANTINED"
  | "UNKNOWN_INSPECT"
  | "UNKNOWN_RUN"
  | "EVENT_IDENTITY"
  | "STALE_EVENT"
  | "WORKER_STILL_LIVE"
  | "HOST_CALLS_UNSETTLED"
  | "CONTEXT_STORE_BYTES"
  | "PROMPT_BYTES"
  | "SOURCE_BYTES"
  | "INPUT_BYTES"
  | "RESPONSE_BYTES"
  | "OUTPUT_BYTES"
  | "HOST_OBJECT"
  | "BACKEND_FAILURE"
  | "ALREADY_INITIALIZED"
  | "CONTEXT_IDENTITY"
  | "GUEST_EVENT_LIMIT";

export class RlmBackendClientError extends Error {
  readonly code: RlmBackendClientErrorCode;
  constructor(code: RlmBackendClientErrorCode, message?: string) {
    super(message ?? code);
    this.name = "RlmBackendClientError";
    this.code = code;
  }
}

export interface RlmBackendBinding {
  fetch(input: Request): Promise<Response>;
}

export interface RlmBackendClientIdentities {
  readonly ownerId: string;
  readonly taskId: string;
  readonly sessionNonce: string;
}

export interface RlmBackendClientOptions {
  binding: RlmBackendBinding;
  ownerId: string;
  taskId: string;
  sessionNonce?: string;
}

export interface RlmBackendOpenParams {
  context: string;
  rootPrompt: string | null;
  limits?: Record<string, number>;
  timing?: BindingTiming;
}

export interface RlmBackendRoundTrip {
  readonly runId: string;
  readonly reply: unknown;
  readonly inspect: unknown;
  readonly lease: unknown;
  readonly result?: unknown;
}

export interface RlmBackendJoinResult {
  readonly unknown: boolean;
  readonly exitSeen: boolean | null;
  readonly pendingEvents: number | null;
  readonly inspect: unknown;
  readonly cancelRequested: boolean;
}

export interface RlmBackendOwedEvent {
  readonly id: string;
  readonly runId: string;
  readonly depth: number;
}

const REFUSED_KEYS = [
  "budget", "client", "pin", "audit", "signal", "env", "runtime",
  "callbacks", "callback", "createMessage", "Worker", "clock", "deadlineMs",
] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function fail(code: RlmBackendClientErrorCode): never {
  throw new RlmBackendClientError(code);
}

function rethrowWire(error: unknown): never {
  if (error instanceof RlmBackendClientError) throw error;
  if (error instanceof BoundaryError) {
    throw new RlmBackendClientError(error.code as RlmBackendClientErrorCode, error.code);
  }
  if (error instanceof Error && "code" in error && error.code === "INVALID_LIMIT") fail("INVALID_LIMIT");
  fail("BACKEND_FAILURE");
}

function errorCodeOf(value: unknown, fallback: RlmBackendClientErrorCode): RlmBackendClientErrorCode {
  if (!isPlainObject(value) || typeof value.code !== "string" || value.code.length === 0) return fallback;
  return value.code as RlmBackendClientErrorCode;
}

function token(value: unknown): string {
  try { return identityToken(value); }
  catch (error) { rethrowWire(error); }
}

export class RlmBackendClient {
  readonly identities: RlmBackendClientIdentities;
  readonly #binding: RlmBackendBinding;
  #state: RlmBackendClientState = "idle";
  #runId: string | null = null;
  #owed = new Map<string, RlmBackendOwedEvent>();
  #seenEvents = new Set<string>();
  #confirmedSettled = new Set<string>();
  #guestEventLimit: number = LIMITS.calls;
  #initRequested = false;
  #cancelRequested = false;
  #terminateReason: string | null = null;
  #lastInspect: unknown = null;
  #lastJoin: RlmBackendJoinResult | null = null;
  #quarantineReason: string | null = null;
  #publishedFindings: string | null = null;

  constructor(options: RlmBackendClientOptions) {
    if (!isPlainObject(options)) fail("IDENTITY_REQUIRED");
    for (const key of REFUSED_KEYS) {
      if (key in options && (options as Record<string, unknown>)[key] !== undefined) {
        throw new RlmBackendClientError("REFUSED_HOST_OBJECT", key);
      }
    }
    if (!options.binding || typeof options.binding.fetch !== "function") fail("BINDING_REQUIRED");
    this.#binding = options.binding;
    this.identities = Object.freeze({
      ownerId: token(options.ownerId),
      taskId: token(options.taskId),
      sessionNonce: token(options.sessionNonce ?? crypto.randomUUID()),
    });
  }

  state(): RlmBackendClientState { return this.#state; }
  runId(): string | null { return this.#runId; }
  cancelRequested(): boolean { return this.#cancelRequested; }
  terminateReason(): string | null { return this.#terminateReason; }
  quarantineReason(): string | null { return this.#quarantineReason; }
  owedEvents(): readonly RlmBackendOwedEvent[] { return [...this.#owed.values()]; }
  lastInspect(): unknown { return this.#lastInspect; }

  async open(params: RlmBackendOpenParams): Promise<RlmBackendRoundTrip> {
    if (this.#state === "quarantined") fail("LEASE_QUARANTINED");
    if (this.#state === "released") fail("RELEASED");
    if (this.#state !== "idle") fail("ADMISSION_BUSY");
    if (!isPlainObject(params)) fail("PROTOCOL");
    for (const key of REFUSED_KEYS) {
      if (key in params && (params as Record<string, unknown>)[key] !== undefined) {
        throw new RlmBackendClientError("REFUSED_HOST_OBJECT", key);
      }
    }
    let limits: ReturnType<typeof lowerLimits>, timing: BindingTiming;
    try { limits = { ...lowerLimits(params.limits ?? {}) }; timing = { ...lowerTiming(params.timing ?? {}) }; }
    catch (error) { rethrowWire(error); }
    this.#guestEventLimit = limits.calls;
    const body: BindingCommand = {
      op: "open",
      ownerId: this.identities.ownerId,
      taskId: this.identities.taskId,
      sessionNonce: this.identities.sessionNonce,
      context: params.context,
      rootPrompt: params.rootPrompt,
      limits,
      timing,
    };
    this.#state = "opening";
    try {
      const parsed = await this.#roundTrip(body);
      if (this.#cancelRequested) {
        const runId = typeof parsed.runId === "string" ? parsed.runId : null;
        if (runId) this.#runId = runId;
        this.#state = "terminating";
        if (this.#runId) await this.#postCancel();
        fail("CANCELLED");
      }
      if (parsed.ok !== true) {
        this.#handleOpenFailure(parsed);
        throw new RlmBackendClientError(errorCodeOf(parsed.error, "BACKEND_FAILURE"));
      }
      if (typeof parsed.runId !== "string") fail("PROTOCOL");
      this.#runId = parsed.runId;
      this.#acceptEvents(parsed.reply, this.#runId, parsed.inspect);
      this.#rememberInspect(parsed.inspect);
      this.#state = "live";
      return this.#trip(parsed);
    } catch (error) {
      if (this.#state === "opening") this.#state = this.#runId ? "quarantined" : "idle";
      throw error;
    }
  }

  async init(): Promise<RlmBackendRoundTrip> {
    if (this.#initRequested) fail("ALREADY_INITIALIZED");
    this.#initRequested = true;
    if (this.#state === "quarantined") fail("LEASE_QUARANTINED");
    if (this.#state === "released") fail("RELEASED");
    if (this.#state !== "live") fail("NOT_LIVE");
    if (!this.#runId) fail("UNKNOWN_RUN");
    const parsed = await this.#roundTrip({
      op: "init",
      ownerId: this.identities.ownerId,
      taskId: this.identities.taskId,
      sessionNonce: this.identities.sessionNonce,
      runId: this.#runId,
    });
    if (parsed.ok !== true) {
      throw new RlmBackendClientError(errorCodeOf(parsed.error, "BACKEND_FAILURE"));
    }
    this.#acceptEvents(parsed.reply, this.#runId, parsed.inspect);
    this.#rememberInspect(parsed.inspect);
    return this.#trip(parsed);
  }

  async evaluate(source: string, input = ""): Promise<RlmBackendRoundTrip> {
    return this.#command({ op: "evaluate", source, input });
  }

  async resolve(eventId: string, value: string): Promise<RlmBackendRoundTrip> {
    if (!this.#owed.has(eventId)) fail("STALE_EVENT");
    const trip = await this.#command({ op: "resolve", eventId: assertEventId(eventId), value });
    if (isPlainObject(trip.reply) && trip.reply.ok === true) {
      this.#owed.delete(eventId); this.#confirmedSettled.add(eventId);
    }
    return trip;
  }

  async pump(): Promise<RlmBackendRoundTrip> {
    return this.#command({ op: "pump" });
  }

  async dispose(): Promise<RlmBackendRoundTrip> {
    return this.#command({ op: "dispose" });
  }

  async cancel(): Promise<unknown> {
    this.#cancelRequested = true;
    if (this.#state === "idle") return { cancelled: false, runId: null };
    if (this.#state === "released") fail("RELEASED");
    if (this.#state === "quarantined") fail("LEASE_QUARANTINED");
    this.#state = this.#runId ? "terminating" : "idle";
    if (!this.#runId) return { cancelled: true, runId: null };
    return this.#postCancel();
  }

  async terminate(reason: string): Promise<unknown> {
    this.#terminateReason ??= token(reason);
    this.#cancelRequested = this.#terminateReason !== "COMPLETE";
    if (this.#state === "idle") return { cancelled: false, runId: null };
    if (this.#state === "released") fail("RELEASED");
    if (this.#state === "quarantined") fail("LEASE_QUARANTINED");
    if (!this.#runId) {
      this.#state = "idle";
      return { cancelled: true, runId: null };
    }
    const parsed = await this.#roundTrip({
      op: "terminate",
      ownerId: this.identities.ownerId,
      taskId: this.identities.taskId,
      sessionNonce: this.identities.sessionNonce,
      runId: this.#runId,
      reason: this.#terminateReason,
    });
    this.#rememberInspect(parsed.inspect);
    if (parsed.ok !== true) {
      this.#quarantine(errorCodeOf(parsed.error, "BACKEND_FAILURE"));
      throw new RlmBackendClientError(errorCodeOf(parsed.error, "BACKEND_FAILURE"));
    }
    this.#state = "terminating";
    return parsed;
  }

  async inspect(): Promise<unknown> {
    if (!this.#runId) fail("UNKNOWN_RUN");
    if (this.#state === "released") fail("RELEASED");
    const parsed = await this.#roundTrip({
      op: "inspect",
      ownerId: this.identities.ownerId,
      taskId: this.identities.taskId,
      sessionNonce: this.identities.sessionNonce,
      runId: this.#runId,
    });
    if (parsed.ok !== true) {
      this.#quarantine(errorCodeOf(parsed.error, "BACKEND_FAILURE"));
      throw new RlmBackendClientError(errorCodeOf(parsed.error, "BACKEND_FAILURE"));
    }
    this.#rememberInspect(parsed.inspect);
    return parsed.inspect;
  }

  /** A real backend wait and fresh exit proof; join() is only a snapshot. */
  async waitExit(): Promise<RlmBackendJoinResult> {
    if (this.#state === "released") fail("RELEASED");
    if (this.#state === "quarantined") fail("LEASE_QUARANTINED");
    if (!this.#runId) fail("UNKNOWN_RUN");
    const parsed = await this.#roundTrip({ op: "waitExit", ...this.identities, runId: this.#runId });
    if (parsed.ok !== true) throw new RlmBackendClientError(errorCodeOf(parsed.error, "BACKEND_FAILURE"));
    this.#rememberInspect(parsed.inspect);
    const facts = this.#factsFromInspect(parsed.inspect);
    if (facts.unknown || facts.exitSeen !== true) fail("WORKER_STILL_LIVE");
    this.#lastJoin = facts;
    this.#state = "joining";
    return facts;
  }

  async join(): Promise<RlmBackendJoinResult> {
    if (this.#state === "released") fail("RELEASED");
    if (this.#state === "idle") fail("IDLE");
    if (this.#state === "quarantined") {
      return this.#lastJoin ?? {
        unknown: true, exitSeen: null, pendingEvents: null,
        inspect: this.#lastInspect, cancelRequested: this.#cancelRequested,
      };
    }
    this.#state = "joining";
    let inspect: unknown;
    try { inspect = await this.inspect(); }
    catch (error) {
      this.#quarantine(error instanceof RlmBackendClientError ? error.code : "UNKNOWN_INSPECT");
      const result: RlmBackendJoinResult = {
        unknown: true, exitSeen: null, pendingEvents: null,
        inspect: this.#lastInspect, cancelRequested: this.#cancelRequested,
      };
      this.#lastJoin = result;
      return result;
    }
    const facts = this.#factsFromInspect(inspect);
    this.#lastJoin = facts;
    if (facts.unknown) this.#quarantine("UNKNOWN_INSPECT");
    return facts;
  }

  async release(): Promise<void> {
    if (this.#state === "quarantined") fail("LEASE_QUARANTINED");
    if (this.#state === "released") fail("RELEASED");
    if (!this.#runId) fail("UNKNOWN_RUN");
    // Never release on a stale pre-settlement or pre-exit snapshot.
    const facts = await this.join();
    if (facts.unknown || facts.exitSeen !== true) fail("WORKER_STILL_LIVE");
    if (facts.pendingEvents !== 0) fail("HOST_CALLS_UNSETTLED");
    if (this.#owed.size !== 0) fail("HOST_CALLS_UNSETTLED");
    const parsed = await this.#roundTrip({
      op: "release",
      ownerId: this.identities.ownerId,
      taskId: this.identities.taskId,
      sessionNonce: this.identities.sessionNonce,
      runId: this.#runId,
    });
    if (parsed.ok !== true) {
      this.#quarantine(errorCodeOf(parsed.error, "BACKEND_FAILURE"));
      throw new RlmBackendClientError(errorCodeOf(parsed.error, "BACKEND_FAILURE"));
    }
    this.#state = "released";
    this.#owed.clear();
  }

  quarantine(reason: string): void {
    token(reason);
    this.#quarantine(reason);
  }

  async clearSettledEvent(eventId: string): Promise<void> {
    if (this.#state === "quarantined") fail("LEASE_QUARANTINED");
    if (this.#state === "released") fail("RELEASED");
    if (!this.#runId) fail("UNKNOWN_RUN");
    if (this.#confirmedSettled.has(eventId)) return;
    if (!this.#owed.has(eventId)) fail("STALE_EVENT");
    const parsed = await this.#roundTrip({
      op: "settled",
      ownerId: this.identities.ownerId,
      taskId: this.identities.taskId,
      sessionNonce: this.identities.sessionNonce,
      runId: this.#runId,
      eventId: assertEventId(eventId),
    });
    if (parsed.ok !== true) {
      this.#quarantine(errorCodeOf(parsed.error, "BACKEND_FAILURE"));
      throw new RlmBackendClientError(errorCodeOf(parsed.error, "BACKEND_FAILURE"));
    }
    this.#owed.delete(eventId);
    this.#confirmedSettled.add(eventId);
    this.#rememberInspect(parsed.inspect);
  }

  /** Alias kept so assembled overlays do not fork a second settled DTO. */
  notifyHostEventSettled(eventId: string): Promise<void> {
    return this.clearSettledEvent(eventId);
  }

  async publish(findings: string): Promise<string> {
    if (this.#state === "quarantined") fail("LEASE_QUARANTINED");
    if (this.#state === "released") fail("RELEASED");
    if (!this.#runId) fail("UNKNOWN_RUN");
    const parsed = await this.#roundTrip({
      op: "publish",
      ownerId: this.identities.ownerId,
      taskId: this.identities.taskId,
      sessionNonce: this.identities.sessionNonce,
      runId: this.#runId,
      findings,
    });
    if (parsed.ok !== true) {
      throw new RlmBackendClientError(errorCodeOf(parsed.error, "BACKEND_FAILURE"));
    }
    const accepted = parsed.result;
    if (typeof accepted !== "string" || accepted !== findings || "published" in parsed) fail("PROTOCOL");
    this.#publishedFindings = accepted;
    this.#rememberInspect(parsed.inspect);
    return accepted;
  }

  #command(command: InnerCommand): Promise<RlmBackendRoundTrip> {
    if (this.#state === "quarantined") return Promise.reject(new RlmBackendClientError("LEASE_QUARANTINED"));
    if (this.#state === "released") return Promise.reject(new RlmBackendClientError("RELEASED"));
    if (this.#state !== "live") return Promise.reject(new RlmBackendClientError("NOT_LIVE"));
    if (!this.#runId) return Promise.reject(new RlmBackendClientError("UNKNOWN_RUN"));
    if (this.#cancelRequested) return Promise.reject(new RlmBackendClientError("CANCELLED"));
    const body: BindingCommand = {
      op: "command",
      ownerId: this.identities.ownerId,
      taskId: this.identities.taskId,
      sessionNonce: this.identities.sessionNonce,
      runId: this.#runId,
      command,
    };
    return this.#roundTrip(body).then((parsed) => {
      if (parsed.ok !== true) {
        throw new RlmBackendClientError(errorCodeOf(parsed.error, "BACKEND_FAILURE"));
      }
      this.#acceptEvents(parsed.reply, this.#runId as string, parsed.inspect);
      this.#rememberInspect(parsed.inspect);
      return this.#trip(parsed);
    });
  }

  async #postCancel(): Promise<unknown> {
    const parsed = await this.#roundTrip({
      op: "cancel",
      ownerId: this.identities.ownerId,
      taskId: this.identities.taskId,
      sessionNonce: this.identities.sessionNonce,
      runId: this.#runId as string,
    });
    this.#rememberInspect(parsed.inspect);
    if (parsed.ok !== true) {
      this.#quarantine(errorCodeOf(parsed.error, "BACKEND_FAILURE"));
      throw new RlmBackendClientError(errorCodeOf(parsed.error, "BACKEND_FAILURE"));
    }
    this.#state = "terminating";
    return parsed;
  }

  async #roundTrip(command: BindingCommand): Promise<Record<string, unknown>> {
    let raw: string;
    try { raw = encodeBindingCommand(command); }
    catch (error) { rethrowWire(error); }
    const request = new Request(RLM_BACKEND_BINDING_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [BINDING_HEADERS.owner]: this.identities.ownerId,
        [BINDING_HEADERS.task]: this.identities.taskId,
        [BINDING_HEADERS.session]: this.identities.sessionNonce,
      },
      body: raw,
    });
    let response: Response;
    try { response = await this.#binding.fetch(request); }
    catch {
      if (this.#runId) this.#quarantine("BACKEND_FAILURE");
      fail("BACKEND_FAILURE");
    }
    const text = await response.text();
    try { textBytes(text, LIMITS.wireBytes, "WIRE_BYTES"); }
    catch (error) { rethrowWire(error); }
    let parsed: unknown;
    try { parsed = JSON.parse(text) as unknown; }
    catch { fail("PROTOCOL"); }
    if (!isPlainObject(parsed) || typeof parsed.ok !== "boolean") fail("PROTOCOL");
    if (parsed.ok === true && "runId" in command && parsed.runId !== command.runId) fail("PROTOCOL");
    return parsed;
  }

  #acceptEvents(reply: unknown, runId: string, inspect: unknown): void {
    if (reply === undefined || reply === null) return; // open creates, not initializes
    let checked: ReturnType<typeof parseWorkerReply>;
    try { checked = parseWorkerReply(JSON.stringify(reply)); }
    catch (error) { rethrowWire(error); }
    if (this.#seenEvents.size + checked.events.length > this.#guestEventLimit) fail("GUEST_EVENT_LIMIT");
    for (const event of checked.events) {
      if (event.runId !== runId || this.#seenEvents.has(event.id)) fail("EVENT_IDENTITY");
      this.#seenEvents.add(event.id);
      this.#owed.set(event.id, { id: event.id, runId: event.runId, depth: event.depth });
    }
    if (checked.ok === true && checked.status === "complete") {
      if (typeof checked.output !== "string" || checked.events.length !== 0 || !isPlainObject(checked.metrics) || checked.metrics.pendingEvents !== 0 ||
          !isPlainObject(inspect) || inspect.complete !== true || inspect.pendingEvents !== 0) fail("PROTOCOL");
      // Only verified completion clears dropped guest delivery debt. Native I/O
      // settlement is a separate root-owned gate. Timeout/exit cannot clear it.
      for (const id of this.#owed.keys()) this.#confirmedSettled.add(id);
      this.#owed.clear();
    }
  }

  #factsFromInspect(inspect: unknown): RlmBackendJoinResult {
    const base = { inspect, cancelRequested: this.#cancelRequested };
    if (!isPlainObject(inspect)) {
      return { unknown: true, exitSeen: null, pendingEvents: null, ...base };
    }
    const exitRaw = inspect.exitSeen;
    const pendingRaw = inspect.pendingEvents;
    const exitSeen = exitRaw === true ? true : exitRaw === false ? false : null;
    const pendingEvents = Number.isSafeInteger(pendingRaw) && (pendingRaw as number) >= 0 ? pendingRaw as number : null;
    const unknown = exitSeen === null || pendingEvents === null;
    return { unknown, exitSeen, pendingEvents, ...base };
  }

  #rememberInspect(inspect: unknown): void {
    if (inspect !== undefined) this.#lastInspect = inspect;
  }

  #trip(parsed: Record<string, unknown>): RlmBackendRoundTrip {
    if (typeof parsed.runId !== "string") fail("PROTOCOL");
    return {
      runId: parsed.runId,
      reply: parsed.reply,
      inspect: parsed.inspect,
      lease: parsed.lease,
      result: parsed.result,
    };
  }

  #handleOpenFailure(parsed: Record<string, unknown>): void {
    const runId = typeof parsed.runId === "string" ? parsed.runId : null;
    const cleanup = parsed.openFailureCleanup;
    if (runId && (!isPlainObject(cleanup) || cleanup.released !== true)) {
      this.#runId = runId;
      this.#quarantine(errorCodeOf(parsed.error, "BACKEND_FAILURE"));
      return;
    }
    this.#state = "idle";
    this.#runId = null;
  }

  #quarantine(reason: string): void {
    this.#state = "quarantined";
    this.#quarantineReason = reason;
  }
}

/** Map validated binding observations to the real coordinator session contract. */
function sessionInspect(value: unknown): RlmInspectSnapshot {
  if (!isPlainObject(value) || typeof value.exitSeen !== "boolean" ||
      !Number.isSafeInteger(value.pendingEvents) || (value.pendingEvents as number) < 0) fail("UNKNOWN_INSPECT");
  const metrics = isPlainObject(value.metrics) ? value.metrics : undefined;
  let hostEvidence: RlmHostEvidenceSnapshot | undefined;
  try {
    if (metrics?.readEvidence != null) hostEvidence = readEvidenceHostSnapshot(metrics.readEvidence);
    if ("hostEvidence" in value) {
      const supplied = validateHostEvidence(value.hostEvidence);
      if (hostEvidence === undefined || JSON.stringify(supplied) !== JSON.stringify(hostEvidence)) fail("PROTOCOL");
    }
  } catch (error) { rethrowWire(error); }
  const optionalCount = (n: unknown) => Number.isSafeInteger(n) && (n as number) >= 0 ? n as number : undefined;
  const createdVMs = optionalCount(metrics?.createdVMs), liveVMs = optionalCount(metrics?.liveVMs);
  const extra = { ...value }; delete extra.metrics; delete extra.hostEvidence;
  return { ...extra, exitSeen: value.exitSeen, pendingEvents: value.pendingEvents as number,
    ...(metrics === undefined ? {} : { metrics }), ...(hostEvidence === undefined ? {} : { hostEvidence }),
    ...(createdVMs === undefined ? {} : { createdVMs }), ...(liveVMs === undefined ? {} : { liveVMs }) };
}

/** Production facade, not a fixture adapter. All operations use the real client. */
export class RlmBindingSession implements RlmSession {
  readonly id: string;
  readonly #client: RlmBackendClient;
  constructor(client: RlmBackendClient, id: string) { this.#client = client; this.id = id; }
  #reply(trip: RlmBackendRoundTrip): RlmSessionReply {
    let reply: ReturnType<typeof parseWorkerReply>;
    try { reply = parseWorkerReply(JSON.stringify(trip.reply)); }
    catch (error) { rethrowWire(error); }
    const inspect = sessionInspect(trip.inspect);
    if (reply.metrics !== undefined && !isPlainObject(reply.metrics)) fail("PROTOCOL");
    const metrics = isPlainObject(reply.metrics) ? reply.metrics : undefined;
    if (reply.ok && metrics === undefined) fail("PROTOCOL");
    return reply.ok
      ? { ok: true, status: reply.status, events: reply.events, output: reply.output, inspect, metrics }
      : { ok: false, error: reply.error, events: [], output: null, inspect,
        ...(metrics === undefined ? {} : { metrics }) };
  }
  async init(): Promise<RlmSessionReply> { return this.#reply(await this.#client.init()); }
  async evaluate(source: string, input = ""): Promise<RlmSessionReply> { return this.#reply(await this.#client.evaluate(source, input)); }
  async resolve(eventId: string, value: string): Promise<RlmSessionReply> { return this.#reply(await this.#client.resolve(eventId, value)); }
  async pump(): Promise<RlmSessionReply> { return this.#reply(await this.#client.pump()); }
  cancel(): Promise<unknown> { return this.#client.cancel(); }
  terminate(reason: string): Promise<unknown> { return this.#client.terminate(reason); }
  waitExit(): Promise<RlmBackendJoinResult> { return this.#client.waitExit(); }
  async inspect(): Promise<RlmInspectSnapshot> { return sessionInspect(await this.#client.inspect()); }
  publish(findings: string): Promise<string> { return this.#client.publish(findings); }
  release(): Promise<void> { return this.#client.release(); }
  clearSettledEvent(eventId: string): Promise<void> { return this.#client.clearSettledEvent(eventId); }
}

export interface RlmBackendPortOptions {
  binding: RlmBackendBinding;
  taskId: string;
  sessionNonce?: string;
}

/** Local Fetcher composition. Context/limits/timing are DATA; providers are not. */
export function createRlmBackendPort(options: RlmBackendPortOptions): RlmBackendPort {
  if (!options || typeof options.binding?.fetch !== "function") fail("BINDING_REQUIRED");
  const taskId = token(options.taskId), binding = options.binding, sessionNonce = options.sessionNonce;
  return Object.freeze({
    async open(request: RlmOpenSessionRequest): Promise<RlmSession> {
      if (!isPlainObject(request)) fail("PROTOCOL");
      const allowed = ["ownerId", "context", "contextId", "rootPrompt", "limits", "timing"];
      for (const key of Object.keys(request)) if (!allowed.includes(key)) fail("REFUSED_HOST_OBJECT");
      let limits: ReturnType<typeof lowerLimits>, timing: BindingTiming;
      try {
        assertPlainData(request);
        textBytes(request.context, LIMITS.contextStoreBytes, "CONTEXT_STORE_BYTES");
        assertContextId(request.contextId);
        limits = { ...lowerLimits(request.limits ?? {}) };
        timing = { ...lowerTiming(request.timing ?? {}) };
      } catch (error) { rethrowWire(error); }
      if (request.rootPrompt !== null) fail("PROTOCOL");
      const context = request.context, expectedContextId = request.contextId, ownerId = token(request.ownerId);
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(context));
      const contextId = "sha256:" + [...new Uint8Array(digest)].map((n) => n.toString(16).padStart(2, "0")).join("");
      if (expectedContextId !== contextId) fail("CONTEXT_IDENTITY");
      const client = new RlmBackendClient({ binding, ownerId, taskId,
        ...(sessionNonce === undefined ? {} : { sessionNonce }) });
      const opened = await client.open({ context, rootPrompt: null, limits, timing });
      // There is deliberately no init call here.
      return new RlmBindingSession(client, opened.runId);
    },
  });
}

export type { RlmBackendPort, RlmSession } from "./rlm-host-types.js";


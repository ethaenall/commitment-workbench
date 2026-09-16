// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Node-side private service-binding handler for an injected RLM session backend.
 *
 * This module is a Miniflare function-binding target: it accepts a Request and
 * returns a Response. It creates no TCP listener or public HTTP route. The local
 * daemon installs it as a private function binding, not a request-selected backend.
 *
 * DATA shapes come from the shared protocol and binding-protocol modules.
 * Trusted local composition injects protocol helpers and the session backend;
 * providers, model budgets, admission, and final ledger authority stay DO-side.
 */

import type { RlmSession, RlmSessionReply } from "../workflows/rlm-host-types.js";
import type { BindingTiming } from "../rlm/binding-protocol.js";
export type { BindingTiming } from "../rlm/binding-protocol.js";

export const BINDING_SENTINEL_URL = "https://rlm-backend.invalid/binding";

const IDENTITY_BYTES = 64;

const HEADER_OWNER = "x-habenula-owner";
const HEADER_TASK = "x-habenula-task";
const HEADER_SESSION = "x-habenula-session";

const OPEN_REQUIRED_KEYS = [
  "op",
  "ownerId",
  "taskId",
  "sessionNonce",
  "context",
  "rootPrompt",
] as const;
const OPEN_OPTIONAL_KEYS = ["limits", "timing"] as const;
const OPEN_KEYS = [...OPEN_REQUIRED_KEYS, ...OPEN_OPTIONAL_KEYS];
const TIMING_KEYS = [
  "taskLifetimeMs",
  "startupDeadlineMs",
  "commandSliceMs",
  "cumulativeCommandMs",
] as const;
const TERMINATE_KEYS = [
  "op",
  "ownerId",
  "taskId",
  "sessionNonce",
  "runId",
  "reason",
] as const;
const PUBLISH_KEYS = [
  "op",
  "ownerId",
  "taskId",
  "sessionNonce",
  "runId",
  "findings",
] as const;

const COMMAND_KEYS = [
  "op",
  "ownerId",
  "taskId",
  "sessionNonce",
  "runId",
  "command",
] as const;

const RUN_KEYS = ["op", "ownerId", "taskId", "sessionNonce", "runId"] as const;

const SETTLED_KEYS = [
  "op",
  "ownerId",
  "taskId",
  "sessionNonce",
  "runId",
  "eventId",
] as const;

const EVALUATE_KEYS = ["op", "source", "input"] as const;
const RESOLVE_KEYS = ["op", "eventId", "value"] as const;
const PUMP_KEYS = ["op"] as const;
const DISPOSE_KEYS = ["op"] as const;

export type BindingProtocolLimits = {
  readonly initWireBytes: number;
  readonly wireBytes: number;
  readonly contextStoreBytes: number;
  readonly sourceBytes: number;
  readonly promptBytes: number;
  readonly responseBytes: number;
  readonly guestOutputBytes: number;
};

export type BindingProtocol = {
  readonly LIMITS: BindingProtocolLimits;
  textBytes: (value: string, cap: number, code?: string) => number;
  fail: (code: string) => never;
  fixedCode: (error: unknown, fallback?: string) => string;
  parseBindingCommand: (raw: string, cap: number) => unknown;
};

/**
 * Consumes private runtime-session methods. Not a public wire DTO.
 */
export type BindingSessionInspect = {
  readonly runId: string;
  readonly state: string;
  readonly cancelled: boolean;
  readonly exitSeen: boolean;
  readonly stopReason: string | null;
  readonly published: boolean;
  readonly pendingEvents: number | null;
  readonly seq?: number;
  readonly wireSent?: number;
  readonly wireReceived?: number;
  readonly terminateMs?: number | null;
  readonly exitAfterMs?: number | null;
  readonly metrics?: unknown;
};

/** Node lifecycle adds dispose and rich inspect to the actual shared host ABI. */
export type BindingSession = Omit<RlmSession, "inspect" | "publish" | "clearSettledEvent"> & {
  dispose: () => Promise<RlmSessionReply>;
  inspect: () => BindingSessionInspect | Promise<BindingSessionInspect>;
  publish: (output: string) => string | Promise<string>;
  clearSettledEvent: (eventId: string) => void | Promise<void>;
};

export type OpenSessionArgs = {
  context: string;
  limits: Record<string, unknown> | undefined;
  rootPrompt: string | null;
  timing: BindingTiming | undefined;
};

export type BindingBackend = {
  openSession: (args: OpenSessionArgs) => BindingSession;
  backendStatus: () => unknown;
};

export type RlmBindingHandler = (request: Request) => Promise<Response>;

type JsonObject = { readonly [key: string]: unknown };

type Identities = {
  ownerId: string;
  taskId: string;
  sessionNonce: string;
};

type SessionRecord = {
  session: BindingSession;
  ownerId: string;
  taskId: string;
  sessionNonce: string;
  quarantined: boolean;
};

function isPlainObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function errorCode(error: unknown): string | null {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code: unknown }).code;
    return typeof code === "string" && code.length > 0 ? code : null;
  }
  return null;
}

function jsonResponse(
  protocol: BindingProtocol,
  value: unknown,
  status: number,
): Response {
  const body = JSON.stringify(value);
  try {
    protocol.textBytes(body, protocol.LIMITS.wireBytes, "WIRE_BYTES");
  } catch {
    const fallback = JSON.stringify({ ok: false, error: { code: "WIRE_BYTES" } });
    return new Response(fallback, {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }
  return new Response(body, {
    status,
    headers: { "content-type": "application/json" },
  });
}

function allowKeys(
  protocol: BindingProtocol,
  value: JsonObject,
  allowed: readonly string[],
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) protocol.fail("PROTOCOL");
  }
}

function requireKeys(
  protocol: BindingProtocol,
  value: JsonObject,
  required: readonly string[],
): void {
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) protocol.fail("PROTOCOL");
  }
}

function exactKeys(
  protocol: BindingProtocol,
  value: JsonObject,
  required: readonly string[],
): void {
  allowKeys(protocol, value, required);
  requireKeys(protocol, value, required);
}

function requiredString(
  protocol: BindingProtocol,
  value: unknown,
  code = "PROTOCOL",
): string {
  if (typeof value !== "string") protocol.fail(code);
  return value;
}

function identityString(protocol: BindingProtocol, value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    protocol.fail("IDENTITY_REQUIRED");
  }
  protocol.textBytes(value, IDENTITY_BYTES, "IDENTITY_REQUIRED");
  return value;
}

function readIdentities(
  protocol: BindingProtocol,
  request: Request,
  cmd: JsonObject,
): Identities {
  const ownerHeader = request.headers.get(HEADER_OWNER);
  const taskHeader = request.headers.get(HEADER_TASK);
  const sessionHeader = request.headers.get(HEADER_SESSION);
  const ownerId = identityString(protocol, cmd.ownerId);
  const taskId = identityString(protocol, cmd.taskId);
  const sessionNonce = identityString(protocol, cmd.sessionNonce);
  if (ownerHeader === null || taskHeader === null || sessionHeader === null) {
    protocol.fail("IDENTITY_REQUIRED");
  }
  const headerOwner = identityString(protocol, ownerHeader);
  const headerTask = identityString(protocol, taskHeader);
  const headerSession = identityString(protocol, sessionHeader);
  if (
    headerOwner !== ownerId ||
    headerTask !== taskId ||
    headerSession !== sessionNonce
  ) {
    protocol.fail("IDENTITY_MISMATCH");
  }
  return { ownerId, taskId, sessionNonce };
}

async function readInspect(session: BindingSession): Promise<BindingSessionInspect> {
  return await session.inspect();
}

function observedPendingEvents(
  protocol: BindingProtocol,
  inspect: BindingSessionInspect,
): number {
  // Missing/null/non-integer is UNKNOWN, never a measured zero.
  const pending = inspect.pendingEvents;
  if (typeof pending !== "number" || !Number.isSafeInteger(pending) || pending < 0) {
    protocol.fail("HOST_CALLS_UNSETTLED");
  }
  return pending;
}

function assertReleaseable(
  protocol: BindingProtocol,
  inspect: BindingSessionInspect,
): void {
  if (inspect.exitSeen !== true) protocol.fail("WORKER_STILL_LIVE");
  const pending = observedPendingEvents(protocol, inspect);
  if (pending !== 0) protocol.fail("HOST_CALLS_UNSETTLED");
}

async function closeFailedInitialization(
  protocol: BindingProtocol,
  record: SessionRecord,
): Promise<{
  runId: string;
  code: string;
  workerExited: boolean;
  pendingEvents: number | null;
  released: boolean;
  cleanupError: string | null;
  inspect: BindingSessionInspect | null;
}> {
  const failure = {
    runId: record.session.id,
    code: "BACKEND_FAILURE",
    workerExited: false,
    pendingEvents: null as number | null,
    released: false,
    cleanupError: null as string | null,
    inspect: null as BindingSessionInspect | null,
  };
  try {
    await record.session.cancel();
    await record.session.waitExit();
    const inspect = await readInspect(record.session);
    failure.inspect = inspect;
    failure.workerExited = inspect.exitSeen === true;
    failure.pendingEvents = Number.isSafeInteger(inspect.pendingEvents)
      ? inspect.pendingEvents
      : null;
    if (inspect.exitSeen !== true) protocol.fail("WORKER_STILL_LIVE");
    if (observedPendingEvents(protocol, inspect) !== 0) {
      protocol.fail("HOST_CALLS_UNSETTLED");
    }
    await record.session.release();
    failure.released = true;
  } catch (cleanupError) {
    failure.cleanupError =
      errorCode(cleanupError) ??
      protocol.fixedCode(cleanupError, "OPEN_CLEANUP_FAILED");
    try {
      failure.inspect = await readInspect(record.session);
      failure.workerExited = failure.inspect.exitSeen === true;
      failure.pendingEvents = Number.isSafeInteger(failure.inspect.pendingEvents)
        ? failure.inspect.pendingEvents
        : null;
    } catch {
      // Inspect after failed cleanup remains UNKNOWN. Do not forge zeros.
    }
  }
  return failure;
}

function requireRecord(
  protocol: BindingProtocol,
  record: SessionRecord | undefined,
  identities: Identities,
): SessionRecord {
  if (!record) protocol.fail("UNKNOWN_RUN");
  if (
    record.ownerId !== identities.ownerId ||
    record.taskId !== identities.taskId ||
    record.sessionNonce !== identities.sessionNonce
  ) {
    protocol.fail("IDENTITY_MISMATCH");
  }
  return record;
}

function parseRootPrompt(
  protocol: BindingProtocol,
  value: unknown,
): string | null {
  if (value === null) return null;
  if (typeof value !== "string") protocol.fail("STRING_REQUIRED");
  return value;
}

function parseTiming(
  protocol: BindingProtocol,
  value: unknown,
): BindingTiming | undefined {
  if (value === undefined) return undefined;
  if (!isPlainObject(value)) protocol.fail("PROTOCOL");
  exactKeys(protocol, value, TIMING_KEYS);
  const read = (key: (typeof TIMING_KEYS)[number]): number => {
    const n = value[key];
    if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 1) {
      protocol.fail("INVALID_LIMIT");
    }
    return n;
  };
  return {
    taskLifetimeMs: read("taskLifetimeMs"),
    startupDeadlineMs: read("startupDeadlineMs"),
    commandSliceMs: read("commandSliceMs"),
    cumulativeCommandMs: read("cumulativeCommandMs"),
  };
}

function parseLimits(
  protocol: BindingProtocol,
  value: unknown,
): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (!isPlainObject(value)) protocol.fail("PROTOCOL");
  return { ...value };
}

function parseInnerCommand(
  protocol: BindingProtocol,
  value: unknown,
): JsonObject {
  if (!isPlainObject(value) || typeof value.op !== "string") {
    protocol.fail("PROTOCOL");
  }
  return value;
}

/**
 * Create a private function-binding handler around one injected session backend.
 *
 * One handler per process. The process-global lease lives in the injected
 * backend (`openSession` / `backendStatus`). This handler additionally maps
 * runId → owner/task/session identities. Quarantine keeps that map entry and
 * does not call `release`.
 */
export function createRlmBindingHandler(deps: {
  backend: BindingBackend;
  protocol: BindingProtocol;
}): RlmBindingHandler {
  const { backend, protocol } = deps;
  const sessions = new Map<string, SessionRecord>();

  const failResponse = (error: unknown, extra: JsonObject = {}, status = 200) => {
    const code = errorCode(error) ?? protocol.fixedCode(error, "BACKEND_FAILURE");
    const payload: Record<string, unknown> = {
      ok: false,
      error: { code },
      lease: backend.backendStatus(),
      ...extra,
    };
    return jsonResponse(protocol, payload, status);
  };

  function statusFor(code: string): number {
    if (code === "WIRE_BYTES") return 413;
    if (
      code === "PROTOCOL" ||
      code === "IDENTITY_REQUIRED" ||
      code === "IDENTITY_MISMATCH" ||
      code === "STRING_REQUIRED" ||
      code === "BODY_READ" ||
      code === "INVALID_LIMIT"
    ) {
      return 400;
    }
    return 200;
  }

  return async function handleRlmBinding(request: Request): Promise<Response> {
    let raw: string;
    try {
      raw = await request.text();
    } catch {
      return jsonResponse(
        protocol,
        { ok: false, error: { code: "BODY_READ" } },
        400,
      );
    }

    let incoming: number;
    try {
      incoming = protocol.textBytes(raw, protocol.LIMITS.initWireBytes, "WIRE_BYTES");
    } catch (error) {
      const code = errorCode(error) ?? protocol.fixedCode(error, "WIRE_BYTES");
      const status = code === "WIRE_BYTES" ? 413 : 400;
      return jsonResponse(
        protocol,
        { ok: false, error: { code } },
        status,
      );
    }

    let cmdUnknown: unknown;
    try {
      cmdUnknown = JSON.parse(raw);
    } catch {
      return jsonResponse(
        protocol,
        { ok: false, error: { code: "PROTOCOL" } },
        400,
      );
    }
    if (!isPlainObject(cmdUnknown) || typeof cmdUnknown.op !== "string") {
      return jsonResponse(
        protocol,
        { ok: false, error: { code: "PROTOCOL" } },
        400,
      );
    }
    const cmd = cmdUnknown;

    try {
      if (cmd.op !== "open" && incoming > protocol.LIMITS.wireBytes) {
        protocol.fail("WIRE_BYTES");
      }

      // The assembled endpoint consumes the real shared DATA validator too.
      protocol.parseBindingCommand(raw, cmd.op === "open" ? protocol.LIMITS.initWireBytes : protocol.LIMITS.wireBytes);
      const identities = readIdentities(protocol, request, cmd);

      if (cmd.op === "open") {
        allowKeys(protocol, cmd, OPEN_KEYS);
        requireKeys(protocol, cmd, OPEN_REQUIRED_KEYS);
        const context = requiredString(protocol, cmd.context, "STRING_REQUIRED");
        protocol.textBytes(
          context,
          protocol.LIMITS.contextStoreBytes,
          "CONTEXT_STORE_BYTES",
        );
        const rootPrompt = parseRootPrompt(protocol, cmd.rootPrompt);
        if (rootPrompt !== null) {
          protocol.textBytes(rootPrompt, protocol.LIMITS.promptBytes, "PROMPT_BYTES");
        }
        const timing = parseTiming(protocol, cmd.timing);
        const limits = parseLimits(protocol, cmd.limits);

        let session: BindingSession;
        try {
          session = backend.openSession({
            context,
            limits,
            rootPrompt,
            timing,
          });
        } catch (error) {
          return failResponse(error);
        }

        const record: SessionRecord = {
          session,
          ownerId: identities.ownerId,
          taskId: identities.taskId,
          sessionNonce: identities.sessionNonce,
          quarantined: false,
        };
        sessions.set(session.id, record);

        try {
          // INC-01: openSession only. Coordinator/do-client call init() later.
          // Do not auto-run worker init here.
          return jsonResponse(
            protocol,
            {
              ok: true,
              runId: session.id,
              inspect: await readInspect(session),
              lease: backend.backendStatus(),
            },
            200,
          );
        } catch (error) {
          const openFailureCleanup = await closeFailedInitialization(
            protocol,
            record,
          );
          openFailureCleanup.code =
            errorCode(error) ??
            protocol.fixedCode(error, openFailureCleanup.code);
          if (!openFailureCleanup.released) {
            record.quarantined = true;
          } else {
            sessions.delete(session.id);
          }
          return jsonResponse(
            protocol,
            {
              ok: false,
              error: { code: openFailureCleanup.code },
              runId: session.id,
              openFailureCleanup,
              lease: backend.backendStatus(),
            },
            200,
          );
        }
      }

      allowKeys(
        protocol,
        cmd,
        cmd.op === "settled"
          ? SETTLED_KEYS
          : cmd.op === "command"
            ? COMMAND_KEYS
            : cmd.op === "terminate"
              ? TERMINATE_KEYS
              : cmd.op === "publish"
                ? PUBLISH_KEYS
                : RUN_KEYS,
      );
      if (cmd.op === "terminate") requireKeys(protocol, cmd, TERMINATE_KEYS);
      if (cmd.op === "publish") requireKeys(protocol, cmd, PUBLISH_KEYS);
      const runId = requiredString(protocol, cmd.runId);
      const record = requireRecord(protocol, sessions.get(runId), identities);
      const session = record.session;

      if (cmd.op === "command") {
        const inner = parseInnerCommand(protocol, cmd.command);
        let reply: unknown;
        if (inner.op === "evaluate") {
          exactKeys(protocol, inner, EVALUATE_KEYS);
          const source = requiredString(protocol, inner.source, "STRING_REQUIRED");
          const input = requiredString(protocol, inner.input, "STRING_REQUIRED");
          protocol.textBytes(source, protocol.LIMITS.sourceBytes, "SOURCE_BYTES");
          protocol.textBytes(input, protocol.LIMITS.promptBytes, "INPUT_BYTES");
          reply = await session.evaluate(source, input);
        } else if (inner.op === "resolve") {
          exactKeys(protocol, inner, RESOLVE_KEYS);
          const eventId = requiredString(protocol, inner.eventId, "PROTOCOL");
          const value = requiredString(protocol, inner.value, "STRING_REQUIRED");
          protocol.textBytes(value, protocol.LIMITS.responseBytes, "RESPONSE_BYTES");
          reply = await session.resolve(eventId, value);
        } else if (inner.op === "pump") {
          exactKeys(protocol, inner, PUMP_KEYS);
          reply = await session.pump();
        } else if (inner.op === "dispose") {
          exactKeys(protocol, inner, DISPOSE_KEYS);
          reply = await session.dispose();
        } else {
          protocol.fail("PROTOCOL");
        }
        return jsonResponse(
          protocol,
          {
            ok: true,
            runId,
            reply,
            inspect: await readInspect(session),
            lease: backend.backendStatus(),
          },
          200,
        );
      }

      if (cmd.op === "cancel") {
        const result = await session.cancel();
        return jsonResponse(
          protocol,
          {
            ok: true,
            runId,
            result,
            inspect: await readInspect(session),
            lease: backend.backendStatus(),
          },
          200,
        );
      }

      if (cmd.op === "settled") {
        const eventId = requiredString(protocol, cmd.eventId, "PROTOCOL");
        await session.clearSettledEvent(eventId);
        return jsonResponse(
          protocol,
          {
            ok: true,
            runId,
            inspect: await readInspect(session),
            lease: backend.backendStatus(),
          },
          200,
        );
      }

      if (cmd.op === "waitExit") {
        exactKeys(protocol, cmd, RUN_KEYS);
        const result = await session.waitExit();
        const inspect = await readInspect(session);
        if (inspect.exitSeen !== true) protocol.fail("WORKER_STILL_LIVE");
        observedPendingEvents(protocol, inspect);
        return jsonResponse(protocol, { ok: true, runId, result, inspect, lease: backend.backendStatus() }, 200);
      }

      if (cmd.op === "inspect") {
        return jsonResponse(
          protocol,
          {
            ok: true,
            runId,
            inspect: await readInspect(session),
            lease: backend.backendStatus(),
          },
          200,
        );
      }

      if (cmd.op === "init") {
        requireKeys(protocol, cmd, RUN_KEYS);
        const reply = await session.init();
        return jsonResponse(
          protocol,
          {
            ok: true,
            runId,
            reply,
            inspect: await readInspect(session),
            lease: backend.backendStatus(),
          },
          200,
        );
      }

      if (cmd.op === "release") {
        const inspect = await readInspect(session);
        try {
          assertReleaseable(protocol, inspect);
          await session.release();
        } catch (error) {
          record.quarantined = true;
          throw error;
        }
        sessions.delete(runId);
        return jsonResponse(
          protocol,
          {
            ok: true,
            runId,
            lease: backend.backendStatus(),
          },
          200,
        );
      }

      if (cmd.op === "terminate") {
        const reason = requiredString(protocol, cmd.reason, "PROTOCOL");
        if (reason.length === 0) protocol.fail("PROTOCOL");
        protocol.textBytes(reason, IDENTITY_BYTES, "PROTOCOL");
        const result = await session.terminate(reason);
        return jsonResponse(
          protocol,
          {
            ok: true,
            runId,
            result,
            inspect: await readInspect(session),
            lease: backend.backendStatus(),
          },
          200,
        );
      }

      if (cmd.op === "publish") {
        const findings = requiredString(protocol, cmd.findings, "STRING_REQUIRED");
        protocol.textBytes(
          findings,
          protocol.LIMITS.guestOutputBytes,
          "OUTPUT_BYTES",
        );
        const published = await session.publish(findings);
        if (typeof published !== "string" || published !== findings) {
          protocol.fail("PUBLICATION_BLOCKED");
        }
        return jsonResponse(
          protocol,
          {
            ok: true,
            runId,
            result: published,
            inspect: await readInspect(session),
            lease: backend.backendStatus(),
          },
          200,
        );
      }

      return protocol.fail("PROTOCOL");
    } catch (error) {
      const code = errorCode(error) ?? protocol.fixedCode(error, "BACKEND_FAILURE");
      return failResponse(error, {}, statusFor(code));
    }
  };
}

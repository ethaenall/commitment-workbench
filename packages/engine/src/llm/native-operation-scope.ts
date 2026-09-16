// SPDX-License-Identifier: AGPL-3.0-only
// Isolated native-operation scope. No public DTO/guest callbacks, no global registry.
// Portable: Node 22 and Workerd. Pending ops only; settled ops are dropped.

export type NativeIoObservation = "UNOBSERVED" | "TRACKED_PENDING" | "SETTLED";
export type NativeIoKind = "fetch" | "read" | "cancel";

const SAT = 2147483647;
const PENDING_CAP = 64;
const TRANSPORT_CAP = 16;
const JOIN_CAP = 16;

function satInc(n: number): number {
  return n >= SAT ? SAT : n + 1;
}

export interface NativeIoSnapshot {
  observation: NativeIoObservation;
  sealed: boolean;
  openTransports: number;
  pendingOperations: number;
  registeredOperations: number;
  settledOperations: number;
}

export interface NativeTransportSession {
  readonly id: number;
  trackPromise<T>(kind: NativeIoKind, start: () => Promise<T>): Promise<T>;
  closeProducer(): void;
}

export interface NativeOperationScope {
  snapshot(): NativeIoSnapshot;
  openTransport(): NativeTransportSession;
  seal(): void;
  join(): Promise<void>;
}

interface Op {
  kind: NativeIoKind;
}

interface Transport {
  id: number;
  producerOpen: boolean;
}

export function createNativeOperationScope(): NativeOperationScope {
  const transports = new Map<number, Transport>();
  const pending = new Set<Op>();
  const waiters: Array<() => void> = [];
  let nextId = 1;
  let sealed = false;
  let instrumented = false;
  let registeredOperations = 0;
  let settledOperations = 0;

  function notify(): void {
    if (!isSettled()) return;
    const list = waiters.splice(0, waiters.length);
    for (const w of list) w();
  }

  function isSettled(): boolean {
    return instrumented && sealed && transports.size === 0 && pending.size === 0;
  }

  function snapshot(): NativeIoSnapshot {
    const observation: NativeIoObservation = !instrumented
      ? "UNOBSERVED"
      : isSettled()
        ? "SETTLED"
        : "TRACKED_PENDING";
    return {
      observation,
      sealed,
      openTransports: transports.size,
      pendingOperations: pending.size,
      registeredOperations,
      settledOperations,
    };
  }

  function settleOp(op: Op): void {
    if (!pending.delete(op)) return;
    settledOperations = satInc(settledOperations);
    notify();
  }

  function openTransport(): NativeTransportSession {
    if (sealed) throw new Error("NATIVE_SCOPE_SEALED");
    if (transports.size >= TRANSPORT_CAP) throw new Error("NATIVE_TRANSPORT_CAP");
    instrumented = true;
    const id = nextId++;
    const transport: Transport = { id, producerOpen: true };
    transports.set(id, transport);
    return {
      id,
      trackPromise<T>(kind: NativeIoKind, start: () => Promise<T>): Promise<T> {
        if (!transport.producerOpen) throw new Error("NATIVE_TRANSPORT_CLOSED");
        if (pending.size >= PENDING_CAP) throw new Error("NATIVE_PENDING_CAP");
        const op: Op = { kind };
        pending.add(op);
        registeredOperations = satInc(registeredOperations);
        let started: Promise<T>;
        try {
          started = start();
        } catch (error) {
          settleOp(op);
          throw error;
        }
        return Promise.resolve(started).then(
          (value) => {
            settleOp(op);
            return value;
          },
          (error: unknown) => {
            settleOp(op);
            throw error;
          },
        );
      },
      closeProducer(): void {
        if (!transport.producerOpen) return;
        transport.producerOpen = false;
        transports.delete(id);
        notify();
      },
    };
  }

  function seal(): void {
    sealed = true;
    notify();
  }

  function join(): Promise<void> {
    if (isSettled()) return Promise.resolve();
    if (waiters.length >= JOIN_CAP) throw new Error("NATIVE_JOIN_CAP");
    return new Promise<void>((resolve) => {
      waiters.push(resolve);
      if (isSettled()) {
        const idx = waiters.lastIndexOf(resolve);
        if (idx >= 0) waiters.splice(idx, 1);
        resolve();
      }
    });
  }

  return { snapshot, openTransport, seal, join };
}

/** False means cleanup was not admitted; the caller must retain cleanup debt. */
export function fireTrackedCancel(
  session: NativeTransportSession | undefined,
  start: () => Promise<unknown>,
): boolean {
  if (!session) {
    void start().catch(() => {});
    return true;
  }
  let dispatched = false;
  try {
    void session.trackPromise("cancel", () => {
      dispatched = true;
      return start();
    }).catch(() => {});
    return dispatched;
  } catch {
    // Refusal is not permission to dispatch untracked I/O or retry a sync throw.
    return false;
  }
}

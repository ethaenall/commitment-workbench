// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { UpstreamResponseError } from "./errors.js";
import { fireTrackedCancel, type NativeOperationScope, type NativeTransportSession } from "./native-operation-scope.js";

export const MAX_RESPONSE_BYTES = 1024 * 1024;
export type BoundedResponseErrorCode =
  | "INVALID_RESPONSE_LIMIT" | "RESPONSE_TOO_LARGE" | "RESPONSE_ABORTED" | "RESPONSE_READ_FAILED";

/** No body, provider error, URL, credential, or caller abort reason is retained. */
export class BoundedResponseError extends UpstreamResponseError {
  constructor(readonly code: BoundedResponseErrorCode) {
    super(`Bounded model response: ${code}`);
    this.name = "BoundedResponseError";
  }
}

export function validateMaxResponseBytes(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0 || value > MAX_RESPONSE_BYTES) {
    throw new BoundedResponseError("INVALID_RESPONSE_LIMIT");
  }
  return value;
}

/**
 * Read the entire wire body BEFORE handing any bytes to an adapter/SDK parser.
 * The transport may deliver a larger chunk. Only checked bytes are copied to a
 * fixed, at-most-limit buffer. This is not a network-buffer/process/RSS bound.
 * Content-Length is never trusted. The returned Response describes only the
 * bytes actually read, not possibly false length/encoding transport headers.
 *
 * Cancellation races both headers and reads, cancels the reader, and aborts the
 * transport. It does not await potentially hung stream cancellation, contain a
 * hostile implementation, or retract an already-started inference/effect.
 *
 * Optional observer tracks fetch/read/cancel. Default 4-arg behavior is unchanged.
 * On native read/fetch failure, admit cancel while the producer is still open,
 * then closeProducer. Do not surface NATIVE_TRANSPORT_CLOSED to callers.
 */
export async function fetchBoundedResponse(
  fetchFn: typeof fetch,
  input: Parameters<typeof fetch>[0],
  init: RequestInit | undefined,
  maxBytes: number,
  observer?: NativeOperationScope,
): Promise<Response> {
  const limit = validateMaxResponseBytes(maxBytes);
  if (limit === undefined) throw new BoundedResponseError("INVALID_RESPONSE_LIMIT");
  const session: NativeTransportSession | undefined = observer?.openTransport();
  const transport = new AbortController();
  const upstream = init?.signal ?? (input instanceof Request ? input.signal : undefined);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let failure: BoundedResponseError | undefined;
  let rejectAbort: (error: BoundedResponseError) => void = () => {};
  let cancelAttempted = false;
  let cleanupIncomplete = false;
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
  const admitCancel = (start: () => Promise<unknown>): void => {
    if (cancelAttempted) return;
    cancelAttempted = true;
    if (!fireTrackedCancel(session, start)) cleanupIncomplete = true;
  };
  const cancelReader = (): void => {
    // Never await hung cancellation.
    const current = reader;
    if (!current) return;
    admitCancel(() => current.cancel());
  };
  const stop = (code: BoundedResponseErrorCode): BoundedResponseError => {
    if (!failure) {
      failure = new BoundedResponseError(code);
      transport.abort(failure);
      cancelReader();
      rejectAbort(failure);
    }
    return failure;
  };
  const abort = (): void => { stop("RESPONSE_ABORTED"); };
  upstream?.addEventListener("abort", abort, { once: true });

  const read = async (): Promise<Response> => {
    try {
      if (upstream?.aborted) throw stop("RESPONSE_ABORTED");
      const runFetch = (): Promise<Response> => fetchFn(input, { ...init, signal: transport.signal });
      const response = session ? await session.trackPromise("fetch", runFetch) : await runFetch();
      if (failure) {
        const body = response.body;
        if (body) admitCancel(() => body.cancel());
        throw failure;
      }
      const buffer = new Uint8Array(limit);
      let size = 0;
      reader = response.body?.getReader();
      if (reader) {
        const currentReader = reader;
        while (true) {
          const runRead = (): ReturnType<typeof currentReader.read> => currentReader.read();
          let chunk: Awaited<ReturnType<typeof currentReader.read>>;
          try {
            chunk = session ? await session.trackPromise("read", runRead) : await runRead();
          } catch (error) {
            if (!failure) admitCancel(() => currentReader.cancel());
            throw error;
          }
          if (failure) throw failure;
          if (chunk.done) break;
          if (!(chunk.value instanceof Uint8Array)) throw stop("RESPONSE_READ_FAILED");
          if (chunk.value.byteLength > limit - size) throw stop("RESPONSE_TOO_LARGE");
          buffer.set(chunk.value, size);
          size += chunk.value.byteLength;
        }
      }
      if (failure || upstream?.aborted) throw stop("RESPONSE_ABORTED");
      const headers = new Headers(response.headers);
      headers.delete("content-length");
      headers.delete("content-encoding");
      return new Response([204, 205, 304].includes(response.status) ? null : buffer.subarray(0, size), {
        status: response.status, statusText: response.statusText, headers,
      });
    } finally {
      // Do not turn refused cleanup into settlement by discarding its producer.
      // This is quarantine debt, not a claim that a native promise is pending.
      if (!cleanupIncomplete) session?.closeProducer();
    }
  };
  try {
    return await Promise.race([read(), aborted]);
  } catch (error) {
    if (error instanceof BoundedResponseError) throw stop(error.code);
    throw stop("RESPONSE_READ_FAILED");
  } finally {
    upstream?.removeEventListener("abort", abort);
    try { reader?.releaseLock(); } catch { /* An ignored read may remain unsettled. */ }
  }
}

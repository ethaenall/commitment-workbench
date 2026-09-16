// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { ApiError, CONTROL_DEADLINE_MS, type FetchFn } from "../src/api-client";
import {
  GOVERNED_RESPONSE_MAX_BYTES, GOVERNED_RESPONSE_MAX_EMPTY_CHUNKS,
  GOVERNED_RESPONSE_MAX_READS, RefinementClient,
} from "../src/refinement-client";
import type { Config } from "../src/config";

const payload = JSON.stringify({ refinements: [], nextCursor: null });
const config: Config = { apiUrl: "http://127.0.0.1:1", userId: "fixture-user",
  internalToken: "fixture-only-token", internalTokenSource: "env", humanTouch: false };
let server: Server | undefined;
async function serve(handler: (res: ServerResponse) => void): Promise<string> {
  server = createServer((_req, res) => handler(res));
  const s = server;
  await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
}
afterEach(() => {
  vi.useRealTimers();
  server?.closeAllConnections(); server?.close(); server = undefined;
});

const clientFor = (fetchFn: FetchFn) => new RefinementClient(config, fetchFn);

describe("bounded governed-learning response reader", () => {
  it("accepts an exact 8 MiB response through the production HTTP transport", async () => {
    const text = " ".repeat(GOVERNED_RESPONSE_MAX_BYTES - Buffer.byteLength(payload)) + payload;
    const apiUrl = await serve((res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.write(text.slice(0, 1024));
      setImmediate(() => res.end(text.slice(1024)));
    });
    expect(await new RefinementClient({ ...config, apiUrl }).list()).toEqual({ refinements: [], nextCursor: null });
  });

  it.each([200, 401, 503])("rejects oversized HTTP status %s bodies with a fixed safe error, once", async (status) => {
    let calls = 0;
    const apiUrl = await serve((res) => {
      calls++;
      res.writeHead(status, { "content-length": String(GOVERNED_RESPONSE_MAX_BYTES * 3) });
      res.write(Buffer.alloc(GOVERNED_RESPONSE_MAX_BYTES + 1, 0x20));
    });
    await expect(new RefinementClient({ ...config, apiUrl }).list()).rejects.toMatchObject({
      status: 502, message: "Governed-learning response exceeds the 8 MiB limit; no result accepted.",
    });
    expect(calls).toBe(1);
  });

  it("also caps an injected global fetch that ignores the transport option", async () => {
    const apiUrl = await serve((res) => {
      res.writeHead(200, { "transfer-encoding": "chunked" });
      res.write(Buffer.alloc(GOVERNED_RESPONSE_MAX_BYTES + 1, 0x20)); res.end();
    });
    const injected: FetchFn = (url, init) => fetch(url, init);
    await expect(new RefinementClient({ ...config, apiUrl }, injected).list()).rejects.toMatchObject({ status: 502 });
  });

  it("ignores a false small Content-Length from an injected Response and cancels without retaining more", async () => {
    let pulls = 0; let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++;
        controller.enqueue(new Uint8Array(pulls === 1 ? GOVERNED_RESPONSE_MAX_BYTES : 1));
      },
      cancel() { cancelled = true; },
    });
    const fetchFn = vi.fn<FetchFn>().mockResolvedValue(new Response(stream, { headers: { "content-length": "1" } }));
    await expect(clientFor(fetchFn).list()).rejects.toMatchObject({ status: 502 });
    expect(cancelled).toBe(true); expect(pulls).toBeLessThanOrEqual(4);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("decodes valid multibyte UTF-8 across byte chunks", async () => {
    const body = new TextEncoder().encode(JSON.stringify({ error: "é" }));
    const stream = new ReadableStream<Uint8Array>({ start(controller) {
      for (const byte of body) controller.enqueue(Uint8Array.of(byte));
      controller.close();
    } });
    await expect(clientFor(async () => new Response(stream, { status: 409 })).list()).rejects.toMatchObject({ status: 409, message: '"é"' });
  });

  it.each([Uint8Array.of(0xff), Uint8Array.of(0xc3)])("rejects malformed or truncated UTF-8 from HTTP", async (bytes) => {
    const apiUrl = await serve((res) => { res.writeHead(503); res.write(bytes); res.end(); });
    await expect(new RefinementClient({ ...config, apiUrl }).list()).rejects.toMatchObject({
      status: 502, message: "Governed-learning response is not valid UTF-8; no result accepted.",
    });
  });

  it("cancels a malformed injected UTF-8 stream instead of consuming its remaining data", async () => {
    let cancelled = false; let pulls = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) { pulls++; controller.enqueue(Uint8Array.of(0xff)); },
      cancel() { cancelled = true; },
    });
    await expect(clientFor(async () => new Response(stream)).list()).rejects.toBeInstanceOf(ApiError);
    expect(cancelled).toBe(true); expect(pulls).toBeLessThanOrEqual(3);
  });

  it("bounds empty chunks even when the injected stream never ends", async () => {
    let pulls = 0; let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) { pulls++; controller.enqueue(new Uint8Array()); },
      cancel() { cancelled = true; },
    });
    await expect(clientFor(async () => new Response(stream)).list()).rejects.toMatchObject({ status: 502,
      message: "Governed-learning response exceeded the empty-chunk limit; no result accepted." });
    expect(cancelled).toBe(true); expect(pulls).toBeLessThanOrEqual(GOVERNED_RESPONSE_MAX_EMPTY_CHUNKS + 2);
  });

  it("bounds nonempty tiny chunk reads independently of the byte limit", async () => {
    let pulls = 0; let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) { pulls++; controller.enqueue(Uint8Array.of(0x20)); },
      cancel() { cancelled = true; },
    });
    await expect(clientFor(async () => new Response(stream)).list()).rejects.toMatchObject({ status: 502,
      message: "Governed-learning response exceeded the stream read limit; no result accepted." });
    expect(cancelled).toBe(true); expect(pulls).toBeLessThanOrEqual(GOVERNED_RESPONSE_MAX_READS + 2);
  });

  it("bounds a hung read even if the stream's cancel hook also hangs", async () => {
    vi.useFakeTimers();
    let cancelled = false; let signal: AbortSignal | undefined;
    const stream = new ReadableStream<Uint8Array>({
      pull: () => new Promise<void>(() => {}),
      cancel: () => { cancelled = true; return new Promise<void>(() => {}); },
    });
    const fetchFn: FetchFn = async (_url, init) => { signal = init?.signal; return new Response(stream); };
    const pending = clientFor(fetchFn).list();
    const assertion = expect(pending).rejects.toMatchObject({ kind: "deadline" });
    await vi.advanceTimersByTimeAsync(CONTROL_DEADLINE_MS);
    await assertion;
    expect(signal?.aborted).toBe(true); expect(cancelled).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([false, true])("cleans signal listeners after streaming reads (failure=%s)", async (failure) => {
    let adds: ReturnType<typeof vi.spyOn> | undefined;
    let removes: ReturnType<typeof vi.spyOn> | undefined;
    const fetchFn: FetchFn = async (_url, init) => {
      adds = vi.spyOn(init!.signal!, "addEventListener");
      removes = vi.spyOn(init!.signal!, "removeEventListener");
      return new Response(failure ? Uint8Array.of(0xff) : payload);
    };
    if (failure) await expect(clientFor(fetchFn).list()).rejects.toMatchObject({ status: 502 });
    else await clientFor(fetchFn).list();
    expect(adds!.mock.calls.length).toBeGreaterThan(0);
    expect(removes!.mock.calls.length).toBe(adds!.mock.calls.length);
  });
});

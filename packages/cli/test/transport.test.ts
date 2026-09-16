import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { CHAT_DEADLINE_MS } from "../src/api-client";
import { classifyPort } from "../src/engine/probe";
import { nodeFetch, ResponseSizeError } from "../src/transport";

/**
 * These tests drive the production transport against a real `node:http`
 * server. What they cannot drive in unit time is the defect the transport
 * exists to fix — the global fetch's undici dispatcher cutting a response
 * whose headers take longer than 300000 ms, half the chat deadline. That
 * behavior was pinned by measurement (a 340s server hang: global fetch dies
 * at 301s with UND_ERR_HEADERS_TIMEOUT, this transport returns the 200), and
 * the QA soak's model-ceiling probe re-measures it on every endure run.
 */

let server: Server | undefined;

function serve(
  handler: (req: IncomingMessage, body: string, res: ServerResponse) => void,
): Promise<string> {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => handler(req, Buffer.concat(chunks).toString("utf8"), res));
  });
  const s = server;
  return new Promise((resolve) => {
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as AddressInfo;
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

afterEach(() => {
  server?.closeAllConnections();
  server?.close();
  server = undefined;
});

describe("nodeFetch", () => {
  it("round-trips status, body, and headers on a GET", async () => {
    const base = await serve((req, _body, res) => {
      expect(req.method).toBe("GET");
      res.writeHead(200, { "content-type": "application/json", "x-single": "one" });
      res.end(JSON.stringify({ ok: true }));
    });

    const res = await nodeFetch(`${base}/api/health`);

    expect(res.status).toBe(200);
    expect(res.ok).toBe(true);
    expect(res.headers.get("x-single")).toBe("one");
    expect(JSON.parse(await res.text())).toEqual({ ok: true });
  });

  it("delivers a POST body with its content-type, an exact content-length, and no connection reuse", async () => {
    let seen: { method?: string; contentType?: string; contentLength?: string; connection?: string; body?: string } = {};
    const base = await serve((req, body, res) => {
      seen = {
        method: req.method,
        contentType: req.headers["content-type"],
        contentLength: req.headers["content-length"],
        connection: req.headers.connection,
        body,
      };
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });

    const payload = JSON.stringify({ message: "héllo" });
    await nodeFetch(`${base}/internal/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: payload,
    });

    expect(seen.method).toBe("POST");
    expect(seen.contentType).toBe("application/json");
    // Byte length, not string length — the payload is deliberately non-ASCII.
    expect(seen.contentLength).toBe(String(Buffer.byteLength(payload)));
    expect(seen.connection).toBe("close");
    expect(seen.body).toBe(payload);
  });

  it("returns a non-2xx as a Response with its body, never a rejection", async () => {
    const base = await serve((_req, _body, res) => {
      res.writeHead(409, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "busy", error_code: "TURN_IN_PROGRESS" }));
    });

    const res = await nodeFetch(`${base}/api/chat`, { method: "POST", headers: {}, body: "{}" });

    expect(res.status).toBe(409);
    expect(JSON.parse(await res.text())).toMatchObject({ error_code: "TURN_IN_PROGRESS" });
  });

  it("resolves a 204 as a null-body Response", async () => {
    const base = await serve((_req, _body, res) => {
      res.writeHead(204);
      res.end();
    });

    const res = await nodeFetch(`${base}/whatever`);

    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
  });

  it("rejects with the signal's reason on an already-aborted signal, without dialing", async () => {
    let dialed = false;
    const base = await serve(() => {
      dialed = true;
    });
    const controller = new AbortController();
    const reason = new Error("caller cancelled before dispatch");
    controller.abort(reason);

    await expect(nodeFetch(`${base}/api/health`, { signal: controller.signal })).rejects.toBe(
      reason,
    );
    expect(dialed).toBe(false);
  });

  it("rejects with the signal's reason when the deadline expires while headers are pending", async () => {
    // The server parks the request and never answers — the hung-model shape.
    const base = await serve(() => {});
    const controller = new AbortController();
    const reason = new Error("deadline expired");
    setTimeout(() => controller.abort(reason), 30);

    await expect(nodeFetch(`${base}/internal/mcp`, { signal: controller.signal })).rejects.toBe(
      reason,
    );
  });

  it("rejects a refused connection fetch-shaped, so the port classifier reads ECONNREFUSED from its cause", async () => {
    // Bind a port, then free it, so nothing is listening. The rejection must
    // be a TypeError with the Node error as `cause` — the exact shape
    // `connectionRefused` (engine/probe.ts) sniffs; a bare Error would make
    // `up`'s port scan classify every free port as held.
    const base = await serve(() => {});
    await new Promise<void>((resolve) => {
      server?.close(() => resolve());
    });
    server = undefined;

    const rejection: unknown = await nodeFetch(`${base}/api/health`).then(
      () => {
        throw new Error("resolved against a closed port");
      },
      (err: unknown) => err,
    );
    expect(rejection).toBeInstanceOf(TypeError);
    expect(
      ((rejection as TypeError).cause as { code?: unknown } | undefined)?.code,
    ).toBe("ECONNREFUSED");

    // The consumer-level guard: the production transport through the real
    // three-way classifier answers "refused" for the free port.
    const port = Number(new URL(base).port);
    await expect(classifyPort(port, { fetchFn: nodeFetch })).resolves.toBe(
      "refused",
    );
  });

  it("keeps the chat deadline above the engine's ten-minute model-call ceiling", () => {
    // 600000 ms is REQUEST_TIMEOUT_MS in the engine's model client. The
    // deadline must sit above it or the ceiling's own answer — the readable
    // timeout — can never reach the user (the defect class this transport
    // and deadline were aligned to remove). If the ceiling moves, both the
    // deadline and this number move with it.
    expect(CHAT_DEADLINE_MS).toBeGreaterThan(600_000);
  });
});


describe("request-local response byte caps", () => {
  it("accepts exactly the byte cap across chunk boundaries", async () => {
    const base = await serve((_req, _body, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.write(Buffer.from([0xc3]));
      setImmediate(() => { res.write(Buffer.from([0xa9, 0x21])); res.end(); });
    });
    expect(await (await nodeFetch(base, { maxResponseBytes: 3 })).text()).toBe("é!");
  });

  it("counts chunked bytes before concatenating and closes an oversized response", async () => {
    let close!: () => void;
    const closed = new Promise<void>((resolve) => { close = resolve; });
    const base = await serve((_req, _body, res) => {
      res.once("close", close);
      res.writeHead(200, { "transfer-encoding": "chunked" });
      res.write("abcd");
      setImmediate(() => res.write("efghi")); // Do not end: the client must destroy this stream.
    });
    const controller = new AbortController();
    const removed = vi.spyOn(controller.signal, "removeEventListener");
    await expect(nodeFetch(base, { maxResponseBytes: 8, signal: controller.signal })).rejects.toBeInstanceOf(ResponseSizeError);
    await closed;
    expect(removed).toHaveBeenCalledWith("abort", expect.any(Function));
  });

  it("does not trust a lying Content-Length header or an error status", async () => {
    const base = await serve((_req, _body, res) => {
      res.writeHead(503, { "content-length": "999999999" });
      res.write("012345678");
    });
    await expect(nodeFetch(base, { maxResponseBytes: 8 })).rejects.toThrow("Response exceeds the configured byte limit.");
  });

  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid maxResponseBytes %s before dialing", async (maxResponseBytes) => {
      let requests = 0;
      const base = await serve((_req, _body, res) => { requests++; res.end("ok"); });
      await expect(nodeFetch(base, { maxResponseBytes })).rejects.toThrow("positive safe integer");
      expect(requests).toBe(0);
    },
  );

  it("keeps uncapped ordinary requests and raw bytes unchanged", async () => {
    const bytes = Buffer.from([0xff, ...Buffer.from("more than eight bytes")]);
    const base = await serve((_req, _body, res) => { res.write(bytes); res.end(); });
    const res = await nodeFetch(base);
    expect(Buffer.from(await res.arrayBuffer())).toEqual(bytes);
  });

  it("aborts a hung partial bounded body with the original reason and removes the signal listener", async () => {
    let started!: () => void;
    let closed!: () => void;
    const start = new Promise<void>((resolve) => { started = resolve; });
    const close = new Promise<void>((resolve) => { closed = resolve; });
    const base = await serve((_req, _body, res) => {
      res.once("close", closed);
      res.writeHead(200); res.write("partial"); started();
    });
    const controller = new AbortController();
    const removed = vi.spyOn(controller.signal, "removeEventListener");
    const reason = new Error("fixture cancellation");
    const pending = nodeFetch(base, { maxResponseBytes: 32, signal: controller.signal });
    const assertion = expect(pending).rejects.toBe(reason);
    await start;
    controller.abort(reason);
    await assertion;
    await close;
    expect(removed).toHaveBeenCalledWith("abort", expect.any(Function));
  });
});

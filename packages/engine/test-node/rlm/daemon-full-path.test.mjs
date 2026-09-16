// SPDX-License-Identifier: AGPL-3.0-only
// Actual built daemon -> HTTP -> UserAgent -> service/runtime -> Worker/QuickJS.
// Only the loopback provider's replies are fixtures. No injected client/runtime.
// Root must build first and run this file with fresh, private fixture environment.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { createServer, request as httpRequest } from "node:http";
import { createConnection } from "node:net";
import { lstatSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

const hash = text => createHash("sha256").update(text, "utf8").digest("hex");
const codeEnvelope = source => JSON.stringify({ rlmCode: 1, source });
const readContext = `const meta=JSON.parse(contextMeta());let joined="";for(let i=0;i<meta.records;i++){joined+=JSON.parse(contextSlice(i,1)).c;}const envelope=JSON.parse(joined);const message=envelope.snapshot.messages[0];const spanEnd=envelope.sourceIndex.messages[0].fullBody[1];if(envelope.sourceIndex.spanUnit!=="utf16-code-units-half-open"||spanEnd!==message.body.length)throw Error("SOURCE_OFFSET_MISMATCH");`;
const simpleCode = `(async()=>{${readContext}return JSON.stringify({snapshotId:envelope.snapshot.snapshotId,body:message.body,bodyHash:message.bodyHash,spanEnd});})()`;
const childCode = `(async()=>{${readContext}return JSON.stringify({body:message.body,bodyHash:message.bodyHash,spanEnd});})()`;
const recursiveCode = `(async()=>{${readContext}const child=await rlm("Read the stored source and report its exact commitment body, hash, and UTF-16 span end.");const note=await llm("Review these child findings without tools: "+child);return JSON.stringify({snapshotId:envelope.snapshot.snapshotId,rootBody:message.body,bodyHash:message.bodyHash,spanEnd,child,note});})()`;
const childNote = "The supplied α🚀 body identifies the report and its deadline.";
const wireText = request => request.messages.map(message => typeof message.content === "string" ? message.content : JSON.stringify(message.content)).join("\n");

// Public-schema fixture construction, not a substitute runtime or validator.
// Field order matches the registered snapshot projection. The real HTTP/DO
// validator must independently accept both hashes and exact UTF-16 evidence.
function fixture(kind) {
  const body = "I will send the α🚀 report by 2026-09-14T17:00:00Z.";
  const snapshot = {
    workflowId: "mail.commitment-handoff.v1", schemaVersion: 1,
    snapshotId: "daemon-" + kind, snapshotHash: "0".repeat(64),
    userAddress: "fixture-owner@example.test", cutoff: "2026-09-11T12:00:00Z", timezone: "UTC",
    coverage: { scope: "supplied-snapshot", source: "synthetic-fixture", omittedMessages: 0,
      note: "Owned loopback daemon fixture. Not model efficacy or real provider billing." },
    messages: [{ id: "m1", threadId: "t1", subject: "Report", sender: "fixture-owner@example.test",
      to: "colleague@example.test", timestamp: "2026-09-11T11:00:00Z", body, bodyHash: hash(body),
      truncated: false, omittedChars: 0 }],
  };
  const content = { ...snapshot };
  delete content.snapshotHash;
  snapshot.snapshotHash = hash("habenula:commitment-snapshot:v1\n" + JSON.stringify(content));
  const sourceIndex = { schemaVersion: 1, kind: "source-offset-index", snapshotId: snapshot.snapshotId,
    snapshotHash: snapshot.snapshotHash, spanUnit: "utf16-code-units-half-open", lineBreaks: "CRLF|CR|LF|NEL|LS|PS",
    lineLimitPerMessage: 256, lineIndexComplete: true,
    messages: [{ messageId: "m1", bodyHash: hash(body), fullBody: [0, body.length], lineCount: 1,
      lines: [[0, body.length]], omittedLineCount: 0 }] };
  const contextRow = JSON.stringify({ i: 0, c: JSON.stringify({ snapshot, sourceIndex }) });
  assert.ok(Buffer.byteLength(contextRow) < 20_000, "This tiny fixture must occupy exactly one context row");
  const ledger = { workflowId: snapshot.workflowId, snapshotId: snapshot.snapshotId, snapshotHash: snapshot.snapshotHash,
    items: [{ itemId: "report", title: "Send report", owner: snapshot.userAddress, state: "due", dueAt: "2026-09-14T17:00:00Z",
      changed: false, evidence: [{ messageId: "m1", bodyHash: hash(body), start: 0, end: body.length, quote: body }],
      priorEvidence: [], uncertainty: null, nextAction: "Send the report by the stated deadline.", replyText: null }],
    coverage: { scope: "supplied-snapshot", omittedMessages: 0, truncatedMessageIds: [], limitations: [] } };
  const texts = kind === "recursive" ? [codeEnvelope(recursiveCode), codeEnvelope(childCode), childNote, JSON.stringify(ledger)]
    : kind === "ordinary-json" ? [JSON.stringify(ledger)] : [codeEnvelope(simpleCode), JSON.stringify(ledger)];
  return { kind, body, snapshot, ledger, contextRow, contextHash: hash(contextRow), texts, requests: [] };
}

function bounded(promise, ms, label, signal) {
  let timer;
  let abort;
  const limit = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(label + " timed out; closure is UNKNOWN")), ms);
    abort = () => reject(new Error(label + " aborted"));
    if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, { once: true });
  });
  return Promise.race([promise, limit]).finally(() => {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  });
}

function requestJson(url, { method = "GET", headers = {}, body, signal } = {}) {
  assert.equal(url.protocol, "http:");
  assert.equal(url.hostname, "127.0.0.1", "Fixture requests cannot leave the owned loopback address");
  return new Promise((resolveReply, reject) => {
    const bytes = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const request = httpRequest(url, { method, signal, agent: false,
      headers: { connection: "close", ...headers, ...(bytes ? { "content-type": "application/json", "content-length": bytes.length } : {}) } }, response => {
      const chunks = [];
      let size = 0;
      response.on("data", chunk => {
        size += chunk.length;
        if (size > 256 * 1024) response.destroy(new Error("API response exceeded fixture bound"));
        else chunks.push(chunk);
      });
      response.once("error", reject);
      response.once("aborted", () => reject(new Error("API response aborted")));
      response.once("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        try { resolveReply({ status: response.statusCode, json: JSON.parse(text), bytes: size }); }
        catch { reject(new Error("API response was not JSON (status " + response.statusCode + ")")); }
      });
    });
    request.setTimeout(5_000, () => request.destroy(new Error("API request timed out")));
    request.once("error", reject);
    request.end(bytes);
  });
}

// Only an explicit connection refusal is a closed-port receipt. Timeout,
// permissions errors, and successful connection are failures, never absence.
function closedPort(port) {
  return new Promise((resolveClosed, reject) => {
    let result;
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.setTimeout(600, () => { result = new Error("Port closure UNKNOWN: timeout"); socket.destroy(); });
    socket.once("connect", () => { result = new Error("Owned port still accepts connections: " + port); socket.destroy(); });
    socket.once("error", error => { result = error.code === "ECONNREFUSED" ? { port, address: "127.0.0.1", code: error.code } : error; });
    socket.once("close", () => result instanceof Error ? reject(result) : result ? resolveClosed(result) : reject(new Error("Port closure UNKNOWN")));
  });
}

function assertReleased(status, previous, reason) {
  assert.equal(status.activeRunId, null, "Coordinator release must precede fixture teardown");
  assert.equal(status.state, "idle");
  assert.equal(status.liveWorkers, 0);
  assert.equal(status.admissions, previous.admissions + 1);
  assert.equal(status.exits, previous.exits + 1, "Actual Worker exit is required");
  assert.equal(status.history.at(-1).reason, reason);
  assert.ok(Number.isInteger(status.history.at(-1).exitCode));
}

function assertComplete(plan, result) {
  assert.equal(result.status, "complete", JSON.stringify(result.validation));
  assert.equal(result.mode, "rlm");
  assert.equal(result.snapshotId, plan.snapshot.snapshotId);
  assert.equal(result.snapshotHash, plan.snapshot.snapshotHash);
  assert.deepEqual(result.ledger, plan.ledger);
  assert.equal(result.validation.valid, true);
  assert.equal(result.validation.semanticVerified, false);
  assert.equal(result.usage.kind, "provider-reported", "Production adapter label; figures are authored by this fake provider");
  assert.equal(result.usage.complete, true);
  assert.equal(result.usage.rootCalls, 2);
  assert.equal(result.usage.childCalls, plan.kind === "recursive" ? 2 : 0);
  assert.equal(result.usage.inputTokens, plan.texts.length * 5);
  assert.equal(result.usage.outputTokens, plan.texts.length * 3);
  assert.deepEqual(result.model, { provider: "openai-compatible", model: "daemon-fixture-model", effort: null });
  const trace = result.analysisTrace;
  assert.equal(trace.outcome, "complete");
  assert.equal(trace.truncated, false);
  assert.equal(trace.snapshotHash, plan.snapshot.snapshotHash);
  assert.equal(trace.contextHash, plan.contextHash);
  assert.deepEqual(trace.calls.map(call => call.id), plan.texts.map((_, index) => "a" + (index + 1)));
  assert.ok(trace.calls.every(call => call.inputTokens === 5 && call.outputTokens === 3 && call.outcome === "complete"));
  const executes = trace.operations.filter(op => op.kind === "execute");
  const expectedHashes = plan.kind === "recursive" ? [hash(recursiveCode), hash(childCode)] : [hash(simpleCode)];
  assert.deepEqual(executes.map(op => op.codeHash).sort(), expectedHashes.sort());
  const slices = trace.operations.filter(op => op.kind === "slice");
  assert.equal(slices.length, expectedHashes.length);
  assert.ok(slices.every(op => op.returnedChars === plan.contextRow.length));
  assert.deepEqual(slices.map(op => op.nodeId).sort(), executes.map(op => op.nodeId).sort());
  assert.ok(Buffer.byteLength(plan.contextRow) > plan.contextRow.length, "Unicode must distinguish UTF-8 bytes from UTF-16 units");
  assert.ok(!wireText(plan.requests[0]).includes(plan.body), "Codegen gets metadata, not the sealed source body");
  assert.ok(wireText(plan.requests.at(-1)).includes(plan.body), "Actual guest findings must reach final synthesis");
  assert.ok(wireText(plan.requests.at(-1)).includes(hash(plan.body)));
  assert.equal(trace.nodes.length, plan.kind === "recursive" ? 3 : 1);
  if (plan.kind === "recursive") {
    assert.match(plan.requests[1].messages[0].content, /rlmCode/);
    assert.match(plan.requests[2].messages[0].content, /bounded analysis subtask/);
    assert.ok(wireText(plan.requests[2]).includes(plan.body), "Child execution must feed the ordinary llm call");
    assert.ok(wireText(plan.requests.at(-1)).includes(childNote));
    assert.ok(trace.calls.slice(1, 3).every(call => call.parentCallId === "a1" && call.nodeId !== "n0"));
  }
}

test("compiled daemon/UserAgent API executes recursive context code, rejects JSON bypass, and recovers", { timeout: 20_000 }, async t => {
  const required = name => { const value = process.env[name]; assert.ok(value, "Root must supply " + name); return value; };
  const fixtureKey = required("RLM_DAEMON_FIXTURE_KEY");
  const token = required("RLM_DAEMON_FIXTURE_TOKEN");
  assert.ok(/^[a-fA-F0-9]{64}$/.test(fixtureKey), "Fixture key must be 64 hex characters");
  assert.ok(token.length >= 24 && token.length <= 512 && !/[\r\n\0]/.test(token), "Invalid synthetic local token");
  const persistRoot = required("RLM_DAEMON_PERSIST_ROOT");
  const output = required("RLM_DAEMON_FULL_PATH_OBSERVATIONS");
  assert.ok(isAbsolute(persistRoot) && isAbsolute(output));
  assert.equal(realpathSync(persistRoot), resolve(persistRoot));
  assert.ok(lstatSync(persistRoot).isDirectory() && !lstatSync(persistRoot).isSymbolicLink());
  assert.deepEqual(readdirSync(persistRoot), [], "Daemon persistence must be a fresh, root-owned empty directory");
  assert.equal(realpathSync(dirname(output)), resolve(dirname(output)));
  const portText = required("HABENULA_PORT");
  assert.ok(/^\d+$/.test(portText) && Number(portText) > 0 && Number(portText) <= 65535, "Root must reserve a nonzero daemon port");
  // Refuse accidental credential inheritance; never inspect a provider/auth store.
  for (const name of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_CLIENT_SECRET", "GITHUB_CLIENT_SECRET", "SLACK_CLIENT_SECRET"]) {
    assert.ok(!process.env[name], "Refuse inherited non-fixture credential environment: " + name);
  }
  const owner = "daemon-fixture-" + randomUUID();
  const observation = { scope: "compiled-daemon-api-loopback-fake-provider", status: "RUNNING", owner,
    limitations: ["Provider replies and usage figures are authored fixtures, not model efficacy or real billing.",
      "Port receipts cover the returned daemon and fake-provider ports only. Root owns OS/process closure proof."],
    http: [], plans: [], providerErrors: [], knownPorts: [], closure: {} };
  const sockets = new Set();
  let plan;
  let daemonPromise;
  let daemon;
  let backendStatus;
  let failure;
  let providerCount = 0;
  const cleanupErrors = [];
  const work = new AbortController();
  const abortWork = () => work.abort();
  t.signal.addEventListener("abort", abortWork, { once: true });
  const workDeadline = setTimeout(abortWork, 12_000);
  const provider = createServer({ requestTimeout: 3_000, headersTimeout: 3_000 }, (request, response) => {
    void (async () => {
      assert.equal(request.method, "POST");
      assert.equal(request.url, "/v1/chat/completions");
      assert.ok(["127.0.0.1", "::ffff:127.0.0.1"].includes(request.socket.remoteAddress));
      assert.equal(request.headers.authorization, "Bearer daemon-fixture-not-a-real-api-key");
      const chunks = [];
      let bytes = 0;
      for await (const chunk of request) { bytes += chunk.length; assert.ok(bytes <= 128 * 1024); chunks.push(chunk); }
      const wire = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      providerCount += 1;
      assert.ok(plan, "No provider dispatch is allowed before an authenticated run");
      plan.requests.push(wire);
      assert.ok(plan.requests.length <= plan.texts.length, "No unexpected call or implicit provider retry");
      assert.equal(wire.model, "daemon-fixture-model");
      assert.ok(Number.isInteger(wire.max_tokens) && wire.max_tokens > 0 && wire.max_tokens <= 4096);
      assert.deepEqual(wire.tools, []);
      assert.equal(wire.stream, undefined);
      assert.equal(wire.messages[0].role, "system");
      response.writeHead(200, { "content-type": "application/json", connection: "close" });
      response.end(JSON.stringify({ id: "owned-loopback-" + providerCount,
        choices: [{ message: { role: "assistant", content: plan.texts[plan.requests.length - 1] }, finish_reason: "stop" }],
        usage: { prompt_tokens: 5, completion_tokens: 3 } }));
    })().catch(error => {
      observation.providerErrors.push({ name: error.name, message: error.message });
      if (!response.headersSent) response.writeHead(500, { "content-type": "application/json", connection: "close" });
      response.end(JSON.stringify({ error: "Owned provider fixture rejected the request" }));
      request.destroy();
    });
  });
  provider.maxConnections = 8;
  provider.setTimeout(3_000, socket => socket.destroy());
  provider.on("connection", socket => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  provider.on("error", error => observation.providerErrors.push({ name: error.name, message: error.message }));
  try {
    await bounded(new Promise((ready, reject) => { provider.once("error", reject); provider.listen(0, "127.0.0.1", ready); }), 2_000, "Fake provider listen", work.signal);
    const address = provider.address();
    assert.equal(address.address, "127.0.0.1");
    observation.knownPorts.push({ role: "fake-provider", address: address.address, port: address.port });
    assert.notEqual(address.port, Number(portText));
    Object.assign(process.env, { CREDENTIAL_ENCRYPTION_KEY: fixtureKey, INTERNAL_MCP_TOKEN: token,
      HABENULA_PERSIST_ROOT: persistRoot, GOVERNED_LEARNING: "true", GOVERNED_RLM: "true", LOCALHOST_ONLY: "true",
      GOVERNED_LEARNING_VALIDATION: "schema_contract", LLM_PROVIDER: "openai-compatible", LLM_MODEL: "daemon-fixture-model",
      LLM_ENDPOINT: "http://127.0.0.1:" + address.port + "/v1", LLM_API_KEY: "daemon-fixture-not-a-real-api-key" });
    const compiled = await bounded(import("../../dist/daemon/start.js"), 5_000, "Compiled daemon import", work.signal);
    ({ backendStatus } = await import("../../dist/rlm/node-backend.mjs"));
    const opening = backendStatus();
    observation.backendOpening = opening;
    assert.equal(opening.activeRunId, null);
    assert.equal(opening.liveWorkers, 0);
    assert.equal(opening.admissions, 0, "This smoke needs an isolated Node process");
    daemonPromise = compiled.startDaemon("127.0.0.1", persistRoot);
    daemon = await bounded(daemonPromise, 8_000, "Actual daemon startup", work.signal);
    assert.ok(daemon.url instanceof URL && typeof daemon.dispose === "function");
    assert.equal(daemon.url.hostname, "127.0.0.1");
    assert.equal(Number(daemon.url.port), Number(portText));
    observation.knownPorts.push({ role: "daemon", address: daemon.url.hostname, port: Number(daemon.url.port) });
    async function api(label, path, options = {}) {
      const headers = { authorization: "Bearer " + token, origin: daemon.url.origin, ...options.headers };
      if (headers.authorization === undefined) delete headers.authorization;
      const reply = await requestJson(new URL(path, daemon.url), { ...options, headers, signal: work.signal });
      observation.http.push({ label, path, method: options.method ?? "GET", reply });
      return reply;
    }
    const describePath = "/api/workflows?userId=" + encodeURIComponent(owner);
    assert.equal((await api("missing-token", describePath, { headers: { authorization: undefined } })).status, 401);
    assert.equal((await api("wrong-token", describePath, { headers: { authorization: "Bearer wrong-fixture-token" } })).status, 401);
    assert.equal((await api("foreign-origin", describePath, { headers: { origin: "https://not-local.invalid" } })).status, 403);
    assert.equal((await api("foreign-host", describePath, { headers: { host: "not-local.invalid" } })).status, 403);
    const describe = await api("describe", describePath);
    assert.equal(describe.status, 200);
    assert.equal(describe.json.workflowId, "mail.commitment-handoff.v1");
    assert.ok(describe.json.supportedModes.includes("rlm"));
    assert.equal(providerCount, 0);
    assert.deepEqual(backendStatus(), opening, "Denied/describe requests must not admit a Worker");
    let previous = opening;
    for (const kind of ["recursive", "ordinary-json", "recovery"]) {
      plan = fixture(kind);
      observation.plans.push(plan);
      const reply = await api(kind, "/api/workflows/run", { method: "POST", body: { userId: owner, mode: "rlm", snapshot: plan.snapshot } });
      plan.backendAfterRunBeforeTeardown = backendStatus();
      assert.equal(reply.status, 200, JSON.stringify(reply.json));
      assert.equal(plan.requests.length, plan.texts.length);
      assertReleased(plan.backendAfterRunBeforeTeardown, previous, kind === "ordinary-json" ? "ERROR" : "COMPLETE");
      previous = plan.backendAfterRunBeforeTeardown;
      if (kind === "ordinary-json") {
        assert.equal(reply.json.status, "error", "Incomplete execution trace is an execution error, not a ledger-only validation failure");
        assert.equal(reply.json.ledger, null);
        assert.equal(reply.json.analysisTrace.outcome, "error");
        assert.equal(reply.json.analysisTrace.operations.some(op => op.kind === "execute" || op.kind === "slice"), false);
        assert.equal(reply.json.usage.rootCalls, 1);
        assert.equal(reply.json.usage.childCalls, 0);
        assert.equal(reply.json.usage.complete, true);
        assert.deepEqual(reply.json.analysisTrace.calls.map(call => call.id), ["a1"]);
      } else assertComplete(plan, reply.json);
    }
    assert.equal(providerCount, 7);
    assert.deepEqual(observation.providerErrors, []);
    const recursive = observation.http.find(entry => entry.label === "recursive").reply.json;
    const recovery = observation.http.find(entry => entry.label === "recovery").reply.json;
    assert.notEqual(recovery.runId, recursive.runId);
    assert.notEqual(recovery.analysisTrace.contextHash, recursive.analysisTrace.contextHash);
    assert.deepEqual(recovery.analysisTrace.calls.map(call => call.id), ["a1", "a2"], "Same UserAgent/runtime gets a fresh task budget and trace");
  } catch (error) { failure = error; }
  finally {
    clearTimeout(workDeadline);
    work.abort();
    t.signal.removeEventListener("abort", abortWork);
    // Even a late startup resolution is paired with actual disposal. A bounded
    // wait expiring is failure/UNKNOWN, never successful cleanup or release.
    if (daemonPromise) {
      try {
        await bounded(daemonPromise.then(async handle => { await handle.dispose(); await handle.dispose(); }), 5_000, "Daemon dispose including probe stop and Miniflare");
        observation.closure.daemonDisposeResolved = true;
      } catch (error) { cleanupErrors.push(error); observation.closure.daemonDisposeResolved = false; }
    }
    try {
      await bounded(new Promise((closed, reject) => {
        if (!provider.listening) { closed(); return; }
        provider.close(error => error ? reject(error) : closed());
        provider.closeAllConnections();
      }), 1_000, "Owned fake provider close");
      observation.closure.fakeProviderListening = provider.listening;
      observation.closure.fakeProviderConnections = sockets.size;
      assert.equal(provider.listening, false);
      assert.equal(sockets.size, 0);
    } catch (error) { cleanupErrors.push(error); }
    if (backendStatus) {
      observation.backendClosing = backendStatus();
      try { assert.equal(observation.backendClosing.activeRunId, null); assert.equal(observation.backendClosing.liveWorkers, 0); }
      catch (error) { cleanupErrors.push(error); }
    }
    try { observation.closure.ports = await Promise.all(observation.knownPorts.map(item => closedPort(item.port))); }
    catch (error) { cleanupErrors.push(error); }
    observation.providerCallCount = providerCount;
    observation.closure.cleanupErrors = cleanupErrors.map(error => ({ name: error.name, message: error.message }));
    observation.failure = failure ? { name: failure.name, message: failure.message } : null;
    observation.status = !failure && cleanupErrors.length === 0 ? "PASS_COMPILED_DAEMON_API_LOOPBACK_FAKE_PROVIDER" : "FAIL";
    // A fresh output is mandatory. Never replace a prior receipt or source file.
    writeFileSync(output, JSON.stringify(observation, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  }
  if (failure || cleanupErrors.length) throw new AggregateError([...(failure ? [failure] : []), ...cleanupErrors], "Compiled daemon/API smoke failed; inspect the preserved observation");
});

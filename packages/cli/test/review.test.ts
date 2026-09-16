// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readBoundedJson, runReview, SNAPSHOT_MAX_BYTES } from "../src/commands/review";
import { HASH, fakeClient, snapshot, workflowResult } from "./governed-learning-fixtures";

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function temp() { const dir = await mkdtemp(join(tmpdir(), "habenula-review-")); dirs.push(dir); return dir; }

describe("bounded snapshot JSON reader", () => {
  it("reads UTF-8 JSON data without importing or executing a file", async () => {
    const file = join(await temp(), "snapshot.json");
    await writeFile(file, JSON.stringify({ text: "import('node:fs'); process.exit(9); 世界" }));
    expect(await readBoundedJson(file)).toEqual({ text: "import('node:fs'); process.exit(9); 世界" });
  });

  it("rejects oversized input, malformed JSON, invalid UTF-8 and directories", async () => {
    const dir = await temp(); const file = join(dir, "input.json");
    await writeFile(file, " ".repeat(65));
    await expect(readBoundedJson(file, 64)).rejects.toThrow("exceeds the 64-byte limit");
    await writeFile(file, "export default {}");
    await expect(readBoundedJson(file)).rejects.toThrow("valid UTF-8 JSON data");
    await writeFile(file, Buffer.from([0x22, 0xff, 0x22]));
    await expect(readBoundedJson(file)).rejects.toThrow("valid UTF-8 JSON data");
    const folder = join(dir, "folder"); await mkdir(folder);
    await expect(readBoundedJson(folder)).rejects.toThrow("regular JSON file");
  });
});

describe("local commitment review", () => {
  it.each(["baseline", "refinements", "rlm", "both"] as const)("requests exactly mode %s and prints all-call usage without mock efficacy", async (mode) => {
    const client = fakeClient(); const out: string[] = []; const source = snapshot();
    const result = workflowResult(); result.mode = mode;
    vi.mocked(client.runWorkflow).mockResolvedValue(result);
    const readJson = vi.fn(async () => source);
    expect(await runReview(client, "snapshot.json", { mode }, { readJson, write: (s) => out.push(s), width: 100 })).toBe(0);
    expect(readJson).toHaveBeenCalledWith("snapshot.json", SNAPSHOT_MAX_BYTES);
    expect(client.runWorkflow).toHaveBeenCalledExactlyOnceWith({ workflowId: "mail.commitment-handoff.v1", mode, snapshot: source });
    const text = out.join("\n");
    expect(text).toContain("CONTRACT-CHECKED · behavior unmeasured");
    expect(text).toContain("1 root + 2 child calls");
    expect(text).toContain("DETERMINISTIC MOCK: plumbing only");
    expect(text).toContain("NOT sent/saved");
    expect(text).toContain("CHANGED"); expect(text).toContain("Current evidence"); expect(text).toContain("Prior evidence");
    expect(text).toContain("Omitted messages: unknown"); expect(text).toContain(HASH);
  });

  it("emits exactly one machine-readable JSON result with no prose or raw terminal controls", async () => {
    const result = workflowResult(); result.notices = ["\u001b[2J\u009b31m\u202equote"];
    const client = fakeClient(); vi.mocked(client.runWorkflow).mockResolvedValue(result);
    const out: string[] = []; const err: string[] = [];
    expect(await runReview(client, "snapshot.json", { mode: "baseline", json: true }, {
      readJson: async () => snapshot(), write: (s) => out.push(s), writeErr: (s) => err.push(s), width: 80,
    })).toBe(0);
    expect(err.join("\n")).toContain("cannot retract inference already dispatched");
    expect(out).toHaveLength(1);
    expect(out[0]).not.toMatch(/[\u001b\u009b\u202e]/);
    expect(JSON.parse(out[0]!)).toEqual(result);
  });

  it("rejects file authority, unsigned drafts and malformed modes before submission", async () => {
    const client = fakeClient(); const io = { readJson: async () => ({ ...snapshot(), userId: "other-user" }), write: vi.fn(), width: 80 };
    await expect(runReview(client, "snapshot.json", { mode: "baseline" }, io)).rejects.toThrow("snapshot contract");
    await expect(runReview(client, "snapshot.json", { mode: "invalid" as "baseline" }, io)).rejects.toThrow("Mode must");
    io.readJson = async () => ({ ...snapshot(), snapshotHash: "" , userId: "other-user" });
    await expect(runReview(client, "snapshot.json", { mode: "baseline" }, io)).rejects.toThrow("snapshot contract");
    expect(client.runWorkflow).not.toHaveBeenCalled();
  });

  it("refuses a response bound to a different snapshot or mode", async () => {
    const client = fakeClient(); const result = workflowResult(); result.mode = "both";
    vi.mocked(client.runWorkflow).mockResolvedValue(result);
    const write = vi.fn();
    await expect(runReview(client, "snapshot.json", { mode: "baseline" }, {
      readJson: async () => snapshot(), write, width: 80,
    })).rejects.toThrow("requested snapshot and mode");
    expect(write).not.toHaveBeenCalled();
  });

  it("reports blocked mode as nonzero and never prints an accepted ledger", async () => {
    const result = workflowResult(); result.status = "blocked"; result.ledger = null;
    result.validation = { level: "contract-only", valid: false, semanticVerified: false,
      issues: [{ code: "runtime_unavailable", path: "mode", message: "RLM unavailable" }] };
    const client = fakeClient(); vi.mocked(client.runWorkflow).mockResolvedValue(result);
    const out: string[] = [];
    expect(await runReview(client, "snapshot.json", { mode: "baseline" }, {
      readJson: async () => snapshot(), write: (s) => out.push(s), width: 80,
    })).toBe(1);
    expect(out.join("\n")).toContain("No accepted ledger");
    expect(out.join("\n")).not.toContain("LEDGER\n");
  });
});

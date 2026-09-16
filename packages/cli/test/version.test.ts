import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
const umbrellaRoot = join(packageRoot, "../habenula");
const umbrellaManifest = JSON.parse(readFileSync(join(umbrellaRoot, "package.json"), "utf8"));
const tsxLoader = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;

// Each fixture uses the real CLI source, build script and umbrella forwarder.
// It lives below the package so build dependencies resolve from this workspace,
// not an install/download or the user's global tools. No engine is executed.
describe.each([manifest.version, "7.8.9-cli-version.1"])("CLI package version %s", (version: string) => {
  let root: string;
  let cliRoot: string;
  let umbrella: string;
  let foreignCwd: string;
  let env: NodeJS.ProcessEnv;

  function run(args: string[], cwd = foreignCwd) {
    const result = spawnSync(process.execPath, args, {
      cwd,
      env,
      encoding: "utf8",
      timeout: 20_000,
      maxBuffer: 512 * 1024,
    });
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  }

  beforeAll(() => {
    root = mkdtempSync(join(packageRoot, ".version-test-"));
    cliRoot = join(root, "node_modules/@habenula-ai/cli");
    const engineRoot = join(root, "node_modules/@habenula-ai/engine");
    umbrella = join(root, "node_modules/habenula");
    foreignCwd = join(root, "unrelated-cwd");
    for (const dir of [cliRoot, engineRoot, umbrella, foreignCwd]) mkdirSync(dir, { recursive: true });
    cpSync(join(packageRoot, "src"), join(cliRoot, "src"), { recursive: true });
    for (const file of ["build.mjs", "tsconfig.json"]) cpSync(join(packageRoot, file), join(cliRoot, file));
    writeFileSync(join(cliRoot, "package.json"), JSON.stringify({ ...manifest, version }));
    cpSync(join(packageRoot, "../engine/package.json"), join(engineRoot, "package.json"));
    for (const file of ["package.json", umbrellaManifest.bin.habenula]) {
      cpSync(join(umbrellaRoot, file), join(umbrella, file));
    }
    writeFileSync(join(foreignCwd, "package.json"), JSON.stringify({
      name: "not-the-cli", version: "99.0.0-cwd", type: "module",
    }));
    const configPath = join(root, "refused-config");
    writeFileSync(configPath, "INTERNAL_MCP_TOKEN\n");
    env = {
      ...process.env,
      HABENULA_PERSIST_ROOT: join(root, "state"),
      HABENULA_CONFIG: configPath,
      npm_package_version: "98.0.0-environment",
    };
    // Build exactly what the owning package's build recipe builds, not a mock
    // of its version seam. The alternate CLI version differs from the engine.
    const build = run(["build.mjs"], cliRoot);
    expect(build.status, build.stderr).toBe(0);
  }, 30_000);

  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it("reports its own version through the TSX source loader, despite bad config and foreign cwd/env", () => {
    expect(run(["--import", tsxLoader, join(cliRoot, "src/bin.ts"), "--version"])).toEqual({
      status: 0, stdout: `${version}\n`, stderr: "",
    });
  });

  it("reports its own version through the actual manifest-declared Node bundle", () => {
    expect(run([join(cliRoot, manifest.bin.habenula), "--version"])).toEqual({
      status: 0, stdout: `${version}\n`, stderr: "",
    });
  });

  it("forwards that same CLI version through the actual umbrella bin", () => {
    expect(run([join(umbrella, umbrellaManifest.bin.habenula), "--version"])).toEqual({
      status: 0, stdout: `${version}\n`, stderr: "",
    });
  });
});

# Run this fork from source

Use Node 22.22.1 and just 1.46.0, as pinned in `.mise.toml`. Run commands from the repository root unless noted. **Do not use `npx habenula` to install this fork:** that selects the upstream published package.

## 1. Build

```sh
mise install
npm ci
just oss-build
node packages/cli/dist/index.js --help
```

The staged build was verified using existing locked dependencies linked read-only into an isolated checkout. A fresh network `npm ci` was not part of that verification. No npm release, container deployment, or GitHub Actions run is claimed.

## 2. Run checks without a live model

```sh
node --import tsx --test --test-concurrency=1 \
  packages/engine/test-node/rlm/app-wiring.test.ts \
  packages/engine/test-node/rlm/backend-binding-integration.test.ts \
  packages/engine/test-node/rlm/native-cancel.test.ts \
  packages/engine/test-node/rlm/runtime-integration.test.ts \
  packages/engine/test-node/rlm/sdk-lifecycle.test.ts \
  packages/engine/test-node/rlm/read-evidence.test.mjs \
  packages/engine/test-node/rlm/full-path.test.mjs \
  packages/engine/test-node/rlm/prompt-contract.test.mjs
```

This is the 59-test native suite. It exercises actual QuickJS/Worker behavior with controlled model/client fixtures. It does not request live inference.

For the engine suite:

```sh
(cd packages/engine &&
  ../../node_modules/.bin/vitest run test/ --maxWorkers=2 --reporter=dot)
```

The recorded staged run passed 104 files/1,168 tests. Expected rejection/error logs are part of negative tests; use the final test summary and exit status, not a search for the word `error`.

The [compiled-daemon fixture](../packages/engine/test-node/rlm/daemon-full-path.test.mjs) is separate. It requires a fresh canonical persistence directory, a synthetic 64-hex encryption key, a synthetic caller token, an unused port via `HABENULA_PORT`, and the `RLM_DAEMON_FIXTURE_KEY`, `RLM_DAEMON_FIXTURE_TOKEN`, `RLM_DAEMON_PERSIST_ROOT`, and `RLM_DAEMON_FULL_PATH_OBSERVATIONS` settings. It refuses inherited provider credentials. Its provider responses are authored, while its compiled daemon/DO/private binding/Worker/QuickJS path is real.

## 3. Explicit live review

Live inference is optional and can take minutes. It requires your own authorized provider setup. Do not put provider credentials or local control tokens in this repository, an issue, a screenshot, or a benchmark export.

Configure the local Node daemon using [the engine setup](../packages/engine/README.md#run-on-the-host-node-no-container) and its example templates. Use fresh private state for a synthetic demo, preserve loopback binding, and explicitly set:

```text
GOVERNED_LEARNING=true
GOVERNED_RLM=true
```

Live review requires your own authorized provider configuration. Historical provider/model identity and account routing are not distributed in this privacy-normalized source package. Do not assume access to an account or local bridge.

Start the built daemon in the foreground from the repository root, using your private environment:

```sh
node packages/engine/dist/daemon/index.js
```

In a second terminal with matching private caller configuration (`HABENULA_API_URL` and `HABENULA_INTERNAL_MCP_TOKEN` matching the daemon), run the **local built CLI**:

```sh
node packages/cli/dist/index.js review \
  evals/governed-learning/sealed/fresh/fresh-05.snapshot.json \
  --mode rlm --json
```

The sealed file is synthetic, not a real mailbox. `--mode baseline` uses the ordinary workflow analyzer. `--mode both` also needs eligible active guidance. Ordinary chat does not automatically use RLM. Standalone Wrangler has no private Node backend and refuses RLM.

Stop only the daemon you started. A local abort or process exit does not prove remote inference/billing stopped. The published benchmark procedure uses additional source pins, exclusive run receipts, bounded supervision, and cleanup checks; a manual demo is not automatically part of that frozen cohort.

## Platform scope

The recorded native build and supervision ran on macOS arm64 with Node 22.22.1. Other operating systems and a clean installed release are not claimed verified. See [limits](LIMITS.md) before exposing anything beyond a trusted local machine.

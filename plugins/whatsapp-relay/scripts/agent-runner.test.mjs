import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { serializableAgentOptions } from "./agent-runner.mjs";
import { requestHostOperation } from "./controller-hosts.mjs";

test("SSH discovery serialization carries host scope without gateway credentials", () => {
  const value = serializableAgentOptions({ engine: "claude", workspace: "/launch", scope: "host", limit: 200,
    env: { SECRET: "private" }, claudeConfigDir: "/gateway-private-config", host: { target: "private-host" } });
  assert.deepEqual(value, { engine: "claude", workspace: "/launch", scope: "host", limit: 200 });
});

test("SSH listing payload reaches the real worker and reads host-wide native indexes", { timeout: 10_000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "relay-agent-discovery-"));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }));
  const claudeConfigDir = path.join(root, "native-config");
  const workspaces = [root, path.join(root, "another-project")];
  const ids = [];
  for (const cwd of workspaces) {
    const id = randomUUID(); ids.push(id);
    const directory = path.join(claudeConfigDir, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, `${id}.jsonl`), `${JSON.stringify({ type: "user", sessionId: id, cwd, message: { content: "Synthetic native session" } })}\n`);
  }
  const workerPath = fileURLToPath(new URL("./relay-worker.mjs", import.meta.url));
  const host = { id: "vm", transport: "ssh", platform: process.platform, target: "test-worker", workerPath };
  const payload = { operation: "agent.listThreads", ...serializableAgentOptions({ engine: "claude", workspace: root, scope: "host", limit: 200 }) };
  const result = await requestHostOperation(host, payload, { timeoutMs: 5_000,
    spawnImpl(command, args, options) {
      assert.equal(command, "ssh");
      assert.equal(options.shell, false);
      // Stand in for SSH only; run the actual worker/adapter under a native
      // config belonging to this fixture, never the machine's credentials.
      return spawn(process.execPath, [workerPath], { ...options, env: { ...process.env, CLAUDE_CONFIG_DIR: claudeConfigDir } });
    }
  });
  assert.deepEqual(new Set(result.map(row => row.id)), new Set(ids));
  assert.deepEqual(new Set(result.map(row => row.cwd)), new Set(workspaces));
});

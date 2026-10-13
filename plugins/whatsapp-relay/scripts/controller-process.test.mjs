import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { controllerDaemonEnv, startControllerDaemon } from "./controller-process.mjs";
import { ensureRuntimeDirs } from "./paths.mjs";

test("controllerDaemonEnv persists relay TTS defaults into the daemon environment", () => {
  const env = controllerDaemonEnv(
    {
      ttsProvider: "chatterbox-turbo",
      ttsChatterboxAllowNonEnglish: true
    },
    {
      PATH: "/tmp/bin",
      WHATSAPP_RELAY_TTS_PROVIDER: "system",
      WHATSAPP_RELAY_TTS_CHATTERBOX_ALLOW_NON_ENGLISH: "0"
    }
  );

  assert.equal(env.PATH, "/tmp/bin");
  assert.equal(env.WHATSAPP_RELAY_TTS_PROVIDER, "chatterbox-turbo");
  assert.equal(env.WHATSAPP_RELAY_TTS_CHATTERBOX_ALLOW_NON_ENGLISH, "1");
});

test("controllerDaemonEnv disables non-English Chatterbox fallback when config says no", () => {
  const env = controllerDaemonEnv(
    {
      ttsProvider: "system",
      ttsChatterboxAllowNonEnglish: false
    },
    {
      WHATSAPP_RELAY_TTS_CHATTERBOX_ALLOW_NON_ENGLISH: "1"
    }
  );

  assert.equal(env.WHATSAPP_RELAY_TTS_PROVIDER, "system");
  assert.equal(env.WHATSAPP_RELAY_TTS_CHATTERBOX_ALLOW_NON_ENGLISH, "0");
});

function fakeChild(pid = 12345) {
  const child = new EventEmitter();
  child.pid = pid;
  child.unref = () => {};
  return child;
}

test("daemon startup creates runtime folders before opening its log and hides the Windows console", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "relay-process-"));
  const runtimeDir = path.join(root, "fresh", "data");
  let statusCalls = 0;
  let closed = false;
  let opened;
  let invocation;
  const child = fakeChild();
  try {
    const status = await startControllerDaemon({
      ensureDirs: () => ensureRuntimeDirs(runtimeDir),
      getStatus: async () => ++statusCalls === 1
        ? { running: false, pid: null }
        : { running: true, pid: child.pid },
      getOwner: async () => null,
      loadConfig: async () => ({ ttsProvider: "system" }),
      openLog: async () => {
        opened = await fs.open(path.join(runtimeDir, "controller.log"), "a");
        return { fd: opened.fd, close: async () => { await opened.close(); closed = true; } };
      },
      spawnImpl: (...args) => { invocation = args; return child; },
      wait: async () => {}
    });
    assert.equal(status.pid, child.pid);
    assert.equal(closed, true);
    assert.equal(invocation[0], process.execPath);
    assert.equal(invocation[2].windowsHide, true);
    assert.equal(invocation[2].detached, true);
    assert.equal(invocation[2].stdio[0], "ignore");
    for (const folder of ["auth", "controller-outbox", "controller-outbox.failed"]) {
      assert.equal((await fs.stat(path.join(runtimeDir, folder))).isDirectory(), true);
    }
  } finally {
    if (opened && !closed) await opened.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("daemon startup refuses another checkout's live owner before spawning", async () => {
  await assert.rejects(startControllerDaemon({
    ensureDirs: async () => {},
    getStatus: async () => ({ running: false, pid: null }),
    getOwner: async () => ({ pid: 6789, repoRoot: "/other/checkout" }),
    loadConfig: async () => assert.fail("must not load or spawn after ownership conflict"),
    spawnImpl: () => assert.fail("must not start a second gateway")
  }), /already running from \/other\/checkout/);
});

test("daemon startup closes its log when spawn throws", async () => {
  let closed = false;
  await assert.rejects(startControllerDaemon({
    ensureDirs: async () => {},
    getStatus: async () => ({ running: false, pid: null }),
    getOwner: async () => null,
    loadConfig: async () => ({}),
    openLog: async () => ({ fd: 1, close: async () => { closed = true; } }),
    spawnImpl: () => { throw new Error("spawn failed"); }
  }), /spawn failed/);
  assert.equal(closed, true);
});

test("daemon startup reports asynchronous process launch failures without unhandled error events", async () => {
  const child = fakeChild();
  let closed = false;
  await assert.rejects(startControllerDaemon({
    ensureDirs: async () => {},
    getStatus: async () => ({ running: false, pid: null }),
    getOwner: async () => null,
    loadConfig: async () => ({}),
    openLog: async () => ({ fd: 1, close: async () => { closed = true; } }),
    spawnImpl: () => child,
    wait: async () => { child.emit("error", new Error("executable unavailable")); }
  }), /executable unavailable/);
  assert.equal(closed, true);
});

test("global ownership path stays in the user home when HOME is absent", () => {
  const env = { ...process.env };
  delete env.HOME;
  const pathsUrl = new URL("./paths.mjs", import.meta.url).href;
  const source = `import os from 'node:os'; import { globalControllerOwnerFile } from ${JSON.stringify(pathsUrl)}; process.stdout.write(JSON.stringify({home:os.homedir(),owner:globalControllerOwnerFile}));`;
  const actual = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", source], {
    env, encoding: "utf8", windowsHide: true
  }));
  assert.equal(actual.owner, path.join(actual.home, ".codex", "plugins", "whatsapp-relay", "controller-owner.json"));
});

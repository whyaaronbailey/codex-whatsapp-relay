import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

import {
  normalizeHosts, resolveHost, buildSshWorkerArgs, requestHostOperation, spawnHostAppServer
} from "./controller-hosts.mjs";
import { resolveCodexLaunch } from "./codex-process.mjs";
import { drainControllerCommands } from "./controller-outbox.mjs";

const remote = { id: "vm", transport: "ssh", target: "relay-user@vm", platform: "linux", workerPath: "/opt/relay/relay-worker.mjs" };
const workerPath = fileURLToPath(new URL("./relay-worker.mjs", import.meta.url));

function fakeChild() {
  const child = new EventEmitter();
  Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), killed: false });
  child.kill = () => { child.killed = true; return true; };
  return child;
}

test("host normalization preserves a default local user and validates configured destinations", () => {
  assert.deepEqual(normalizeHosts({ hosts: [remote] }).map((host) => host.id), ["host", "vm"]);
  assert.equal(resolveHost().transport, "local");
  assert.throws(() => resolveHost({}, "vm"), /Unknown host/);
  assert.throws(() => normalizeHosts({ hosts: [remote, remote] }), /Duplicate/);
  assert.throws(() => normalizeHosts({ hosts: [{ ...remote, target: "-oProxyCommand=evil" }] }), /SSH target/);
  assert.throws(() => normalizeHosts({ hosts: [{ ...remote, target: "vm;anything" }] }), /SSH target/);
  assert.throws(() => normalizeHosts({ hosts: [{ ...remote, nodeBin: "node $(anything)" }] }), /shell syntax/);
  assert.throws(() => normalizeHosts({ hosts: [{ ...remote, workerPath: "relative.mjs" }] }), /absolute workerPath/);
});

test("SSH bootstrap keeps configured worker paths encoded and host key policy intact", () => {
  const args = buildSshWorkerArgs({ ...remote, workerPath: "/opt/relay path/it's $(literal)/worker.mjs" });
  assert.equal(args.at(-2), "relay-user@vm");
  assert.match(args.at(-1), /^'node' -e /);
  assert.doesNotMatch(args.join(" "), /StrictHostKeyChecking|UserKnownHostsFile|literal|relay path/);
  const encoded = args.at(-1).match(/Buffer\.from\('([^']+)'/)[1];
  assert.match(Buffer.from(encoded, "base64").toString(), /it's \$\(literal\)/);
  const windows = buildSshWorkerArgs({ ...remote, platform: "win32", nodeBin: "C:\\Program Files\\nodejs\\node.exe", workerPath: "C:\\Relay Files\\relay-worker.mjs" });
  assert.match(windows.at(-1), /^powershell\.exe -NoProfile -NonInteractive -EncodedCommand [A-Za-z0-9+/=]+$/);
  const script = Buffer.from(windows.at(-1).split(" ").at(-1), "base64").toString("utf16le");
  assert.match(script, /& 'C:\\Program Files\\nodejs\\node\.exe' -e /);
});

test("Windows npm Codex shim launches JavaScript through Node without a shell", () => {
  const launcher = "C:\\npm\\node_modules\\@openai\\codex\\bin\\codex.js";
  const found = new Set(["C:\\npm\\codex.cmd", launcher]);
  assert.deepEqual(resolveCodexLaunch("codex", {
    platform: "win32", env: { Path: "C:\\npm" }, execPath: "C:\\node.exe", fileExists: (file) => found.has(file)
  }), { command: "C:\\node.exe", argsPrefix: [launcher] });
  assert.throws(() => resolveCodexLaunch("C:\\custom\\anything.cmd", { platform: "win32", fileExists: () => false }), /Cannot safely launch/);
});

test("SSH app-server keeps workspace and all protocol data off the shell command", () => {
  const child = fakeChild();
  let invocation;
  const workspace = "/repo/$(touch pwned); quote ' workspace";
  const actual = spawnHostAppServer({ host: remote, codexBin: "C:\\host\\codex.exe", workspace, args: ["app-server"] }, {
    spawnImpl(command, args, options) { invocation = { command, args, options }; return child; }
  });
  assert.equal(actual, child);
  assert.equal(invocation.command, "ssh");
  assert.equal(invocation.options.shell, false);
  assert.doesNotMatch(invocation.args.at(-1), /touch pwned|host\\codex/);
  assert.deepEqual(JSON.parse(child.stdin.read().toString()), { operation: "codex.appServer", workspace, codexBin: "codex", args: ["app-server"] });
});

test("one-shot SSH file request forwards bytes as JSON and propagates worker errors", async () => {
  let received;
  const result = await requestHostOperation(remote, { operation: "file.list", workspace: "/repo" }, {
    spawnImpl() {
      const child = fakeChild();
      child.stdin.on("data", (chunk) => { received = JSON.parse(chunk); });
      setImmediate(() => { child.stdout.write(JSON.stringify({ result: [{ id: "attachment-1" }] })); child.emit("close", 0, null); });
      return child;
    }
  });
  assert.deepEqual(received, { operation: "file.list", workspace: "/repo" });
  assert.deepEqual(result, [{ id: "attachment-1" }]);
  await assert.rejects(requestHostOperation(remote, { operation: "file.list", workspace: "/repo" }, {
    spawnImpl() {
      const child = fakeChild();
      setImmediate(() => { child.stdout.write(JSON.stringify({ error: "Workspace unavailable" })); child.emit("close", 1, null); });
      return child;
    }
  }), /Workspace unavailable/);
});

test("one-shot SSH operation times out and terminates its connection", async () => {
  const child = fakeChild();
  await assert.rejects(requestHostOperation(remote, { operation: "file.list", workspace: "/repo" }, { timeoutMs: 10, spawnImpl: () => child }), /timed out/);
  assert.equal(child.killed, true);
});

test("SSH request reconciliation forwards only a read-only status operation", async () => {
  const request = { operation: "agent.gatewayStatus", engine: "codex", requestId: "wa-request-001", codexGateway: { pythonBin: "python", configPath: "/relay/gateway.json" } };
  let received;
  const status = await requestHostOperation(remote, request, {
    spawnImpl() {
      const child = fakeChild();
      child.stdin.on("data", chunk => { received = JSON.parse(chunk); });
      setImmediate(() => { child.stdout.write(JSON.stringify({ result: { completed: false, readOnly: true } })); child.emit("close", 0, null); });
      return child;
    }
  });
  assert.deepEqual(received, request);
  assert.deepEqual(status, { completed: false, readOnly: true });
});

test("SSH status timeout leaves bounded receipt collection to release its lock", async () => {
  const child = fakeChild();
  await assert.rejects(requestHostOperation(remote, { operation: "agent.gatewayStatus", requestId: "wa-request-001" }, { timeoutMs: 10, spawnImpl: () => child }), /timed out/);
  assert.equal(child.killed, false);
});

test("an offline SSH destination remains retryable", async () => {
  await assert.rejects(requestHostOperation(remote, { operation: "file.readOutgoing", workspace: "/repo", relativePath: "report.pdf" }, {
    spawnImpl() {
      const child = fakeChild();
      setImmediate(() => { child.stderr.write("ssh: connect to host vm: Connection refused"); child.emit("close", 255, null); });
      return child;
    }
  }), (error) => /Connection refused/.test(error.message) && error.retryable !== false);
});

test("real worker subprocess rejects unsupported operations", async () => {
  const child = spawn(process.execPath, [workerPath], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  const closed = new Promise((resolve, reject) => { child.once("close", resolve); child.once("error", reject); });
  child.stdin.end(JSON.stringify({ operation: "run-anything", command: "ignored" }) + "\n");
  assert.equal(await closed, 1);
  assert.match(JSON.parse(output).error, /Unsupported worker operation/);
});

test("real worker proxies complete app-server lines and reaps child on input close", { timeout: 5000 }, async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "relay-worker-test-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const server = path.join(directory, "mock-server.mjs");
  await fs.writeFile(server, `import readline from 'node:readline';
    for await (const line of readline.createInterface({input:process.stdin})) {
      const request=JSON.parse(line);
      process.stdout.write(JSON.stringify({id:request.id,result:{cwd:process.cwd(),args:process.argv.slice(2),text:request.params.text}})+'\\n');
    }`);
  const child = spawn(process.execPath, [workerPath], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  t.after(() => child.kill());
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const closed = new Promise((resolve, reject) => { child.once("close", resolve); child.once("error", reject); });
  const response = new Promise((resolve) => {
    let data = "";
    child.stdout.on("data", (chunk) => { data += chunk; if (data.includes("\n")) resolve(JSON.parse(data.split("\n")[0])); });
  });
  // Send startup and JSON-RPC together: the worker must retain the remainder.
  child.stdin.write(JSON.stringify({ operation: "codex.appServer", codexBin: server, workspace: directory, args: ["app-server"] }) + "\n" +
    JSON.stringify({ id: 1, method: "test", params: { text: "voice 🎤; $(literal)" } }) + "\n");
  assert.deepEqual(await response, { id: 1, result: { cwd: directory, args: ["app-server"], text: "voice 🎤; $(literal)" } });
  child.stdin.end();
  await closed;
  assert.equal(stderr, "");
});

// Allow bounded headroom for real PowerShell cold startup under parallel CI load.
test("Windows SSH bootstrap passes stdin and UTF-8 through its actual PowerShell launcher", { timeout: 30000, skip: process.platform !== "win32" }, async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "relay-windows-ssh-test-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }));
  const server = path.join(directory, "mock-server.mjs");
  await fs.writeFile(server, `import readline from 'node:readline';
    for await (const line of readline.createInterface({input:process.stdin})) {
      const request=JSON.parse(line);
      process.stdout.write(JSON.stringify({id:request.id,result:{text:request.params.text}})+'\\n');
    }`);
  const args = buildSshWorkerArgs({ ...remote, platform: "win32", nodeBin: process.execPath, workerPath });
  const command = args.at(-1).split(" ");
  const child = spawn(command[0], command.slice(1), { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  t.after(() => child.kill());
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const closed = new Promise((resolve, reject) => { child.once("close", resolve); child.once("error", reject); });
  const response = new Promise((resolve, reject) => {
    let data = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      data += chunk;
      if (data.includes("\n")) {
        try { resolve(JSON.parse(data.split("\n")[0])); } catch (error) { reject(error); }
      }
    });
    child.once("close", () => { if (!data) reject(new Error(stderr || "Bootstrap closed without output")); });
  });
  child.stdin.write(JSON.stringify({ operation: "codex.appServer", codexBin: server, workspace: directory, args: ["app-server"] }) + "\n" +
    JSON.stringify({ id: 7, method: "test", params: { text: "Unicode café 中文 🎤" } }) + "\n");
  assert.deepEqual(await response, { id: 7, result: { text: "Unicode café 中文 🎤" } });
  child.stdin.end();
  await closed;
  assert.equal(stderr, "");
});

test("worker file roundtrip preserves binary data, manifests, limits and permanent errors", { timeout: 10000 }, async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "relay-worker-files-test-"));
  t.after(() => fs.rm(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }));
  const operate = (request) => requestHostOperation(remote, { workspace, ...request }, {
    // Keep the real request/response transport and worker, replacing only SSH.
    spawnImpl(command) {
      assert.equal(command, "ssh");
      return spawn(process.execPath, [workerPath], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    }
  });
  const bytes = Buffer.from(Array.from({ length: 4096 }, (_, i) => i % 256));
  const incoming = await operate({ operation: "file.writeIncoming", filename: "../binary?.bin", bufferBase64: bytes.toString("base64") });
  assert.equal(incoming.direction, "incoming");
  assert.equal(incoming.filename, "binary_.bin");
  assert.deepEqual(await fs.readFile(path.join(workspace, incoming.relativePath)), bytes);
  const outgoing = await operate({ operation: "file.readOutgoing", relativePath: incoming.relativePath });
  assert.deepEqual(Buffer.from(outgoing.bufferBase64, "base64"), bytes);
  assert.equal(outgoing.sha256, crypto.createHash("sha256").update(bytes).digest("hex"));
  assert.equal(outgoing.status, "prepared");
  assert.equal((await operate({ operation: "file.markSent", id: outgoing.id })).status, "sent");
  const listed = await operate({ operation: "file.list" });
  assert.equal(listed.length, 2);
  assert.equal(listed.find((entry) => entry.id === outgoing.id).status, "sent");
  for (const request of [
    { operation: "file.readOutgoing", relativePath: "../outside.txt" },
    { operation: "file.readOutgoing", relativePath: incoming.relativePath, maxBytes: 4095 },
    { operation: "file.writeIncoming", filename: "too-large.bin", bufferBase64: bytes.toString("base64"), maxBytes: 4095 }
  ]) await assert.rejects(operate(request), { code: "ERR_RELAY_ATTACHMENT", retryable: false });
  await assert.rejects(operate({ operation: "file.readOutgoing", relativePath: "does-not-exist.pdf" }), { code: "ENOENT", retryable: false });
  await assert.rejects(operate({ operation: "file.readOutgoing", relativePath: ".whatsapp-relay/inbox" }), { code: "ERR_RELAY_ATTACHMENT", retryable: false });

  // A permanent remote validation failure must not block later outbox commands.
  const outboxDir = path.join(workspace, "test-outbox");
  const failedDir = path.join(workspace, "test-failed");
  await fs.mkdir(outboxDir);
  await fs.mkdir(failedDir);
  await fs.writeFile(path.join(outboxDir, "01.json"), JSON.stringify({ id: "invalid-file", type: "send_file" }));
  await fs.writeFile(path.join(outboxDir, "02.json"), JSON.stringify({ id: "later-message", type: "send_message" }));
  const handled = [];
  await drainControllerCommands(async (command) => {
    if (command.type === "send_file") await operate({ operation: "file.readOutgoing", relativePath: "../outside.txt" });
    handled.push(command.id);
  }, { outboxDir, failedDir });
  assert.deepEqual(handled, ["later-message"]);
  assert.deepEqual(await fs.readdir(outboxDir), []);
  assert.deepEqual(await fs.readdir(failedDir), ["invalid-file.failed.json"]);
});

test("worker refuses exporting WhatsApp auth and relay runtime data from its repository workspace", { timeout: 10000 }, async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "relay-private-files-test-"));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const relativePath = "plugins/whatsapp-relay/data/auth/creds.json";
  await fs.mkdir(path.dirname(path.join(workspace, relativePath)), { recursive: true });
  await fs.writeFile(path.join(workspace, relativePath), JSON.stringify({ fixture: true }));
  for (const file of [relativePath, "auth-backup/session-123.json", "store.json", "runtime.json", "controller-config.json", "controller-state.json", "controller-owner.json", "controller.log", "controller-outbox/01.json", "pre-key-123.json", "sender-key-123.json", "app-state-sync-key-123.json"]) {
    await assert.rejects(requestHostOperation(remote, { operation: "file.readOutgoing", workspace, relativePath: file }, {
      spawnImpl: () => spawn(process.execPath, [workerPath], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true })
    }), { code: "ERR_RELAY_ATTACHMENT", retryable: false });
  }
});

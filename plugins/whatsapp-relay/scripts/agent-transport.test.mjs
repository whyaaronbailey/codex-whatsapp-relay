import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startRemoteAgentTurn, runAgentWorker } from "./agent-transport.mjs";
import { serializableAgentOptions } from "./agent-runner.mjs";

const host = { id: "vm", transport: "ssh", platform: "linux", target: "relay-test", workerPath: "/relay/relay-worker.mjs" };
const options = { host, engine: "opencode", workspace: "/project", prompt: "Do requested work", permissionLevel: "native", opencodeUrl: "http://127.0.0.1:4096" };
const result = { threadId: "ses_native", replyText: "Completed." };

function fakeSsh(t, { killCloses = true } = {}) {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.signals = []; child.requests = [];
  let input = "";
  child.stdin.on("data", chunk => {
    input += chunk.toString("utf8");
    let index;
    while ((index = input.indexOf("\n")) >= 0) {
      const line = input.slice(0, index); input = input.slice(index + 1);
      if (line) child.requests.push(JSON.parse(line));
    }
  });
  child.kill = signal => { child.signals.push(signal ?? "SIGTERM"); if (killCloses) queueMicrotask(() => child.emit("close", null)); return true; };
  child.send = message => child.stdout.write(`${JSON.stringify(message)}\n`);
  child.spawnImpl = (...args) => { child.spawnArgs = args; return child; };
  // The transport's watchdog deliberately unrefs its own timer.
  const keepAlive = setTimeout(() => {}, 5000);
  t.after(() => { clearTimeout(keepAlive); child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); });
  return child;
}

test("SSH agent sends only provider fields over stdin and confirms the result on clean close", async t => {
  const child = fakeSsh(t);
  const run = startRemoteAgentTurn({ ...options, prompt: "private prompt $(unsafe)", env: { SECRET: "secret" }, whatsappToken: "token", password: "private", onLifecycleEvent: () => {}, opencodePasswordEnv: "VM_PASSWORD" }, { spawnImpl: child.spawnImpl });
  const request = child.requests[0];
  assert.equal(request.operation, "agent.run");
  assert.equal(request.params.prompt, "private prompt $(unsafe)");
  assert.equal(request.params.opencodePasswordEnv, "VM_PASSWORD");
  for (const field of ["env", "whatsappToken", "password", "onLifecycleEvent", "host"]) assert.equal(Object.hasOwn(request.params, field), false);
  assert.equal(child.spawnArgs[0], "ssh");
  assert.equal(child.spawnArgs[2].shell, false);
  assert.ok(!JSON.stringify(child.spawnArgs).includes("private prompt"));
  child.send({ type: "ready" });
  child.send({ type: "result", result });
  let resolved = false; run.resultPromise.then(() => { resolved = true; });
  await delay(5); assert.equal(resolved, false);
  child.emit("close", 0);
  assert.deepEqual(await run.resultPromise, result);
});

test("SSH agent lifecycle and approval events retain their native identity", async t => {
  const child = fakeSsh(t);
  const events = [];
  const run = startRemoteAgentTurn({ ...options, onLifecycleEvent: e => events.push(["lifecycle", e]), onApprovalRequest: e => events.push(["approval", e]), onApprovalResolved: e => events.push(["resolved", e]) }, { spawnImpl: child.spawnImpl });
  child.send({ type: "lifecycle", event: { type: "turnStarted", threadId: "ses_native" } });
  child.send({ type: "approval", event: { requestId: "per_native", reason: "Review action" } });
  child.send({ type: "approvalResolved", event: { requestId: "per_native" } });
  await delay(1);
  assert.deepEqual(events.map(e => e[0]), ["lifecycle", "approval", "resolved"]);
  child.send({ type: "result", result }); child.emit("close", 0);
  await run.resultPromise;
});

test("SSH agent propagates typed remote failures without retrying", async t => {
  const child = fakeSsh(t);
  const run = startRemoteAgentTurn(options, { spawnImpl: child.spawnImpl });
  child.send({ type: "error", error: { message: "Native server needs attention", code: "NATIVE_FAILURE", retryable: false } });
  await assert.rejects(run.resultPromise, error => error.message === "Native server needs attention" && error.code === "NATIVE_FAILURE" && error.retryable === false);
  assert.equal(child.requests.filter(r => r.operation === "agent.run").length, 1);
  assert.ok(child.signals.length);
});

for (const [name, action, error] of [
  ["disconnect", c => c.emit("close", 0), /disconnected/],
  ["failed exit", c => { c.stderr.write("SSH authentication failed"); c.emit("close", 255); }, /authentication failed/],
  ["malformed JSON", c => c.stdout.write("{invalid}\n"), /Invalid/],
  ["unknown event", c => c.send({ type: "unexpected" }), /Unknown/],
  ["truncated output", c => { c.stdout.write('{"type":"res'); c.emit("close", 0); }, /disconnected/],
  ["invalid result", c => { c.send({ type: "result", result: { ok: true } }); c.emit("close", 0); }, /Invalid|invalid|result/],
  ["duplicate result", c => { c.send({ type: "result", result }); c.send({ type: "result", result }); c.emit("close", 0); }, /duplicate|Duplicate|result/]
]) {
  test(`SSH agent rejects ${name}`, async t => {
    const child = fakeSsh(t);
    const run = startRemoteAgentTurn(options, { spawnImpl: child.spawnImpl });
    action(child); await assert.rejects(run.resultPromise, error);
  });
}

test("SSH agent heartbeats keep a long run alive and silence fails closed", async t => {
  const child = fakeSsh(t);
  const run = startRemoteAgentTurn(options, { spawnImpl: child.spawnImpl, idleTimeoutMs: 40 });
  const heartbeat = setInterval(() => child.send({ type: "heartbeat" }), 10);
  t.after(() => clearInterval(heartbeat));
  await delay(90); clearInterval(heartbeat);
  await assert.rejects(run.resultPromise, /stopped responding/);
  assert.ok(child.signals.length);
});

test("SSH agent interrupt and approval preserve both control arguments and await acknowledgment", async t => {
  const child = fakeSsh(t);
  const run = startRemoteAgentTurn(options, { spawnImpl: child.spawnImpl });
  const approval = run.answerApproval("per_native", "accept");
  const command = child.requests.at(-1);
  assert.equal(command.command, "approval");
  assert.deepEqual(command.value, { requestId: "per_native", decision: "accept" });
  child.send({ type: "controlResult", id: command.id, result: null });
  await approval;
  const interrupted = run.interrupt();
  const stop = child.requests.at(-1);
  assert.equal(stop.command, "interrupt");
  child.send({ type: "controlResult", id: stop.id, result: { stopped: true } });
  assert.deepEqual(await interrupted, { stopped: true });
  child.send({ type: "error", error: { message: "Native run was interrupted", code: "INTERRUPTED" } });
  await assert.rejects(run.resultPromise, /interrupted/);
});

test("SSH control timeout reports uncertain interruption and never repeats it", async t => {
  const child = fakeSsh(t);
  const run = startRemoteAgentTurn(options, { spawnImpl: child.spawnImpl, controlTimeoutMs: 20 });
  await assert.rejects(run.interrupt(), /not confirmed/);
  assert.equal(child.requests.filter(r => r.command === "interrupt").length, 1);
  child.send({ type: "result", result }); child.emit("close", 0); await run.resultPromise;
});

test("SSH transport escalates cleanup when its child ignores termination", async t => {
  const child = fakeSsh(t, { killCloses: false });
  const run = startRemoteAgentTurn(options, { spawnImpl: child.spawnImpl, idleTimeoutMs: 15 });
  await assert.rejects(run.resultPromise, /stopped responding/);
  await delay(2050);
  assert.deepEqual(child.signals, ["SIGTERM", "SIGKILL"]);
  child.emit("close", null);
});

test("SSH lifecycle delivery failures stop the owned connection", async t => {
  const child = fakeSsh(t);
  const run = startRemoteAgentTurn({ ...options, onLifecycleEvent: () => { throw new Error("Delivery disconnected"); } }, { spawnImpl: child.spawnImpl });
  child.send({ type: "lifecycle", event: { type: "turnStarted" } });
  await assert.rejects(run.resultPromise, /Delivery disconnected/);
  assert.ok(child.signals.length);
});

function workerFixture(t, overrides = {}) {
  const input = new PassThrough(), output = new PassThrough();
  const messages = [];
  let text = "", resolve, reject;
  output.on("data", chunk => {
    text += chunk.toString("utf8");
    let newline;
    while ((newline = text.indexOf("\n")) >= 0) { messages.push(JSON.parse(text.slice(0, newline))); text = text.slice(newline + 1); }
  });
  const run = { child: null, resultPromise: new Promise((res, rej) => { resolve = res; reject = rej; }), interrupt: async () => { reject(new Error("Interrupted")); }, answerApproval: async () => {}, ...overrides };
  t.after(() => { input.destroy(); output.destroy(); });
  return { input, output, messages, run, resolve, reject };
}

test("Agent worker strips host routing, forwards lifecycle, heartbeats, and final result", async t => {
  const f = workerFixture(t);
  let received;
  const worker = runAgentWorker({ params: { ...options, host: { transport: "ssh" } } }, Buffer.alloc(0), { ...f, heartbeatMs: 5, startTurn: params => { received = params; return f.run; } });
  assert.equal(received.host, null);
  received.onLifecycleEvent({ type: "turnStarted", threadId: "ses_native" });
  await delay(15); f.resolve(result); await worker;
  assert.ok(f.messages.some(m => m.type === "heartbeat"));
  assert.ok(f.messages.some(m => m.type === "lifecycle"));
  assert.deepEqual(f.messages.at(-1), { type: "result", result });
});

test("Agent worker unpacks approval arguments and acknowledges interrupted runs", async t => {
  const calls = [];
  const f = workerFixture(t, { answerApproval: async (...args) => { calls.push(args); } });
  const worker = runAgentWorker({ params: options }, Buffer.from(`${JSON.stringify({ id: 1, command: "approval", value: { requestId: "per_native", decision: "decline" } })}\n`), { ...f, startTurn: () => f.run });
  await delay(5);
  assert.deepEqual(calls, [["per_native", "decline"]]);
  f.input.write(`${JSON.stringify({ id: 2, command: "interrupt" })}\n`);
  await worker;
  assert.ok(f.messages.some(m => m.type === "controlResult" && m.id === 2 && !m.error));
  assert.equal(f.messages.at(-1).type, "error");
});

test("Agent worker interrupts its owned run on gateway disconnect", async t => {
  const f = workerFixture(t);
  let interrupts = 0;
  f.run.interrupt = async () => { interrupts++; f.reject(new Error("Interrupted")); };
  const worker = runAgentWorker({ params: options }, Buffer.alloc(0), { ...f, startTurn: () => f.run });
  f.input.end(); await worker;
  assert.equal(interrupts, 1);
  assert.match(f.messages.at(-1).error.message, /Gateway disconnected/);
});

test("Agent worker bounds a hung control call before finalizing its result", async t => {
  const f = workerFixture(t, { answerApproval: () => new Promise(() => {}) });
  const command = { id: 1, command: "approval", value: { requestId: "per_hanging", decision: "accept" } };
  const worker = runAgentWorker({ params: options }, Buffer.from(`${JSON.stringify(command)}\n`), { ...f, startTurn: () => f.run, controlTimeoutMs: 20 });
  f.resolve(result);
  await worker;
  assert.ok(f.messages.some(m => m.type === "controlResult" && /timed out/.test(m.error?.message ?? "")));
  assert.deepEqual(f.messages.at(-1), { type: "result", result });
});

test("Provider serialization rejects unknown engines and omits secrets and executable callbacks", () => {
  assert.throws(() => serializableAgentOptions({ engine: "shell" }), /Unsupported/);
  assert.deepEqual(serializableAgentOptions({ engine: "claude", workspace: "/project", prompt: "task", env: { TOKEN: "private" }, accessToken: "private", spawnProcess: () => {}, host: { target: "remote" }, apiKey: "private" }), { engine: "claude", workspace: "/project", prompt: "task" });
});

test("Actual worker subprocess uses its own OpenCode credentials and native HTTP API", async t => {
  const workspace = process.cwd();
  const requests = [];
  const server = http.createServer(async (request, response) => {
    let content = ""; for await (const chunk of request) content += chunk;
    const route = new URL(request.url, "http://localhost").pathname;
    requests.push({ method: request.method, route, authorization: request.headers.authorization, body: content ? JSON.parse(content) : undefined });
    const key = `${request.method} ${route}`;
    const session = { id: "ses_worker", location: { directory: workspace } };
    const responses = {
      "GET /api/info": { version: "2.0.27" },
      "POST /api/session": { data: session },
      "GET /api/session/active": { data: {} },
      "GET /api/session/ses_worker/permission": { data: [] },
      "GET /api/session/ses_worker/form": { data: [] },
      "GET /api/session/ses_worker/inbox": { data: [] },
      "POST /api/session/ses_worker/prompt": { data: { id: "prompt_worker" } },
      "GET /api/session/ses_worker/message": { data: [{ type: "idle", outcome: "succeeded" }, { type: "assistant", content: [{ type: "text", text: "Worker answer 🎤" }] }, { type: "user", id: "prompt_worker" }] }
    };
    response.writeHead(Object.hasOwn(responses, key) ? 200 : 404, { "content-type": "application/json" });
    response.end(JSON.stringify(responses[key] ?? {}));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const workerPath = fileURLToPath(new URL("./relay-worker.mjs", import.meta.url));
  let child;
  const run = startRemoteAgentTurn({ ...options, workspace, opencodeUrl: `http://127.0.0.1:${server.address().port}`, opencodePasswordEnv: "RELAY_TEST_WORKER_PASSWORD", opencodeUsernameEnv: "RELAY_TEST_WORKER_USERNAME", env: { RELAY_TEST_WORKER_PASSWORD: "must-not-cross" } }, {
    spawnImpl: () => {
      child = spawn(process.execPath, [workerPath], { cwd: path.dirname(workerPath), stdio: ["pipe", "pipe", "pipe"], windowsHide: true, shell: false, env: { ...process.env, RELAY_TEST_WORKER_PASSWORD: "worker-only", RELAY_TEST_WORKER_USERNAME: "fixture" } });
      return child;
    }
  });
  t.after(() => child?.kill());
  assert.deepEqual(await run.resultPromise, { threadId: "ses_worker", replyText: "Worker answer 🎤" });
  assert.ok(requests.length >= 8);
  assert.ok(requests.every(r => r.authorization === `Basic ${Buffer.from("fixture:worker-only").toString("base64")}`));
  assert.equal(requests.filter(r => r.route.endsWith("/prompt")).length, 1);
  assert.equal(requests.find(r => r.route.endsWith("/prompt")).body.text, options.prompt);
});

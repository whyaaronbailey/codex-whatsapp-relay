import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { EventEmitter, once } from "node:events";
import { PassThrough } from "node:stream";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { BRIDGE_SCHEMA, isDesktopAppServerInvocation, startDesktopBridge, readJsonLines } from "./desktop-owned-bridge.mjs";

const TOKEN = "A".repeat(64);
async function eventually(check) {
  for (let i = 0; i < 200; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.fail("Expected condition did not become true within one second.");
}
async function freePort() {
  const server = net.createServer(); server.listen(0, "127.0.0.1"); await once(server, "listening");
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}
function capture(stream) {
  const messages = [];
  let data = "";
  stream.on("data", chunk => { data += chunk.toString("utf8"); let at; while ((at = data.indexOf("\n")) >= 0) { const line = data.slice(0, at); data = data.slice(at + 1); if (line) messages.push(JSON.parse(line)); } });
  return messages;
}
function mockBackend({ linger = false, respond, respondInitialize } = {}) {
  const child = new EventEmitter(); Object.assign(child, { pid: 32123, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), killed: false });
  child.kill = () => { assert.fail("The bridge must never kill a process."); };
  const requests = capture(child.stdin);
  let chunk = "", closed = false;
  child.stdin.on("data", data => { chunk += data.toString(); let i; while ((i = chunk.indexOf("\n")) >= 0) { const message = JSON.parse(chunk.slice(0, i)); chunk = chunk.slice(i + 1); if (message.method === "initialize") { if (respondInitialize) respondInitialize(message, child); else child.stdout.write(`${JSON.stringify({ id: message.id, result: { userAgent: "mock/1", platformFamily: "windows" } })}\n`); } else respond?.(message, child); } });
  child.finish = () => { if (closed) return; closed = true; child.stdout.end(); child.stderr.end(); setImmediate(() => child.emit("close", 0)); };
  child.stdin.once("finish", () => { if (!linger) child.finish(); });
  return { child, requests };
}
async function fixture(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-desktop-bridge-"));
  const config = { schema: BRIDGE_SCHEMA, realCliPath: process.execPath, nodePath: process.execPath,
    bridgePath: fileURLToPath(new URL("./desktop-owned-bridge.mjs", import.meta.url)), tokenFile: path.join(dir, "token"), statusFile: path.join(dir, "status.json"), port: await freePort(), shutdownGraceMs: 30, ...options.config };
  fs.writeFileSync(config.tokenFile, `${TOKEN}\n`);
  const input = new PassThrough(), output = options.output ?? new PassThrough(), errors = new PassThrough();
  errors.resume(); const desktop = capture(output), backend = options.backend ?? mockBackend(options);
  let spawns = 0, launch; const statuses = [];
  const bridge = await startDesktopBridge(config, options.nativeArgs ?? ["-c", "features.code_mode_host=true", "app-server", "--analytics-default-enabled"], {
    input, output, errors, env: options.env ?? process.env, onStatus: value => statuses.push(value),
    spawnImpl: (file, args, opts) => { spawns++; launch = { file, args, opts }; return options.spawnImpl ? options.spawnImpl(file, args, opts) : backend.child; }
  });
  const clients = [];
  t.after(async () => {
    for (const ws of clients) ws.terminate(); // Test-owned sockets only.
    input.end(); await bridge.stop(); backend.child.finish?.();
    await bridge.completion;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const write = message => input.write(`${JSON.stringify(message)}\n`);
  async function ready() {
    write({ id: 1, method: "initialize", params: { clientInfo: { name: "actual-desktop" }, capabilities: { experimentalApi: true, requestAttestation: true }, extensionField: { untouched: true } } });
    await eventually(() => desktop.some(message => message.id === 1));
    write({ method: "initialized", params: {} }); await eventually(() => bridge.health().primaryReady);
  }
  async function connect({ initialize = true, token = TOKEN, origin } = {}) {
    const ws = new WebSocket(`ws://127.0.0.1:${config.port}/`, { headers: { Authorization: `Bearer ${token}`, ...(origin ? { Origin: origin } : {}) } });
    clients.push(ws); const messages = [];
    ws.on("message", data => messages.push(JSON.parse(data.toString())));
    await once(ws, "open");
    if (initialize) {
      ws.send(JSON.stringify({ id: 1, method: "initialize", params: { clientInfo: { name: "gateway" }, capabilities: { experimentalApi: true } } }));
      await eventually(() => messages.some(message => message.id === 1));
      ws.send(JSON.stringify({ method: "initialized", params: {} }));
    }
    return { ws, messages, send: message => ws.send(JSON.stringify(message)) };
  }
  return { dir, config, input, output, desktop, backend, bridge, ready, connect, write, statuses, spawns: () => spawns, launch: () => launch };
}

test("only normal desktop stdio launch is intercepted", () => {
  assert.equal(isDesktopAppServerInvocation(["-c", "features.code_mode_host=true", "app-server", "-c", "features.x=true"]), true);
  for (const args of [["app-server", "proxy"], ["app-server", "daemon", "start"], ["app-server", "generate-json-schema"], ["app-server", "--listen", "ws://127.0.0.1:4501"], ["exec", "app-server"], ["--version"], ["-c"]]) assert.equal(isDesktopAppServerInvocation(args), false);
});

test("initialization, environment and arguments stay desktop-owned; health leaks no context", async t => {
  const inherited = { ...process.env, SYNTHETIC_BOOTSTRAP: "opaque-fixture-only" };
  const f = await fixture(t, { env: inherited });
  await assert.rejects(f.connect(), /403/);
  await f.ready();
  await f.connect();
  assert.equal(f.spawns(), 1);
  assert.equal(f.launch().opts.env, inherited);
  assert.deepEqual(f.launch().args, ["-c", "features.code_mode_host=true", "app-server", "--analytics-default-enabled"]);
  assert.equal(f.backend.requests.filter(item => item.method === "initialize").length, 1);
  assert.deepEqual(f.backend.requests[0].params.extensionField, { untouched: true });
  const response = await fetch(`http://127.0.0.1:${f.config.port}/health?challenge=${"a".repeat(32)}`);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const health = await response.json();
  assert.equal(health.challenge, "a".repeat(32)); assert.equal(health.state, "ready");
  assert.equal(JSON.stringify(health).includes("opaque-fixture"), false);
  assert.deepEqual(Object.keys(health).sort(), ["backendPid", "bridgePid", "challenge", "instanceId", "primaryReady", "schema", "state", "initializeRequestSeen", "initializeRequestForwarded", "initializeResultSeen", "initializeReplyForwarded", "initializeErrorSeen", "initializeErrorForwarded", "initializedNotificationSeen", "postInitializePrimaryRequestSeen", "postInitializePrimarySuccessSeen", "readyBasis"].sort());
  assert.equal(health.readyBasis, "initialized_notification");
  await assert.rejects(f.connect({ token: "wrong" }), /403/);
  await assert.rejects(f.connect({ origin: "https://untrusted.example" }), /403/);
});

const initializePrimary = f => f.write({ id: "desktop-init", method: "initialize", params: { clientInfo: { name: "actual-desktop" }, capabilities: { experimentalApi: true } } });
const nativeReply = (f, request, fields) => f.backend.child.stdout.write(`${JSON.stringify({ id: request.id, ...fields })}\n`);
function heldOutput(id) {
  const output = new PassThrough(), original = output.write.bind(output), callbacks = [];
  output.write = (bytes, callback) => {
    if (JSON.parse(bytes.toString()).id !== id) return original(bytes, callback);
    // Expose the bytes, but withhold successful write completion separately.
    return original(bytes, error => error ? callback(error) : callbacks.push(callback));
  };
  return { output, callbacks, release: error => callbacks.shift()(error) };
}

test("desktop without initialized becomes ready only after a successful post-init RPC is forwarded", async t => {
  const f = await fixture(t);
  initializePrimary(f);
  await eventually(() => f.bridge.health().initializeReplyForwarded);
  assert.equal(f.bridge.health().primaryReady, false);
  assert.equal(f.bridge.health().readyBasis, null);
  await assert.rejects(f.connect(), /403/); // A secondary cannot drive readiness.
  f.write({ id: "post-init", method: "account/read", params: {} });
  await eventually(() => f.backend.requests.some(message => message.method === "account/read"));
  assert.equal(f.bridge.health().postInitializePrimaryRequestSeen, true);
  assert.equal(f.bridge.health().primaryReady, false);
  nativeReply(f, f.backend.requests.find(message => message.method === "account/read"), { result: { fixture: "private-result-not-diagnostics" } });
  await eventually(() => f.bridge.health().primaryReady);
  const health = f.bridge.health();
  assert.equal(health.readyBasis, "desktop_followup_response");
  assert.equal(health.initializedNotificationSeen, false);
  assert.equal(health.postInitializePrimarySuccessSeen, true);
  assert.equal(JSON.stringify(health).includes("private-result-not-diagnostics"), false);
  await f.connect();
  assert.equal(f.backend.requests.filter(message => message.method === "initialize").length, 1);
  assert.equal(f.backend.requests.some(message => message.method === "initialized"), false);
  assert.equal(f.backend.requests.length, 2); // No synthetic handshake/probe.
});

test("a primary request admitted before init reply delivery cannot unlock readiness when its result arrives later", async t => {
  const held = heldOutput("desktop-init"), f = await fixture(t, { output: held.output });
  initializePrimary(f);
  await eventually(() => held.callbacks.length === 1);
  f.write({ id: "premature", method: "account/read", params: {} });
  await eventually(() => f.backend.requests.some(message => message.id !== f.backend.requests[0].id));
  assert.equal(f.bridge.health().initializeReplyForwarded, false);
  held.release();
  await eventually(() => f.bridge.health().initializeReplyForwarded);
  nativeReply(f, f.backend.requests.find(message => message.method === "account/read"), { result: {} });
  await eventually(() => f.desktop.some(message => message.id === "premature"));
  assert.equal(f.bridge.health().postInitializePrimaryRequestSeen, false);
  assert.equal(f.bridge.health().postInitializePrimarySuccessSeen, false);
  assert.equal(f.bridge.health().primaryReady, false);
});

test("initialized before a held init response unlocks only once that response is successfully forwarded", async t => {
  const held = heldOutput("desktop-init"), f = await fixture(t, { output: held.output });
  initializePrimary(f);
  await eventually(() => held.callbacks.length === 1);
  f.write({ method: "initialized", params: {} });
  await eventually(() => f.bridge.health().initializedNotificationSeen);
  assert.equal(f.bridge.health().primaryReady, false);
  held.release();
  await eventually(() => f.bridge.health().primaryReady);
  assert.equal(f.bridge.health().readyBasis, "initialized_notification");
});

test("initialized before any initialize request is forwarded transparently but cannot unlock readiness", async t => {
  const f = await fixture(t);
  f.write({ method: "initialized", params: {} });
  await eventually(() => f.backend.requests.length === 1);
  assert.equal(f.bridge.health().initializedNotificationSeen, false);
  initializePrimary(f);
  await eventually(() => f.bridge.health().initializeReplyForwarded);
  assert.equal(f.bridge.health().primaryReady, false);
  f.write({ method: "initialized", params: {} });
  await eventually(() => f.bridge.health().primaryReady);
  assert.equal(f.backend.requests.filter(message => message.method === "initialized").length, 2);
});

test("init errors and subsequent successful responses never imply successful initialization", async t => {
  const f = await fixture(t, { respondInitialize: (message, child) => child.stdout.write(`${JSON.stringify({ id: message.id, error: { code: -32600, message: "fixture-private-error" } })}\n`) });
  initializePrimary(f);
  f.write({ method: "initialized", params: {} });
  await eventually(() => f.bridge.health().initializeErrorForwarded);
  f.write({ id: "after-error", method: "account/read", params: {} });
  await eventually(() => f.backend.requests.some(message => message.method === "account/read"));
  nativeReply(f, f.backend.requests.find(message => message.method === "account/read"), { result: {} });
  await eventually(() => f.desktop.some(message => message.id === "after-error"));
  assert.equal(f.bridge.health().initializeErrorSeen, true);
  assert.equal(f.bridge.health().initializeResultSeen, false);
  assert.equal(f.bridge.health().initializeReplyForwarded, false);
  assert.equal(f.bridge.health().primaryReady, false);
  assert.equal(JSON.stringify(f.bridge.health()).includes("fixture-private-error"), false);
});

test("post-init errors and desktop replies to server-initiated requests cannot unlock readiness", async t => {
  const f = await fixture(t);
  initializePrimary(f);
  await eventually(() => f.bridge.health().initializeReplyForwarded);
  f.write({ id: "unsuccessful", method: "account/read", params: {} });
  await eventually(() => f.backend.requests.some(message => message.method === "account/read"));
  nativeReply(f, f.backend.requests.find(message => message.method === "account/read"), { error: { code: -32600, message: "fixture error" } });
  await eventually(() => f.desktop.some(message => message.id === "unsuccessful"));
  f.backend.child.stdout.write(`${JSON.stringify({ id: 100, method: "attestation/generate", params: {} })}\n`);
  await eventually(() => f.desktop.some(message => message.method === "attestation/generate"));
  f.write({ id: f.desktop.find(message => message.method === "attestation/generate").id, result: { fixture: true } });
  await eventually(() => f.backend.requests.some(message => message.id === 100));
  assert.equal(f.bridge.health().postInitializePrimarySuccessSeen, false);
  assert.equal(f.bridge.health().primaryReady, false);
});

test("follow-up native success waits for primary output completion before readiness", async t => {
  const held = heldOutput("post-init"), f = await fixture(t, { output: held.output });
  initializePrimary(f);
  await eventually(() => f.bridge.health().initializeReplyForwarded);
  f.write({ id: "post-init", method: "account/read", params: {} });
  await eventually(() => f.backend.requests.some(message => message.method === "account/read"));
  nativeReply(f, f.backend.requests.find(message => message.method === "account/read"), { result: {} });
  await eventually(() => held.callbacks.length === 1);
  assert.equal(f.bridge.health().primaryReady, false);
  held.release();
  await eventually(() => f.bridge.health().primaryReady);
});

for (const phase of ["init", "followup"]) {
  test(`${phase} output write failure never publishes readiness`, async t => {
    const held = heldOutput(phase === "init" ? "desktop-init" : "post-init"), f = await fixture(t, { output: held.output });
    initializePrimary(f);
    if (phase === "init") {
      f.write({ method: "initialized", params: {} });
    } else {
      await eventually(() => f.bridge.health().initializeReplyForwarded);
      f.write({ id: "post-init", method: "account/read", params: {} });
      await eventually(() => f.backend.requests.some(message => message.method === "account/read"));
      nativeReply(f, f.backend.requests.find(message => message.method === "account/read"), { result: {} });
    }
    await eventually(() => held.callbacks.length === 1);
    held.release(new Error("fixture output failure"));
    await f.bridge.completion;
    assert.equal(f.statuses.some(status => status.primaryReady), false);
    assert.equal(f.bridge.health().readyBasis, null);
  });

  test(`${phase} output completed after desktop EOF never publishes readiness`, async t => {
    const held = heldOutput(phase === "init" ? "desktop-init" : "post-init"), f = await fixture(t, { output: held.output });
    initializePrimary(f);
    if (phase === "init") {
      f.write({ method: "initialized", params: {} });
      await eventually(() => f.bridge.health().initializedNotificationSeen);
    } else {
      await eventually(() => f.bridge.health().initializeReplyForwarded);
      f.write({ id: "post-init", method: "account/read", params: {} });
      await eventually(() => f.backend.requests.some(message => message.method === "account/read"));
      nativeReply(f, f.backend.requests.find(message => message.method === "account/read"), { result: {} });
    }
    await eventually(() => held.callbacks.length === 1);
    f.input.end();
    await eventually(() => f.bridge.health().state !== "starting");
    held.release();
    await f.bridge.completion;
    assert.equal(f.statuses.some(status => status.primaryReady), false);
    assert.equal(f.bridge.health().readyBasis, null);
  });
}

test("handshake diagnostics publish only on transitions and EOF revokes readiness", async t => {
  const f = await fixture(t); await f.ready();
  const before = f.statuses.length;
  for (let index = 0; index < 10; index++) f.write({ method: "initialized", params: {} });
  await eventually(() => f.backend.requests.filter(message => message.method === "initialized").length === 11);
  assert.equal(f.statuses.length, before);
  f.input.end(); await f.bridge.completion;
  assert.equal(f.bridge.health().primaryReady, false);
  assert.equal(f.bridge.health().readyBasis, null);
});

test("a failed status publication keeps secondary access closed after otherwise successful initialization", async t => {
  const f = await fixture(t);
  initializePrimary(f);
  await eventually(() => f.bridge.health().initializeReplyForwarded);
  fs.unlinkSync(f.config.statusFile);
  fs.mkdirSync(f.config.statusFile); // Test-owned obstruction makes atomic replacement fail.
  f.write({ id: "post-init", method: "account/read", params: {} });
  await eventually(() => f.backend.requests.some(message => message.method === "account/read"));
  nativeReply(f, f.backend.requests.find(message => message.method === "account/read"), { result: {} });
  await eventually(() => f.bridge.health().postInitializePrimarySuccessSeen);
  assert.equal(f.bridge.health().state, "status_unavailable");
  assert.equal(f.bridge.health().primaryReady, false);
  assert.equal(f.bridge.health().readyBasis, null);
  await assert.rejects(f.connect(), /403/);
});

test("both streams get collision-free IDs and out-of-order responses return only to their owner", async t => {
  const f = await fixture(t); await f.ready(); const peer = await f.connect();
  f.write({ id: 2, method: "desktop/futureMethod", params: { keep: "all fields" } });
  peer.send({ id: 2, method: "thread/read", params: { threadId: "selected", includeTurns: false } });
  peer.send({ id: "2", method: "thread/read", params: { threadId: "selected", includeTurns: true } });
  await eventually(() => f.backend.requests.filter(item => item.method === "thread/read").length === 2);
  const d = f.backend.requests.find(item => item.method === "desktop/futureMethod");
  const [a, b] = f.backend.requests.filter(item => item.method === "thread/read");
  assert.equal(new Set([d.id, a.id, b.id]).size, 3);
  for (const [request, marker] of [[b, "string"], [d, "desktop"], [a, "number"]]) f.backend.child.stdout.write(`${JSON.stringify({ id: request.id, result: { marker } })}\n`);
  await eventually(() => peer.messages.length === 3 && f.desktop.some(item => item.result?.marker === "desktop"));
  assert.equal(peer.messages.find(item => item.result?.marker === "string").id, "2");
  assert.equal(peer.messages.find(item => item.result?.marker === "number").id, 2);
  assert.equal(peer.messages.some(item => item.result?.marker === "desktop"), false);
  assert.equal(f.desktop.some(item => ["number", "string"].includes(item.result?.marker)), false);
});

test("native server requests stay desktop-only, even when their IDs collide with client requests", async t => {
  const f = await fixture(t); await f.ready(); const peer = await f.connect();
  f.backend.child.stdout.write(`${JSON.stringify({ id: 1, method: "attestation/generate", params: {} })}\n`);
  await eventually(() => f.desktop.some(item => item.method === "attestation/generate"));
  assert.equal(peer.messages.some(item => item.method === "attestation/generate"), false);
  f.write({ id: f.desktop.find(item => item.method === "attestation/generate").id, result: { opaqueFixture: true } });
  await eventually(() => f.backend.requests.some(item => item.result?.opaqueFixture));
  peer.send({ id: 1, result: { forged: true } });
  await once(peer.ws, "close");
  assert.equal(f.backend.requests.some(item => item.result?.forged), false);
});

test("gateway capabilities, unsafe overrides, uninitialized calls and connection controls are rejected", async t => {
  const f = await fixture(t); await f.ready(); const peer = await f.connect({ initialize: false });
  peer.send({ id: 2, method: "thread/list", params: {} });
  peer.send({ id: 3, method: "initialize", params: { clientInfo: { name: "gateway" }, capabilities: { explicitGatewayOauth: true } } });
  await eventually(() => peer.messages.length === 2);
  assert.ok(peer.messages.every(item => item.error));
  const allowed = await f.connect();
  for (const [id, method, params] of [[2, "thread/unsubscribe", { threadId: "x" }], [3, "config/value/write", { keyPath: "x", value: true }], [4, "turn/start", { threadId: "x", input: [{ type: "text", text: "fixture" }], approvalPolicy: "never" }], [5, "thread/resume", { threadId: "x", config: { arbitrary: true } }]]) allowed.send({ id, method, params });
  await eventually(() => allowed.messages.length === 5);
  assert.ok(allowed.messages.slice(1).every(item => item.error));
  assert.equal(f.backend.requests.length, 2);
});

test("notifications are limited to secondary-selected threads and exclude auth/global events", async t => {
  const f = await fixture(t); await f.ready(); const peer = await f.connect();
  peer.send({ id: 2, method: "thread/read", params: { threadId: "selected" } });
  await eventually(() => f.backend.requests.some(item => item.method === "thread/read"));
  for (const [method, threadId] of [["turn/started", "selected"], ["turn/started", "unrelated"], ["account/updated", "selected"]]) f.backend.child.stdout.write(`${JSON.stringify({ method, params: { threadId } })}\n`);
  await eventually(() => f.desktop.filter(item => item.method).length === 3);
  await eventually(() => peer.messages.some(item => item.method === "turn/started"));
  assert.equal(peer.messages.filter(item => item.method).length, 1);
  assert.equal(peer.messages.at(-1).params.threadId, "selected");
});

test("secondary disconnect after submission leaves work alone and never replays", async t => {
  const f = await fixture(t); await f.ready(); const peer = await f.connect();
  peer.send({ id: 2, method: "turn/start", params: { threadId: "selected", input: [{ type: "text", text: "fixture only" }] } });
  await eventually(() => f.backend.requests.some(item => item.method === "turn/start"));
  const request = f.backend.requests.find(item => item.method === "turn/start");
  peer.ws.close(); await once(peer.ws, "close");
  assert.equal(f.backend.child.stdin.writableEnded, false);
  f.backend.child.stdout.write(`${JSON.stringify({ id: request.id, result: { turn: { id: "turn" } } })}\n`);
  await f.connect();
  assert.equal(f.backend.requests.filter(item => item.method === "turn/start").length, 1);
  assert.equal(f.desktop.some(item => item.result?.turn), false);
  assert.equal(f.spawns(), 1);
});

test("desktop EOF closes native stdin once; a lingering backend is reported and never killed or replaced", async t => {
  const f = await fixture(t, { linger: true }); await f.ready();
  let finishes = 0; f.backend.child.stdin.on("finish", () => finishes++);
  f.input.end();
  await eventually(() => f.bridge.health().state === "backend_exit_unverified");
  assert.equal(finishes, 1); assert.equal(f.spawns(), 1); assert.equal(f.backend.child.killed, false);
  const status = JSON.parse(fs.readFileSync(f.config.statusFile, "utf8"));
  assert.equal(status.backendPid, f.backend.child.pid); assert.equal(status.primaryReady, false);
  f.backend.child.finish(); await f.bridge.completion;
});

test("fragmented UTF-8 JSONL preserves data; partial, invalid and oversized frames fail", async () => {
  const bytes = Buffer.from(`${JSON.stringify({ id: "unicode", result: "a😀é" })}\n`);
  const stream = new PassThrough(); const values = [];
  const reading = (async () => { for await (const item of readJsonLines(stream, 1024)) values.push(item); })();
  for (const byte of bytes) stream.write(Buffer.from([byte])); stream.end(); await reading;
  assert.deepEqual(values, [{ id: "unicode", result: "a😀é" }]);
  for (const bytes of [Buffer.from('{"id":1}'), Buffer.from([0xff, 10]), Buffer.from(`${"a".repeat(1025)}\n`)]) {
    const bad = new PassThrough(); bad.end(bytes);
    await assert.rejects(async () => { for await (const ignored of readJsonLines(bad, 1024)) void ignored; });
  }
});

test("a real harmless subprocess exits on stdio EOF with inherited synthetic context", async t => {
  const code = `let s='';process.stdin.on('data',b=>{s+=b;let i;while((i=s.indexOf('\\n'))>=0){const m=JSON.parse(s.slice(0,i));s=s.slice(i+1);if(m.method==='initialize')process.stdout.write(JSON.stringify({id:m.id,result:{userAgent:'fixture/'+process.env.SYNTHETIC_BOOTSTRAP}})+'\\n')}});process.stdin.on('end',()=>process.exitCode=0);`;
  const f = await fixture(t, { env: { ...process.env, SYNTHETIC_BOOTSTRAP: "opaque-test" }, spawnImpl: (_file, _args, opts) => spawn(process.execPath, ["-e", code], opts) });
  await f.ready(); assert.equal(f.desktop[0].result.userAgent, "fixture/opaque-test");
  f.input.end(); const result = await f.bridge.completion;
  assert.equal(result.exitCode, 0); assert.equal(result.state, "stopped");
});

test("secondary in-flight limits reject only new unsubmitted work", async t => {
  const f = await fixture(t, { config: { maxSecondaryPending: 1 } }); await f.ready(); const peer = await f.connect();
  peer.send({ id: 2, method: "thread/read", params: { threadId: "selected" } });
  peer.send({ id: 3, method: "thread/read", params: { threadId: "selected" } });
  await eventually(() => peer.messages.some(item => item.id === 3 && item.error));
  assert.equal(f.backend.requests.filter(item => item.method === "thread/read").length, 1);
  assert.equal(peer.messages.some(item => item.id === 2), false);
});

test("failure during a native write closes the peer without falsely rejecting uncertain delivery", async t => {
  const f = await fixture(t, { linger: true }); await f.ready(); const peer = await f.connect();
  f.backend.child.stdin._write = (_chunk, _encoding, callback) => callback(new Error("synthetic pipe failure"));
  peer.send({ id: 2, method: "turn/start", params: { threadId: "selected", input: [{ type: "text", text: "synthetic" }] } });
  await once(peer.ws, "close");
  assert.equal(peer.messages.some(item => item.id === 2), false);
  assert.equal(f.spawns(), 1); assert.equal(f.bridge.health().primaryReady, false);
  f.backend.child.finish(); await f.bridge.completion;
});

test("an occupied listener prevents native launch, rather than attaching to another owner", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-port-conflict-"));
  const listener = net.createServer(); listener.listen(0, "127.0.0.1"); await once(listener, "listening");
  t.after(async () => { await new Promise(resolve => listener.close(resolve)); fs.rmSync(dir, { recursive: true, force: true }); });
  const config = { schema: BRIDGE_SCHEMA, realCliPath: process.execPath, nodePath: process.execPath, bridgePath: fileURLToPath(import.meta.url), tokenFile: path.join(dir, "token"), statusFile: path.join(dir, "status"), port: listener.address().port };
  fs.writeFileSync(config.tokenFile, TOKEN);
  let launches = 0;
  await assert.rejects(startDesktopBridge(config, ["app-server"], { spawnImpl: () => { launches++; return mockBackend().child; } }), /EADDRINUSE/);
  assert.equal(launches, 0);
});

test("oversized secondary frames close only that client, preserving desktop readiness", async t => {
  const f = await fixture(t, { config: { maxMessageBytes: 1024, maxQueueBytes: 2048 } }); await f.ready(); const peer = await f.connect();
  peer.ws.send(JSON.stringify({ id: 2, method: "turn/start", params: { threadId: "selected", input: [{ type: "text", text: "x".repeat(2048) }] } }));
  await once(peer.ws, "close");
  assert.equal(f.bridge.health().primaryReady, true);
  assert.equal(f.backend.requests.length, 2);
});

test("metadata MCP status is allowed but its config mutation counterpart is not", async t => {
  const f = await fixture(t); await f.ready(); const peer = await f.connect();
  peer.send({ id: 2, method: "mcpServerStatus/list", params: { serverName: "codex_app", detail: "toolsAndAuthOnly", limit: 10 } });
  peer.send({ id: 3, method: "config/mcpServer/reload", params: {} });
  await eventually(() => peer.messages.some(item => item.id === 3 && item.error));
  assert.equal(f.backend.requests.filter(item => item.method === "mcpServerStatus/list").length, 1);
  assert.equal(f.backend.requests.some(item => item.method === "config/mcpServer/reload"), false);
});

test("duplicate IDs cannot falsely reject an already submitted mutation", async t => {
  const f = await fixture(t); await f.ready();
  const duplicates = [
    { id: 2, method: "turn/start", params: { threadId: "x", input: [{ type: "text", text: "again" }] } },
    { id: 2, method: "invalid", params: {} },
    { id: 2, method: "initialize", params: { clientInfo: { name: "again" } } }
  ];
  for (const duplicate of duplicates) {
    const peer = await f.connect();
    const before = f.backend.requests.filter(item => item.method === "turn/start").length;
    peer.send({ id: 2, method: "turn/start", params: { threadId: "x", input: [{ type: "text", text: "one submission" }] } });
    await eventually(() => f.backend.requests.filter(item => item.method === "turn/start").length === before + 1);
    peer.send(duplicate); await once(peer.ws, "close");
    assert.equal(peer.messages.some(item => item.id === 2), false);
  }
  assert.equal(f.backend.requests.filter(item => item.method === "turn/start").length, 3);
});

test("canceled server requests release their IDs and late desktop responses cannot answer a reused native ID", async t => {
  const f = await fixture(t); await f.ready();
  f.backend.child.stdout.write(`${JSON.stringify({ id: 50, method: "tool/requestUserInput", params: {} })}\n`);
  await eventually(() => f.desktop.some(item => item.method === "tool/requestUserInput"));
  const first = f.desktop.find(item => item.method === "tool/requestUserInput").id;
  f.backend.child.stdout.write(`${JSON.stringify({ method: "serverRequest/resolved", params: { requestId: 50, threadId: "x" } })}\n`);
  f.backend.child.stdout.write(`${JSON.stringify({ id: 50, method: "tool/requestUserInput", params: {} })}\n`);
  await eventually(() => f.desktop.filter(item => item.method === "tool/requestUserInput").length === 2);
  const second = f.desktop.filter(item => item.method === "tool/requestUserInput")[1].id;
  assert.notEqual(first, second);
  assert.equal(f.desktop.find(item => item.method === "serverRequest/resolved").params.requestId, first);
  f.write({ id: first, result: { late: true } });
  f.write({ id: second, result: { current: true } });
  await eventually(() => f.backend.requests.some(item => item.result?.current));
  assert.equal(f.backend.requests.some(item => item.result?.late), false);
  assert.equal(f.backend.requests.find(item => item.result?.current).id, 50);
  assert.equal(f.bridge.health().primaryReady, true);
});

test("desktop EOF eventually closes a backpressured native input handle without process termination", async t => {
  const f = await fixture(t, { linger: true }); await f.ready();
  f.backend.child.stdin._write = () => {}; // Simulate a pipe whose consumer stopped reading.
  const peer = await f.connect();
  peer.send({ id: 2, method: "turn/start", params: { threadId: "x", input: [{ type: "text", text: "uncertain" }] } });
  await new Promise(resolve => setTimeout(resolve, 10));
  f.input.end();
  await eventually(() => f.backend.child.stdin.destroyed);
  assert.equal(f.spawns(), 1); assert.equal(f.bridge.health().primaryReady, false);
  assert.equal(peer.messages.some(item => item.id === 2), false);
  f.backend.child.finish(); await f.bridge.completion;
});

test("EOF drains native output despite a desktop output consumer that stops reading", async t => {
  const f = await fixture(t); await f.ready();
  // The desktop receives its handshake normally, then stops consuming writes.
  f.output._write = () => {};
  f.backend.child.stdout.write(`${JSON.stringify({ method: "turn/started", params: { threadId: "x" } })}\n`);
  await new Promise(resolve => setTimeout(resolve, 10));
  f.input.end();
  const result = await f.bridge.completion;
  assert.equal(result.state, "stopped"); assert.equal(f.output.destroyed, true);
});

test("successful server responses retain ID translation until resolved, including subsequent native ID reuse", async t => {
  const f = await fixture(t); await f.ready();
  const request = { id: 7, method: "attestation/generate", params: {} };
  for (let iteration = 0; iteration < 2; iteration++) {
    f.backend.child.stdout.write(`${JSON.stringify(request)}\n`);
    await eventually(() => f.desktop.filter(item => item.method === request.method).length === iteration + 1);
    const desktopId = f.desktop.filter(item => item.method === request.method)[iteration].id;
    f.write({ id: desktopId, result: { synthetic: iteration } });
    await eventually(() => f.backend.requests.filter(item => item.result && "synthetic" in item.result).length === iteration + 1);
    f.backend.child.stdout.write(`${JSON.stringify({ method: "serverRequest/resolved", params: { requestId: 7, threadId: "x" } })}\n`);
    await eventually(() => f.desktop.filter(item => item.method === "serverRequest/resolved").length === iteration + 1);
    assert.equal(f.desktop.filter(item => item.method === "serverRequest/resolved")[iteration].params.requestId, desktopId);
  }
  const desktopIds = f.desktop.filter(item => item.method === request.method).map(item => item.id);
  assert.notEqual(desktopIds[0], desktopIds[1]);
  assert.equal(f.bridge.health().primaryReady, true);
});

import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { normalizeCodexGateway } from "./codex-gateway-config.mjs";
import { gatewayRequest, startGatewayTurn, listGatewayThreads, readGatewayRequestStatusLocal } from "./codex-gateway-runner.mjs";
import { normalizeHosts } from "./controller-hosts.mjs";
import { serializableAgentOptions } from "./agent-runner.mjs";

const configPath = process.platform === "win32" ? "C:\\Gateway config\\whatsapp.json" : "/gateway config/whatsapp.json";
const gateway = { pythonBin: "python", configPath };
const options = { codexGateway: gateway, requestId: `wa-v1-${"a".repeat(64)}`, workspace: "/work", threadId: "existing-native-session", prompt: "A literal $(message) with quotes ' and \"" };

function mock() {
  const child = new EventEmitter();
  Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), killed: false });
  child.kill = () => { child.killed = true; return true; };
  child.send = message => child.stdout.write(`${JSON.stringify({ id: 1, ...message })}\n`);
  const calls = [];
  return { child, calls, spawnImpl: (...args) => { calls.push(args); return child; } };
}

test("gateway configuration pins target-host paths and rejects unexpected inputs", () => {
  assert.deepEqual(normalizeCodexGateway({ configPath: "C:\\Gateway\\config.json" }, "win32"), { pythonBin: "python", configPath: "C:\\Gateway\\config.json" });
  assert.throws(() => normalizeCodexGateway({ configPath: "relative.json" }), /absolute/);
  assert.throws(() => normalizeCodexGateway({ ...gateway, endpoint: "ws://elsewhere" }), /only/);
  assert.throws(() => normalizeCodexGateway({ ...gateway, pythonBin: "cmd.bat" }), /executable/);
  assert.throws(() => normalizeCodexGateway({ ...gateway, pythonBin: "python\nanything" }), /executable/);
  const host = normalizeHosts({ hosts: [{ id: "host", codexGateway: gateway }] })[0];
  assert.deepEqual(host.codexGateway, gateway);
});

test("gateway sends a single stable request over stdin and waits for clean worker exit", async () => {
  const fixture = mock(), events = [];
  const run = startGatewayTurn({ ...options, onLifecycleEvent: event => events.push(event) }, fixture);
  const [command, args, spawnOptions] = fixture.calls[0];
  assert.equal(command, "python");
  assert.equal(spawnOptions.shell, false);
  assert.equal(spawnOptions.windowsHide, true);
  assert.ok(!JSON.stringify(args).includes(options.prompt));
  assert.equal(args.at(-1), configPath);
  const request = JSON.parse(fixture.child.stdin.read().toString());
  assert.equal(request.method, "send_prompt");
  assert.equal(request.params.requestId, options.requestId);
  assert.equal(request.params.prompt, options.prompt);
  fixture.child.send({ type: "event", event: { type: "turnStarted", threadId: options.threadId, turnId: "turn-1" } });
  fixture.child.send({ type: "result", result: { threadId: options.threadId, replyText: "Done.", requestId: options.requestId } });
  fixture.child.emit("close", 0);
  assert.equal((await run.resultPromise).replyText, "Done.");
  assert.equal(events[0].turnId, "turn-1");
  assert.equal(fixture.calls.length, 1);
});

test("shared session control never stops a native desktop-owned turn implicitly", async () => {
  const fixture = mock();
  const run = startGatewayTurn(options, fixture);
  await assert.rejects(run.interrupt(), /handled in Codex/);
  assert.equal(fixture.child.killed, false);
  await assert.rejects(run.answerApproval("approval", "accept"), /handled in Codex/);
  run.detach();
  await assert.rejects(run.resultPromise, error => error.deliveryUncertain === true && error.requestId === options.requestId);
  assert.equal(fixture.child.killed, false);
  assert.equal(fixture.child.stdin.writableEnded, true); // Graceful EOF releases ledger locks.
});

test("gateway pre-send refusal retains no-submission evidence", async () => {
  const fixture = mock();
  const run = startGatewayTurn(options, fixture);
  fixture.child.send({ type: "error", error: { code: "ERR_CODEX_GATEWAY_UNAVAILABLE", message: "Owner offline", promptSubmitted: false, retryable: false } });
  fixture.child.emit("close", 1);
  await assert.rejects(run.resultPromise, error => error.promptSubmitted === false && error.deliveryUncertain === undefined && error.requestId === options.requestId);
});

for (const [name, failure] of [
  ["disconnect", child => child.emit("close", 0)],
  ["bad JSON", child => child.stdout.write("invalid\n")],
  ["wrong correlation", child => child.stdout.write('{"id":2,"type":"heartbeat"}\n')],
  ["partial output", child => { child.stdout.write('{"id":1'); child.emit("close", 0); }],
  ["invalid final", child => child.send({ type: "result", result: { ok: true } })]
]) {
  test(`gateway ${name} after request is uncertain and never retries`, async () => {
    const fixture = mock();
    const run = startGatewayTurn(options, fixture);
    failure(fixture.child);
    await assert.rejects(run.resultPromise, error => error.code === "ERR_CODEX_GATEWAY_UNCERTAIN" && error.deliveryUncertain === true && error.retryable === false);
    assert.equal(fixture.calls.length, 1);
  });
}

test("OS spawn failure is known not submitted", async () => {
  const fixture = mock();
  const run = startGatewayTurn(options, fixture);
  fixture.child.emit("error", Object.assign(new Error("missing"), { code: "ENOENT" }));
  await assert.rejects(run.resultPromise, error => error.promptSubmitted === false && error.deliveryUncertain === undefined);
});

test("listing is read-only and new sessions select an explicit method", async () => {
  const fixture = mock();
  const promise = listGatewayThreads({ ...options, scope: "host" }, fixture);
  assert.equal(JSON.parse(fixture.child.stdin.read().toString()).method, "list_sessions");
  fixture.child.send({ type: "result", result: [{ id: "native-1", name: "One", cwd: "/work" }] });
  fixture.child.emit("close", 0);
  assert.equal((await promise)[0].id, "native-1");
  const create = mock();
  const run = startGatewayTurn({ ...options, threadId: null }, create);
  assert.equal(JSON.parse(create.child.stdin.read().toString()).method, "create_session");
  create.child.send({ type: "error", error: { code: "UNSUPPORTED", message: "Not enabled", promptSubmitted: false } });
  create.child.emit("close", 1);
  await assert.rejects(run.resultPromise, /Not enabled/);
});

test("gateway requires a durable identity before starting a worker", () => {
  const fixture = mock();
  assert.throws(() => startGatewayTurn({ ...options, requestId: undefined }, fixture), /stable requestId/);
  assert.equal(fixture.calls.length, 0);
  const payload = serializableAgentOptions({ ...options, engine: "codex", env: { PASSWORD: "private" }, host: { secret: "private" } });
  assert.deepEqual(payload.codexGateway, gateway);
  assert.equal(payload.requestId, options.requestId);
  assert.equal(payload.env, undefined);
});

test("request reconciliation uses status without a prompt or new submission", async () => {
  const fixture = mock();
  const promise = readGatewayRequestStatusLocal({ codexGateway: gateway, requestId: options.requestId, threadId: options.threadId, workspace: options.workspace }, fixture);
  const request = JSON.parse(fixture.child.stdin.read().toString());
  assert.equal(request.method, "status");
  assert.equal(request.params.requestId, options.requestId);
  assert.equal(request.params.prompt, undefined);
  const status = { requestId: options.requestId, threadId: options.threadId, completed: true, replyText: "Recovered answer", readOnly: true };
  fixture.child.send({ type: "result", result: status });
  fixture.child.emit("close", 0);
  assert.deepEqual(await promise, status);
  assert.equal(fixture.calls.length, 1);
});

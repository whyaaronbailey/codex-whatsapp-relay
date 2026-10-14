import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { WhatsAppControllerBridge, projectBindingKey, whatsappRequestId } from "./controller-bridge.mjs";
import { ControllerConfigStore } from "./controller-config.mjs";
import { ControllerStateStore } from "./controller-state.mjs";

const phoneKey = "10000000000", remoteJid = `${phoneKey}@s.whatsapp.net`;
const request = { phoneKey, remoteJid, label: "Test", projectAlias: "pc" };
const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(check) {
  const deadline = Date.now() + 3000;
  while (!check()) { if (Date.now() > deadline) throw new Error("Timed out waiting for fixture"); await tick(); }
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "relay-gateway-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const configStore = new ControllerConfigStore(path.join(dir, "config.json"));
  await configStore.update({ enabled: true, allowedControllers: [{ number: `+${phoneKey}` }], defaultProject: "pc",
    hosts: [{ id: "host", transport: "local", codexGateway: { pythonBin: "python", configPath: path.join(dir, "gateway.json") } }],
    projects: [{ alias: "pc", workspace: dir }, { alias: "other", workspace: path.join(dir, "Other Directory") }] });
  const stateFile = path.join(dir, "state.json");
  const stateStore = new ControllerStateStore(stateFile);
  await stateStore.upsertSession(phoneKey, { activeProject: "pc", projects: {
    pc: { threadId: "original-native", bindingKey: projectBindingKey(configStore.data, configStore.data.projects[0]) }
  } });
  const calls = [], replies = [], statusCalls = [], files = [];
  const runner = {
    startCodexTurn(args) {
      const durable = JSON.parse(readFileSync(stateFile, "utf8")).sessions[phoneKey].gatewayRequests[args.requestId];
      assert.equal(durable.status, "pending", "request must be on disk before runner invocation");
      assert.equal(durable.target.threadId, args.threadId);
      assert.equal(durable.prompt, args.prompt);
      const done = deferred();
      const call = { args, done, interrupted: false, durable }; calls.push(call);
      return { resultPromise: done.promise, child: { killed: false, kill() { this.killed = true; } },
        interrupt: async () => { call.interrupted = true; throw new Error("Shared gateway cannot interrupt the owning client"); } };
    },
    async readGatewayRequestStatus(args) {
      statusCalls.push(args);
      return { requestId: args.requestId, threadId: args.threadId, completed: true, readOnly: true, replyText: "Recovered reply" };
    }
  };
  const runtime = { downloadMediaBuffer: async () => Buffer.from("file") };
  const fileService = { async saveIncomingAttachment(args) { files.push(args); return {
    relativePath: ".whatsapp-relay/inbox/fixture/file.txt", size: 4, sha256: "abc", mimetype: "text/plain"
  }; } };
  const makeBridge = () => {
    const bridge = new WhatsAppControllerBridge({ runtime, configStore, stateStore, runner, fileService });
    bridge.sendReply = async (_jid, text) => { replies.push(text); };
    return bridge;
  };
  const bridge = makeBridge();
  const message = (id, text) => ({ key: { id, remoteJid }, messageTimestamp: Math.floor(Date.now() / 1000), message: { conversation: text } });
  const finish = (index) => calls[index].done.resolve({ requestId: calls[index].args.requestId, threadId: calls[index].args.threadId ?? "new-native", replyText: `Reply ${index}` });
  return { dir, bridge, makeBridge, configStore, stateStore, stateFile, runner, calls, replies, statusCalls, files, message, finish };
}

test("stable WhatsApp identity survives restart, changed selection and completed duplicate delivery", async t => {
  const f = await fixture(t);
  const incoming = f.message("message-one", "Do the task");
  const running = f.bridge.handleIncomingMessage(incoming);
  await until(() => f.calls.length === 1);
  assert.equal(f.calls[0].args.requestId, whatsappRequestId(phoneKey, "message-one"));
  assert.notEqual(whatsappRequestId(phoneKey, "message-one"), whatsappRequestId("20000000000", "message-one"));
  f.finish(0); await running;
  await f.stateStore.load();
  await f.bridge.upsertChatSession(phoneKey, { activeProject: "other" });
  await f.makeBridge().handleIncomingMessage(incoming);
  assert.equal(f.calls.length, 1);
  assert.match(f.replies.at(-1), /original-native/);
  assert.match(f.replies.at(-1), /completed/);
  assert.equal(f.stateStore.getSession(phoneKey).gatewayRequests[f.calls[0].args.requestId].replyDelivery, "sent");
});

test("uncertain delivery holds follow-ups across restart and stop cannot clear the native request", async t => {
  const f = await fixture(t);
  const running = f.bridge.handleIncomingMessage(f.message("uncertain", "First"));
  await until(() => f.calls.length === 1);
  await until(() => f.bridge.activeRuns.size === 1);
  await f.bridge.handleIncomingMessage(f.message("followup", "Follow up"));
  const followupId = whatsappRequestId(phoneKey, "followup");
  assert.equal(f.stateStore.getSession(phoneKey).projects.pc.queuedPrompts[0].requestId, followupId);
  f.calls[0].done.reject(Object.assign(new Error("Connection lost"), { code: "ERR_CODEX_GATEWAY_UNCERTAIN", deliveryUncertain: true }));
  await running;
  assert.equal(f.calls.length, 1);
  assert.equal(f.stateStore.getSession(phoneKey).projects.pc.queuedPromptsPaused, true);
  assert.match(f.replies.at(-1), /Delivery or completion has not been confirmed/);
  assert.doesNotMatch(f.replies.at(-1), /was not submitted/);
  await f.stateStore.load(); const resumed = f.makeBridge();
  await resumed.stopActiveRun(phoneKey, remoteJid);
  assert.equal(f.stateStore.getSession(phoneKey).projects.pc.threadId, "original-native");
  assert.equal(f.stateStore.getSession(phoneKey).gatewayRequests[followupId].status, "cancelled");
  await resumed.handleIncomingMessage(f.message("new-followup", "Do more"));
  assert.equal(f.calls.length, 1);
  assert.match(resumed.renderSessionStatus(phoneKey), /gateway_request: .*uncertain/);
});

test("read-only reconciliation uses the frozen host and never drains held prompts after a later success", async t => {
  const f = await fixture(t);
  const running = f.bridge.handleIncomingMessage(f.message("lost", "First"));
  await until(() => f.bridge.activeRuns.size === 1);
  await f.bridge.handleIncomingMessage(f.message("held", "Held"));
  f.calls[0].done.reject(Object.assign(new Error("Lost receipt"), { deliveryUncertain: true })); await running;
  const originalHost = f.calls[0].durable.target.host;
  await f.bridge.handleIncomingMessage(f.message("refresh", "/status refresh"));
  assert.deepEqual(f.statusCalls[0].host, originalHost);
  assert.equal(f.calls.length, 1);
  assert.equal(f.stateStore.getSession(phoneKey).projects.pc.queuedPromptsPaused, true);
  const next = f.bridge.handleIncomingMessage(f.message("manual", "Manual next request"));
  await until(() => f.calls.length === 2); f.finish(1); await next;
  assert.equal(f.calls.length, 2);
  assert.equal(f.stateStore.getSession(phoneKey).projects.pc.queuedPrompts.length, 1);
  assert.ok(f.replies.some(text => text.includes("Recovered reply")));
});

test("queue handoff is durable before dispatch and a restart cannot silently lose or replay it", async t => {
  const f = await fixture(t), id = whatsappRequestId(phoneKey, "handoff");
  await f.bridge.enqueueQueuedPrompt({ ...request, prompt: "queued", requestId: id });
  const item = await f.bridge.dequeueQueuedPrompt(phoneKey, { projectAlias: "pc" });
  assert.ok(item.gatewayClaimToken);
  await f.stateStore.load();
  assert.equal(f.stateStore.getSession(phoneKey).gatewayRequests[id].status, "prepared");
  const resumed = f.makeBridge();
  await resumed.runPrompt({ ...request, prompt: "queued", requestId: id });
  await resumed.runPrompt({ ...request, prompt: "different", requestId: whatsappRequestId(phoneKey, "other") });
  assert.equal(f.calls.length, 0);
  assert.match(resumed.renderSessionStatus(phoneKey), /prepared/);
});

test("successful queued gateway requests retain their own IDs and resume only the original conversation", async t => {
  const f = await fixture(t);
  const running = f.bridge.handleIncomingMessage(f.message("first", "First"));
  await until(() => f.bridge.activeRuns.size === 1);
  await f.bridge.handleIncomingMessage(f.message("second", "Second"));
  await f.bridge.upsertChatSession(phoneKey, { activeProject: "other" });
  f.finish(0);
  await until(() => f.calls.length === 2);
  assert.equal(f.calls[1].args.requestId, whatsappRequestId(phoneKey, "second"));
  assert.equal(f.calls[1].args.threadId, "original-native");
  assert.equal(f.calls[1].args.workspace, f.dir);
  f.finish(1); await running;
});

test("file caption shares its WhatsApp identity and frozen file destination", async t => {
  const f = await fixture(t), incoming = { ...f.message("attachment", ""), message: {
    documentMessage: { fileName: "file.txt", mimetype: "text/plain", fileLength: 4, caption: "Read this" }
  } };
  const running = f.bridge.handleIncomingMessage(incoming);
  await until(() => f.calls.length === 1);
  assert.equal(f.calls[0].args.requestId, whatsappRequestId(phoneKey, "attachment"));
  assert.match(f.calls[0].args.prompt, /inbox\/fixture\/file.txt/);
  f.finish(0); await running;
  await f.makeBridge().handleIncomingMessage(incoming);
  assert.equal(f.files.length, 1);
  assert.equal(f.calls.length, 1);
});

test("explicit pre-send refusal is safe while unknown gateway failure is conservatively held", async t => {
  const f = await fixture(t);
  const first = f.bridge.handleIncomingMessage(f.message("unavailable", "First"));
  await until(() => f.calls.length === 1);
  f.calls[0].done.reject(Object.assign(new Error("Gateway offline"), { promptSubmitted: false })); await first;
  assert.equal(f.stateStore.getSession(phoneKey).gatewayRequests[f.calls[0].args.requestId].status, "not_submitted");
  const second = f.bridge.handleIncomingMessage(f.message("unknown", "Second"));
  await until(() => f.calls.length === 2);
  f.calls[1].done.reject(new Error("Unexpected EOF")); await second;
  assert.equal(f.stateStore.getSession(phoneKey).gatewayRequests[f.calls[1].args.requestId].status, "uncertain");
  assert.doesNotMatch(f.replies.at(-1), /was not submitted/);
});

test("gateway native permissions and unsupported stop never claim a sandbox or confirmed interruption", async t => {
  const f = await fixture(t);
  assert.match(f.bridge.renderSessionStatus(phoneKey), /permissions: native/);
  await f.bridge.handlePermissionsCommand({ ...request, payload: "dfa" });
  assert.match(f.replies.at(-1), /permission rules/);
  const running = f.bridge.handleIncomingMessage(f.message("stop", "Work"));
  await until(() => f.bridge.activeRuns.size === 1);
  await f.bridge.stopActiveRun(phoneKey, remoteJid);
  assert.match(f.replies.at(-1), /Interruption is unconfirmed/);
  assert.doesNotMatch(f.replies.at(-1), /Stopped the active/);
  f.calls[0].done.reject(Object.assign(new Error("Observer closed"), { deliveryUncertain: true })); await running;
  assert.equal(f.stateStore.getSession(phoneKey).gatewayRequests[f.calls[0].args.requestId].status, "uncertain");
  await f.bridge.refreshGatewayStatus(phoneKey, remoteJid);
  assert.equal(f.bridge.activeRuns.size, 0, "confirmed completion releases only the observer stop guard");
});

test("gateway configuration identity invalidates direct transport binding and durable save failure prevents launch", async t => {
  const f = await fixture(t), project = f.configStore.data.projects[0];
  const gatewayBinding = projectBindingKey(f.configStore.data, project);
  const native = structuredClone(f.configStore.data); delete native.hosts[0].codexGateway;
  assert.notEqual(projectBindingKey(native, project), gatewayBinding);
  const changed = structuredClone(f.configStore.data); changed.hosts[0].codexGateway.configPath = path.join(f.dir, "different.json");
  assert.notEqual(projectBindingKey(changed, project), gatewayBinding);
  const mutate = f.stateStore.mutateSession;
  f.stateStore.mutateSession = async () => { throw new Error("Disk full"); };
  await assert.rejects(f.bridge.runPrompt({ ...request, prompt: "Must not send" }), /Disk full/);
  assert.equal(f.calls.length, 0);
  f.stateStore.mutateSession = mutate;
});

test("unresolved requests cannot be bypassed by switching the host back to direct Codex", async t => {
  const f = await fixture(t);
  const running = f.bridge.handleIncomingMessage(f.message("lost-direct", "First"));
  await until(() => f.calls.length === 1);
  f.calls[0].done.reject(Object.assign(new Error("Uncertain"), { deliveryUncertain: true })); await running;
  await f.configStore.update({ hosts: [{ id: "host", transport: "local" }] });
  await f.bridge.runPrompt({ ...request, prompt: "Do not bypass", forceNewThread: true });
  assert.equal(f.calls.length, 1);
  assert.match(f.replies.at(-1), /uncertain/);
});

test("concurrent duplicate admissions start only once and invalid request IDs cannot escape persistence", async t => {
  const f = await fixture(t), id = whatsappRequestId(phoneKey, "concurrent");
  const a = f.bridge.runPrompt({ ...request, prompt: "Same", requestId: id });
  const b = f.bridge.runPrompt({ ...request, prompt: "Same", requestId: id });
  await until(() => f.calls.length === 1);
  f.finish(0); await Promise.all([a, b]);
  assert.equal(f.calls.length, 1);
  await assert.rejects(f.bridge.runPrompt({ ...request, prompt: "Bad id", requestId: "__proto__" }), /Invalid durable/);
  assert.equal(f.calls.length, 1);
});

test("creation uncertainty wins over no-prompt-submission and read-only lookup failures do not release it", async t => {
  const f = await fixture(t);
  const running = f.bridge.handleIncomingMessage(f.message("creation", "/new Create a session"));
  await until(() => f.calls.length === 1);
  f.calls[0].done.reject(Object.assign(new Error("Creation response lost"), { promptSubmitted: false, deliveryUncertain: true })); await running;
  const id = f.calls[0].args.requestId;
  assert.equal(f.stateStore.getSession(phoneKey).gatewayRequests[id].status, "uncertain");
  f.runner.readGatewayRequestStatus = async () => { throw new Error("No receipt found"); };
  await f.bridge.refreshGatewayStatus(phoneKey, remoteJid);
  assert.equal(f.stateStore.getSession(phoneKey).gatewayRequests[id].status, "uncertain");
  assert.equal(f.calls.length, 1);
  assert.match(f.replies.at(-1), /previous delivery status remains unchanged/);
});

test("completed native result with failed WhatsApp delivery is recoverable by read-only refresh", async t => {
  const f = await fixture(t);
  const originalReply = f.bridge.sendReply;
  f.bridge.sendReply = async (jid, text) => { if (text.includes("Reply 0")) throw new Error("WhatsApp disconnected"); return originalReply(jid, text); };
  const running = f.bridge.handleIncomingMessage(f.message("reply-loss", "First"));
  await until(() => f.calls.length === 1); f.finish(0); await running;
  const id = f.calls[0].args.requestId;
  assert.equal(f.stateStore.getSession(phoneKey).gatewayRequests[id].status, "completed");
  assert.equal(f.stateStore.getSession(phoneKey).gatewayRequests[id].replyDelivery, "uncertain");
  await f.bridge.refreshGatewayStatus(phoneKey, remoteJid);
  assert.equal(f.calls.length, 1);
  assert.equal(f.stateStore.getSession(phoneKey).gatewayRequests[id].replyDelivery, "sent");
  assert.match(f.replies.at(-1), /Recovered reply/);
});

test("queued destination changes never dispatch to the replacement and reset cancels durable queued identities", async t => {
  const f = await fixture(t), id = whatsappRequestId(phoneKey, "remapped");
  await f.bridge.enqueueQueuedPrompt({ ...request, prompt: "Old destination", requestId: id });
  await f.configStore.update({ projects: [{ alias: "pc", workspace: path.join(f.dir, "Changed Directory") }] });
  await f.bridge.runNextQueuedPrompt({ ...request });
  assert.equal(f.calls.length, 0);
  assert.equal(f.stateStore.getSession(phoneKey).gatewayRequests[id].status, "not_submitted");
  const cancelled = whatsappRequestId(phoneKey, "cancelled");
  await f.bridge.enqueueQueuedPrompt({ ...request, prompt: "Clear this", requestId: cancelled });
  await f.bridge.resetProjectSession(phoneKey, "pc");
  assert.equal(f.stateStore.getSession(phoneKey).gatewayRequests[cancelled].status, "cancelled");
});

test("status cannot declare an in-flight worker safely unsubmitted from an intermediate creation receipt", async t => {
  const f = await fixture(t);
  const running = f.bridge.handleIncomingMessage(f.message("creating", "/new Work"));
  await until(() => f.bridge.activeRuns.size === 1);
  f.runner.readGatewayRequestStatus = async args => ({ requestId: args.requestId, readOnly: true,
    completed: false, state: "created", promptSubmitted: false, deliveryUncertain: false });
  await f.bridge.refreshGatewayStatus(phoneKey, remoteJid);
  assert.equal(f.stateStore.getSession(phoneKey).gatewayRequests[f.calls[0].args.requestId].status, "uncertain");
  f.finish(0); await running;
  assert.equal(f.calls.length, 1);
});

test("reconciliation restores an uncertain new conversation so the next prompt resumes it", async t => {
  const f = await fixture(t);
  const creating = f.bridge.handleIncomingMessage(f.message("new-lost", "/new Work"));
  await until(() => f.calls.length === 1);
  f.calls[0].done.reject(Object.assign(new Error("Response lost"), { deliveryUncertain: true })); await creating;
  assert.equal(f.stateStore.getSession(phoneKey).projects.pc.threadId, null);
  await f.stateStore.load();
  const resumed = f.makeBridge();
  f.runner.readGatewayRequestStatus = async args => ({ requestId: args.requestId, threadId: "created-native",
    completed: true, readOnly: true, replyText: "Recovered" });
  await resumed.refreshGatewayStatus(phoneKey, remoteJid);
  assert.equal(f.stateStore.getSession(phoneKey).projects.pc.threadId, "created-native");
  const next = resumed.handleIncomingMessage(f.message("after-recovery", "Continue"));
  await until(() => f.calls.length === 2);
  assert.equal(f.calls[1].args.threadId, "created-native");
  f.finish(1); await next;
});

test("recovering a new conversation neither steals focus nor replaces an explicitly selected native session", async t => {
  for (const replace of [false, true]) {
    const f = await fixture(t);
    const creating = f.bridge.handleIncomingMessage(f.message(`focus-${replace}`, "/new Work"));
    await until(() => f.calls.length === 1);
    f.calls[0].done.reject(Object.assign(new Error("Response lost"), { deliveryUncertain: true })); await creating;
    await f.bridge.upsertChatSession(phoneKey, { activeProject: "other" });
    if (replace) await f.bridge.upsertProjectSession(phoneKey, "pc", { projectPatch: { threadId: "user-selected" } });
    f.runner.readGatewayRequestStatus = async args => ({ requestId: args.requestId, threadId: "created-native",
      completed: true, readOnly: true, replyText: "Recovered" });
    await f.bridge.refreshGatewayStatus(phoneKey, remoteJid);
    assert.equal(f.stateStore.getSession(phoneKey).activeProject, "other");
    assert.equal(f.stateStore.getSession(phoneKey).projects.pc.threadId, replace ? "user-selected" : "created-native");
  }
});

test("explicit reset or destination reassignment prevents recovered conversation attachment", async t => {
  for (const remap of [false, true]) {
    const f = await fixture(t);
    const creating = f.bridge.handleIncomingMessage(f.message(`reset-${remap}`, "/new Work"));
    await until(() => f.calls.length === 1);
    f.calls[0].done.reject(Object.assign(new Error("Response lost"), { deliveryUncertain: true })); await creating;
    if (remap) await f.configStore.update({ projects: [{ alias: "pc", workspace: path.join(f.dir, "Replacement") }] });
    else await f.bridge.resetProjectSession(phoneKey, "pc");
    f.runner.readGatewayRequestStatus = async args => ({ requestId: args.requestId, threadId: "created-native",
      completed: true, readOnly: true, replyText: "Recovered" });
    await f.bridge.refreshGatewayStatus(phoneKey, remoteJid);
    assert.equal(f.stateStore.getSession(phoneKey).projects.pc.threadId, null);
    assert.equal(f.stateStore.getSession(phoneKey).gatewayRequests[f.calls[0].args.requestId].resultThreadId, "created-native");
  }
});

test("inProgress receipt stays uncertain after restart even if it also says no prompt submitted", async t => {
  const f = await fixture(t);
  const creating = f.bridge.handleIncomingMessage(f.message("restart-creating", "/new Work"));
  await until(() => f.calls.length === 1);
  f.calls[0].done.reject(Object.assign(new Error("Response lost"), { deliveryUncertain: true })); await creating;
  await f.stateStore.load(); const resumed = f.makeBridge();
  f.runner.readGatewayRequestStatus = async args => ({ requestId: args.requestId, threadId: "created-native",
    completed: false, promptSubmitted: false, deliveryUncertain: false, inProgress: true, readOnly: true });
  await resumed.refreshGatewayStatus(phoneKey, remoteJid);
  assert.equal(f.stateStore.getSession(phoneKey).gatewayRequests[f.calls[0].args.requestId].status, "uncertain");
  assert.equal(f.stateStore.getSession(phoneKey).projects.pc.threadId, "created-native");
  await resumed.handleIncomingMessage(f.message("blocked-more", "More work"));
  assert.equal(f.calls.length, 1);
});

test("removing a queued destination records proven non-submission instead of leaving a prepared blocker", async t => {
  const f = await fixture(t), id = whatsappRequestId(phoneKey, "removed");
  await f.bridge.enqueueQueuedPrompt({ ...request, prompt: "Old destination", requestId: id });
  await f.configStore.update({ defaultProject: "other", projects: [{ alias: "other", workspace: path.join(f.dir, "Other") }] });
  await f.bridge.runNextQueuedPrompt({ ...request });
  assert.equal(f.calls.length, 0);
  await f.stateStore.load();
  assert.equal(f.stateStore.getSession(phoneKey).gatewayRequests[id].status, "not_submitted");
  assert.equal(f.stateStore.getSession(phoneKey).projects.pc.queuedPrompts.length, 0);
  assert.match(f.replies.at(-1), /no longer configured/);
});

test("stale native binding rejects a claimed queued request without leaving a prepared blocker", async t => {
  const f = await fixture(t), id = whatsappRequestId(phoneKey, "stale-binding");
  await f.bridge.enqueueQueuedPrompt({ ...request, prompt: "Original binding", requestId: id });
  await f.bridge.upsertProjectSession(phoneKey, "pc", { projectPatch: { bindingKey: "old-native-binding" } });
  await f.bridge.runNextQueuedPrompt({ ...request });
  assert.equal(f.calls.length, 0);
  await f.stateStore.load();
  assert.equal(f.stateStore.getSession(phoneKey).gatewayRequests[id].status, "not_submitted");
  assert.equal(f.stateStore.getSession(phoneKey).projects.pc.queuedPromptsPaused, true);
});

test("configuration changes during final admission reject only the verified prepared claim", async t => {
  const f = await fixture(t), id = whatsappRequestId(phoneKey, "admission-remap");
  await f.bridge.enqueueQueuedPrompt({ ...request, prompt: "Original destination", requestId: id });
  const admit = f.bridge.admitGatewayRequest.bind(f.bridge);
  f.bridge.admitGatewayRequest = async args => {
    await f.configStore.update({ projects: [{ alias: "pc", workspace: path.join(f.dir, "Changed during admission") }] });
    return admit(args);
  };
  await f.bridge.runNextQueuedPrompt({ ...request });
  assert.equal(f.calls.length, 0);
  await f.stateStore.load();
  assert.equal(f.stateStore.getSession(phoneKey).gatewayRequests[id].status, "not_submitted");
  assert.match(f.replies.at(-1), /was not submitted/);
});

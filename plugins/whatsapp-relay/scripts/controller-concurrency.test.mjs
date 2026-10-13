import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WhatsAppControllerBridge, projectBindingKey } from "./controller-bridge.mjs";
import { ControllerConfigStore } from "./controller-config.mjs";
import { ControllerStateStore } from "./controller-state.mjs";

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "relay-concurrency-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const configStore = new ControllerConfigStore(path.join(dir, "config.json"));
  await configStore.update({
    defaultProject: "pc",
    hosts: [{ id: "vm", transport: "ssh", target: "test-vm", platform: "win32", workerPath: "C:/relay/relay-worker.mjs" }],
    projects: [{ alias: "pc", host: "host", workspace: dir }, { alias: "vm", host: "vm", workspace: "C:/work/project" }]
  });
  const stateStore = new ControllerStateStore(path.join(dir, "state.json"));
  await stateStore.upsertSession("123", { activeProject: "pc" });
  const calls = [], replies = [];
  const runner = {
    listCodexThreads: async () => [],
    startCodexTurn: (args) => {
      const result = deferred();
      const child = { killed: false, kill() { this.killed = true; } };
      const call = { args, result, child, interrupted: false };
      calls.push(call);
      return { child, resultPromise: result.promise, interrupt: async () => { call.interrupted = true; } };
    }
  };
  const bridge = new WhatsAppControllerBridge({ runtime: {}, configStore, stateStore, runner });
  bridge.sendReply = async (_jid, text) => { replies.push(text); };
  return { bridge, configStore, stateStore, calls, replies };
}

const request = { phoneKey: "123", remoteJid: "123@s.whatsapp.net", label: "Test" };

test("concurrent host and VM state patches preserve both threads and the selected host", async (t) => {
  const f = await fixture(t);
  await Promise.all([
    f.bridge.upsertProjectSession("123", "pc", { projectPatch: { threadId: "pc-thread" } }),
    f.bridge.upsertProjectSession("123", "vm", { projectPatch: { threadId: "vm-thread" } }),
    f.bridge.upsertChatSession("123", { activeProject: "vm" })
  ]);
  const session = f.stateStore.getSession("123");
  assert.equal(session.projects.pc.threadId, "pc-thread");
  assert.equal(session.projects.vm.threadId, "vm-thread");
  assert.equal(session.activeProject, "vm");
});

test("concurrent queue additions and removals never drop or duplicate prompts", async (t) => {
  const f = await fixture(t);
  await Promise.all(Array.from({ length: 10 }, (_, index) => f.bridge.enqueueQueuedPrompt({
    ...request, projectAlias: "pc", prompt: `follow-up-${index}`
  })));
  assert.equal(f.stateStore.getSession("123").projects.pc.queuedPrompts.length, 10);
  const removed = await Promise.all(Array.from({ length: 10 }, () => f.bridge.dequeueQueuedPrompt("123", { projectAlias: "pc" })));
  assert.equal(new Set(removed.map((item) => item.prompt)).size, 10);
  assert.equal(f.stateStore.getSession("123").projects.pc.queuedPrompts.length, 0);
  await Promise.all(["one", "two"].map((prompt) => f.bridge.enqueueQueuedPrompt({ ...request, projectAlias: "vm", scopeType: "btw", prompt })));
  await f.bridge.upsertChatSession("123", { btw: { lastUsedAt: "now" } });
  assert.equal(f.stateStore.getSession("123").btw.queuedPrompts.length, 2);
});

test("simultaneous PC and VM turns retain separate native thread IDs", async (t) => {
  const f = await fixture(t);
  const pc = f.bridge.runPrompt({ ...request, projectAlias: "pc", prompt: "local" });
  const vm = f.bridge.runPrompt({ ...request, projectAlias: "vm", prompt: "remote" });
  assert.equal(f.calls.length, 2);
  f.calls[0].result.resolve({ threadId: "pc-thread", replyText: "Local done" });
  f.calls[1].result.resolve({ threadId: "vm-thread", replyText: "Remote done" });
  await Promise.all([pc, vm]);
  assert.equal(f.stateStore.getSession("123").projects.pc.threadId, "pc-thread");
  assert.equal(f.stateStore.getSession("123").projects.vm.threadId, "vm-thread");
  assert.equal(f.bridge.activeRuns.size, 0);
});

test("follow-up waits until the completed thread ID is durably stored", async (t) => {
  const f = await fixture(t);
  const storing = deferred(), release = deferred();
  const original = f.bridge.upsertProjectSession.bind(f.bridge);
  f.bridge.upsertProjectSession = async (...args) => {
    if (args[2]?.projectPatch?.threadId === "first-result") {
      storing.resolve();
      await release.promise;
    }
    return original(...args);
  };
  const run = f.bridge.runPrompt({ ...request, projectAlias: "pc", prompt: "first" });
  f.calls[0].result.resolve({ threadId: "first-result", replyText: "First done" });
  await storing.promise;
  assert.ok(f.bridge.projectRun("123", "pc"));
  assert.equal(await f.bridge.queuePromptIfBusy({ ...request, projectAlias: "pc", prompt: "second" }), true);
  assert.equal(f.calls.length, 1);
  const start = f.bridge.runner.startCodexTurn;
  f.bridge.runner.startCodexTurn = (args) => {
    const result = start(args);
    f.calls.at(-1).result.resolve({ threadId: "second-result", replyText: "Second done" });
    return result;
  };
  release.resolve();
  await run;
  assert.equal(f.calls[1].args.threadId, "first-result");
  assert.equal(f.stateStore.getSession("123").projects.pc.threadId, "second-result");
});

test("an initial WhatsApp reply failure interrupts Codex and releases the active run", async (t) => {
  const f = await fixture(t);
  f.bridge.sendReply = async () => { throw new Error("WhatsApp offline"); };
  await assert.rejects(f.bridge.runPrompt({ ...request, projectAlias: "pc", prompt: "first" }), /WhatsApp offline/);
  assert.equal(f.calls[0].interrupted, true);
  assert.equal(f.calls[0].child.killed, true);
  assert.equal(f.bridge.activeRuns.size, 0);
});

test("a late completion cannot overwrite state for a reassigned project", async (t) => {
  const f = await fixture(t);
  const started = deferred();
  f.bridge.sendReply = async (_jid, text) => { f.replies.push(text); started.resolve(); };
  const run = f.bridge.runPrompt({ ...request, projectAlias: "pc", prompt: "old destination" });
  await started.promise;
  await f.configStore.update({ projects: f.configStore.data.projects.map((project) => project.alias === "pc"
    ? { ...project, host: "vm", workspace: "C:/work/reassigned" } : project) });
  const bindingKey = projectBindingKey(f.configStore.data, f.configStore.data.projects[0]);
  await f.bridge.upsertProjectSession("123", "pc", { projectPatch: { bindingKey, threadId: "new-destination-thread" } });
  f.calls[0].result.resolve({ threadId: "old-thread", replyText: "Old output" });
  await run;
  assert.equal(f.stateStore.getSession("123").projects.pc.threadId, "new-destination-thread");
  assert.equal(f.stateStore.getSession("123").projects.pc.bindingKey, bindingKey);
  assert.equal(f.bridge.activeRuns.size, 0);
});

test("an old completion never deletes a replacement run with the same key", async (t) => {
  const f = await fixture(t);
  const started = deferred();
  f.bridge.sendReply = async () => { started.resolve(); };
  const run = f.bridge.runPrompt({ ...request, projectAlias: "pc", prompt: "old" });
  await started.promise;
  const replacement = { threadId: "replacement-thread" };
  f.bridge.activeRuns.set("project:123:pc", replacement);
  f.calls[0].result.resolve({ threadId: "old-thread", replyText: "Old output" });
  await run;
  assert.equal(f.bridge.projectRun("123", "pc"), replacement);
  assert.notEqual(f.stateStore.getSession("123").projects.pc.threadId, "old-thread");
});

test("removed explicit projects never fall back to sending the prompt to the default host", async (t) => {
  const f = await fixture(t);
  await f.bridge.runPrompt({ ...request, projectAlias: "removed", prompt: "private" });
  assert.equal(f.calls.length, 0);
  assert.match(f.replies.at(-1), /no longer configured/);
});

test("legacy unbound threads cannot resume when the host ID is reassigned to SSH", async (t) => {
  const f = await fixture(t);
  await f.configStore.update({
    hosts: [{ id: "host", transport: "ssh", target: "new-vm", platform: "win32", workerPath: "C:/relay/relay-worker.mjs" }],
    projects: [{ alias: "pc", host: "host", workspace: "C:/work/project" }]
  });
  await f.bridge.upsertProjectSession("123", "pc", { projectPatch: { threadId: "legacy-local-thread", bindingKey: null } });
  await f.bridge.runPrompt({ ...request, projectAlias: "pc", prompt: "private" });
  assert.equal(f.calls.length, 0);
  assert.match(f.replies.at(-1), /destination.*changed/);
});

test("slow session selection cannot replace a run started while the thread list loads", async (t) => {
  const f = await fixture(t);
  const listing = deferred();
  f.bridge.runner.listCodexThreads = () => listing.promise;
  const selection = f.bridge.connectToThread({ ...request, payload: "chosen-thread" });
  const run = f.bridge.runPrompt({ ...request, projectAlias: "pc", prompt: "first" });
  listing.resolve([{ id: "chosen-thread", name: "Earlier session" }]);
  await selection;
  assert.notEqual(f.stateStore.getSession("123").projects.pc.threadId, "chosen-thread");
  f.calls[0].result.resolve({ threadId: "running-thread", replyText: "Done" });
  await run;
  assert.equal(f.stateStore.getSession("123").projects.pc.threadId, "running-thread");
});

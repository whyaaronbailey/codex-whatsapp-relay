import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WhatsAppControllerBridge, parseIncomingCommand, projectBindingKey } from "./controller-bridge.mjs";
import { ControllerConfigStore } from "./controller-config.mjs";
import { ControllerStateStore, normalizeThreadName } from "./controller-state.mjs";

const phoneKey = "10000000000";
const request = { phoneKey, remoteJid: `${phoneKey}@s.whatsapp.net`, label: "Test" };
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "relay-named-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const configStore = new ControllerConfigStore(path.join(dir, "config.json"));
  await configStore.update({ enabled: true, allowedControllers: [{ number: `+${phoneKey}` }],
    defaultProject: "pc", projects: [{ alias: "pc", workspace: dir }], model: "codex-model", profile: "codex-profile", search: true });
  const stateStore = new ControllerStateStore(path.join(dir, "state.json"));
  await stateStore.upsertSession(phoneKey, { activeProject: "pc" });
  const calls = [], replies = [], files = [];
  const runner = { listCodexThreads: async () => [{ id: "existing-thread", name: "Existing" }],
    startCodexTurn(args) {
      const result = deferred(), started = deferred();
      const call = { args, result, started, decisions: [], interrupted: false };
      calls.push(call);
      const child = { killed: false, kill() { this.killed = true; } };
      return { child, resultPromise: result.promise,
        answerApproval: async (...decision) => { call.decisions.push(decision); },
        interrupt: async () => { call.interrupted = true; } };
    } };
  const runtime = { downloadMediaBuffer: async () => Buffer.from("file"), ensureConnected: async () => ({ sendMessage: async () => ({}) }) };
  const fileService = { saveIncomingAttachment: async (args) => { files.push(args); return { relativePath: ".whatsapp-relay/inbox/id/file.txt", size: 4, sha256: "abc", mimetype: "text/plain" }; } };
  const bridge = new WhatsAppControllerBridge({ runtime, configStore, stateStore, runner, fileService });
  bridge.sendReply = async (_jid, text) => { replies.push(text); if (/Starting a fresh|Working in|Started a one-off/.test(text)) {
    const call = calls.find((item) => !item.didStart && (!item.args.threadName || text.includes(item.args.threadName.match(/\[([^\]]+)\]/)?.[1])));
    if (call) { call.didStart = true; call.started.resolve(); }
  } };
  let id = 0;
  const send = (text) => bridge.handleIncomingMessage({ key: { id: `incoming-${++id}`, remoteJid: request.remoteJid },
    messageTimestamp: Math.floor(Date.now() / 1000), message: { conversation: text } });
  const select = (name) => bridge.handleNamedThreadCommand({ ...request, payload: name });
  const finish = async (index, threadId = `native-${index}`) => { calls[index].result.resolve({ threadId, replyText: `Reply ${index}` }); };
  return { bridge, configStore, stateStore, calls, replies, files, send, select, finish };
}

test("legacy state and queues remain in main when named sessions are created", async (t) => {
  const f = await fixture(t);
  await f.bridge.upsertProjectSession(phoneKey, "pc", { projectPatch: { threadId: "legacy", queuedPrompts: [{ prompt: "old followup" }] } });
  await f.select("review");
  await f.bridge.upsertProjectSession(phoneKey, "pc", { projectPatch: { threadId: "review-native" } });
  await f.stateStore.load();
  const state = f.stateStore.getSession(phoneKey).projects.pc;
  assert.equal(state.threadId, "legacy");
  assert.equal(state.queuedPrompts[0].prompt, "old followup");
  assert.equal(state.namedThreads.review.threadId, "review-native");
  assert.equal(state.activeThread, "review");
  assert.equal(f.stateStore.listSessions()[0].threadId, "review-native");
  assert.equal(f.bridge.summary().sessions[0].activeThread, "review");
  assert.equal(f.bridge.summary().sessions[0].threadId, "review-native");
});

test("named command parser and names reject traversal and prototype keys", () => {
  assert.deepEqual(parseIncomingCommand("/threads", true), { type: "namedThreads", payload: "" });
  assert.deepEqual(parseIncomingCommand("/thread Review", true), { type: "namedThread", payload: "Review" });
  assert.equal(normalizeThreadName("Review"), "review");
  for (const name of ["../main", "__proto__", "constructor", "prototype", "two words", "a".repeat(49)]) assert.equal(normalizeThreadName(name), null);
});

test("parallel sessions in one workspace complete independently after selection changes", async (t) => {
  const f = await fixture(t);
  const first = f.bridge.runPrompt({ ...request, prompt: "first", threadName: "build" });
  const second = f.bridge.runPrompt({ ...request, prompt: "second", threadName: "review" });
  await Promise.all(f.calls.map((call) => call.started.promise));
  await f.select("review");
  assert.equal(f.bridge.activeRuns.size, 2);
  assert.match(f.bridge.renderSessionStatus(phoneKey, "pc/build"), /relay_thread: build/);
  assert.match(f.bridge.renderSessionStatus(phoneKey, "pc/build"), /busy: yes/);
  await f.finish(1); await second;
  await f.finish(0); await first;
  const state = f.stateStore.getSession(phoneKey).projects.pc;
  assert.equal(state.activeThread, "review");
  assert.equal(state.namedThreads.build.threadId, "native-0");
  assert.equal(state.namedThreads.review.threadId, "native-1");
  assert.ok(f.replies.some((text) => text.includes("host/codex/pc/build") && text.includes("Reply 0")));
  assert.ok(f.replies.some((text) => text.includes("host/codex/pc/review") && text.includes("Reply 1")));
  assert.equal(f.bridge.activeRuns.size, 0);
});

test("same-slot queued prompts resume the saved thread even after selecting another slot", async (t) => {
  const f = await fixture(t);
  const running = f.bridge.runPrompt({ ...request, prompt: "first", threadName: "build" });
  await f.calls[0].started.promise;
  assert.equal(await f.bridge.queuePromptIfBusy({ ...request, projectAlias: "pc", threadName: "build", prompt: "follow-up" }), true);
  assert.equal(await f.bridge.queuePromptIfBusy({ ...request, projectAlias: "pc", threadName: "review", prompt: "independent" }), false);
  await f.select("review");
  const secondStarted = deferred();
  const start = f.bridge.runner.startCodexTurn;
  f.bridge.runner.startCodexTurn = (args) => { const result = start(args); secondStarted.resolve(); return result; };
  await f.finish(0, "persisted-build");
  await secondStarted.promise;
  assert.equal(f.calls[1].args.threadId, "persisted-build");
  await f.finish(1, "persisted-build");
  await running;
  assert.equal(f.stateStore.getSession(phoneKey).projects.pc.namedThreads.review.threadId, null);
  assert.equal(f.bridge.getQueuedPrompts(phoneKey, { projectAlias: "pc", threadName: "build" }).length, 0);
});

test("targeted stop clears only that slot and ignores its late completion", async (t) => {
  const f = await fixture(t);
  const a = f.bridge.runPrompt({ ...request, prompt: "a", threadName: "build" });
  const b = f.bridge.runPrompt({ ...request, prompt: "b", threadName: "review" });
  await Promise.all(f.calls.map((call) => call.started.promise));
  await f.bridge.enqueueQueuedPrompt({ ...request, projectAlias: "pc", threadName: "build", prompt: "queued-a" });
  await f.bridge.enqueueQueuedPrompt({ ...request, projectAlias: "pc", threadName: "review", prompt: "queued-b" });
  await f.bridge.stopActiveRun(phoneKey, request.remoteJid, "pc/build");
  assert.equal(f.calls[0].interrupted, true);
  assert.equal(f.calls[1].interrupted, false);
  assert.equal(f.bridge.getQueuedPrompts(phoneKey, { projectAlias: "pc", threadName: "build" }).length, 0);
  assert.equal(f.bridge.getQueuedPrompts(phoneKey, { projectAlias: "pc", threadName: "review" }).length, 1);
  await f.bridge.clearQueuedPrompts(phoneKey, { projectAlias: "pc", threadName: "review" });
  await f.finish(0, "must-not-save"); await a;
  assert.equal(f.stateStore.getSession(phoneKey).projects.pc.namedThreads.build.threadId, null);
  assert.ok(f.bridge.projectRun(phoneKey, "pc", "review"));
  await f.finish(1); await b;
});

test("approvals target the named run and its durable state after switching selection", async (t) => {
  const f = await fixture(t);
  const a = f.bridge.runPrompt({ ...request, prompt: "a", threadName: "build" });
  const b = f.bridge.runPrompt({ ...request, prompt: "b", threadName: "review" });
  await Promise.all(f.calls.map((call) => call.started.promise));
  await f.select("review");
  await f.calls[0].args.onApprovalRequest({ kind: "commandExecution", requestId: "approval-a", threadId: "build-native" });
  await f.calls[1].args.onApprovalRequest({ kind: "commandExecution", requestId: "approval-b", threadId: "review-native" });
  await f.bridge.handleApprovalDecision(phoneKey, request.remoteJid, "accept", "pc/build");
  assert.deepEqual(f.calls[0].decisions, [["approval-a", "accept"]]);
  assert.deepEqual(f.calls[1].decisions, []);
  const state = f.stateStore.getSession(phoneKey).projects.pc;
  assert.equal(state.namedThreads.build.pendingApproval, null);
  assert.equal(state.namedThreads.review.pendingApproval.requestId, "approval-b");
  assert.ok(f.replies.some((text) => text.includes("/approve pc/build")));
  await f.finish(0); await f.finish(1); await Promise.all([a, b]);
});

test("a native thread cannot run in two slots or controller chats at once", async (t) => {
  const f = await fixture(t);
  for (const name of ["build", "review"]) await f.bridge.upsertProjectSession(phoneKey, "pc", { threadName: name, projectPatch: { threadId: "shared-native" } });
  const running = f.bridge.runPrompt({ ...request, prompt: "a", threadName: "build" });
  await f.calls[0].started.promise;
  await f.bridge.runPrompt({ ...request, prompt: "b", threadName: "review" });
  assert.equal(f.calls.length, 1);
  assert.match(f.replies.at(-1), /already running in another relay slot/);
  await f.bridge.upsertProjectSession("other", "pc", { threadName: "review", projectPatch: { threadId: "shared-native" } });
  await f.bridge.runPrompt({ ...request, phoneKey: "other", projectAlias: "pc", prompt: "c", threadName: "review" });
  assert.equal(f.calls.length, 1);
  await f.finish(0, "shared-native"); await running;
});

test("native session list and connect capture their slot across slow provider calls", async (t) => {
  const f = await fixture(t);
  await f.select("build");
  const listing = deferred();
  f.bridge.runner.listCodexThreads = () => listing.promise;
  const list = f.bridge.sendThreadList(phoneKey, request.remoteJid);
  await f.select("review");
  listing.resolve([{ id: "chosen", name: "Chosen native" }]); await list;
  assert.match(f.replies.at(-1), /\/session pc\/build 1/);
  assert.doesNotMatch(f.replies.at(-1), /\/\d+\b|\/session <|\/connect </);
  assert.equal(f.stateStore.getSession(phoneKey).projects.pc.namedThreads.build.lastThreadChoices[0].id, "chosen");
  assert.equal(f.stateStore.getSession(phoneKey).projects.pc.namedThreads.review.lastThreadChoices.length, 0);
  await f.bridge.connectToThread({ ...request, payload: "pc/build 1" });
  assert.match(f.replies.at(-1), /\/in pc\/build <prompt>/);
  assert.doesNotMatch(f.replies.at(-1), /Next: send a normal message/);
  assert.equal(f.bridge.getProjectSession(phoneKey).threadName, "review");
  assert.equal(f.stateStore.getSession(phoneKey).projects.pc.namedThreads.build.threadId, "chosen");
  assert.equal(f.stateStore.getSession(phoneKey).projects.pc.namedThreads.review.threadId, null);
});

test("file caption stays with the named slot captured before download", async (t) => {
  const f = await fixture(t);
  await f.select("build");
  f.bridge.runtime.downloadMediaBuffer = async () => { await f.select("review"); return Buffer.from("file"); };
  const handled = f.bridge.handleAttachmentMessage({ ...request, project: f.bridge.getActiveProject(phoneKey), message: {}, attachment: { size: 4, caption: "Read this", filename: "file.txt" } });
  const start = f.bridge.runner.startCodexTurn;
  f.bridge.runner.startCodexTurn = (args) => { const result = start(args); f.calls.at(-1).result.resolve({ threadId: "file-build", replyText: "Read" }); return result; };
  await handled;
  assert.equal(f.stateStore.getSession(phoneKey).projects.pc.namedThreads.build.threadId, "file-build");
  assert.equal(f.stateStore.getSession(phoneKey).projects.pc.namedThreads.review.threadId, null);
});

test("WhatsApp /in project/name targets a session without changing selection", async (t) => {
  const f = await fixture(t);
  await f.send("/thread review");
  const start = f.bridge.runner.startCodexTurn;
  f.bridge.runner.startCodexTurn = (args) => { const result = start(args); f.calls.at(-1).result.resolve({ threadId: "build-id", replyText: "Done" }); return result; };
  await f.send("/in pc/build inspect these files");
  assert.equal(f.calls[0].args.prompt, "inspect these files");
  const state = f.stateStore.getSession(phoneKey).projects.pc;
  assert.equal(state.activeThread, "review");
  assert.equal(state.namedThreads.build.threadId, "build-id");
  await f.send("/threads");
  assert.match(f.replies.at(-1), /\* review/);
  assert.match(f.replies.at(-1), /build: idle/);
});

test("new resets only the selected named slot", async (t) => {
  const f = await fixture(t);
  await f.bridge.upsertProjectSession(phoneKey, "pc", { threadName: "main", projectPatch: { threadId: "legacy" } });
  await f.select("review");
  await f.bridge.upsertProjectSession(phoneKey, "pc", { projectPatch: { threadId: "review-id" } });
  await f.send("/new");
  const state = f.stateStore.getSession(phoneKey).projects.pc;
  assert.equal(state.activeThread, "review");
  assert.equal(state.threadId, "legacy");
  assert.equal(state.namedThreads.review.threadId, null);
});

test("provider routing keeps Codex defaults out of other engines and binds saved IDs to engine", async (t) => {
  const f = await fixture(t);
  const project = { ...f.configStore.data.projects[0], engine: "opencode", opencodeUrl: "http://localhost:4096", opencodeApiVersion: "v2" };
  const before = projectBindingKey(f.configStore.data, f.configStore.data.projects[0]);
  await f.configStore.update({ projects: [project] });
  assert.notEqual(projectBindingKey(f.configStore.data, project), before);
  const running = f.bridge.runPrompt({ ...request, prompt: "native", threadName: "review" });
  assert.equal(f.calls[0].args.engine, "opencode");
  assert.equal(f.calls[0].args.model, null);
  assert.equal(f.calls[0].args.profile, null);
  assert.equal(f.calls[0].args.search, false);
  assert.equal(f.calls[0].args.permissionLevel, "native");
  await f.finish(0); await running;
  await f.bridge.handlePermissionsCommand({ ...request, payload: "pc/review dfa" });
  assert.match(f.replies.at(-1), /native/);
});

test("an unbound legacy Codex ID cannot resume through a newly assigned engine", async (t) => {
  const f = await fixture(t);
  await f.bridge.upsertProjectSession(phoneKey, "pc", { projectPatch: { threadId: "legacy-codex" } });
  await f.configStore.update({ projects: [{ ...f.configStore.data.projects[0], engine: "claude" }] });
  await f.bridge.runPrompt({ ...request, prompt: "private follow-up" });
  assert.equal(f.calls.length, 0);
  assert.match(f.replies.at(-1), /destination.*changed/);
});

test("provider startup failures return a scoped error and leave no busy slot", async (t) => {
  const f = await fixture(t);
  f.bridge.runner.startCodexTurn = () => { throw new Error("Coding tool unavailable"); };
  await f.bridge.runPrompt({ ...request, prompt: "first", threadName: "review" });
  assert.equal(f.bridge.activeRuns.size, 0);
  assert.match(f.replies.at(-1), /Could not start host\/codex\/pc\/review: Coding tool unavailable/);
});

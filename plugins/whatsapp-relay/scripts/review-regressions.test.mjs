import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WhatsAppControllerBridge, parseApprovalTargetPayload, parseIncomingCommand } from "./controller-bridge.mjs";
import { ControllerConfigStore } from "./controller-config.mjs";
import { ControllerStateStore } from "./controller-state.mjs";

const phoneKey = "10000000000";
const request = { phoneKey, remoteJid: `${phoneKey}@s.whatsapp.net`, label: "Regression fixture" };
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "relay-review-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const configStore = new ControllerConfigStore(path.join(dir, "config.json"));
  await configStore.update({ defaultProject: "pc", projects: [{ alias: "pc", workspace: dir, engine: "opencode", opencodeUrl: "http://127.0.0.1:4096" }] });
  const stateStore = new ControllerStateStore(path.join(dir, "state.json"));
  await stateStore.upsertSession(phoneKey, { activeProject: "pc" });
  const calls = [], replies = [];
  const runner = {
    startCodexTurn(args) {
      const result = deferred(), started = deferred();
      const call = { args, result, started, decisions: [], interrupts: 0 };
      calls.push(call);
      return { child: null, resultPromise: result.promise,
        interrupt: async () => { call.interrupts++; result.reject(new Error("Interrupted by fixture")); },
        answerApproval: async (...values) => call.decisions.push(values) };
    }
  };
  const bridge = new WhatsAppControllerBridge({ runtime: {}, configStore, stateStore, runner });
  bridge.sendReply = async (_jid, text) => {
    replies.push(text);
    if (/Connecting to the coding tool|The coding tool accepted/.test(text)) calls.at(-1)?.started.resolve();
  };
  return { bridge, calls, replies, stateStore, configStore };
}

test("session modifier cannot turn deny/cancel into approval", () => {
  for (const decision of ["decline", "cancel"]) {
    for (const payload of ["session", "pc/review session", "session pc/review"]) {
      assert.equal(parseApprovalTargetPayload(payload, decision).decision, decision);
    }
  }
  assert.deepEqual(parseApprovalTargetPayload("pc/review session", "accept"), { decision: "acceptForSession", targetToken: "pc/review" });
});

test("an early non-Codex lifecycle event does not claim the provider accepted a message", async (t) => {
  const f = await fixture(t);
  const start = f.bridge.runner.startCodexTurn;
  f.bridge.runner.startCodexTurn = (args) => {
    const run = start(args);
    queueMicrotask(() => args.onLifecycleEvent({ type: "turnStarted", threadId: "native", turnId: "initializing" }));
    return run;
  };
  const running = f.bridge.runPrompt({ ...request, prompt: "hello" });
  await f.calls[0].started.promise;
  assert.match(f.replies.at(-1), /Connecting to the coding tool/);
  assert.doesNotMatch(f.replies.at(-1), /accepted your message/);
  f.calls[0].result.resolve({ threadId: "native", replyText: "Reply" });
  await running;
});

test("malformed deny/cancel commands never grant an active native approval", async (t) => {
  const f = await fixture(t);
  const running = f.bridge.runPrompt({ ...request, prompt: "fixture", threadName: "review" });
  await f.calls[0].started.promise;
  await f.calls[0].args.onApprovalRequest({ requestId: "per_once", kind: "permissions", availableDecisions: ["accept", "decline", "cancel"] });
  await f.bridge.handleApprovalDecision(phoneKey, request.remoteJid, "decline", "pc/review session");
  await f.bridge.handleApprovalDecision(phoneKey, request.remoteJid, "cancel", "pc/review session");
  assert.deepEqual(f.calls[0].decisions, []);
  assert.equal(f.bridge.projectRun(phoneKey, "pc", "review").pendingApproval.requestId, "per_once");
  f.calls[0].result.resolve({ threadId: "ses_fixture", replyText: "Done" });
  await running;
});

test("successful stop supports an HTTP runner without a child process", async (t) => {
  const f = await fixture(t);
  const running = f.bridge.runPrompt({ ...request, prompt: "fixture", threadName: "review" });
  await f.calls[0].started.promise;
  await f.bridge.enqueueQueuedPrompt({ ...request, projectAlias: "pc", threadName: "review", prompt: "must not run" });
  await f.bridge.stopActiveRun(phoneKey, request.remoteJid, "pc/review");
  await running;
  assert.equal(f.calls[0].interrupts, 1);
  assert.equal(f.bridge.activeRuns.size, 0);
  assert.equal(f.bridge.queuedPromptCount(phoneKey, { projectAlias: "pc", threadName: "review" }), 0);
  assert.ok(f.replies.some((text) => /Stopped the active/.test(text)));
});

test("unconfirmed HTTP interruption clears queued work but keeps the native-session guard", async (t) => {
  const f = await fixture(t);
  const running = f.bridge.runPrompt({ ...request, prompt: "fixture", threadName: "review" });
  await f.calls[0].started.promise;
  const active = f.bridge.projectRun(phoneKey, "pc", "review");
  active.interrupt = async () => { throw new Error("Native server did not confirm interruption"); };
  await f.bridge.enqueueQueuedPrompt({ ...request, projectAlias: "pc", threadName: "review", prompt: "must not run" });
  await f.bridge.stopActiveRun(phoneKey, request.remoteJid, "pc/review");
  assert.equal(f.bridge.projectRun(phoneKey, "pc", "review"), active);
  assert.equal(active.status, "stop-unconfirmed");
  assert.equal(f.bridge.queuedPromptCount(phoneKey, { projectAlias: "pc", threadName: "review" }), 0);
  assert.ok(f.replies.some((text) => /Interruption is unconfirmed/.test(text)));
  assert.ok(!f.replies.some((text) => /Stopped the active/.test(text)));
  await f.bridge.runPrompt({ ...request, prompt: "duplicate", threadName: "review" });
  assert.equal(f.calls.length, 1);
  // A terminal provider result is confirmation even when the stop RPC failed.
  f.calls[0].result.resolve({ threadId: "ses_fixture", replyText: "Already completed" });
  await running;
  assert.equal(f.bridge.activeRuns.size, 0);
  assert.ok(!f.replies.some((text) => /Already completed/.test(text)));
});

test("an unknown provider failure does not release an uncertain-stop guard", async (t) => {
  const f = await fixture(t);
  const running = f.bridge.runPrompt({ ...request, prompt: "fixture", threadName: "review" });
  await f.calls[0].started.promise;
  const active = f.bridge.projectRun(phoneKey, "pc", "review");
  active.interrupt = async () => { throw new Error("Connection lost"); };
  await f.bridge.stopActiveRun(phoneKey, request.remoteJid, "pc/review");
  f.calls[0].result.reject(new Error("Native state unknown after connection loss"));
  await running;
  assert.equal(f.bridge.projectRun(phoneKey, "pc", "review"), active);
  await f.bridge.stopActiveRun(phoneKey, request.remoteJid, "pc/review");
  assert.equal(f.bridge.projectRun(phoneKey, "pc", "review"), active);
  assert.ok(!f.replies.some((text) => /Stopped the active/.test(text)));
});

test("daemon shutdown tolerates a failed HTTP interrupt and never drains queued work", async (t) => {
  const f = await fixture(t);
  const running = f.bridge.runPrompt({ ...request, prompt: "fixture", threadName: "review" });
  await f.calls[0].started.promise;
  const active = f.bridge.projectRun(phoneKey, "pc", "review");
  active.interrupt = async () => { throw new Error("Native server unreachable"); };
  await f.bridge.enqueueQueuedPrompt({ ...request, projectAlias: "pc", threadName: "review", prompt: "must not start during shutdown" });
  await f.bridge.stop();
  assert.equal(active.stopUnconfirmed, true);
  f.calls[0].result.resolve({ threadId: "ses_fixture", replyText: "Completed later" });
  await running;
  assert.equal(f.calls.length, 1);
});

test("delivery failure cleanup supports an HTTP runner with no child", async (t) => {
  const f = await fixture(t);
  let failFirst = true;
  const sendReply = f.bridge.sendReply;
  f.bridge.sendReply = async (...args) => {
    if (failFirst) { failFirst = false; throw new Error("WhatsApp delivery failed"); }
    await sendReply(...args);
  };
  await f.bridge.runPrompt({ ...request, prompt: "fixture", threadName: "review" });
  assert.equal(f.calls[0].interrupts, 1);
  assert.equal(f.bridge.activeRuns.size, 0);
  assert.ok(f.replies.some((text) => /WhatsApp delivery failed/.test(text)));
});

test("an old approval resolution cannot clear a newer request in the same native run", async (t) => {
  const f = await fixture(t);
  const running = f.bridge.runPrompt({ ...request, prompt: "fixture", threadName: "review" });
  await f.calls[0].started.promise;
  const callbacks = f.calls[0].args;
  await callbacks.onApprovalRequest({ kind: "permissions", requestId: "approval-old" });
  await callbacks.onApprovalRequest({ kind: "permissions", requestId: "approval-new" });
  await callbacks.onApprovalResolved({ requestId: "approval-old" });
  assert.equal(f.bridge.projectRun(phoneKey, "pc", "review").pendingApproval.requestId, "approval-new");
  assert.equal(f.stateStore.getSession(phoneKey).projects.pc.namedThreads.review.pendingApproval.requestId, "approval-new");
  await callbacks.onApprovalResolved({ requestId: "approval-new" });
  assert.equal(f.bridge.projectRun(phoneKey, "pc", "review").pendingApproval, null);
  f.calls[0].result.resolve({ threadId: "ses_fixture", replyText: "Done" });
  await running;
});

test("failed interruption during delivery cleanup does not free the HTTP session slot", async (t) => {
  const f = await fixture(t);
  let failFirst = true;
  const sendReply = f.bridge.sendReply;
  f.bridge.sendReply = async (...args) => {
    if (failFirst) { failFirst = false; throw new Error("WhatsApp delivery failed"); }
    await sendReply(...args);
  };
  const start = f.bridge.runner.startCodexTurn;
  f.bridge.runner.startCodexTurn = (args) => ({ ...start(args), interrupt: async () => { throw new Error("Native status unknown"); } });
  await f.bridge.runPrompt({ ...request, prompt: "fixture", threadName: "review" });
  const active = f.bridge.projectRun(phoneKey, "pc", "review");
  assert.equal(active.stopUnconfirmed, true);
  assert.equal(active.cancelled, true);
  assert.ok(f.replies.some((text) => /Cleanup interruption is unconfirmed/.test(text)));
  await f.bridge.runPrompt({ ...request, prompt: "do not duplicate", threadName: "review" });
  assert.equal(f.calls.length, 1);
  f.calls[0].result.resolve({ threadId: "ses_fixture", replyText: "Completed after cleanup returned" });
  await Promise.resolve();
  assert.equal(f.bridge.activeRuns.size, 0);
});

test("full-access confirmation remains bound to its named slot after selection changes", async (t) => {
  for (const target of ["review", "main"]) {
    const f = await fixture(t);
    await f.configStore.update({ projects: [{ ...f.configStore.data.projects[0], engine: "codex", permissionLevel: "workspace-write" }] });
    await f.bridge.handlePermissionsCommand({ ...request, payload: `pc/${target} dfa` });
    const confirmation = f.replies.at(-1).match(/Reply (\/dfa \S+ \d{6}) within/);
    assert.ok(confirmation);
    assert.match(confirmation[1], new RegExp(`^/dfa pc/${target} \\d{6}$`));
    await f.bridge.handleNamedThreadCommand({ ...request, payload: "another" });
    const parsed = parseIncomingCommand(confirmation[1], true);
    assert.equal(parsed.type, "permissions");
    await f.bridge.handlePermissionsCommand({ ...request, payload: parsed.payload });
    assert.equal(f.bridge.getProjectSession(phoneKey, "pc", target).session.permissionLevel, "danger-full-access");
    assert.equal(f.bridge.getProjectSession(phoneKey, "pc", "another").session.permissionLevel, null);
    assert.equal(f.bridge.getProjectSession(phoneKey, "pc").threadName, "another");
  }
});

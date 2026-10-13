import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WhatsAppControllerBridge, parseIncomingCommand, projectBindingKey } from "./controller-bridge.mjs";
import { ControllerConfigStore } from "./controller-config.mjs";
import { ControllerStateStore } from "./controller-state.mjs";

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "relay-routing-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const configStore = new ControllerConfigStore(path.join(dir, "config.json"));
  await configStore.update({ defaultProject: "desktop", hosts: [{ id: "vm", transport: "ssh", target: "test-vm", platform: "win32", workerPath: "C:/relay/relay-worker.mjs" }],
    projects: [{ alias: "desktop", host: "host", workspace: dir }, { alias: "guest", host: "vm", workspace: "C:/work/project" }] });
  const stateStore = new ControllerStateStore(path.join(dir, "state.json"));
  await stateStore.upsertSession("123", { activeProject: "desktop", remoteJid: "123@s.whatsapp.net" });
  const messages = [], calls = [], files = [];
  const runtime = { ensureConnected: async () => ({ sendMessage: async (chatId, content) => { messages.push({ chatId, content }); return { key: { id: `sent-${messages.length}` } }; } }),
    downloadMediaBuffer: async () => Buffer.from("file bytes") };
  const runner = { listCodexThreads: async (args) => { calls.push(args); return [{ id: `${args.host.id}-thread`, name: "Existing" }]; },
    startCodexTurn: (args) => { calls.push(args); return { child: {}, resultPromise: Promise.resolve({ threadId: `${args.host.id}-thread`, replyText: "Done" }) }; } };
  const fileService = { saveIncomingAttachment: async (args) => { files.push(args); return { relativePath: ".whatsapp-relay/inbox/uuid/file.txt", size: args.buffer.length, sha256: "abc", mimetype: "text/plain" }; },
    readOutgoingAttachment: async (args) => { files.push(args); return { id: "file-id", filename: "report.txt", mimetype: "text/plain", buffer: Buffer.from("report") }; },
    markAttachmentSent: async (args) => { files.push({ ...args, marked: true }); }, listStoredAttachments: async () => [] };
  const bridge = new WhatsAppControllerBridge({ runtime, configStore, stateStore, runner, fileService });
  return { bridge, configStore, stateStore, messages, calls, files };
}
const request = { phoneKey: "123", remoteJid: "123@s.whatsapp.net", label: "Test" };

test("host and attachment commands preserve full file paths", () => {
  assert.deepEqual(parseIncomingCommand("/host vm guest", true), { type: "host", payload: "vm guest" });
  assert.deepEqual(parseIncomingCommand("/send output/my report.pdf", true), { type: "sendFile", payload: "output/my report.pdf" });
  assert.deepEqual(parseIncomingCommand("/files", true), { type: "files" });
});

test("host switch routes native list, resume and new turns independently", async (t) => {
  const f = await fixture(t);
  await f.bridge.runPrompt({ ...request, prompt: "local" });
  await f.bridge.handleHostCommand({ ...request, payload: "vm guest" });
  await f.bridge.connectToThread({ ...request, payload: "vm-thread" });
  await f.bridge.runPrompt({ ...request, prompt: "remote" });
  assert.equal(f.calls[0].host.id, "host");
  assert.equal(f.calls[1].host.id, "vm");
  assert.equal(f.calls[2].threadId, "vm-thread");
  assert.equal(f.calls[2].workspace, "C:\\work\\project");
  assert.equal(f.stateStore.getSession("123").projects.desktop.threadId, "host-thread");
  assert.equal(f.stateStore.getSession("123").projects.guest.threadId, "vm-thread");
  await f.bridge.runPrompt({ ...request, prompt: "fresh", forceNewThread: true });
  assert.equal(f.calls.at(-1).threadId, null);
  assert.ok(f.messages.every((message) => message.content.linkPreview === null));
});

test("native session list identifies the exact remote scope and preserves the named target in its shortcut", async (t) => {
  const f = await fixture(t);
  await f.bridge.sendThreadList(request.phoneKey, request.remoteJid, "guest/review");
  const reply = f.messages.at(-1).content.text;
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].host.id, "vm");
  assert.equal(f.calls[0].workspace, "C:\\work\\project");
  assert.match(reply, /Host: vm \| engine: codex \| relay slot: guest\/review/);
  assert.ok(reply.includes("Workspace: C:\\work\\project"));
  assert.match(reply, /Existing/);
  assert.match(reply, /\/session guest\/review <number>/);
  assert.match(reply, /\/session guest\/review 1/);
  assert.doesNotMatch(reply, /\/\d+\b|\/session <|\/connect </);
  assert.match(reply, /Only native sessions in this workspace are searched/);
  assert.equal(f.stateStore.getSession(request.phoneKey).activeProject, "desktop");
});

test("attaching to another relay slot gives scoped follow-up commands without selecting that slot", async (t) => {
  const f = await fixture(t);
  await f.bridge.connectToThread({ ...request, payload: "guest/review vm-thread" });
  const reply = f.messages.at(-1).content.text;
  assert.match(reply, /Attached session .* to guest\/review/);
  assert.match(reply, /active relay slot is unchanged/);
  assert.match(reply, /\/in guest\/review <prompt>/);
  assert.match(reply, /\/project guest, then \/thread review/);
  assert.doesNotMatch(reply, /Next: send a normal message/);
  assert.equal(f.stateStore.getSession(request.phoneKey).activeProject, "desktop");
  assert.equal(f.bridge.getProjectSession(request.phoneKey, "guest").threadName, "main");
  assert.equal(f.bridge.getProjectSession(request.phoneKey, "guest", "review").session.threadId, "vm-thread");
  await f.bridge.runPrompt({ ...request, prompt: "normal follow-up" });
  assert.equal(f.calls.at(-1).host.id, "host");
  await f.bridge.runPrompt({ ...request, projectAlias: "guest", threadName: "review", prompt: "targeted follow-up" });
  assert.equal(f.calls.at(-1).host.id, "vm");
  assert.equal(f.calls.at(-1).threadId, "vm-thread");
});

test("the selected relay slot retains working shorthand and normal-message guidance", async (t) => {
  const f = await fixture(t);
  await f.bridge.sendThreadList(request.phoneKey, request.remoteJid);
  assert.match(f.messages.at(-1).content.text, /Use \/1, \/2/);
  await f.bridge.connectToThread({ ...request, payload: "1" });
  assert.match(f.messages.at(-1).content.text, /Next: send a normal message/);
  assert.equal(f.bridge.getProjectSession(request.phoneKey).session.threadId, "host-thread");
});

test("an empty native session list explains its workspace and how to select another configured folder", async (t) => {
  const f = await fixture(t);
  await f.configStore.update({ projects: f.configStore.data.projects.map((project) =>
    project.alias === "guest" ? { ...project, engine: "opencode", opencodeUrl: "http://127.0.0.1:4096", permissionLevel: "native" } : project) });
  f.bridge.runner.listCodexThreads = async (args) => { f.calls.push(args); return []; };
  await f.bridge.sendThreadList(request.phoneKey, request.remoteJid, "guest");
  const reply = f.messages.at(-1).content.text;
  assert.equal(f.calls[0].engine, "opencode");
  assert.match(reply, /No native sessions were found in this workspace/);
  assert.match(reply, /Host: vm \| engine: opencode \| relay slot: guest\/main/);
  assert.ok(reply.includes("Workspace: C:\\work\\project"));
  assert.match(reply, /\/projects.*\/project <alias>/);
});

test("remote discovery errors are returned with scope for both list and attach without changing the selected session", async (t) => {
  const f = await fixture(t);
  await f.configStore.update({ projects: f.configStore.data.projects.map((project) =>
    project.alias === "guest" ? { ...project, engine: "claude", permissionLevel: "native" } : project) });
  f.bridge.runner.listCodexThreads = async () => { throw new Error("Permission denied (publickey)."); };
  await f.bridge.sendThreadList(request.phoneKey, request.remoteJid, "guest/review");
  await f.bridge.connectToThread({ ...request, payload: "guest/review existing-id" });
  assert.equal(f.messages.length, 2);
  for (const { content } of f.messages) {
    assert.match(content.text, /Could not list native sessions/);
    assert.match(content.text, /Host: vm \| engine: claude \| relay slot: guest\/review/);
    assert.ok(content.text.includes("Workspace: C:\\work\\project"));
    assert.match(content.text, /Error: Permission denied \(publickey\)/);
    assert.match(content.text, /Only native sessions in this workspace are searched/);
  }
  assert.equal(f.stateStore.getSession(request.phoneKey).activeProject, "desktop");
  assert.equal(f.bridge.getProjectSession(request.phoneKey, "guest", "review").session.threadId, null);
});

test("existing threads and queued content cannot follow a remapped project", async (t) => {
  const f = await fixture(t);
  await f.bridge.runPrompt({ ...request, prompt: "first" });
  await f.bridge.enqueueQueuedPrompt({ ...request, projectAlias: "desktop", prompt: "private follow-up" });
  await f.configStore.update({ projects: f.configStore.data.projects.map((p) => p.alias === "desktop" ? { ...p, workspace: "C:/different", host: "vm" } : p) });
  await f.bridge.runPrompt({ ...request, prompt: "second" });
  await f.bridge.runNextQueuedPrompt({ ...request, projectAlias: "desktop" });
  assert.equal(f.calls.length, 1);
  assert.match(f.messages.at(-1).content.text, /queued message was not sent/);
});

test("attachment received on VM remains there when active host changes during download", async (t) => {
  const f = await fixture(t);
  await f.bridge.handleHostCommand({ ...request, payload: "vm guest" });
  const project = f.bridge.getActiveProject("123");
  f.bridge.runtime.downloadMediaBuffer = async () => {
    await f.bridge.handleHostCommand({ ...request, payload: "host desktop" });
    return Buffer.from("file bytes");
  };
  await f.bridge.handleAttachmentMessage({ ...request, message: {}, project,
    attachment: { filename: "file.txt", mimetype: "text/plain", size: 10, caption: "/host host" } });
  assert.equal(f.files[0].host.id, "vm");
  assert.equal(f.calls[0].host.id, "vm");
  assert.match(f.calls[0].prompt, /User request:\n\/host host/);
  assert.equal(f.stateStore.getSession("123").activeProject, "desktop");
});

test("oversized attachment is refused before download", async (t) => {
  const f = await fixture(t);
  let downloads = 0;
  f.bridge.runtime.downloadMediaBuffer = async () => { downloads++; return Buffer.alloc(0); };
  await f.bridge.handleAttachmentMessage({ ...request, message: {}, project: f.bridge.getActiveProject("123"),
    attachment: { size: 26 * 1024 * 1024, caption: "" } });
  assert.equal(downloads, 0);
  assert.equal(f.files.length, 0);
});

test("outgoing VM file is only marked sent after WhatsApp accepts it", async (t) => {
  const f = await fixture(t);
  await f.bridge.handleOutboxCommand({ type: "send_file", payload: { chatId: request.remoteJid, projectAlias: "guest", hostId: "vm", relativePath: "report.txt" } });
  assert.equal(f.files[0].host.id, "vm");
  assert.equal(f.messages[0].content.document.toString(), "report");
  assert.equal(f.files[1].marked, true);
  f.files.length = 0;
  f.bridge.runtime.ensureConnected = async () => ({ sendMessage: async () => { throw new Error("offline"); } });
  await assert.rejects(f.bridge.sendProjectFile(request.remoteJid, f.configStore.data.projects[1], "report.txt"), /offline/);
  assert.equal(f.files.length, 1);
  await assert.rejects(f.bridge.handleOutboxCommand({ type: "send_file", payload: { chatId: request.remoteJid, projectAlias: "guest", hostId: "host", relativePath: "report.txt" } }), /Invalid/);
});

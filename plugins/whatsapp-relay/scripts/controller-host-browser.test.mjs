import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WhatsAppControllerBridge, parseIncomingCommand, projectBindingKey } from "./controller-bridge.mjs";
import { ControllerConfigStore } from "./controller-config.mjs";
import { ControllerStateStore } from "./controller-state.mjs";
import { directoryPathKey } from "./controller-projects.mjs";

const request = { phoneKey: "123", remoteJid: "123@s.whatsapp.net", label: "Test" };
async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "relay-browser-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const configStore = new ControllerConfigStore(path.join(dir, "config.json"));
  await configStore.update({ defaultProject: "desktop", hosts: [{ id: "vm", transport: "ssh", target: "test-vm", platform: "win32", workerPath: "C:/relay/worker.mjs" }],
    projects: [
      { alias: "desktop", host: "host", workspace: dir },
      { alias: "vm-work", host: "vm", workspace: "C:/relay", permissionLevel: "danger-full-access" },
      { alias: "vm-claude", host: "vm", engine: "claude", workspace: "C:/relay" },
      { alias: "vm-open", host: "vm", engine: "opencode", workspace: "C:/relay", opencodeUrl: "http://127.0.0.1:4096" }
    ] });
  const stateStore = new ControllerStateStore(path.join(dir, "state.json"));
  await stateStore.upsertSession(request.phoneKey, { activeProject: "desktop" });
  const replies = [], calls = [], turns = [], files = [], rows = new Map();
  const key = (args) => `${args.host.id}:${args.engine ?? "codex"}:${args.opencodeUrl ?? ""}`;
  const runner = {
    listCodexThreads: async (args) => {
      calls.push(args);
      const result = rows.get(key(args)) ?? [];
      if (result instanceof Error) throw result;
      return (args.scope === "workspace" ? result.filter((row) => {
        try { return directoryPathKey(row.cwd, args.host) === directoryPathKey(args.workspace, args.host); }
        catch { return false; }
      }) : result).slice(0, args.limit);
    },
    startCodexTurn: (args) => { turns.push(args); return { child: {}, resultPromise: Promise.resolve({ threadId: args.threadId ?? "new-thread", replyText: "Done" }) }; }
  };
  const runtime = { downloadMediaBuffer: async () => Buffer.from("file"), ensureConnected: async () => ({ sendMessage: async () => ({}) }) };
  const fileService = { saveIncomingAttachment: async (args) => { files.push(args); return { relativePath: ".whatsapp-relay/inbox/file.txt", size: 4, sha256: "test", mimetype: "text/plain" }; } };
  const bridge = new WhatsAppControllerBridge({ runtime, configStore, stateStore, runner, fileService });
  bridge.sendReply = async (_jid, text) => replies.push(text);
  const host = (id = "vm") => bridge.handleHostCommand({ ...request, payload: id });
  const list = (payload = "") => bridge.sendThreadList(request.phoneKey, request.remoteJid, payload);
  const select = (payload) => bridge.connectToThread({ ...request, payload: String(payload) });
  const directory = (payload) => bridge.handleDirectoryCommand({ ...request, payload });
  const number = (id, engine = null, endpoint = null) => stateStore.getSession(request.phoneKey).hostSessionBrowser.choices.findIndex((row) => row.id === id && (!engine || row.engine === engine) && (!endpoint || row.connectionKey.includes(endpoint))) + 1;
  return { bridge, configStore, stateStore, replies, calls, turns, files, rows, host, list, select, directory, number };
}

test("directory commands preserve full paths and legacy commands remain recognized", () => {
  assert.deepEqual(parseIncomingCommand('/dir "C:\\My Work\\Session Files"', true), { type: "directory", payload: '"C:\\My Work\\Session Files"' });
  assert.deepEqual(parseIncomingCommand("/dirs", true), { type: "projects" });
  assert.deepEqual(parseIncomingCommand("/project old-alias", true), { type: "project", payload: "old-alias" });
  assert.deepEqual(parseIncomingCommand("/sessions more", true), { type: "sessions", payload: "more" });
});

test("host-wide selection creates the actual cwd route, caps permissions and sends turns and files there", async (t) => {
  const f = await fixture(t);
  await f.configStore.update({ projects: [...f.configStore.data.projects,
    { alias: "vm-existing", host: "vm", workspace: "C:/existing", permissionLevel: "read-only" }] });
  await f.bridge.upsertProjectSession(request.phoneKey, "vm-existing", { projectPatch: { threadId: "keep-original" } });
  f.rows.set("vm:codex:", [{ id: "native-new", cwd: "C:\\My Work\\New App", name: "New App", updatedAt: 100 }]);
  await f.host(); await f.list();
  assert.equal(f.calls.filter((args) => args.engine === "codex").length, 2); // Distinct configured permission sources.
  assert.equal(f.stateStore.getSession(request.phoneKey).hostSessionBrowser.choices.length, 1);
  await f.select(f.number("native-new"));
  const project = f.bridge.getActiveProject(request.phoneKey);
  assert.equal(project.host, "vm"); assert.equal(project.engine, "codex");
  assert.equal(project.workspace, "C:\\My Work\\New App");
  assert.equal(project.permissionLevel, "read-only"); // The duplicate read-only discovery source remains conservative.
  assert.equal(f.bridge.getProjectSession(request.phoneKey).session.threadId, "native-new");
  assert.equal(f.stateStore.getSession(request.phoneKey).projects["vm-existing"].threadId, "keep-original");
  await f.bridge.runPrompt({ ...request, prompt: "continue" });
  assert.equal(f.turns.at(-1).threadId, "native-new"); assert.equal(f.turns.at(-1).workspace, project.workspace);
  await f.bridge.handleAttachmentMessage({ ...request, project, message: {}, attachment: { size: 4, filename: "file.txt", mimetype: "text/plain", caption: "" } });
  assert.equal(f.files[0].workspace, project.workspace); assert.equal(f.files[0].host.id, "vm");
  assert.match(f.replies.find((reply) => reply.includes("Selected session")), /Computer: vm \| tool: codex/);
  assert.match(f.bridge.renderSessionStatus(request.phoneKey), /directory: C:\\My Work\\New App/);
});

test("multiple engines and OpenCode endpoints with the same native ID remain distinct and selectable", async (t) => {
  const f = await fixture(t);
  await f.configStore.update({ projects: [...f.configStore.data.projects,
    { alias: "vm-open-two", host: "vm", engine: "opencode", workspace: "C:/relay", opencodeUrl: "http://127.0.0.1:4097" }] });
  for (const key of ["vm:codex:", "vm:claude:", "vm:opencode:http://127.0.0.1:4096", "vm:opencode:http://127.0.0.1:4097"]) f.rows.set(key, [{ id: "same-id", cwd: "C:/Shared App", name: "Shared" }]);
  await f.host(); await f.list();
  assert.equal(f.calls.length, 4); assert.equal(f.stateStore.getSession(request.phoneKey).hostSessionBrowser.choices.length, 4);
  await f.select("same-id"); assert.match(f.replies.at(-1), /more than one tool or provider/);
  await f.select(f.number("same-id", "opencode", "4097"));
  const selected = f.bridge.getActiveProject(request.phoneKey);
  assert.equal(selected.opencodeUrl, "http://127.0.0.1:4097"); assert.equal(selected.permissionLevel, "native");
  await f.bridge.runPrompt({ ...request, prompt: "continue" });
  assert.equal(f.turns.at(-1).engine, "opencode"); assert.equal(f.turns.at(-1).threadId, "same-id");
  assert.equal(f.turns.at(-1).opencodeUrl, "http://127.0.0.1:4097");
});

test("pagination keeps global snapshot numbers, excludes unseen entries and rejects expired choices", async (t) => {
  const f = await fixture(t);
  f.rows.set("vm:codex:", Array.from({ length: 15 }, (_, index) => ({ id: `id-${index}`, cwd: `C:/Work/${index}`, updatedAt: 200 - index })));
  await f.host(); await f.list();
  const calls = f.calls.length;
  await f.select(13); assert.match(f.replies.at(-1), /displayed list/); assert.equal(f.calls.length, calls);
  await f.list("more"); assert.match(f.replies.at(-1), /13\. codex/); assert.equal(f.calls.length, calls);
  await f.select(13); assert.equal(f.bridge.getProjectSession(request.phoneKey).session.threadId, "id-12");
  await f.stateStore.mutateSession(request.phoneKey, (chat) => { chat.hostSessionBrowser.createdAt = "2000-01-01T00:00:00Z"; });
  const before = f.calls.length;
  await f.select(1); assert.match(f.replies.at(-1), /expired/); assert.equal(f.calls.length, before);
});

test("host and directory changes reject old shortcuts, and legacy cross-host switches clear the filter", async (t) => {
  const f = await fixture(t);
  f.rows.set("vm:codex:", [{ id: "vm-old", cwd: "C:/Old" }]);
  await f.host(); await f.list(); await f.host("host"); await f.select(1);
  assert.match(f.replies.at(-1), /numbered session list is missing/);
  assert.equal(f.bridge.getActiveProject(request.phoneKey).host, "host");
  await f.host(); await f.list(); await f.directory('"C:\\A New Folder"'); await f.select(1);
  assert.match(f.replies.at(-1), /numbered session list is missing/);
  assert.equal(f.bridge.getActiveProject(request.phoneKey).workspace, "C:\\A New Folder");
  await f.bridge.handleProjectCommand({ ...request, payload: "desktop" });
  assert.equal(f.stateStore.getSession(request.phoneKey).directoryFilter, null);
  assert.equal(f.bridge.getActiveProject(request.phoneKey).host, "host");
});

test("directory filtering queries that workspace directly and all clears only the filter", async (t) => {
  const f = await fixture(t);
  f.rows.set("vm:codex:", [...Array.from({ length: 200 }, (_, index) => ({ id: `new-${index}`, cwd: "C:/New" })), { id: "old", cwd: "C:/Older Folder" }]);
  await f.host(); await f.directory("C:/Older Folder"); await f.list();
  assert.ok(f.calls.every((args) => args.scope === "workspace" && args.workspace === "C:\\Older Folder"));
  assert.equal(f.stateStore.getSession(request.phoneKey).hostSessionBrowser.choices[0].id, "old");
  await f.select(1); const project = f.bridge.getActiveProject(request.phoneKey);
  assert.equal(project.permissionLevel, "workspace-write");
  await f.directory("all");
  assert.equal(f.bridge.getActiveProject(request.phoneKey).alias, project.alias);
  assert.equal(f.bridge.getProjectSession(request.phoneKey).session.threadId, "old");
  assert.equal(f.stateStore.getSession(request.phoneKey).directoryFilter, null);
});

test("selecting another native session preserves occupied slots, queues and exact destination settings", async (t) => {
  const f = await fixture(t);
  await f.configStore.update({ projects: [...f.configStore.data.projects,
    { alias: "vm-existing", host: "vm", workspace: "C:/Existing", model: "specific-model", permissionLevel: "read-only" }] });
  const project = f.configStore.data.projects.find((item) => item.alias === "vm-existing");
  await f.bridge.upsertProjectSession(request.phoneKey, project.alias, { projectPatch: { threadId: "original", bindingKey: projectBindingKey(f.configStore.data, project), queuedPrompts: [{ prompt: "keep queued", threadName: "main" }] } });
  f.bridge.activeRuns.set("project:123:vm-existing", { threadId: "original", bindingKey: projectBindingKey(f.configStore.data, project) });
  f.rows.set("vm:codex:", [{ id: "another", cwd: "c:/existing" }]);
  await f.host(); await f.list(); await f.select(1);
  assert.equal(f.bridge.getActiveProject(request.phoneKey).alias, "vm-existing");
  assert.equal(f.bridge.getActiveProject(request.phoneKey).model, "specific-model");
  assert.equal(f.bridge.getActiveProject(request.phoneKey).permissionLevel, "read-only");
  const state = f.stateStore.getSession(request.phoneKey).projects[project.alias];
  assert.equal(state.threadId, "original"); assert.equal(state.queuedPrompts[0].prompt, "keep queued");
  assert.notEqual(state.activeThread, "main"); assert.equal(state.namedThreads[state.activeThread].threadId, "another");
  assert.equal(f.bridge.activeRuns.get("project:123:vm-existing").threadId, "original");
});

test("partial provider errors are visible and missing cwd rows never become selectable", async (t) => {
  const f = await fixture(t);
  f.rows.set("vm:codex:", [{ id: "missing-cwd" }, { id: "saved", cwd: "C:/Saved", status: { type: "notLoaded" } }, { id: "active", cwd: "C:/Active", status: { type: "active" } }]);
  f.rows.set("vm:claude:", new Error("authentication unavailable"));
  await f.host(); await f.list();
  assert.match(f.replies.at(-1), /Could not search claude.*authentication unavailable/);
  assert.match(f.replies.at(-1), /Activity: tool reports active/);
  assert.match(f.replies.at(-1), /Activity: saved; running status unconfirmed/);
  const rows = f.stateStore.getSession(request.phoneKey).hostSessionBrowser.choices;
  assert.equal(rows.length, 2); assert.equal(rows[0].id, "active");
});

test("selection rejects moved sessions and host changes during native revalidation", async (t) => {
  const f = await fixture(t);
  f.rows.set("vm:codex:", [{ id: "saved", cwd: "C:/Before" }]);
  await f.host(); await f.list(); f.rows.set("vm:codex:", [{ id: "saved", cwd: "C:/After" }]);
  await f.select(1); assert.match(f.replies.at(-1), /moved, disappeared/);
  f.rows.set("vm:codex:", [{ id: "saved", cwd: "C:/Before" }]); await f.list();
  const original = f.bridge.runner.listCodexThreads;
  f.bridge.runner.listCodexThreads = async (args) => { await f.host("host"); return original(args); };
  await f.select(1); assert.match(f.replies.at(-1), /computer or directory changed/);
  assert.equal(f.bridge.getActiveProject(request.phoneKey).host, "host");
});

test("changed provider settings reject a cached choice before inheriting stronger permissions", async (t) => {
  const f = await fixture(t);
  f.rows.set("vm:codex:", [{ id: "saved", cwd: "C:/Unknown" }]);
  await f.host(); await f.list();
  const original = f.bridge.runner.listCodexThreads;
  f.bridge.runner.listCodexThreads = async (args) => {
    const result = await original(args);
    await f.configStore.update({ projects: f.configStore.data.projects.map((project) => project.alias === "vm-work" ? { ...project, model: "changed" } : project) });
    return result;
  };
  await f.select(1); assert.match(f.replies.at(-1), /provider configuration changed/);
  assert.equal(f.bridge.getActiveProject(request.phoneKey).alias, "vm-work");
});

test("native identity prevents a second run via another workspace alias", async (t) => {
  const f = await fixture(t);
  f.rows.set("vm:codex:", [{ id: "same-native", cwd: "C:/Alias" }]);
  await f.host(); await f.list();
  const choice = f.stateStore.getSession(request.phoneKey).hostSessionBrowser.choices[0];
  f.bridge.activeRuns.set("project:other:elsewhere", { threadId: choice.id, providerConnectionKey: choice.connectionKey, bindingKey: "other-workspace" });
  await f.select(1); assert.match(f.replies.at(-1), /running in another relay slot/);
  assert.equal(f.bridge.getActiveProject(request.phoneKey).alias, "vm-work");
});

test("underscore host IDs and default-route alias collisions cannot select another computer", async (t) => {
  const f = await fixture(t);
  await f.configStore.update({ hosts: [...f.configStore.data.hosts,
    { id: "my_vm", transport: "ssh", target: "other-vm", platform: "win32", workerPath: "C:/Other Relay/worker.mjs" }],
    projects: [...f.configStore.data.projects, { alias: "dir-my-vm-default", host: "vm", workspace: "C:/Collision" }] });
  await f.host("my_vm");
  assert.equal(f.bridge.getActiveProject(request.phoneKey).host, "my_vm");
  assert.equal(f.bridge.getActiveProject(request.phoneKey).alias, "dir-my-vm-default-2");
  await f.directory("C:/New Directory");
  assert.equal(f.bridge.getActiveProject(request.phoneKey).host, "my_vm");
  assert.equal(f.bridge.getActiveProject(request.phoneKey).workspace, "C:\\New Directory");
  f.rows.set("my_vm:codex:", [{ id: "under-scored", cwd: "C:/Another Directory" }]);
  await f.directory("all"); await f.list(); await f.select(1);
  assert.equal(f.bridge.getProjectSession(request.phoneKey).session.threadId, "under-scored");
  assert.equal(f.bridge.getActiveProject(request.phoneKey).host, "my_vm");
  assert.equal(f.bridge.getActiveProject(request.phoneKey).workspace, "C:\\Another Directory");
});

test("legacy reset selection clears old directory filters and cached numbers", async (t) => {
  const f = await fixture(t);
  await f.host(); await f.directory("C:/Filtered");
  await f.bridge.resetProjectSession(request.phoneKey, "desktop", { activeProject: "desktop" });
  assert.equal(f.stateStore.getSession(request.phoneKey).directoryFilter, null);
  await f.select(1); assert.match(f.replies.at(-1), /numbered session list is missing/);
});

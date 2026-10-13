import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { ControllerConfigStore } from "./controller-config.mjs";
import { projectBindingKey } from "./controller-bridge.mjs";
import { createWhatsAppMcpServer } from "./mcp-server.mjs";

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "relay-mcp-test-"));
  const configStore = new ControllerConfigStore(path.join(root, "controller-config.json"));
  await configStore.update({
    enabled: true,
    allowedControllers: [{ number: "+10000000000", label: "Test owner" }],
    hosts: [
      { id: "host", transport: "local" },
      { id: "vm", transport: "ssh", target: "relay-test-vm", platform: "linux", workerPath: "/opt/relay/relay-worker.mjs" }
    ],
    projects: [{ alias: "main", workspace: root }, { alias: "vm-work", host: "vm", workspace: "/srv/work" }],
    maxAttachmentBytes: 1024
  });
  const queued = [];
  const sent = [];
  let started = 0;
  let connected = 0;
  const status = { running: true, process: {}, sessions: [] };
  const chat = { id: "owner@example.invalid", displayName: "Test owner" };
  const runtime = {
    initialize: async () => {},
    hasSavedCreds: () => true,
    ensureConnected: async () => {
      connected++;
      return { sendMessage: async (...args) => { sent.push(args); } };
    },
    store: {
      resolveChat: ({ chatId, chatName }) => ({
        match: chatId === chat.id || chatName === chat.displayName ? chat : null,
        candidates: []
      })
    }
  };
  const server = await createWhatsAppMcpServer({
    runtime,
    controllerConfigStore: configStore,
    getControllerProcessStatus: async () => status,
    startControllerDaemon: async () => { started++; return status; },
    stopControllerDaemon: async () => ({ ...status, running: false }),
    enqueueControllerCommand: async (command) => { queued.push(command); return { id: "test-command", ...command }; }
  });
  const client = new Client({ name: "relay-tests", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => {
    await client.close();
    await server.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const call = (name, args = {}) => client.callTool({ name, arguments: args });
  return { root, client, call, configStore, status, queued, sent, chat, counts: () => ({ started, connected }) };
}

function resultText(result) {
  return result.content.filter((item) => item.type === "text").map((item) => item.text).join("\n");
}

test("MCP advertises host routing, file cap, and explicit file project schemas", async (t) => {
  const { client } = await fixture(t);
  const { tools } = await client.listTools();
  const start = tools.find((tool) => tool.name === "whatsapp_start_controller_bridge").inputSchema;
  assert.ok(start.properties.hosts.items.properties.workerPath);
  assert.ok(start.properties.projects.items.properties.host);
  assert.equal(start.properties.maxAttachmentBytes.maximum, 25 * 1024 * 1024);
  const send = tools.find((tool) => tool.name === "whatsapp_send_file").inputSchema;
  assert.ok(send.required.includes("projectAlias"));
  assert.ok(send.required.includes("relativePath"));
});

test("bridge configuration patches preserve unspecified hosts and limits", async (t) => {
  const { root, call, configStore, counts } = await fixture(t);
  const hosts = [
    { id: "host", transport: "local" },
    { id: "vm", transport: "ssh", target: "relay-test-vm", platform: "windows", workerPath: "C:\\relay\\relay-worker.mjs" }
  ];
  const first = await call("whatsapp_start_controller_bridge", {
    hosts, maxAttachmentBytes: 2048,
    projects: [{ alias: "main", workspace: root }, { alias: "vm-work", host: "vm", workspace: "C:\\work" }]
  });
  assert.equal(first.isError, false, resultText(first));
  const before = structuredClone(await configStore.load());
  const second = await call("whatsapp_start_controller_bridge", { model: "test-model", captureAllDirectMessages: false });
  assert.equal(second.isError, false, resultText(second));
  const after = await configStore.load();
  assert.deepEqual(after.hosts, before.hosts);
  assert.deepEqual(after.projects, before.projects);
  assert.equal(after.maxAttachmentBytes, 2048);
  assert.equal(after.model, "test-model");
  assert.equal(after.captureAllDirectMessages, false);
  assert.equal(counts().started, 2);
  assert.equal(counts().connected, 0);
});

test("MCP refuses invalid hosts and oversized limits before starting a daemon", async (t) => {
  const { call, counts } = await fixture(t);
  const hostResult = await call("whatsapp_start_controller_bridge", { hosts: [{ id: "vm", transport: "ssh" }] });
  assert.equal(hostResult.isError, true);
  assert.match(resultText(hostResult), /SSH target/);
  const limitResult = await call("whatsapp_start_controller_bridge", { maxAttachmentBytes: 25 * 1024 * 1024 + 1 });
  assert.equal(limitResult.isError, true);
  assert.equal(counts().started, 0);
});

test("file delivery queues an exact project and host without opening WhatsApp", async (t) => {
  const { call, queued, chat, counts, sent, configStore } = await fixture(t);
  const result = await call("whatsapp_send_file", { chatName: chat.displayName, projectAlias: "vm-work", relativePath: "reports/final.pdf" });
  assert.equal(result.isError, false, resultText(result));
  assert.match(resultText(result), /Delivery is pending/);
  const config = await configStore.load();
  const project = config.projects.find((entry) => entry.alias === "vm-work");
  const expectedBindingKey = projectBindingKey(config, project);
  assert.deepEqual(queued, [{
    type: "send_file",
    payload: { chatId: chat.id, projectAlias: "vm-work", relativePath: "reports/final.pdf", hostId: "vm", bindingKey: expectedBindingKey }
  }]);
  assert.notEqual(projectBindingKey(config, { ...project, workspace: "/srv/different" }), queued[0].payload.bindingKey);
  assert.notEqual(projectBindingKey({ ...config, hosts: config.hosts.map((host) => host.id === "vm" ? { ...host, target: "different-vm" } : host) }, project), queued[0].payload.bindingKey);
  assert.equal(counts().connected, 0);
  assert.deepEqual(sent, []);
});

test("file delivery requires a running enabled bridge and exact project", async (t) => {
  const { call, queued, status, configStore, chat } = await fixture(t);
  const args = { chatId: chat.id, projectAlias: "vm-work", relativePath: "file.txt" };
  status.running = false;
  assert.match(resultText(await call("whatsapp_send_file", args)), /requires a running controller/);
  status.running = true;
  await configStore.update({ enabled: false });
  assert.match(resultText(await call("whatsapp_send_file", args)), /requires a running controller/);
  await configStore.update({ enabled: true });
  const unknown = await call("whatsapp_send_file", { ...args, projectAlias: "vm" });
  assert.equal(unknown.isError, true);
  assert.match(resultText(unknown), /Unknown project alias/);
  const missing = await call("whatsapp_send_file", { chatId: chat.id, relativePath: "file.txt" });
  assert.equal(missing.isError, true);
  assert.deepEqual(queued, []);
});

test("status identifies each host and the active session host", async (t) => {
  const { call, status } = await fixture(t);
  status.sessions.push({ activeProject: "vm-work", label: "Test", phoneKey: "test-owner", threadId: "test-thread" });
  const response = await call("whatsapp_controller_status");
  assert.equal(response.isError, false);
  const text = resultText(response);
  assert.match(text, /host_count: 2/);
  assert.match(text, /vm transport=ssh platform=linux/);
  assert.match(text, /vm-work host=vm engine=codex workspace=\/srv\/work/);
  assert.match(text, /active_project=vm-work.*host=vm/);
  assert.match(text, /max_attachment_bytes: 1024/);
});

test("direct text sends explicitly disable link previews", async (t) => {
  const { call, status, chat, sent, queued } = await fixture(t);
  status.running = false;
  const result = await call("whatsapp_send_message", { chatId: chat.id, text: "https://example.invalid/" });
  assert.equal(result.isError, false);
  assert.deepEqual(sent, [[chat.id, { text: "https://example.invalid/", linkPreview: null }]]);
  assert.deepEqual(queued, []);
});

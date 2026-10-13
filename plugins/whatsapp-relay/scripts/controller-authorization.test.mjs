import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { WhatsAppControllerBridge } from "./controller-bridge.mjs";
import { ControllerConfigStore } from "./controller-config.mjs";
import { ControllerStateStore } from "./controller-state.mjs";
import { listStoredAttachments } from "./relay-files.mjs";

// Synthetic controller identifiers, with all fixtures confined to a temporary workspace.
const OWNER = "10000000000";
const UNKNOWN = "20000000000";

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "relay-authorization-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const configStore = new ControllerConfigStore(path.join(root, "controller-config.json"));
  const workspace = path.join(root, "workspace");
  await fs.mkdir(workspace);
  await configStore.update({
    enabled: true, allowedControllers: [{ number: `+${OWNER}` }],
    projects: [{ alias: "main", workspace }], maxAttachmentBytes: 1024
  });
  const stateStore = new ControllerStateStore(path.join(root, "controller-state.json"));
  const downloads = [];
  const sent = [];
  const runtime = {
    downloadMediaBuffer: async (message, options) => { downloads.push({ message, options }); return Buffer.from("test payload"); },
    ensureConnected: async () => ({
      sendMessage: async (chatId, content) => { sent.push({ chatId, content }); return { key: { id: `reply-${sent.length}` } }; }
    })
  };
  const bridge = new WhatsAppControllerBridge({ runtime, configStore, stateStore });
  await bridge.initialize();
  let sequence = 0;
  const message = (remoteJid, { kind = "documentMessage", fromMe = false, ...metadata } = {}) => ({
    key: { id: `test-${++sequence}`, remoteJid, fromMe },
    messageTimestamp: Math.floor(Date.now() / 1000),
    message: { [kind]: { fileName: "example.txt", mimetype: "text/plain", fileLength: 12, ...metadata } }
  });
  return { bridge, configStore, stateStore, workspace, downloads, sent, message };
}

test("matching controller digits do not authorize malformed or non-direct media JIDs", async (t) => {
  const { bridge, downloads, sent, stateStore, message } = await fixture(t);
  const addresses = [
    `${OWNER}@g.us`, `${OWNER}@broadcast`, `${OWNER}@newsletter`, `${OWNER}@example.invalid`,
    `${OWNER}@s.whatsapp.net.example.invalid`, OWNER, `${OWNER}extra@s.whatsapp.net`,
    `prefix${OWNER}@s.whatsapp.net`, "status@broadcast", "", null
  ];
  for (const address of addresses) await bridge.handleIncomingMessage(message(address));
  assert.deepEqual(downloads, []);
  assert.deepEqual(sent, []);
  assert.deepEqual(stateStore.listSessions(), []);
});

test("unknown direct controllers cannot download documents, images or voice notes", async (t) => {
  const { bridge, downloads, sent, stateStore, message } = await fixture(t);
  for (const kind of ["documentMessage", "imageMessage", "audioMessage"]) {
    await bridge.handleIncomingMessage(message(`${UNKNOWN}@s.whatsapp.net`, { kind }));
  }
  assert.deepEqual(downloads, []);
  assert.deepEqual(sent, []);
  assert.deepEqual(stateStore.listSessions(), []);
});

test("disabled bridge and revoked controller stop downloads before media access", async (t) => {
  const { bridge, configStore, downloads, sent, message } = await fixture(t);
  await configStore.update({ enabled: false });
  await bridge.handleIncomingMessage(message(`${OWNER}@s.whatsapp.net`));
  await configStore.update({ enabled: true, allowedControllers: [] });
  await bridge.handleIncomingMessage(message(`${OWNER}@s.whatsapp.net`));
  assert.deepEqual(downloads, []);
  assert.deepEqual(sent, []);
});

test("allowed direct attachments download with configured bounds and save in selected workspace", async (t) => {
  const { bridge, workspace, downloads, sent, message } = await fixture(t);
  for (const kind of ["documentMessage", "imageMessage", "videoMessage"]) {
    await bridge.handleIncomingMessage(message(`${OWNER}@s.whatsapp.net`, { kind }));
  }
  assert.equal(downloads.length, 3);
  assert.ok(downloads.every(({ options }) => options.maxBytes === 1024));
  const stored = await listStoredAttachments({ workspace });
  assert.equal(stored.length, 3);
  for (const record of stored) {
    assert.equal(await fs.readFile(path.join(workspace, record.relativePath), "utf8"), "test payload");
  }
  assert.equal(sent.length, 3);
  assert.ok(sent.every(({ chatId, content }) => chatId === `${OWNER}@s.whatsapp.net` && content.text.includes("Saved on host / main")));
});

test("allowed self-chat works while own sent-document echoes are ignored", async (t) => {
  const { bridge, downloads, message } = await fixture(t);
  const selfChat = message(`${OWNER}@s.whatsapp.net`, { fromMe: true });
  await bridge.handleIncomingMessage(selfChat);
  const echo = message(`${OWNER}@s.whatsapp.net`, { fromMe: true });
  bridge.rememberOutgoingMessage(echo.key.id);
  await bridge.handleIncomingMessage(echo);
  assert.equal(downloads.length, 1);
});

test("oversized authorized media is rejected from metadata before downloading", async (t) => {
  const { bridge, downloads, sent, message } = await fixture(t);
  await bridge.handleIncomingMessage(message(`${OWNER}@s.whatsapp.net`, { fileLength: 1025 }));
  assert.deepEqual(downloads, []);
  assert.equal(sent.length, 1);
  assert.match(sent[0].content.text, /exceeds the 1024-byte limit/);
});

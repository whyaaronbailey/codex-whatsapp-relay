import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  attachmentByteLimit, MAX_ATTACHMENT_BYTES, performFileOperation, sanitizeAttachmentFilename
} from "./relay-file-ops.mjs";
import { listStoredAttachments, markAttachmentSent, readOutgoingAttachment, saveIncomingAttachment } from "./relay-files.mjs";

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "relay-files-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, "workspace");
  await fs.mkdir(workspace);
  const operate = (request) => performFileOperation({ workspace, ...request });
  const incoming = (filename, data = "sample", extra = {}) => operate({
    operation: "file.writeIncoming", filename, bufferBase64: Buffer.from(data).toString("base64"), ...extra
  });
  return { root, workspace, operate, incoming };
}

test("incoming transfers sanitize names, preserve exact bytes, and never overwrite", async (t) => {
  const { workspace, incoming, operate } = await fixture(t);
  const bytes = Buffer.from([0, 255, 123, 13, 10]);
  const first = await incoming("../../nested\\document.pdf", bytes, {
    mimetype: "application/pdf", sender: "must-not-be-stored", caption: "must-not-be-stored"
  });
  const second = await incoming("document.pdf", "different");
  assert.notEqual(first.id, second.id);
  assert.equal(first.filename, "document.pdf");
  assert.equal(first.direction, "incoming");
  assert.equal(first.status, "received");
  assert.equal(first.mimetype, "application/pdf");
  assert.equal(first.size, bytes.length);
  assert.equal(first.sha256, crypto.createHash("sha256").update(bytes).digest("hex"));
  assert.deepEqual(await fs.readFile(path.join(workspace, first.relativePath)), bytes);
  const metadata = await fs.readFile(path.join(workspace, path.dirname(first.relativePath), ".manifest.json"), "utf8");
  assert.ok(!metadata.includes("must-not-be-stored"));
  assert.equal(await fs.readFile(path.join(workspace, ".whatsapp-relay", ".gitignore"), "utf8"), "*\n");
  assert.equal((await operate({ operation: "file.list" })).length, 2);
});

test("filename and MIME sanitization neutralizes Windows names and control data", async (t) => {
  const { incoming } = await fixture(t);
  for (const name of ["CON", "NUL.pdf", "LPT1.txt", ".env"]) {
    assert.match(sanitizeAttachmentFilename(name), /^attachment_/);
  }
  assert.equal(sanitizeAttachmentFilename("x:y\n.txt... "), "x_y_.txt");
  assert.equal(sanitizeAttachmentFilename(""), "attachment.bin");
  const stored = await incoming("picture.png", "pixels", { mimetype: "text/plain\r\nInjected: yes" });
  assert.equal(stored.mimetype, "image/png");
});

test("outgoing snapshots preserve what was prepared and record confirmed sends", async (t) => {
  const { workspace, operate } = await fixture(t);
  await fs.mkdir(path.join(workspace, "reports"));
  await fs.writeFile(path.join(workspace, "reports", "final report.txt"), "version one");
  const transfer = await operate({ operation: "file.readOutgoing", relativePath: "reports\\final report.txt" });
  assert.equal(Buffer.from(transfer.bufferBase64, "base64").toString(), "version one");
  assert.equal(transfer.status, "prepared");
  assert.equal(transfer.sourceRelativePath, "reports/final report.txt");
  await fs.writeFile(path.join(workspace, "reports", "final report.txt"), "version two");
  assert.equal(await fs.readFile(path.join(workspace, transfer.relativePath), "utf8"), "version one");
  assert.equal((await operate({ operation: "file.list" }))[0].status, "prepared");
  const sent = await operate({ operation: "file.markSent", id: transfer.id });
  assert.equal(sent.status, "sent");
  assert.ok(sent.sentAt);
  assert.deepEqual(await operate({ operation: "file.markSent", id: transfer.id }), sent);
  assert.equal((await operate({ operation: "file.list" }))[0].status, "sent");
});

test("incoming file paths can be explicitly sent back without mixing workspaces", async (t) => {
  const { root, incoming, operate } = await fixture(t);
  const stored = await incoming("hello.txt", "from workspace one");
  const result = await operate({ operation: "file.readOutgoing", relativePath: stored.relativePath });
  assert.equal(Buffer.from(result.bufferBase64, "base64").toString(), "from workspace one");
  const other = path.join(root, "other");
  await fs.mkdir(other);
  assert.deepEqual(await performFileOperation({ operation: "file.list", workspace: other }), []);
  await assert.rejects(performFileOperation({ operation: "file.readOutgoing", workspace: other, relativePath: stored.relativePath }), { code: "ENOENT" });
});

test("outgoing rejects traversal, absolute, UNC, devices, ADS and ambiguous paths", async (t) => {
  const { operate } = await fixture(t);
  for (const relativePath of [
    "../outside.txt", "nested/../../outside.txt", "C:\\secret.txt", "C:secret.txt", "/tmp/secret.txt",
    "\\\\server\\share\\file", "\\\\?\\C:\\file", "file.txt:secret", "NUL", "docs/COM1.txt", "docs/.. /file",
    "docs/./file", "docs//file", "file. ", "~/.ssh/id_rsa", "file\u0000.txt", "CONOUT$", "COM¹.txt"
  ]) {
    await assert.rejects(operate({ operation: "file.readOutgoing", relativePath }), { code: "ERR_RELAY_ATTACHMENT" }, relativePath);
  }
});

test("outgoing protects common credentials even when requested inside a workspace", async (t) => {
  const { operate } = await fixture(t);
  for (const relativePath of [".env", "nested/.env.production", ".ssh/config", ".codex/auth.json", ".git/config", "key.pem", "id_ed25519", "credentials.json", ".npmrc"]) {
    await assert.rejects(operate({ operation: "file.readOutgoing", relativePath }), /Credential and private configuration/);
  }
});

test("bounds reject oversized incoming, malformed base64, and outgoing data", async (t) => {
  const { workspace, incoming, operate } = await fixture(t);
  await assert.rejects(incoming("large.bin", "12345", { maxBytes: 4 }), /limit|bounded/);
  await assert.rejects(operate({ operation: "file.writeIncoming", filename: "x", bufferBase64: "!!!!" }), /base64/);
  await assert.rejects(operate({ operation: "file.writeIncoming", filename: "x", bufferBase64: "AA=A" }), /base64/);
  await fs.writeFile(path.join(workspace, "large.bin"), "12345");
  await assert.rejects(operate({ operation: "file.readOutgoing", relativePath: "large.bin", maxBytes: 4 }), /limit/);
  const atLimit = await incoming("exact.bin", "1234", { maxBytes: 4 });
  assert.equal(atLimit.size, 4);
  assert.equal((await incoming("empty.txt", "")).size, 0);
  assert.equal(attachmentByteLimit(), MAX_ATTACHMENT_BYTES);
  for (const limit of [0, -1, 1.5, Infinity, "25", MAX_ATTACHMENT_BYTES + 1]) {
    assert.throws(() => attachmentByteLimit(limit), /limit/);
  }
});

test("large base64 is decoded without a recursive regular expression", async (t) => {
  const { incoming } = await fixture(t);
  const stored = await incoming("large.bin", Buffer.alloc(2 * 1024 * 1024, 42));
  assert.equal(stored.size, 2 * 1024 * 1024);
});

test("all source and storage directory junctions are rejected", async (t) => {
  const { root, workspace, incoming, operate } = await fixture(t);
  const outside = path.join(root, "outside");
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, "private.txt"), "private");
  await fs.symlink(outside, path.join(workspace, "linked"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(operate({ operation: "file.readOutgoing", relativePath: "linked/private.txt" }), /Symlinks and junctions/);
  await fs.symlink(outside, path.join(workspace, ".whatsapp-relay"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(incoming("incoming.txt"), /Symlinks and junctions/);
  await assert.rejects(operate({ operation: "file.list" }), /Symlinks and junctions/);
  assert.deepEqual(await fs.readdir(outside), ["private.txt"]);
});

test("nested storage junctions and hard-linked source files are rejected", async (t) => {
  const { root, workspace, incoming, operate } = await fixture(t);
  const outside = path.join(root, "outside");
  await fs.mkdir(outside);
  await fs.mkdir(path.join(workspace, ".whatsapp-relay"));
  await fs.symlink(outside, path.join(workspace, ".whatsapp-relay", "inbox"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(incoming("incoming.txt"), /Symlinks and junctions/);
  await fs.writeFile(path.join(outside, "private.txt"), "private");
  await fs.link(path.join(outside, "private.txt"), path.join(workspace, "linked.txt"));
  await assert.rejects(operate({ operation: "file.readOutgoing", relativePath: "linked.txt" }), /hard links/);
});

test("unsafe ignore rules fail closed without rewriting user rules", async (t) => {
  const { workspace, incoming } = await fixture(t);
  await fs.mkdir(path.join(workspace, ".whatsapp-relay"));
  await fs.writeFile(path.join(workspace, ".whatsapp-relay", ".gitignore"), "custom-rules\n");
  await assert.rejects(incoming("private.pdf"), /gitignore/);
  assert.equal(await fs.readFile(path.join(workspace, ".whatsapp-relay", ".gitignore"), "utf8"), "custom-rules\n");
  await fs.writeFile(path.join(workspace, ".whatsapp-relay", ".gitignore"), "*\n!*\n");
  await assert.rejects(incoming("private.pdf"), /gitignore/);
});

test("corrupt and injected manifests cannot become recoverable download paths", async (t) => {
  const { workspace, incoming, operate } = await fixture(t);
  const transfer = await incoming("good.txt");
  const manifestPath = path.join(workspace, path.dirname(transfer.relativePath), ".manifest.json");
  await fs.writeFile(manifestPath, JSON.stringify({ ...transfer, relativePath: "../../outside.txt" }));
  assert.deepEqual(await operate({ operation: "file.list" }), []);
  await assert.rejects(operate({ operation: "file.markSent", id: "../../elsewhere" }), /identifier/);
});

test("list returns bounded valid records and omits missing payloads", async (t) => {
  const { workspace, incoming, operate } = await fixture(t);
  const transfer = await incoming("one.txt");
  await incoming("two.txt");
  await incoming("three.txt");
  assert.equal((await operate({ operation: "file.list", limit: 2 })).length, 2);
  await fs.unlink(path.join(workspace, transfer.relativePath));
  assert.equal((await operate({ operation: "file.list" })).length, 2);
  await assert.rejects(operate({ operation: "file.list", limit: 101 }), /List limit/);
});

test("public APIs dispatch a complete transfer lifecycle to the selected local host", async (t) => {
  const { workspace } = await fixture(t);
  const target = { host: { id: "host", transport: "local" }, workspace };
  const incoming = await saveIncomingAttachment({ ...target, filename: "hello.txt", mimetype: "text/plain", buffer: Buffer.from("hello") });
  const outgoing = await readOutgoingAttachment({ ...target, relativePath: incoming.relativePath });
  assert.deepEqual(outgoing.buffer, Buffer.from("hello"));
  assert.ok(!("bufferBase64" in outgoing));
  await markAttachmentSent({ ...target, id: outgoing.id });
  const records = await listStoredAttachments(target);
  assert.equal(records.length, 2);
  assert.equal(records.find((record) => record.id === outgoing.id).status, "sent");
  await assert.rejects(saveIncomingAttachment({ ...target, filename: "x", buffer: "not a Buffer" }), /Buffer/);
});

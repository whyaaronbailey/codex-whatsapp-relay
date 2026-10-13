import crypto from "node:crypto";
import { requestHostOperation } from "./controller-hosts.mjs";
import { attachmentByteLimit, DEFAULT_ATTACHMENT_MAX_BYTES, MAX_ATTACHMENT_BYTES } from "./relay-file-ops.mjs";

export { DEFAULT_ATTACHMENT_MAX_BYTES, MAX_ATTACHMENT_BYTES };

export async function saveIncomingAttachment({ host, workspace, filename, mimetype, buffer, maxBytes }) {
  const limit = attachmentByteLimit(maxBytes);
  if (!Buffer.isBuffer(buffer) || buffer.length > limit) {
    throw new Error(`Attachment must be a Buffer of at most ${limit} bytes.`);
  }
  return requestHostOperation(host, {
    operation: "file.writeIncoming", workspace, filename, mimetype,
    bufferBase64: buffer.toString("base64"), maxBytes: limit
  });
}

export async function readOutgoingAttachment({ host, workspace, relativePath, maxBytes }) {
  const limit = attachmentByteLimit(maxBytes);
  const result = await requestHostOperation(host, {
    operation: "file.readOutgoing", workspace, relativePath, maxBytes: limit
  });
  if (typeof result?.bufferBase64 !== "string" || result.bufferBase64.length > 4 * Math.ceil(limit / 3)) {
    throw new Error("Host returned an invalid or oversized attachment.");
  }
  const { bufferBase64, ...manifest } = result;
  const buffer = Buffer.from(bufferBase64, "base64");
  if (buffer.length > limit || buffer.length !== manifest.size) throw new Error("Host attachment size does not match its manifest.");
  if (crypto.createHash("sha256").update(buffer).digest("hex") !== manifest.sha256) {
    throw new Error("Host attachment hash does not match its manifest.");
  }
  return { ...manifest, buffer };
}

export async function markAttachmentSent({ host, workspace, id }) {
  return requestHostOperation(host, { operation: "file.markSent", workspace, id });
}

export async function listStoredAttachments({ host, workspace, limit = 20 }) {
  return requestHostOperation(host, { operation: "file.list", workspace, limit });
}

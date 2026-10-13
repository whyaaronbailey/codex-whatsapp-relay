import crypto from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

export const DEFAULT_ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;
export const MAX_ATTACHMENT_BYTES = DEFAULT_ATTACHMENT_MAX_BYTES;
const STORE = ".whatsapp-relay";
const MANIFEST = ".manifest.json";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DEVICE_NAME = /^(?:con|prn|aux|nul|conin\$|conout\$|clock\$|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/i;
const MIME_TYPES = {
  ".pdf": "application/pdf", ".txt": "text/plain", ".md": "text/markdown",
  ".csv": "text/csv", ".json": "application/json", ".png": "image/png",
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".webp": "image/webp", ".mp3": "audio/mpeg", ".ogg": "audio/ogg",
  ".wav": "audio/wav", ".mp4": "video/mp4", ".zip": "application/zip",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation"
};

function invalid(message) {
  const error = new Error(message);
  error.code = "ERR_RELAY_ATTACHMENT";
  error.retryable = false;
  return error;
}

export function attachmentByteLimit(value = DEFAULT_ATTACHMENT_MAX_BYTES) {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_ATTACHMENT_BYTES) {
    throw invalid(`Attachment limit must be between 1 and ${MAX_ATTACHMENT_BYTES} bytes.`);
  }
  return value;
}

export function sanitizeAttachmentFilename(value) {
  const basename = String(value ?? "attachment.bin").normalize("NFKC").split(/[/\\]/).pop();
  let filename = basename.replace(/[^a-zA-Z0-9._ -]/g, "_").replace(/\s+/g, " ")
    .replace(/[. ]+$/g, "").slice(0, 160).replace(/[. ]+$/g, "");
  if (!filename || /^\.+$/.test(filename)) filename = "attachment.bin";
  if (filename.startsWith(".") || DEVICE_NAME.test(filename)) filename = `attachment_${filename}`;
  return filename;
}

function cleanMime(value, filename) {
  const mime = String(value ?? "").trim().toLowerCase();
  return mime.length <= 127 && /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(mime)
    ? mime : MIME_TYPES[path.extname(filename).toLowerCase()] ?? "application/octet-stream";
}

function relativeParts(value) {
  if (typeof value !== "string" || value.length > 2048 || !value ||
      /[\x00-\x1f\x7f:<>"|?*]/.test(value) || /^[\\/]/.test(value) || value.startsWith("~")) {
    throw invalid("Use a relative file path inside the selected workspace.");
  }
  const parts = value.replace(/\\/g, "/").split("/");
  if (parts.some((part) => !part || part === "." || part === ".." ||
      /[. ]$/.test(part) || DEVICE_NAME.test(part))) {
    throw invalid("Unsafe file path: traversal, device names and ambiguous paths are not allowed.");
  }
  return parts;
}

function checkExportPath(parts) {
  // Do not turn /send into accidental credential/configuration exfiltration.
  const protectedDirs = new Set([".git", ".ssh", ".aws", ".azure", ".gnupg", ".kube", ".codex", ".config"]);
  const relayPrivateDirectory = parts.slice(0, -1).some((part) =>
    /^auth(?:$|[-_.])/i.test(part) || /^controller-outbox(?:$|\.)/i.test(part));
  const relayPrivateFile = /^(?:creds|store|runtime|controller(?:-[a-z-]+)?)\.json$|^controller\.log$|^(?:session|pre-key|sender-key|sender-key-memory|app-state-sync-key|app-state-sync-version|lid-mapping|device-list|tctoken)-.+\.json$/i;
  if (relayPrivateDirectory || relayPrivateFile.test(parts.at(-1)) ||
      parts.some((part) => protectedDirs.has(part.toLowerCase())) || parts.some((part) =>
    /^(?:\.env(?:\..*)?|\.npmrc|\.netrc|\.pypirc|auth\.json|credentials(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?|\.manifest\.json)$/i.test(part)
  ) || /\.(?:pem|key|p12|pfx|kdbx)$/i.test(parts.at(-1))) {
    throw invalid("Credential and private configuration files cannot be sent by the relay.");
  }
}

async function workspaceRoot(workspace) {
  if (typeof workspace !== "string" || !path.isAbsolute(workspace)) {
    throw invalid("The selected workspace must be an absolute path on its host.");
  }
  const root = await fs.realpath(workspace);
  if (!(await fs.stat(root)).isDirectory()) throw invalid("Workspace is not a directory.");
  return root;
}

function within(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

async function checkedPath(root, parts, { createDirectories = false } = {}) {
  let current = root;
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part);
    if (!within(root, current)) throw invalid("File path escapes the selected workspace.");
    if (createDirectories) {
      await fs.mkdir(current, { mode: 0o700 }).catch((error) => {
        if (error.code !== "EEXIST") throw error;
      });
    }
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink()) throw invalid("Symlinks and junctions are not permitted in attachment paths.");
    if ((createDirectories || index < parts.length - 1) && !stat.isDirectory()) {
      throw invalid("Attachment path contains a non-directory component.");
    }
    if (!within(root, await fs.realpath(current))) throw invalid("File path escapes the selected workspace.");
  }
  return current;
}

async function readBounded(root, parts, maxBytes) {
  const filename = await checkedPath(root, parts);
  if (!(await fs.lstat(filename)).isFile()) {
    throw invalid("Only regular files can be sent; directories are not attachments.");
  }
  const handle = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink > 1) throw invalid("Only regular files without hard links can be sent.");
    if (stat.size > maxBytes) throw invalid(`File exceeds the ${maxBytes}-byte attachment limit.`);
    const current = await fs.lstat(await checkedPath(root, parts));
    if (current.dev !== stat.dev || current.ino !== stat.ino) {
      throw invalid("Attachment path changed while opening the file.");
    }
    const chunks = [];
    let total = 0;
    while (true) {
      const chunk = Buffer.alloc(Math.min(64 * 1024, maxBytes + 1 - total));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (!bytesRead) break;
      total += bytesRead;
      if (total > maxBytes) throw invalid(`File exceeds the ${maxBytes}-byte attachment limit.`);
      chunks.push(chunk.subarray(0, bytesRead));
    }
    return Buffer.concat(chunks, total);
  } finally {
    await handle.close();
  }
}

async function durableWrite(filename, data) {
  const handle = await fs.open(filename, "wx", 0o600);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function decodeBuffer(value, maxBytes) {
  if (typeof value !== "string" || value.length > 4 * Math.ceil(maxBytes / 3) ||
      value.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(value)) {
    throw invalid("Attachment data is not bounded, valid base64.");
  }
  const buffer = Buffer.from(value, "base64");
  if (buffer.toString("base64") !== value) throw invalid("Attachment data is not valid base64.");
  if (buffer.length > maxBytes) throw invalid(`File exceeds the ${maxBytes}-byte attachment limit.`);
  return buffer;
}

async function storeSnapshot(root, { direction, buffer, filename, mimetype, sourceRelativePath }) {
  const id = crypto.randomUUID();
  const bucket = direction === "incoming" ? "inbox" : "outbox";
  const directoryParts = [STORE, bucket, id];
  await checkedPath(root, [STORE, bucket], { createDirectories: true });
  const ignorePath = path.join(root, STORE, ".gitignore");
  await durableWrite(ignorePath, "*\n").catch((error) => {
    if (error.code !== "EEXIST") throw error;
  });
  const ignore = await readBounded(root, [STORE, ".gitignore"], 16 * 1024);
  if (ignore.toString("utf8").trim() !== "*") {
    throw invalid("Attachment storage .gitignore must contain only '*' to ignore all transfer contents.");
  }
  const directory = path.join(root, ...directoryParts);
  await fs.mkdir(directory, { mode: 0o700 }); // A collision never reuses a previous transfer.
  const manifest = {
    schemaVersion: 1, id, direction, status: direction === "incoming" ? "received" : "prepared",
    filename, mimetype: cleanMime(mimetype, filename), size: buffer.length,
    sha256: crypto.createHash("sha256").update(buffer).digest("hex"),
    createdAt: new Date().toISOString(), relativePath: [...directoryParts, filename].join("/")
  };
  if (sourceRelativePath) manifest.sourceRelativePath = sourceRelativePath;
  await checkedPath(root, directoryParts);
  await durableWrite(path.join(directory, filename), buffer);
  await durableWrite(path.join(directory, MANIFEST), JSON.stringify(manifest, null, 2));
  return manifest;
}

async function readManifest(root, bucket, id) {
  if (!["inbox", "outbox"].includes(bucket) || !UUID.test(id)) throw invalid("Invalid attachment identifier.");
  const bytes = await readBounded(root, [STORE, bucket, id, MANIFEST], 16 * 1024);
  const raw = JSON.parse(bytes.toString("utf8"));
  const direction = bucket === "inbox" ? "incoming" : "outgoing";
  const filename = sanitizeAttachmentFilename(raw.filename);
  const relativePath = [STORE, bucket, id, filename].join("/");
  if (raw.schemaVersion !== 1 || raw.id !== id || raw.direction !== direction ||
      raw.filename !== filename || raw.relativePath !== relativePath ||
      !Number.isSafeInteger(raw.size) || raw.size < 0 || raw.size > MAX_ATTACHMENT_BYTES ||
      !/^[a-f0-9]{64}$/.test(raw.sha256) || !Number.isFinite(Date.parse(raw.createdAt)) ||
      !(direction === "incoming" ? ["received"] : ["prepared", "sent"]).includes(raw.status)) {
    throw invalid("Invalid attachment manifest.");
  }
  const manifest = {
    schemaVersion: 1, id, direction, status: raw.status, filename,
    mimetype: cleanMime(raw.mimetype, filename), size: raw.size, sha256: raw.sha256,
    createdAt: new Date(raw.createdAt).toISOString(), relativePath
  };
  if (direction === "outgoing" && raw.sourceRelativePath) {
    const source = relativeParts(raw.sourceRelativePath);
    checkExportPath(source);
    manifest.sourceRelativePath = source.join("/");
  }
  if (raw.status === "sent" && Number.isFinite(Date.parse(raw.sentAt))) {
    manifest.sentAt = new Date(raw.sentAt).toISOString();
  }
  return manifest;
}

export async function performFileOperation(request) {
  const root = await workspaceRoot(request.workspace);
  const maxBytes = attachmentByteLimit(request.maxBytes);
  switch (request.operation) {
    case "file.writeIncoming": {
      const buffer = decodeBuffer(request.bufferBase64, maxBytes);
      return storeSnapshot(root, {
        direction: "incoming", buffer, filename: sanitizeAttachmentFilename(request.filename), mimetype: request.mimetype
      });
    }
    case "file.readOutgoing": {
      const parts = relativeParts(request.relativePath);
      checkExportPath(parts);
      let buffer;
      try {
        buffer = await readBounded(root, parts, maxBytes);
      } catch (error) {
        // Retrying an explicitly requested missing file or directory cannot
        // deliver that command. Keep offline/network errors retryable.
        if (["ENOENT", "EISDIR"].includes(error.code)) error.retryable = false;
        throw error;
      }
      const manifest = await storeSnapshot(root, {
        direction: "outgoing", buffer, filename: sanitizeAttachmentFilename(parts.at(-1)), sourceRelativePath: parts.join("/")
      });
      return { ...manifest, bufferBase64: buffer.toString("base64") };
    }
    case "file.markSent": {
      const manifest = await readManifest(root, "outbox", request.id);
      if (manifest.status === "sent") return manifest;
      const updated = { ...manifest, status: "sent", sentAt: new Date().toISOString() };
      const directory = await checkedPath(root, [STORE, "outbox", request.id]);
      const temporary = path.join(directory, `.${crypto.randomUUID()}.tmp`);
      await durableWrite(temporary, JSON.stringify(updated, null, 2));
      await checkedPath(root, [STORE, "outbox", request.id, MANIFEST]);
      await fs.rename(temporary, path.join(directory, MANIFEST));
      return updated;
    }
    case "file.list": {
      const limit = request.limit ?? 20;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw invalid("List limit must be between 1 and 100.");
      const manifests = [];
      for (const bucket of ["inbox", "outbox"]) {
        let directory;
        try {
          directory = await checkedPath(root, [STORE, bucket]);
        } catch (error) {
          if (error.code === "ENOENT") continue;
          throw error;
        }
        const entries = await fs.opendir(directory);
        for await (const entry of entries) {
          if (!entry.isDirectory() || !UUID.test(entry.name)) continue;
          try {
            const manifest = await readManifest(root, bucket, entry.name);
            const stored = await checkedPath(root, relativeParts(manifest.relativePath));
            const stat = await fs.lstat(stored);
            if (!stat.isFile() || stat.size !== manifest.size || stat.nlink > 1) continue;
            manifests.push(manifest);
            manifests.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
            if (manifests.length > limit) manifests.pop();
          } catch {
            // Partial/corrupt transfers are never promoted into downloadable paths.
          }
        }
      }
      return manifests;
    }
    default:
      throw invalid("Unknown attachment operation.");
  }
}

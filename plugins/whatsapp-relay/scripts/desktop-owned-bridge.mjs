// Experimental desktop-owned broker. Never install/activate this implicitly.
// The real desktop owns the sole native initialize and every server request.
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { randomUUID, createHash, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";

export const BRIDGE_SCHEMA = "codex-desktop-owned-bridge-v1";
export const SECONDARY_FIELDS = Object.freeze({
  "thread/list": ["cursor", "limit", "sortKey", "sortDirection", "cwd", "sourceKinds", "archived", "useStateDbOnly", "searchTerm", "modelProviders"],
  "thread/loaded/list": ["cursor", "limit"],
  "thread/read": ["threadId", "includeTurns"],
  "thread/turns/list": ["threadId", "cursor", "limit", "itemsView", "sortDirection"],
  "thread/start": ["cwd", "model", "sandbox", "approvalPolicy", "experimentalRawEvents"],
  "thread/name/set": ["threadId", "name"],
  "thread/resume": ["threadId", "cwd", "model", "sandbox", "approvalPolicy", "config"],
  "mcpServerStatus/list": ["cursor", "detail", "limit", "serverName", "threadId"],
  "turn/start": ["threadId", "input"],
  "turn/steer": ["threadId", "input", "expectedTurnId"]
});
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const validId = value => typeof value === "string" ? value.length <= 1024 : Number.isSafeInteger(value);
const idKey = value => `${typeof value}:${JSON.stringify(value)}`;
const fail = message => Object.assign(new Error(message), { code: "ERR_DESKTOP_BRIDGE" });

export function isDesktopAppServerInvocation(args) {
  let index = 0;
  while (index < args.length) {
    const arg = args[index];
    if (["-c", "--config", "--enable", "--disable"].includes(arg)) { index += 2; continue; }
    if (arg.startsWith("--config=") || arg.startsWith("--enable=") || arg.startsWith("--disable=")) { index++; continue; }
    if (arg !== "app-server") return false;
    index++;
    while (index < args.length) {
      const option = args[index++];
      if (["-c", "--config", "--enable", "--disable"].includes(option)) { if (index >= args.length) return false; index++; continue; }
      if (option.startsWith("--config=") || option.startsWith("--enable=") || option.startsWith("--disable=")) continue;
      if (!["--analytics-default-enabled", "--strict-config", "--stdio"].includes(option)) return false;
    }
    return true;
  }
  return false;
}

export function validateBridgeConfig(value) {
  if (!object(value) || value.schema !== BRIDGE_SCHEMA) throw fail("Invalid bridge configuration schema.");
  const allowed = ["schema", "realCliPath", "nodePath", "bridgePath", "port", "tokenFile", "statusFile", "maxMessageBytes", "maxQueueBytes", "maxPending", "maxSecondaryPending", "shutdownGraceMs"];
  if (Object.keys(value).some(key => !allowed.includes(key))) throw fail("Unknown bridge configuration field.");
  for (const key of ["realCliPath", "nodePath", "bridgePath", "tokenFile", "statusFile"]) {
    if (typeof value[key] !== "string" || !path.isAbsolute(value[key]) || /[\x00-\x1f]/.test(value[key])) throw fail(`Bridge ${key} must be an absolute path.`);
  }
  if (!Number.isInteger(value.port) || value.port < 1024 || value.port > 65535) throw fail("Bridge port must be a fixed unprivileged port.");
  const result = { maxMessageBytes: 16 * 1024 * 1024, maxQueueBytes: 32 * 1024 * 1024, maxPending: 2048, maxSecondaryPending: 32, shutdownGraceMs: 10000, ...value };
  for (const [key, low, high] of [["maxMessageBytes", 1024, 64 * 1024 * 1024], ["maxQueueBytes", 1024, 128 * 1024 * 1024], ["maxPending", 1, 10000], ["maxSecondaryPending", 1, 256], ["shutdownGraceMs", 10, 60000]]) {
    if (!Number.isInteger(result[key]) || result[key] < low || result[key] > high) throw fail(`Invalid bridge ${key}.`);
  }
  if (result.maxQueueBytes < result.maxMessageBytes) throw fail("Bridge queue must fit one maximum-size message.");
  return result;
}

function parseFrame(raw, maximum) {
  const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
  if (bytes.length > maximum) throw fail("Bridge message size limit exceeded.");
  // Fatal UTF-8 decoding prevents silent replacement of a message's contents.
  const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  if (!object(parsed)) throw fail("Bridge only accepts individual JSON-RPC objects.");
  if (own(parsed, "id") && !validId(parsed.id)) throw fail("Invalid JSON-RPC request ID.");
  return parsed;
}

export async function* readJsonLines(stream, maximum) {
  let chunks = [], size = 0;
  for await (const chunk of stream) {
    const bytes = Buffer.from(chunk);
    let offset = 0;
    for (;;) {
      const newline = bytes.indexOf(10, offset);
      const part = bytes.subarray(offset, newline < 0 ? bytes.length : newline);
      size += part.length;
      if (size > maximum) throw fail("Bridge JSONL line size limit exceeded.");
      if (part.length) chunks.push(part);
      if (newline < 0) break;
      const line = Buffer.concat(chunks, size);
      chunks = []; size = 0;
      if (line.length && !(line.length === 1 && line[0] === 13)) yield parseFrame(line, maximum);
      offset = newline + 1;
    }
  }
  if (size) throw fail("Desktop/native JSONL ended with an incomplete frame.");
}

class BoundedWriter {
  constructor(stream, maximum) { this.stream = stream; this.maximum = maximum; this.bytes = 0; this.tail = Promise.resolve(); this.closed = false; this.aborted = false; this.aborters = new Set(); }
  write(message) {
    const data = Buffer.isBuffer(message) ? message : Buffer.from(`${JSON.stringify(message)}\n`);
    if (this.closed || this.bytes + data.length > this.maximum) return Promise.reject(fail("Bridge output queue unavailable or full."));
    this.bytes += data.length;
    const task = this.tail.then(() => new Promise((resolve, reject) => {
      if (this.aborted || this.stream.destroyed || this.stream.writableEnded) { reject(fail("Bridge output closed.")); return; }
      const cancel = () => reject(fail("Bridge output closed before its write outcome was known."));
      this.aborters.add(cancel);
      this.stream.write(data, error => { this.aborters.delete(cancel); error ? reject(fail("Bridge output write failed.")) : resolve(); });
    }));
    this.tail = task.catch(() => {});
    return task.finally(() => { this.bytes -= data.length; });
  }
  async end() { if (this.closed) return; this.closed = true; await this.tail; if (!this.stream.destroyed && !this.stream.writableEnded) this.stream.end(); }
  closeHandle() { this.closed = true; this.aborted = true; for (const cancel of this.aborters) cancel(); this.aborters.clear(); this.stream.destroy(); }
}

function secondaryParams(method, params) {
  if (!own(SECONDARY_FIELDS, method) || !object(params) || Object.keys(params).some(key => !SECONDARY_FIELDS[method].includes(key))) throw fail("Secondary method or parameters are not permitted.");
  if (method !== "thread/start" && !["thread/list", "thread/loaded/list", "mcpServerStatus/list"].includes(method) && (typeof params.threadId !== "string" || !params.threadId || params.threadId.length > 512)) throw fail("A threadId is required.");
  if (own(params, "config") && (!object(params.config) || Object.keys(params.config).some(key => key !== "model_reasoning_effort"))) throw fail("Only recorded reasoning effort may be restored.");
  if (own(params, "experimentalRawEvents") && params.experimentalRawEvents !== false) throw fail("Raw native events are not exposed.");
  if (method.startsWith("turn/")) {
    if (!Array.isArray(params.input) || !params.input.length || params.input.some(item => !object(item) || item.type !== "text" || typeof item.text !== "string" || Object.keys(item).some(key => !["type", "text"].includes(key)))) throw fail("Secondary turns require plain text input.");
  }
  return params;
}

/** No private desktop context is read, reconstructed or logged. The child simply
 * inherits its parent's existing environment. All outbound mutations stay in
 * the gateway's durable ledger; this broker never retries a request. */
export async function startDesktopBridge(configValue, nativeArgs, {
  input = process.stdin, output = process.stdout, errors = process.stderr,
  env = process.env, cwd = process.cwd(), spawnImpl = spawn,
  configPath = null, onStatus = () => {}
} = {}) {
  const config = validateBridgeConfig(configValue);
  if (!isDesktopAppServerInvocation(nativeArgs)) throw fail("Bridge requires an ordinary stdio app-server invocation.");
  const tokenBytes = fs.readFileSync(config.tokenFile);
  const tokenText = tokenBytes.toString("utf8");
  if (!/^[A-Za-z0-9_-]{64}(?:\r?\n)?$/.test(tokenText)) throw fail("Bridge capability token file is invalid.");
  const tokenHash = createHash("sha256").update(tokenText.trimEnd()).digest();
  const instanceId = randomUUID();
  let child, state = "starting", primaryReady = false, nativeInitResult, nativeExperimental = false;
  let primaryInitialized = false, shuttingDown = false, counter = 0, childEnded = false, fatalCode = null, shutdownTimer, statusHealthy = true, primaryUnavailable = false;
  let initializeRequestSeen = false, initializeRequestForwarded = false, initializeReplyForwarded = false;
  let initializeErrorSeen = false, initializeErrorForwarded = false;
  let postInitializePrimaryRequestSeen = false, postInitializePrimarySuccessSeen = false;
  const clients = new Set(), pending = new Map(), desktopIds = new Set(), serverRequests = new Map(), serverDesktopIds = new Map(), completedServerRequests = new Map(), canceledServerIds = new Set();
  const primaryWriter = new BoundedWriter(output, config.maxQueueBytes);
  const stderrWriter = new BoundedWriter(errors, config.maxQueueBytes);
  let nativeWriter;
  const health = () => {
    const ready = primaryReady && statusHealthy && !shuttingDown;
    return { schema: "codex-desktop-stdio-health-v1", instanceId, bridgePid: process.pid, backendPid: child?.pid ?? null, primaryReady: ready, state: statusHealthy ? state : "status_unavailable",
      initializeRequestSeen, initializeRequestForwarded, initializeResultSeen: nativeInitResult !== undefined, initializeReplyForwarded,
      initializeErrorSeen, initializeErrorForwarded,
      initializedNotificationSeen: primaryInitialized, postInitializePrimaryRequestSeen, postInitializePrimarySuccessSeen,
      readyBasis: ready ? (primaryInitialized ? "initialized_notification" : "desktop_followup_response") : null };
  };
  function status() {
    statusHealthy = true;
    const value = { ...health(), parentPid: process.ppid, shimPid: process.ppid, execPath: process.execPath, scriptPath: fileURLToPath(import.meta.url), configPath, recordedAt: new Date().toISOString() };
    try {
      onStatus(value);
      const temporary = `${config.statusFile}.${instanceId}.tmp`;
      fs.writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
      fs.renameSync(temporary, config.statusFile);
    } catch { statusHealthy = false; }
  }
  function updateReadiness() {
    // Some real desktop versions omit initialized. Observe their successful
    // follow-up RPC instead; never synthesize initialization or test requests.
    if (!shuttingDown) {
      primaryReady = initializeReplyForwarded && nativeInitResult !== undefined && (primaryInitialized || postInitializePrimarySuccessSeen);
      state = primaryReady ? "ready" : "starting";
    }
    status();
  }
  const server = http.createServer((request, response) => {
    let url;
    try { url = new URL(request.url, "http://127.0.0.1"); } catch { response.writeHead(400); response.end(); return; }
    if (request.method !== "GET" || url.pathname !== "/health" || request.headers.origin) { response.writeHead(404); response.end(); return; }
    const challenge = url.searchParams.get("challenge");
    if (challenge !== null && !/^[a-f0-9]{32}$/.test(challenge)) { response.writeHead(400); response.end(); return; }
    response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(JSON.stringify({ ...health(), ...(challenge ? { challenge } : {}) }));
  });
  const websocketServer = new WebSocketServer({ noServer: true, maxPayload: config.maxMessageBytes, perMessageDeflate: false });
  server.on("upgrade", (request, socket, head) => {
    const authorization = request.headers.authorization;
    const candidate = typeof authorization === "string" && authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
    const authorized = timingSafeEqual(createHash("sha256").update(candidate).digest(), tokenHash);
    if (request.url !== "/" || request.headers.origin || !authorized || shuttingDown || !health().primaryReady || clients.size >= 32) { socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"); return; }
    websocketServer.handleUpgrade(request, socket, head, ws => websocketServer.emit("connection", ws));
  });
  function closeClient(client) {
    if (client.closed) return;
    client.closed = true; clients.delete(client); client.ws.close(1008, "Broker connection closed");
    // This closes only the broker's own network socket, never a process.
    const timer = setTimeout(() => { if (client.ws.readyState !== WebSocket.CLOSED) client.ws.terminate(); }, 1000);
    timer.unref?.();
    client.ws.once("close", () => clearTimeout(timer));
  }
  function sendClient(client, message) {
    if (client.closed) return;
    const data = JSON.stringify(message);
    if (Buffer.byteLength(data) > config.maxMessageBytes || client.ws.bufferedAmount + Buffer.byteLength(data) > config.maxQueueBytes) { closeClient(client); return; }
    client.ws.send(data, error => { if (error) closeClient(client); });
  }
  function rejectClient(client, id, message, code = -32600) { sendClient(client, { id, error: { code, message } }); }
  async function upstream(message, client = null) {
    if (shuttingDown || (client && !health().primaryReady)) throw fail("Bridge is not ready; request was not admitted.");
    const ids = client ? client.ids : desktopIds;
    const key = idKey(message.id);
    if (ids.has(key) || pending.size >= config.maxPending || (client && ids.size >= config.maxSecondaryPending)) throw fail("Duplicate request ID or in-flight limit reached.");
    const id = `bridge:${instanceId}:${++counter}`;
    ids.add(key);
    // Eligibility is captured when the desktop request arrives, not when its
    // response arrives: a pre-initialization request must never unlock access.
    const postInitializePrimary = !client && message.method !== "initialize" && initializeReplyForwarded;
    const record = { client, id: message.id, key, method: message.method, postInitializePrimary };
    pending.set(id, record);
    if (!client && message.method === "initialize") {
      nativeExperimental = message.params?.capabilities?.experimentalApi === true;
      if (!initializeRequestSeen) { initializeRequestSeen = true; status(); }
    }
    if (postInitializePrimary && !postInitializePrimaryRequestSeen) { postInitializePrimaryRequestSeen = true; status(); }
    // Keep this tombstone even if a socket vanishes after the write. No replay.
    try {
      await nativeWriter.write({ ...message, id });
      if (!client && message.method === "initialize" && !initializeRequestForwarded) { initializeRequestForwarded = true; status(); }
    }
    catch { throw Object.assign(fail("Native write outcome is uncertain."), { deliveryUncertain: true }); }
  }
  async function desktopFrame(message) {
    if (typeof message.method === "string") {
      if (own(message, "id")) await upstream(message);
      else {
        await nativeWriter.write(message);
        if (message.method === "initialized" && initializeRequestForwarded && !primaryInitialized) { primaryInitialized = true; updateReadiness(); }
      }
    } else if (own(message, "id") && (own(message, "result") || own(message, "error"))) {
      const key = idKey(message.id);
      const request = serverDesktopIds.get(key);
      if (!request) { if (canceledServerIds.has(key)) return; throw fail("Desktop response did not match a native server request."); }
      serverDesktopIds.delete(key); serverRequests.delete(idKey(request.nativeId));
      completedServerRequests.set(idKey(request.nativeId), request);
      if (completedServerRequests.size > config.maxPending) completedServerRequests.delete(completedServerRequests.keys().next().value);
      await nativeWriter.write({ ...message, id: request.nativeId });
    } else throw fail("Invalid desktop JSON-RPC frame.");
  }
  async function toDesktop(message) {
    if (primaryUnavailable) return false;
    try { await primaryWriter.write(message); return true; } catch (error) { if (!shuttingDown) throw error; return false; }
  }
  async function backendFrame(message) {
    if (typeof message.method === "string") {
      if (own(message, "id")) {
        const key = idKey(message.id);
        if (serverRequests.has(key) || serverRequests.size >= config.maxPending) throw fail("Invalid native server request state.");
        const desktopId = `server:${instanceId}:${++counter}`;
        const request = { nativeId: message.id, desktopId };
        completedServerRequests.delete(key); // A reused native ID now belongs to this request.
        serverRequests.set(key, request); serverDesktopIds.set(idKey(desktopId), request);
        await toDesktop({ ...message, id: desktopId });
        return;
      }
      if (message.method === "serverRequest/resolved" && validId(message.params?.requestId)) {
        const nativeKey = idKey(message.params.requestId);
        const request = serverRequests.get(nativeKey) ?? completedServerRequests.get(nativeKey);
        if (request) {
          serverRequests.delete(idKey(request.nativeId)); serverDesktopIds.delete(idKey(request.desktopId));
          completedServerRequests.delete(nativeKey);
          canceledServerIds.add(idKey(request.desktopId));
          if (canceledServerIds.size > config.maxPending) canceledServerIds.delete(canceledServerIds.values().next().value);
          message = { ...message, params: { ...message.params, requestId: request.desktopId } };
        }
      }
      await toDesktop(message);
      const threadId = message.params?.threadId ?? message.params?.thread_id ?? message.params?.thread?.id;
      if (typeof threadId === "string" && /^(thread|turn|item)\//.test(message.method)) {
        for (const client of clients) if (client.initialized && client.threads.has(threadId)) sendClient(client, message);
      }
      return;
    }
    if (!own(message, "id") || (!own(message, "result") && !own(message, "error"))) throw fail("Invalid native JSON-RPC response.");
    const record = pending.get(message.id);
    if (!record) throw fail("Native response ID is not owned by this broker.");
    pending.delete(message.id);
    (record.client ? record.client.ids : desktopIds).delete(record.key);
    const restored = { ...message, id: record.id };
    if (!record.client) {
      const succeeded = own(message, "result") && !own(message, "error");
      if (record.method === "initialize" && own(message, "error") && !initializeErrorSeen) { initializeErrorSeen = true; status(); }
      if (record.method === "initialize" && succeeded && object(message.result) && nativeInitResult === undefined) {
        nativeInitResult = message.result;
        status();
      }
      const forwarded = await toDesktop(restored);
      if (forwarded && !shuttingDown) {
        if (record.method === "initialize" && own(message, "error") && !initializeErrorForwarded) { initializeErrorForwarded = true; status(); }
        if (record.method === "initialize" && succeeded && object(message.result) && !initializeReplyForwarded) {
          initializeReplyForwarded = true;
          updateReadiness();
        } else if (record.postInitializePrimary && succeeded && !postInitializePrimarySuccessSeen) {
          postInitializePrimarySuccessSeen = true;
          updateReadiness();
        }
      }
    } else {
      const threadId = message.result?.thread?.id;
      if (typeof threadId === "string") record.client.threads.add(threadId);
      sendClient(record.client, restored);
    }
  }
  async function secondaryFrame(client, message) {
    // An error carrying a reused ID could falsely reject the original mutation.
    if (own(message, "id") && client.ids.has(idKey(message.id))) { closeClient(client); return; }
    if (typeof message.method !== "string") { closeClient(client); return; } // No native server responses from a secondary.
    if (message.method === "initialized" && !own(message, "id")) {
      if (!client.initializeReplied || client.initialized) { closeClient(client); return; }
      client.initialized = true; return;
    }
    if (!own(message, "id")) { closeClient(client); return; }
    if (message.method === "initialize") {
      const params = message.params;
      const caps = params?.capabilities ?? {};
      if (client.initializeReplied || !primaryReady || !object(params) || !object(params.clientInfo) || typeof params.clientInfo.name !== "string" || !object(caps) || Object.keys(params).some(key => !["clientInfo", "capabilities"].includes(key)) || Object.keys(caps).some(key => key !== "experimentalApi") || (caps.experimentalApi === true && !nativeExperimental)) {
        rejectClient(client, message.id, "Secondary initialization or capabilities rejected."); return;
      }
      client.initializeReplied = true;
      sendClient(client, { id: message.id, result: nativeInitResult }); return;
    }
    if (!client.initialized) { rejectClient(client, message.id, "Initialize this secondary connection first.", -32002); return; }
    try {
      secondaryParams(message.method, message.params ?? {});
      if (typeof message.params?.threadId === "string") {
        if (client.threads.size >= 4096 && !client.threads.has(message.params.threadId)) throw fail("Secondary thread subscription limit reached.");
        client.threads.add(message.params.threadId);
      }
      await upstream(message, client);
    } catch (error) {
      if (error.deliveryUncertain) { closeClient(client); fatal("backend_input_failed"); }
      else rejectClient(client, message.id, "Secondary request rejected before submission.");
    }
  }
  websocketServer.on("connection", ws => {
    const client = { ws, ids: new Set(), threads: new Set(), initialized: false, initializeReplied: false, closed: false, tail: Promise.resolve(), queued: 0 };
    clients.add(client);
    ws.on("error", () => closeClient(client));
    ws.on("close", () => { client.closed = true; clients.delete(client); });
    ws.on("message", (raw, binary) => {
      if (binary || client.closed) { closeClient(client); return; }
      client.queued += raw.length;
      if (client.queued > config.maxQueueBytes) { closeClient(client); return; }
      client.tail = client.tail.then(async () => { if (!client.closed) await secondaryFrame(client, parseFrame(raw, config.maxMessageBytes)); }).catch(() => closeClient(client)).finally(() => { client.queued -= raw.length; });
    });
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(config.port, "127.0.0.1", resolve); });
  // Bind before spawning: an occupied port never causes a second backend launch.
  try {
    child = spawnImpl(config.realCliPath, nativeArgs, { cwd, env, stdio: ["pipe", "pipe", "pipe"], shell: false, windowsHide: true });
    if (!child?.pid || !child.stdin || !child.stdout || !child.stderr) throw fail("Native backend did not start.");
    nativeWriter = new BoundedWriter(child.stdin, config.maxQueueBytes);
    child.stdin.on("error", () => stop("backend_input_failed"));
    status();
  } catch (error) { server.close(); websocketServer.close(); throw error; }
  let resolveCompletion;
  const completion = new Promise(resolve => { resolveCompletion = resolve; });
  async function stop(reason = "desktop_eof") {
    if (shuttingDown) return;
    shuttingDown = true; primaryReady = false; state = reason; status();
    for (const client of [...clients]) closeClient(client);
    // No cancellation, forced termination, replacement process or resend.
    if (!childEnded) {
      shutdownTimer = setTimeout(() => {
        // Close our own pipe handles if backpressure prevents EOF. This never
        // signals or kills the backend; unanswered writes remain uncertain.
        nativeWriter.closeHandle();
        if (primaryWriter.bytes) { primaryUnavailable = true; primaryWriter.closeHandle(); }
        if (!childEnded) { state = "backend_exit_unverified"; status(); }
      }, config.shutdownGraceMs);
      shutdownTimer.unref?.();
    }
    await nativeWriter.end();
  }
  function fatal(reason) { fatalCode ??= reason; void stop(reason).catch(() => {}); }
  child.on("error", () => fatal("backend_process_error"));
  const stdoutTask = (async () => { try { for await (const message of readJsonLines(child.stdout, config.maxMessageBytes)) await backendFrame(message); } catch { fatal("backend_protocol_failed"); } })();
  const stderrTask = (async () => { try { for await (const bytes of child.stderr) await stderrWriter.write(Buffer.from(bytes)); } catch { fatal("backend_stderr_failed"); } })();
  child.on("close", async code => {
    childEnded = true; primaryReady = false;
    if (!shuttingDown) {
      shuttingDown = true; for (const client of [...clients]) closeClient(client);
      shutdownTimer = setTimeout(() => { primaryUnavailable = true; primaryWriter.closeHandle(); }, config.shutdownGraceMs);
      shutdownTimer.unref?.();
    }
    input.destroy?.();
    await Promise.allSettled([stdoutTask, stderrTask]);
    clearTimeout(shutdownTimer);
    state = fatalCode ? "failed" : "stopped"; status();
    websocketServer.close(); server.close(); server.closeAllConnections?.();
    resolveCompletion({ exitCode: code ?? 1, state, pendingRequests: pending.size });
  });
  void (async () => { try { for await (const message of readJsonLines(input, config.maxMessageBytes)) await desktopFrame(message); await stop(); } catch { fatal("desktop_protocol_failed"); } })();
  return { health, completion, stop, address: server.address(), child, server };
}

async function main() {
  const [flag, filename, delimiter, ...args] = process.argv.slice(2);
  if (flag !== "--config" || !path.isAbsolute(filename ?? "") || delimiter !== "--") throw fail("Usage: desktop-owned-bridge --config ABSOLUTE_JSON -- NATIVE_ARGS");
  const config = JSON.parse(fs.readFileSync(filename, "utf8"));
  const bridge = await startDesktopBridge(config, args, { configPath: filename });
  const result = await bridge.completion;
  process.exitCode = result.state === "stopped" ? result.exitCode : 1;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(() => { process.stderr.write("Desktop bridge failed; inspect its sanitized status. No backend was force-stopped.\n"); process.exitCode = 1; });

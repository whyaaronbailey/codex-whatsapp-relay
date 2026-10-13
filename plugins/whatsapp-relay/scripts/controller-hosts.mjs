import { spawn } from "node:child_process";
import path from "node:path";
import { spawnNativeCodex } from "./codex-process.mjs";

export const MAX_WORKER_MESSAGE_BYTES = 40 * 1024 * 1024;
const HOST_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const SSH_TARGET = /^[a-zA-Z0-9_][a-zA-Z0-9_.@:\[\]-]*$/;
const NODE_COMMAND = /^[a-zA-Z0-9_./\\ :+-]+$/;
const FILE_OPERATIONS = new Set(["file.writeIncoming", "file.readOutgoing", "file.list", "file.markSent"]);
const CLASSIFICATION_OPERATIONS = new Set(["codex.classifyVoice", "codex.classifyProject"]);

function normalizeHost(host) {
  if (!host || typeof host !== "object" || !HOST_ID.test(host.id ?? "")) {
    throw new Error("Each host requires an id containing lowercase letters, numbers, underscores or hyphens.");
  }
  const transport = host.transport ?? "local";
  if (!["local", "ssh"].includes(transport)) {
    throw new Error(`Unsupported transport for host ${host.id}: ${transport}`);
  }
  const platform = host.platform === "windows" ? "win32" : host.platform === "posix" ? "linux" :
    host.platform ?? (transport === "local" ? process.platform : "linux");
  if (!["win32", "linux", "darwin"].includes(platform)) {
    throw new Error(`Unsupported platform for host ${host.id}.`);
  }
  const normalized = { id: host.id, transport, platform };
  if (host.label) normalized.label = String(host.label);
  if (host.codexBin) normalized.codexBin = String(host.codexBin);
  if (transport === "ssh") {
    if (!SSH_TARGET.test(host.target ?? "")) {
      throw new Error(`Host ${host.id} requires a configured SSH target (an alias or user@hostname).`);
    }
    const workerPath = String(host.workerPath ?? "");
    const paths = platform === "win32" ? path.win32 : path.posix;
    if (!paths.isAbsolute(workerPath) || /[\0\r\n]/.test(workerPath)) {
      throw new Error(`Host ${host.id} requires an absolute workerPath on that host.`);
    }
    const nodeBin = String(host.nodeBin ?? "node");
    if (!NODE_COMMAND.test(nodeBin) || nodeBin.startsWith("-")) {
      throw new Error(`Host ${host.id} nodeBin must be an executable name or path without shell syntax.`);
    }
    Object.assign(normalized, { target: host.target, workerPath, nodeBin });
  }
  return normalized;
}

export function normalizeHosts(config = {}) {
  if (config.hosts !== undefined && !Array.isArray(config.hosts)) {
    throw new Error("hosts must be an array.");
  }
  const raw = config.hosts ?? [];
  const hosts = raw.map(normalizeHost);
  const ids = new Set();
  for (const host of hosts) {
    if (ids.has(host.id)) throw new Error(`Duplicate host id: ${host.id}`);
    ids.add(host.id);
  }
  if (!ids.has("host")) hosts.unshift(normalizeHost({ id: "host", transport: "local" }));
  return hosts;
}

export const normalizeConfiguredHosts = normalizeHosts;

export function resolveHost(config = {}, hostId = "host") {
  const host = normalizeHosts(config).find((item) => item.id === hostId);
  if (!host) throw new Error(`Unknown host: ${hostId}`);
  return host;
}

// SSH necessarily invokes the configured remote login shell. Only this fixed
// launcher and validated local configuration enter its command string. All
// workspaces, prompts, filenames and payload bytes travel over standard input.
export function buildSshWorkerArgs(host) {
  const normalized = normalizeHost(host);
  if (normalized.transport !== "ssh") throw new Error("Expected an SSH host.");
  const bootstrap = `import('node:url').then(({pathToFileURL})=>import(pathToFileURL(${JSON.stringify(normalized.workerPath)}).href)).then(m=>m.runWorker()).catch(e=>{process.stderr.write(String(e.message)+'\\n');process.exitCode=1})`;
  const encoded = Buffer.from(bootstrap).toString("base64");
  const expression = `eval(Buffer.from('${encoded}','base64').toString())`;
  // Windows OpenSSH can use cmd or PowerShell as its login shell. An encoded
  // PowerShell bootstrap works with either, including paths containing spaces.
  const powershell = `$ErrorActionPreference='Stop'; [Console]::InputEncoding=[Text.UTF8Encoding]::new($false); [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); $OutputEncoding=[Console]::OutputEncoding; & '${normalized.nodeBin}' -e '${expression.replaceAll("'", "''")}'; exit $LASTEXITCODE`;
  const command = normalized.platform === "win32"
    ? `powershell.exe -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(powershell, "utf16le").toString("base64")}`
    : `'${normalized.nodeBin}' -e "${expression}"`;
  return ["-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", "--", normalized.target, command];
}

function writeWorkerRequest(child, request, { end = false } = {}) {
  const line = `${JSON.stringify(request)}\n`;
  if (Buffer.byteLength(line) > MAX_WORKER_MESSAGE_BYTES) {
    child.kill();
    throw new Error("Worker request exceeds the relay transport size limit.");
  }
  // An early SSH disconnect can close stdin before the caller observes close.
  child.stdin.on("error", () => {});
  if (end) child.stdin.end(line);
  else child.stdin.write(line);
}

export function spawnHostAppServer({ host = null, codexBin = "codex", workspace, args }, { spawnImpl = spawn } = {}) {
  const resolved = host ? normalizeHost(host) : resolveHost();
  if (resolved.transport === "local") {
    return spawnNativeCodex(resolved.codexBin ?? codexBin, args, {
      cwd: workspace,
      stdio: ["pipe", "pipe", "pipe"]
    }, spawnImpl);
  }
  const child = spawnImpl("ssh", buildSshWorkerArgs(resolved), {
    stdio: ["pipe", "pipe", "pipe"], shell: false, windowsHide: true
  });
  writeWorkerRequest(child, { operation: "codex.appServer", workspace, codexBin: resolved.codexBin ?? "codex", args });
  return child;
}

export async function performHostOperation(request) {
  if (FILE_OPERATIONS.has(request?.operation)) {
    const { performFileOperation } = await import("./relay-file-ops.mjs");
    return performFileOperation(request);
  }
  if (CLASSIFICATION_OPERATIONS.has(request?.operation)) {
    const runner = await import("./codex-runner.mjs");
    const { operation, host: _ignored, ...params } = request;
    return operation === "codex.classifyVoice" ? runner.classifyVoiceCommandIntent(params) : runner.classifyProjectIntent(params);
  }
  throw new Error(`Unsupported worker operation: ${request?.operation}`);
}

export async function requestHostOperation(host, request, { timeoutMs = 60_000, spawnImpl = spawn } = {}) {
  const resolved = host ? normalizeHost(host) : resolveHost();
  if (!FILE_OPERATIONS.has(request?.operation) && !CLASSIFICATION_OPERATIONS.has(request?.operation)) {
    throw new Error(`Unsupported worker operation: ${request?.operation}`);
  }
  const operationRequest = CLASSIFICATION_OPERATIONS.has(request.operation)
    ? { ...request, codexBin: resolved.codexBin ?? (resolved.transport === "local" ? request.codexBin : "codex") }
    : request;
  if (resolved.transport === "local") return performHostOperation(operationRequest);
  return new Promise((resolve, reject) => {
    const child = spawnImpl("ssh", buildSshWorkerArgs(resolved), {
      stdio: ["pipe", "pipe", "pipe"], shell: false, windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    let bytes = 0;
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(new Error(`Host ${resolved.id} operation timed out after ${timeoutMs}ms.`));
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > MAX_WORKER_MESSAGE_BYTES) {
        child.kill();
        finish(new Error("Worker response exceeds the relay transport size limit."));
      } else stdout += chunk;
    });
    child.stderr.on("data", (chunk) => { stderr = (stderr + chunk.toString("utf8")).slice(-8192); });
    child.once("error", (error) => finish(error));
    child.once("close", (code, signal) => {
      if (settled) return;
      let response;
      try { response = JSON.parse(stdout); }
      catch { finish(new Error(stderr.trim() || `Host ${resolved.id} returned invalid worker output (exit ${code}, signal ${signal ?? "none"}).`)); return; }
      if (response.error) {
        const error = new Error(String(response.error));
        if (typeof response.code === "string") error.code = response.code;
        if (typeof response.retryable === "boolean") error.retryable = response.retryable;
        finish(error);
      }
      else if (code !== 0) finish(new Error(stderr.trim() || `Host ${resolved.id} worker exited with code ${code}.`));
      else if (!Object.hasOwn(response, "result")) finish(new Error("Worker response is missing a result."));
      else finish(null, response.result);
    });
    try { writeWorkerRequest(child, operationRequest, { end: true }); }
    catch (error) { finish(error); }
  });
}

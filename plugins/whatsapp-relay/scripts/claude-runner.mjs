import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { normalizePermissionLevel } from "./controller-permissions.mjs";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const MAX_LINE_BYTES = 8 * 1024 * 1024;
const METADATA_BYTES = 256 * 1024;
const MAX_PROJECT_DIRECTORIES = 2000;
const MAX_INDEX_ENTRIES = 20000;
const MAX_METADATA_READS = 1000;

// Use the installed CLI and its normal user/project configuration. In
// particular, do not pass --bare, --safe-mode, or --strict-mcp-config: those
// would discard the user's existing hooks, instructions, and memory tools.
export function resolveClaudeLaunch(claudeBin = "claude", {
  platform = process.platform, env = process.env, execPath = process.execPath,
  fileExists = fs.existsSync
} = {}) {
  const bin = String(claudeBin || "claude");
  if (/\.(?:mjs|cjs|js)$/i.test(bin)) return { command: execPath, argsPrefix: [bin] };
  if (platform !== "win32") return { command: bin, argsPrefix: [] };
  const directories = /[\\/]/.test(bin) ? [""] :
    (Object.entries(env).find(([key]) => key.toLowerCase() === "path")?.[1] ?? "").split(";").filter(Boolean);
  const candidates = path.win32.extname(bin) ? [bin] : [`${bin}.exe`, `${bin}.cmd`, bin];
  let resolved = bin;
  outer: for (const directory of directories) {
    for (const candidate of candidates) {
      const full = directory ? path.win32.join(directory, candidate) : candidate;
      if (fileExists(full)) { resolved = full; break outer; }
    }
  }
  if (/\.(?:cmd|bat)$/i.test(resolved)) {
    const launcher = path.win32.join(path.win32.dirname(resolved), "node_modules", "@anthropic-ai", "claude-code", "cli.js");
    if (/^claude\.(?:cmd|bat)$/i.test(path.win32.basename(resolved)) && fileExists(launcher)) {
      return { command: execPath, argsPrefix: [launcher] };
    }
    throw new Error("Cannot safely launch this Windows command shim. Set claudeBin to claude.exe or @anthropic-ai/claude-code/cli.js.");
  }
  return { command: resolved, argsPrefix: [] };
}

function normalizedWorkspace(workspace) {
  if (typeof workspace !== "string" || !path.isAbsolute(workspace)) {
    throw new Error("Claude Code requires an absolute workspace on the selected host.");
  }
  const normalized = path.normalize(workspace);
  return normalized.length > path.parse(normalized).root.length ? normalized.replace(/[\\/]+$/, "") : normalized;
}

function equalWorkspace(a, b) {
  if (typeof a !== "string" || !path.isAbsolute(a)) return false;
  const left = normalizedWorkspace(a);
  return process.platform === "win32" ? left.toLowerCase() === b.toLowerCase() : left === b;
}

function configRoot(claudeConfigDir) {
  return path.resolve(claudeConfigDir || process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"));
}

function projectDirectories(workspace, claudeConfigDir, scope = "workspace") {
  const projects = path.join(configRoot(claudeConfigDir), "projects");
  // Claude's filesystem slug is not unique (a_b and a-b collide). Verify cwd
  // inside every transcript too, including on resume, rather than trusting it.
  const slug = workspace.replace(/[^a-zA-Z0-9]/g, "-");
  let directory;
  try { directory = fs.opendirSync(projects); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
  const matches = [];
  let scanned = 0;
  try {
    for (let entry; (entry = directory.readSync()) !== null;) {
      if (++scanned > MAX_INDEX_ENTRIES) throw new Error("Claude session index exceeds the entry scan limit.");
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      if (scope !== "host" && !(process.platform === "win32"
        ? entry.name.toLowerCase() === slug.toLowerCase() : entry.name === slug)) continue;
      matches.push(path.join(projects, entry.name));
      if (matches.length > MAX_PROJECT_DIRECTORIES) throw new Error("Claude session index exceeds the project scan limit. Use workspace scope.");
    }
  } finally { directory.closeSync(); }
  return matches;
}

function parseLines(text, { trimStart = false, trimEnd = false } = {}) {
  const lines = text.split("\n");
  if (trimStart) lines.shift();
  if (trimEnd) lines.pop();
  return lines.flatMap(line => {
    try { const record = JSON.parse(line); return record && typeof record === "object" ? [record] : []; }
    catch { return []; }
  });
}

function textBlocks(content) {
  if (typeof content === "string") return content;
  return Array.isArray(content) ? content.filter(block => block?.type === "text" && typeof block.text === "string").map(block => block.text).join("\n") : "";
}

function sessionMetadata(file, workspace, id) {
  let fd;
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || !stat.size) return null;
    fd = fs.openSync(file, "r");
    const head = Buffer.alloc(Math.min(METADATA_BYTES, stat.size));
    const headLength = fs.readSync(fd, head, 0, head.length, 0);
    const records = parseLines(head.subarray(0, headLength).toString("utf8"), { trimEnd: stat.size > headLength });
    if (stat.size > headLength) {
      const tail = Buffer.alloc(Math.min(METADATA_BYTES, stat.size - headLength));
      const start = stat.size - tail.length;
      const count = fs.readSync(fd, tail, 0, tail.length, start);
      records.push(...parseLines(tail.subarray(0, count).toString("utf8"), { trimStart: true }));
    }
    const native = records.filter(record => record.sessionId === id && !record.isSidechain);
    const cwdRecord = native.find(record => typeof record.cwd === "string");
    if (!cwdRecord || /[\x00-\x1f\x7f]/.test(cwdRecord.cwd) || !path.isAbsolute(cwdRecord.cwd) ||
        (process.platform === "win32" && !/^(?:[a-z]:\\|\\\\[^\\]+\\[^\\]+\\)/i.test(path.normalize(cwdRecord.cwd))) ||
        (workspace !== null && !equalWorkspace(cwdRecord.cwd, workspace))) return null;
    const title = native.findLast(record => record.type === "custom-title")?.customTitle ||
      native.findLast(record => record.type === "ai-title")?.aiTitle;
    const user = native.find(record => record.type === "user" && !record.isMeta);
    return {
      id, name: typeof title === "string" ? title.slice(0, 500) : null,
      preview: textBlocks(user?.message?.content).slice(0, 1000), cwd: cwdRecord.cwd,
      createdAt: Math.floor((Date.parse(cwdRecord.timestamp) || stat.birthtimeMs) / 1000),
      updatedAt: Math.floor(stat.mtimeMs / 1000)
    };
  } catch (error) {
    if (["ENOENT", "EACCES", "EPERM"].includes(error.code)) return null;
    throw error;
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}

// Bounded reads of native transcripts avoid another SDK/CLI installation and
// do not start a model request, rewrite history, or create a second memory DB.
export async function listClaudeThreads({ workspace, scope = "workspace", limit = 20, claudeConfigDir } = {}) {
  if (!["workspace", "host"].includes(scope)) throw new Error("Claude session scope must be workspace or host.");
  const cwd = normalizedWorkspace(workspace);
  const resultLimit = Math.max(1, Math.min(200, Math.trunc(Number(limit)) || 20));
  const candidates = [];
  let scanned = 0;
  for (const directory of projectDirectories(cwd, claudeConfigDir, scope)) {
    const index = fs.opendirSync(directory);
    try {
      for (let entry; (entry = index.readSync()) !== null;) {
        if (++scanned > MAX_INDEX_ENTRIES) throw new Error("Claude session index exceeds the entry scan limit. Use workspace scope.");
        const id = entry.name.replace(/\.jsonl$/, "");
        if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith(".jsonl") || !UUID.test(id)) continue;
        const file = path.join(directory, entry.name);
        try {
          const stat = fs.lstatSync(file);
          if (stat.isFile() && !stat.isSymbolicLink()) candidates.push({ file, id, updated: stat.mtimeMs });
        } catch (error) { if (!["ENOENT", "EACCES", "EPERM"].includes(error.code)) throw error; }
      }
    } finally { index.closeSync(); }
  }
  candidates.sort((a, b) => b.updated - a.updated || a.id.localeCompare(b.id));
  const sessions = [];
  const ids = new Set();
  for (let index = 0; index < candidates.length; index++) {
    if (index >= MAX_METADATA_READS) throw new Error("Claude session discovery exceeded its metadata read limit. Use workspace scope.");
    const { file, id } = candidates[index];
    if (ids.has(id)) continue;
    const metadata = sessionMetadata(file, scope === "host" ? null : cwd, id);
    if (!metadata) continue;
    ids.add(id);
    sessions.push(metadata);
    if (sessions.length === resultLimit) break;
  }
  return sessions;
}

function validateResume(threadId, workspace, claudeConfigDir) {
  if (!UUID.test(threadId)) throw new Error("Claude Code session ID must be a UUID from /sessions.");
  if (!projectDirectories(workspace, claudeConfigDir).some(directory =>
    sessionMetadata(path.join(directory, `${threadId}.jsonl`), workspace, threadId))) {
    throw new Error("Claude Code session was not found in this workspace. Select it from /sessions in its original project.");
  }
}

export function startClaudeTurn({
  claudeBin = "claude", workspace, prompt, threadId = null, threadName = null,
  model = null, permissionLevel = "native", onLifecycleEvent = null,
  claudeConfigDir, signal, spawnProcess = spawn,
  startupTimeoutMs = 120_000, shutdownTimeoutMs = 5_000
} = {}) {
  if (typeof prompt !== "string" || !prompt.trim()) throw new Error("Claude Code prompt cannot be empty.");
  const cwd = normalizedWorkspace(workspace);
  const level = permissionLevel === "native" ? "native" : normalizePermissionLevel(permissionLevel);
  if (!["native", "read-only", "workspace-write"].includes(level)) {
    throw new Error("Claude Code supports native, read-only (plan), and workspace-write (acceptEdits) modes in this relay. Permission bypass is not supported.");
  }
  if (signal?.aborted) throw new Error("Claude Code run was interrupted before startup.");
  if (threadId) validateResume(threadId, cwd, claudeConfigDir);
  const sessionId = threadId || randomUUID();
  const turnId = randomUUID();
  const args = ["--print", "--output-format", "stream-json", "--verbose",
    "--permission-prompts", "none", threadId ? "--resume" : "--session-id", sessionId];
  // These are Claude's native modes, not Codex's OS sandbox policies. Leave
  // the user's chosen baseline intact unless the project explicitly opts in.
  if (level !== "native") args.push("--permission-mode", level === "read-only" ? "plan" : "acceptEdits");
  if (model) args.push("--model", String(model));
  if (threadName?.trim()) args.push("--name", threadName.trim());
  const env = claudeConfigDir ? { ...process.env, CLAUDE_CONFIG_DIR: configRoot(claudeConfigDir) } : process.env;
  const launch = resolveClaudeLaunch(claudeBin, { env });
  const child = spawnProcess(launch.command, [...launch.argsPrefix, ...args], {
    cwd, env, stdio: ["pipe", "pipe", "pipe"], shell: false,
    windowsHide: true, detached: process.platform !== "win32"
  });
  const decoder = new StringDecoder("utf8");
  let buffer = "", stderr = "", result = null, protocolError = null, assistantFailure = null;
  let started = false, settled = false, stopping = false, closed = false;
  let startupTimer, completionTimer, forceTimer;
  let resolveResult, rejectResult, resolveClosed;
  const resultPromise = new Promise((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
  const closedPromise = new Promise(resolve => { resolveClosed = resolve; });

  const emit = event => { try { onLifecycleEvent?.(event); } catch (error) { fail(error); } };
  function settle(error, value) {
    if (settled) return;
    settled = true;
    clearTimeout(startupTimer); clearTimeout(completionTimer); clearTimeout(forceTimer);
    signal?.removeEventListener("abort", abort);
    if (error) {
      // Initialization or a native result confirms a resumable identity; a
      // launch failure alone does not establish that a transcript was created.
      if (threadId || started || result) error.threadId = sessionId;
      rejectResult(error);
    } else resolveResult(value);
  }
  function killTree(force = false) {
    if (closed || !child.pid) return;
    if (process.platform === "win32") {
      // Kill only this owned process tree, including tools started by Claude.
      const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", shell: false, windowsHide: true });
      killer.on("error", () => child.kill("SIGKILL"));
    } else {
      try { process.kill(-child.pid, force ? "SIGKILL" : "SIGTERM"); }
      catch { child.kill(force ? "SIGKILL" : "SIGTERM"); }
    }
  }
  function fail(error) {
    if (protocolError || settled) return;
    protocolError = error instanceof Error ? error : new Error(String(error));
    killTree();
    forceTimer = setTimeout(() => { killTree(true); settle(protocolError); }, shutdownTimeoutMs);
  }
  function observe(record) {
    if (!record || typeof record !== "object" || Array.isArray(record) || typeof record.type !== "string") {
      throw new Error("Claude Code emitted malformed structured output.");
    }
    if (record.parent_tool_use_id) return; // Subagent output is not the user's final answer.
    if (record.session_id && record.session_id !== sessionId) throw new Error("Claude Code returned a different session ID.");
    if (record.type === "system" && record.subtype === "init") {
      if (!started) { started = true; clearTimeout(startupTimer); emit({ type: "turnStarted", turnId, threadId: sessionId }); }
    } else if (record.type === "assistant") {
      const text = textBlocks(record.message?.content);
      if (record.isApiErrorMessage === true || typeof record.error === "string") {
        assistantFailure = { text, code: typeof record.error === "string" ? record.error : null };
      }
      if (text) emit({ type: "agentMessageCompleted", turnId, threadId: sessionId,
        itemId: record.message?.id || record.uuid || randomUUID(), phase: "commentary", text });
    } else if (record.type === "result") {
      if (result) throw new Error("Claude Code emitted more than one result.");
      if (record.session_id !== sessionId || typeof record.is_error !== "boolean" || typeof record.subtype !== "string") {
        throw new Error("Claude Code emitted an invalid result envelope.");
      }
      if (!record.is_error && record.subtype === "success" && typeof record.result !== "string") {
        throw new Error("Claude Code result is missing its response text.");
      }
      result = record;
      clearTimeout(startupTimer);
      completionTimer = setTimeout(() => fail(new Error("Claude Code did not exit after its final result.")), shutdownTimeoutMs);
    }
  }
  function consume(text, final = false) {
    buffer += text;
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
      if (Buffer.byteLength(line) > MAX_LINE_BYTES) throw new Error("Claude Code output exceeded the structured message size limit.");
      if (line.trim()) { try { observe(JSON.parse(line)); } catch (error) { if (error instanceof SyntaxError) throw new Error("Claude Code emitted invalid JSON."); throw error; } }
    }
    if (Buffer.byteLength(buffer) > MAX_LINE_BYTES) throw new Error("Claude Code output exceeded the structured message size limit.");
    if (final && buffer.trim()) { const remaining = buffer; buffer = ""; consume(`${remaining}\n`); }
  }
  function abort() { void interrupt(); }
  async function interrupt() {
    if (settled) return;
    stopping = true;
    const error = new Error("Claude Code run was interrupted.");
    error.code = "INTERRUPTED";
    fail(error);
    await Promise.race([closedPromise, resultPromise.catch(() => {})]);
  }
  child.stdout.on("data", chunk => { if (!protocolError) { try { consume(decoder.write(chunk)); } catch (error) { fail(error); } } });
  child.stderr.on("data", chunk => { stderr = (stderr + chunk.toString("utf8")).slice(-64 * 1024); });
  child.stdin.on("error", error => { if (error.code !== "EPIPE") fail(error); });
  child.once("error", error => { protocolError = error; settle(error); resolveClosed(); });
  child.once("close", (code, exitSignal) => {
    closed = true; resolveClosed();
    try { if (!protocolError) consume(decoder.end(), true); } catch (error) { protocolError = error; }
    if (protocolError) { settle(protocolError); return; }
    const denialNotice = Array.isArray(result?.permission_denials) && result.permission_denials.length
      ? "\n\nSome actions were denied by Claude Code permissions. Approve them in native Claude Code or configure narrow permission rules there, then retry. WhatsApp approval replies are not supported for Claude Code yet." : "";
    // Native failures often deliberately exit 1 with the useful explanation
    // only on stdout in the result/assistant envelope (not stderr). Preserve it
    // instead of masking expired credentials as an unhelpful exit-code error.
    if (result && (result.is_error || result.subtype !== "success")) {
      const detail = (Array.isArray(result.errors) ? result.errors.filter(value => typeof value === "string").join("\n") : "") || result.result || assistantFailure?.text || `Claude Code run failed (${result.subtype}).`;
      const error = new Error(detail + denialNotice);
      if (assistantFailure?.code) error.code = assistantFailure.code;
      settle(error); return;
    }
    if (code !== 0) {
      const error = new Error(assistantFailure?.text || stderr.trim() || `Claude Code exited with ${exitSignal ? `signal ${exitSignal}` : `code ${code}`}.`);
      if (assistantFailure?.code) error.code = assistantFailure.code;
      settle(error); return;
    }
    if (!result) { settle(new Error("Claude Code exited without a structured result.")); return; }
    const replyText = (result.result.trim() || "Claude Code completed without a final message.") + denialNotice;
    emit({ type: "turnCompleted", turnId, threadId: sessionId, status: stopping ? "interrupted" : "completed" });
    settle(protocolError, { threadId: sessionId, replyText });
  });
  startupTimer = setTimeout(() => fail(new Error("Claude Code did not initialize within the startup timeout.")), startupTimeoutMs);
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  // Prompts go through stdin, not shell syntax or command-line option parsing.
  child.stdin.end(prompt);
  return { child, resultPromise, interrupt, answerApproval: async () => {
    throw new Error("Claude Code headless approvals are not supported by this relay. Use native Claude Code permissions and retry.");
  } };
}

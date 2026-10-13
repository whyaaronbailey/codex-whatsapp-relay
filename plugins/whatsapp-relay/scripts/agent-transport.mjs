import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { buildSshWorkerArgs, MAX_WORKER_MESSAGE_BYTES } from "./controller-hosts.mjs";
import { serializableAgentOptions } from "./agent-runner.mjs";

function errorFromWire(value) {
  const error = new Error(value?.message ?? String(value ?? "Remote coding tool failed."));
  if (value?.code) error.code = value.code;
  if (value?.retryable !== undefined) error.retryable = value.retryable;
  return error;
}

export function wireError(error) {
  return { message: String(error?.message ?? error), ...(error?.code ? { code: error.code } : {}), ...(typeof error?.retryable === "boolean" ? { retryable: error.retryable } : {}) };
}

function writeLine(stream, value) {
  const line = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(line) > MAX_WORKER_MESSAGE_BYTES) throw new Error("Agent worker message exceeds the transport limit.");
  stream.write(line);
}

export function startRemoteAgentTurn(options, { spawnImpl = spawn, idleTimeoutMs = 45_000, controlTimeoutMs = 15_000 } = {}) {
  const child = spawnImpl("ssh", buildSshWorkerArgs(options.host), { stdio: ["pipe", "pipe", "pipe"], shell: false, windowsHide: true });
  let buffer = "";
  let stderr = "";
  let finalResult;
  let hasResult = false;
  let finished = false;
  let nextId = 0;
  let resolveResult;
  let rejectResult;
  let idleTimer;
  let killTimer;
  let childClosed = false;
  const pending = new Map();
  const resultPromise = new Promise((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
  // Transport errors can arrive before the controller installs its observer.
  resultPromise.catch(() => {});
  const finish = (error) => {
    if (finished) return;
    finished = true;
    clearTimeout(idleTimer);
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(error ?? new Error("The run has finished.")); }
    pending.clear();
    child.stdin.end();
    if (error) {
      child.kill();
      if (!childClosed) {
        killTimer = setTimeout(() => { if (!childClosed) child.kill("SIGKILL"); }, 2000);
        killTimer.unref?.();
      }
      rejectResult(error);
    }
    else resolveResult(finalResult);
  };
  const heartbeat = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => finish(new Error(`The worker on ${options.host.id} stopped responding. Check the native session before resending.`)), idleTimeoutMs);
    idleTimer.unref?.();
  };
  const dispatch = (message) => {
    if (finished) return;
    heartbeat();
    if (message.type === "heartbeat" || message.type === "ready") return;
    if (message.type === "controlResult") {
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) entry.reject(errorFromWire(message.error));
      else entry.resolve(message.result);
      return;
    }
    if (message.type === "result") {
      if (hasResult || !message.result || typeof message.result.threadId !== "string" || !message.result.threadId || typeof message.result.replyText !== "string") {
        finish(new Error("Invalid or duplicate agent worker result."));
        return;
      }
      hasResult = true; finalResult = message.result; return;
    }
    if (message.type === "error") { finish(errorFromWire(message.error)); return; }
    const handler = message.type === "lifecycle" ? options.onLifecycleEvent : message.type === "approval" ? options.onApprovalRequest : message.type === "approvalResolved" ? options.onApprovalResolved : null;
    if (!handler) {
      if (!["lifecycle", "approval", "approvalResolved"].includes(message.type)) finish(new Error("Unknown agent worker event."));
      return;
    }
    Promise.resolve().then(() => handler(message.event)).catch((error) => finish(error));
  };
  child.stdin.on("error", (error) => { if (!hasResult) finish(error); });
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    if (Buffer.byteLength(buffer) > MAX_WORKER_MESSAGE_BYTES) { finish(new Error("Agent worker output exceeds the transport limit.")); return; }
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      try { dispatch(JSON.parse(line)); }
      catch { finish(new Error("Invalid agent worker response.")); return; }
    }
  });
  child.stderr.on("data", (chunk) => { stderr = (stderr + chunk.toString("utf8")).slice(-4096); });
  child.once("error", finish);
  child.once("close", (code) => {
    childClosed = true;
    clearTimeout(killTimer);
    if (finished) return;
    if (code !== 0 || !hasResult || buffer.trim()) finish(new Error(stderr.trim() || "The remote worker disconnected before confirming the result. Check the native session before resending."));
    else finish();
  });
  heartbeat();
  try { writeLine(child.stdin, { operation: "agent.run", params: serializableAgentOptions(options) }); }
  catch (error) { finish(error); }
  const control = (command, value) => {
    if (finished) return Promise.reject(new Error("The run has finished."));
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Remote ${command} was not confirmed. Check the native session before resending.`));
      }, controlTimeoutMs);
      timer.unref?.();
      pending.set(id, { resolve, reject, timer });
      try { writeLine(child.stdin, { id, command, value }); }
      catch (error) { clearTimeout(timer); pending.delete(id); reject(error); }
    });
  };
  return { child, resultPromise, interrupt: () => control("interrupt"), answerApproval: (requestId, decision) => control("approval", { requestId, decision }) };
}

export async function runAgentWorker(request, remainder, { input, output, startTurn, heartbeatMs = 10_000, controlTimeoutMs = 15_000 }) {
  const params = request?.params;
  if (!params || !["opencode", "claude"].includes(params.engine) || typeof params.workspace !== "string" || typeof params.prompt !== "string") throw new Error("Invalid agent worker request.");
  let run;
  let done = false;
  const decoder = new StringDecoder("utf8");
  let buffer = decoder.write(remainder);
  let commandQueue = Promise.resolve();
  let stopPromise = null;
  let rejectDisconnect;
  const disconnected = new Promise((_, reject) => { rejectDisconnect = reject; });
  disconnected.catch(() => {});
  const send = (message) => writeLine(output, message);
  const boundedControl = async (action) => {
    let timer;
    try {
      return await Promise.race([
        Promise.resolve().then(action),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Worker control operation timed out.")), controlTimeoutMs); })
      ]);
    } finally { clearTimeout(timer); }
  };
  const stop = () => stopPromise ??= (async () => {
    let timer;
    try {
      await Promise.race([
        Promise.resolve().then(() => run?.interrupt()),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Worker interruption timed out.")), 15_000); })
      ]);
    } catch { /* The native session may need attention after transport loss. */ }
    finally { clearTimeout(timer); run?.child?.kill?.(); }
  })();
  const drain = () => {
    if (Buffer.byteLength(buffer) > MAX_WORKER_MESSAGE_BYTES) { void stop(); input.destroy(new Error("Agent control message too large.")); return; }
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      commandQueue = commandQueue.then(async () => {
        let command;
        try {
          command = JSON.parse(line);
          if (!Number.isSafeInteger(command.id)) throw new Error("Invalid control request id.");
          let result;
          if (command.command === "interrupt") result = await boundedControl(() => run.interrupt());
          else if (command.command === "approval") result = await boundedControl(() => run.answerApproval(command.value?.requestId, command.value?.decision));
          else throw new Error("Unknown agent control command.");
          send({ type: "controlResult", id: command.id, result: result ?? null });
        } catch (error) {
          try { send({ type: "controlResult", id: command?.id ?? null, error: wireError(error) }); }
          catch { onDisconnect(); }
        }
      });
    }
  };
  const onData = (chunk) => { buffer += decoder.write(chunk); drain(); };
  const onDisconnect = () => {
    if (!done) {
      rejectDisconnect(new Error("Gateway disconnected; the worker is interrupting its owned run."));
      void stop();
    }
  };
  input.on("data", onData);
  input.once("end", onDisconnect);
  input.once("error", onDisconnect);
  output.once("error", onDisconnect);
  const signalHandlers = ["SIGTERM", "SIGINT", "SIGHUP"];
  for (const signal of signalHandlers) process.on(signal, onDisconnect);
  const timer = setInterval(() => { try { send({ type: "heartbeat" }); } catch { onDisconnect(); } }, heartbeatMs);
  timer.unref?.();
  try {
    run = startTurn({ ...params, host: null, onLifecycleEvent: (event) => send({ type: "lifecycle", event }), onApprovalRequest: (event) => send({ type: "approval", event }), onApprovalResolved: (event) => send({ type: "approvalResolved", event }) });
    send({ type: "ready" });
    drain();
    input.resume();
    const result = await Promise.race([run.resultPromise, disconnected]);
    done = true;
    await commandQueue.catch(() => {});
    send({ type: "result", result });
  } catch (error) {
    done = true;
    await stop();
    await commandQueue.catch(() => {});
    try { send({ type: "error", error: wireError(error) }); } catch { /* Disconnected gateway cannot receive a final error. */ }
  } finally {
    clearInterval(timer);
    input.off("data", onData);
    input.off("end", onDisconnect);
    input.off("error", onDisconnect);
    output.off("error", onDisconnect);
    for (const signal of signalHandlers) process.off(signal, onDisconnect);
    input.destroy();
  }
}

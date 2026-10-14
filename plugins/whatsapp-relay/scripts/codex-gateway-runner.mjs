import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { normalizeCodexGateway } from "./codex-gateway-config.mjs";

const WORKER = fileURLToPath(new URL("./codex-gateway-worker.py", import.meta.url));
const MAX_LINE_BYTES = 8 * 1024 * 1024;
const REQUEST_FIELDS = ["requestId", "workspace", "scope", "limit", "threadId", "prompt", "threadName", "model", "permissionLevel"];

function wireError(value, requestId) {
  const error = new Error(value?.message ?? "Codex gateway failed.");
  for (const key of ["code", "retryable", "promptSubmitted", "deliveryUncertain", "stage", "requestId"]) {
    if (value?.[key] !== undefined) error[key] = value[key];
  }
  error.requestId ??= requestId;
  return error;
}

export function gatewayRequest(method, options, { spawnImpl = spawn, idleTimeoutMs = 45_000 } = {}) {
  const gateway = normalizeCodexGateway(options.codexGateway ?? options.host?.codexGateway);
  if (!gateway) throw new Error("No shared Codex gateway is configured.");
  const params = Object.fromEntries(REQUEST_FIELDS.filter(key => options[key] !== undefined).map(key => [key, options[key]]));
  const mutating = ["send_prompt", "create_session"].includes(method);
  if (mutating && (typeof params.requestId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{4,95}$/.test(params.requestId))) {
    throw new Error("A stable requestId is required before submitting a gateway message.");
  }
  const child = spawnImpl(gateway.pythonBin, ["-B", "-u", WORKER, "--config", gateway.configPath], {
    stdio: ["pipe", "pipe", "pipe"], shell: false, windowsHide: true
  });
  let buffer = "", stderr = "", terminal = null, submitted = false, finished = false, timer;
  let resolve, reject;
  const resultPromise = new Promise((yes, no) => { resolve = yes; reject = no; });
  resultPromise.catch(() => {});
  const uncertain = message => Object.assign(new Error(message), {
    code: mutating && submitted ? "ERR_CODEX_GATEWAY_UNCERTAIN" : "ERR_CODEX_GATEWAY_UNAVAILABLE",
    retryable: false, requestId: params.requestId,
    ...(mutating && submitted ? { deliveryUncertain: true } : { promptSubmitted: false })
  });
  const finish = (error, result) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    // EOF asks the observer to unwind its durable lock contexts. A hard kill
    // would leave request locks behind even though Codex itself keeps running.
    child.stdin.end();
    if (error) { child.unref?.(); reject(error); } else resolve(result);
  };
  const resetTimeout = () => {
    clearTimeout(timer);
    timer = setTimeout(() => finish(uncertain("The gateway stopped responding. Check the saved request before resending.")), idleTimeoutMs);
    timer.unref?.();
  };
  const dispatch = message => {
    if (finished) return;
    if (!message || message.id !== 1 || terminal) throw new Error("Unexpected gateway response.");
    resetTimeout();
    if (message.type === "heartbeat") return;
    if (message.type === "event") {
      if (!message.event || typeof message.event.type !== "string") throw new Error("Invalid gateway lifecycle event.");
      Promise.resolve(options.onLifecycleEvent?.(message.event)).catch(error => finish(uncertain(error.message)));
      return;
    }
    if (message.type === "error") {
      terminal = { error: wireError(message.error, params.requestId) };
      return;
    }
    if (message.type === "result") {
      if (mutating && (!message.result || typeof message.result.threadId !== "string" || !message.result.threadId || typeof message.result.replyText !== "string")) {
        throw new Error("Invalid gateway result.");
      }
      if (method === "list_sessions" && !Array.isArray(message.result)) throw new Error("Invalid gateway session list.");
      terminal = { result: message.result };
      return;
    }
    throw new Error("Unknown gateway event.");
  };
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", chunk => {
    if (finished) return;
    buffer += chunk;
    if (Buffer.byteLength(buffer) > MAX_LINE_BYTES) { finish(uncertain("Gateway output exceeds its size limit.")); return; }
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
      if (!line.trim()) continue;
      try { dispatch(JSON.parse(line)); }
      catch { finish(uncertain("Invalid gateway output. Reconcile the saved request before resending.")); return; }
    }
  });
  child.stderr.on("data", chunk => { stderr = (stderr + chunk.toString("utf8")).slice(-4096); });
  child.stdin.on("error", () => finish(uncertain("The gateway connection closed before confirmation.")));
  child.once("error", error => {
    // An OS spawn failure means the worker never accepted the request.
    finish(Object.assign(new Error(`Could not launch the gateway Python executable: ${error.code ?? "spawn failed"}.`), {
      code: "ERR_CODEX_GATEWAY_UNAVAILABLE", promptSubmitted: false, retryable: false, requestId: params.requestId
    }));
  });
  child.once("close", code => {
    if (terminal?.error && !buffer.trim()) finish(terminal.error);
    else if (code === 0 && terminal && !buffer.trim()) finish(null, terminal.result);
    else finish(uncertain("The gateway exited without a confirmed result. Check its installation and the saved request."));
  });
  resetTimeout();
  try {
    submitted = true;
    child.stdin.write(`${JSON.stringify({ id: 1, method, params })}\n`);
  } catch { finish(uncertain("Could not write the gateway request.")); }
  const unsupported = action => Promise.reject(Object.assign(new Error(
    `${action} for a shared desktop session must be handled in Codex. The session has not been stopped or changed.`
  ), { code: "ERR_CODEX_GATEWAY_NATIVE_CONTROL", retryable: false, requestId: params.requestId }));
  return { child, resultPromise, interrupt: () => unsupported("Stopping"), answerApproval: () => unsupported("Approval"),
    detach: () => finish(uncertain("Gateway observation stopped; Codex may still be working. Reconcile the saved request.")) };
}

export function listGatewayThreads(options, dependencies) {
  return gatewayRequest("list_sessions", options, dependencies).resultPromise;
}

export function readGatewayRequestStatusLocal(options, dependencies) {
  return gatewayRequest("status", options, dependencies).resultPromise;
}

export function startGatewayTurn(options, dependencies) {
  return gatewayRequest(options.threadId ? "send_prompt" : "create_session", options, dependencies);
}

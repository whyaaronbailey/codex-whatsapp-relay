import * as codex from "./codex-runner.mjs";
import { listOpenCodeThreads, startOpenCodeTurn } from "./opencode-runner.mjs";
import { listClaudeThreads, startClaudeTurn } from "./claude-runner.mjs";
import { requestHostOperation } from "./controller-hosts.mjs";
import { startRemoteAgentTurn } from "./agent-transport.mjs";
import { listGatewayThreads, startGatewayTurn, readGatewayRequestStatusLocal } from "./codex-gateway-runner.mjs";

export const classifyVoiceCommandIntent = codex.classifyVoiceCommandIntent;
export const classifyProjectIntent = codex.classifyProjectIntent;
export const normalizeVoiceCommandIntent = codex.normalizeVoiceCommandIntent;

export function agentEngine(options = {}) {
  const engine = options.engine ?? "codex";
  if (!["codex", "opencode", "claude"].includes(engine)) throw new Error(`Unsupported coding engine: ${engine}`);
  return engine;
}

// Only configuration needed by a provider crosses the SSH boundary. Never send
// the gateway's process environment, WhatsApp identity, or credentials to a VM.
export function serializableAgentOptions(options = {}) {
  const fields = ["engine", "workspace", "scope", "prompt", "threadId", "threadName", "requestId", "model", "profile", "search", "permissionLevel", "limit", "codexBin", "claudeBin", "opencodeUrl", "opencodeApiVersion", "opencodeUsernameEnv", "opencodePasswordEnv", "codexGateway"];
  const result = {};
  for (const field of fields) if (options[field] !== undefined) result[field] = options[field];
  result.engine = agentEngine(options);
  return result;
}

function providerOptions(options) {
  const engine = agentEngine(options);
  return {
    ...options,
    engine,
    codexGateway: options.host?.codexGateway ?? options.codexGateway ?? null,
    claudeBin: options.host?.claudeBin ?? options.claudeBin ?? "claude",
    permissionLevel: options.permissionLevel ?? (engine === "codex" ? "workspace-write" : "native")
  };
}

export async function listAgentThreadsLocal(options = {}) {
  const params = providerOptions({ ...options, host: null });
  if (params.engine === "codex") return params.codexGateway ? listGatewayThreads(params) : codex.listCodexThreads(params);
  if (params.engine === "opencode") return listOpenCodeThreads(params);
  return listClaudeThreads(params);
}

export function startAgentTurnLocal(options = {}) {
  const params = providerOptions({ ...options, host: null });
  if (params.engine === "codex") return params.codexGateway ? startGatewayTurn(params) : codex.startCodexTurn(params);
  if (params.engine === "opencode") return startOpenCodeTurn(params);
  return startClaudeTurn(params);
}

export async function listCodexThreads(options = {}) {
  const params = providerOptions(options);
  if (params.engine === "codex" && !params.codexGateway) return codex.listCodexThreads(params);
  if (params.host?.transport === "ssh") {
    return requestHostOperation(params.host, { operation: "agent.listThreads", ...serializableAgentOptions(params) });
  }
  return listAgentThreadsLocal(params);
}

export function startCodexTurn(options = {}) {
  const params = providerOptions(options);
  if (params.engine === "codex" && !params.codexGateway) return codex.startCodexTurn(params);
  if (params.host?.transport === "ssh") return startRemoteAgentTurn(params);
  return startAgentTurnLocal(params);
}

export async function readGatewayRequestStatus(options = {}) {
  const params = providerOptions(options);
  if (params.engine !== "codex" || !params.codexGateway) throw new Error("This session does not use a shared Codex gateway.");
  if (params.host?.transport === "ssh") {
    return requestHostOperation(params.host, { operation: "agent.gatewayStatus", ...serializableAgentOptions(params) });
  }
  return readGatewayRequestStatusLocal(params);
}

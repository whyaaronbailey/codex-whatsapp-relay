// Explicit, metadata-only validation command. Never invoked by npm test.
// This uses a synthetic primary; it cannot establish real desktop tool parity.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { validateBridgeConfig } from "../plugins/whatsapp-relay/scripts/desktop-owned-bridge.mjs";

const sha = filename => createHash("sha256").update(fs.readFileSync(filename)).digest("hex");
async function bounded(promise, milliseconds, fallback) {
  let timer;
  try { return await Promise.race([promise, new Promise(resolve => { timer = setTimeout(() => resolve(fallback), milliseconds); })]); }
  finally { clearTimeout(timer); }
}

export async function testDesktopOwnedNative(candidateManifest, validationDirectory) {
  if (!path.isAbsolute(candidateManifest) || !path.isAbsolute(validationDirectory)) throw new Error("Use absolute manifest and new validation-directory paths.");
  if (fs.existsSync(validationDirectory)) throw new Error("Validation directory must not already exist.");
  const manifest = JSON.parse(fs.readFileSync(candidateManifest, "utf8"));
  if (manifest.schema !== "codex-desktop-owned-candidate-v1" || manifest.activated !== false || !Array.isArray(manifest.files)) throw new Error("Invalid candidate manifest; no launch.");
  for (const file of manifest.files) if (!path.isAbsolute(file.path) || sha(file.path) !== file.sha256) throw new Error("Reviewed candidate source changed; no launch.");
  const config = validateBridgeConfig(JSON.parse(fs.readFileSync(manifest.configFile, "utf8")));
  for (const [role, filename] of Object.entries({ shim: manifest.executable, bridge: config.nodePath, server: config.realCliPath, script: config.bridgePath, config: manifest.configFile })) {
    if (sha(filename) !== manifest.expectedHashes?.[role]) throw new Error("Candidate role hash mismatch; no launch.");
  }
  fs.mkdirSync(validationDirectory, { recursive: true });
  const executable = path.join(validationDirectory, "codex-desktop-owned-shim.exe");
  fs.copyFileSync(manifest.executable, executable, fs.constants.COPYFILE_EXCL);
  config.statusFile = path.join(validationDirectory, "status.json");
  fs.writeFileSync(`${executable}.json`, `${JSON.stringify(config, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  const proofFile = path.join(validationDirectory, "native-protocol-proof.json");
  const proof = { schema: "desktop-owned-native-protocol-smoke-v1", startedAt: new Date().toISOString(), candidateManifest,
    syntheticPrimary: true, realDesktopTouched: false, modelPromptsSent: 0, desktopToolParityClaimed: false,
    forcedTermination: false, port: config.port, operations: [], serverRequestMethods: [], stderrBytes: 0 };
  const save = () => fs.writeFileSync(proofFile, `${JSON.stringify(proof, null, 2)}\n`);
  const args = ["-c", "features.code_mode_host=true", "app-server", "--analytics-default-enabled", "-c", "features.prefer_mxc=true",
    "-c", "plugins.code-review@openai-bundled.mcp_servers.code-review.enabled=true", "-c", "plugins.codex-app-tools@openai-bundled.mcp_servers.codex_app.enabled=true"];
  const primaryPending = new Map(), secondaryPending = new Map();
  let child, peer, closePromise, closed = false, primaryId = 0, secondaryId = 0, buffer = "";
  const decoder = new StringDecoder("utf8");
  function rejectPending(pending) {
    for (const job of pending.values()) { clearTimeout(job.timer); job.reject(new Error("Metadata transport closed.")); }
    pending.clear();
  }
  function dispatch(message, pending, primary = false) {
    if (primary && typeof message.method === "string" && message.id != null) {
      if (!proof.serverRequestMethods.includes(message.method)) proof.serverRequestMethods.push(message.method);
      if (!child.stdin.writableEnded) child.stdin.write(`${JSON.stringify({ id: message.id, error: { code: -32601, message: "Synthetic metadata-only client does not provide desktop services." } })}\n`);
    } else if (pending.has(message.id)) {
      const job = pending.get(message.id); pending.delete(message.id); clearTimeout(job.timer); job.resolve(message);
    }
  }
  function request(primary, method, params) {
    const id = primary ? ++primaryId : ++secondaryId;
    const pending = primary ? primaryPending : secondaryPending;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error("Bounded metadata RPC timeout.")); }, 30000);
      pending.set(id, { resolve, reject, timer });
      const text = JSON.stringify({ id, method, params });
      if (primary) child.stdin.write(`${text}\n`); else peer.send(text);
    });
  }
  try {
    child = spawn(executable, args, { cwd: validationDirectory, stdio: ["pipe", "pipe", "pipe"], shell: false, windowsHide: true });
    proof.shimPid = child.pid ?? null;
    closePromise = new Promise(resolve => child.on("close", code => { closed = true; rejectPending(primaryPending); rejectPending(secondaryPending); resolve(code); }));
    child.on("error", () => { rejectPending(primaryPending); rejectPending(secondaryPending); });
    child.stdin.on("error", () => rejectPending(primaryPending));
    child.stderr.on("data", data => { proof.stderrBytes += data.length; }); // Never retain or print raw logs.
    child.stdout.on("data", chunk => {
      try {
        buffer += decoder.write(chunk);
        if (Buffer.byteLength(buffer) > 32 * 1024 * 1024) throw new Error("Output bound exceeded.");
        let at;
        while ((at = buffer.indexOf("\n")) >= 0) { const line = buffer.slice(0, at); buffer = buffer.slice(at + 1); if (line) dispatch(JSON.parse(line), primaryPending, true); }
      } catch { rejectPending(primaryPending); rejectPending(secondaryPending); }
    });
    const initialized = await request(true, "initialize", { clientInfo: { name: "whatsapp_bridge_protocol_validation", version: "1" }, capabilities: { experimentalApi: true } });
    if (initialized.error) throw new Error("Native initialization rejected.");
    proof.operations.push({ method: "initialize", success: true });
    child.stdin.write(`${JSON.stringify({ method: "initialized", params: {} })}\n`);
    const challenge = "a".repeat(32);
    for (let tries = 0; tries < 100; tries++) {
      const response = await fetch(`http://127.0.0.1:${config.port}/health?challenge=${challenge}`, { signal: AbortSignal.timeout(2000) });
      const health = await response.json();
      if (health.primaryReady && health.challenge === challenge && health.schema === "codex-desktop-stdio-health-v1") { proof.readyHealth = health; break; }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    if (!proof.readyHealth) throw new Error("Primary readiness was not verified.");
    const token = fs.readFileSync(config.tokenFile, "utf8").trimEnd();
    peer = new WebSocket(`ws://127.0.0.1:${config.port}/`, { headers: { Authorization: `Bearer ${token}` }, handshakeTimeout: 10000 });
    peer.on("error", () => rejectPending(secondaryPending));
    peer.on("close", () => rejectPending(secondaryPending));
    peer.on("message", data => { try { dispatch(JSON.parse(data.toString()), secondaryPending); } catch { rejectPending(secondaryPending); } });
    await once(peer, "open");
    const initializedSecondary = await request(false, "initialize", { clientInfo: { name: "whatsapp_gateway_metadata_validation", version: "1" }, capabilities: { experimentalApi: true } });
    if (initializedSecondary.error) throw new Error("Secondary initialization rejected.");
    peer.send(JSON.stringify({ method: "initialized", params: {} }));
    for (const [method, params] of [["thread/loaded/list", { limit: 10 }], ["mcpServerStatus/list", { serverName: "codex_app", detail: "toolsAndAuthOnly", limit: 10 }]]) {
      const response = await request(false, method, params);
      proof.operations.push({ method, success: !response.error, ...(response.error ? { errorCode: response.error.code } : {}),
        returnedRows: Array.isArray(response.result?.data) ? response.result.data.length : null,
        resultFieldNames: response.result ? Object.keys(response.result).sort() : [] });
    }
    proof.protocolPassed = proof.operations.every(item => item.success);
  } catch {
    proof.protocolPassed = false;
    proof.failure = "Metadata validation failed; inspect sanitized status without replaying mutations.";
  } finally {
    peer?.close();
    proof.primaryEofAt = new Date().toISOString();
    child?.stdin?.end();
    save();
    const code = closePromise ? await bounded(closePromise, 30000, null) : null;
    proof.nativeProcessChainExited = closed;
    proof.shimExitCode = code;
    proof.completedAt = new Date().toISOString();
    if (fs.existsSync(config.statusFile)) {
      const status = JSON.parse(fs.readFileSync(config.statusFile, "utf8"));
      proof.finalStatus = { state: status.state, primaryReady: status.primaryReady, bridgePid: status.bridgePid, backendPid: status.backendPid };
    }
    save();
    if (child && !closed) { child.unref(); child.stdout.destroy(); child.stderr.destroy(); } // Keep any surviving process intact.
  }
  return { proofFile, protocolPassed: proof.protocolPassed, nativeProcessChainExited: proof.nativeProcessChainExited,
    shimExitCode: proof.shimExitCode, operations: proof.operations, modelPromptsSent: 0, desktopToolParityClaimed: false };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [manifest, directory] = process.argv.slice(2);
  if (!manifest || !directory) throw new Error("Usage: node scripts/test-desktop-owned-native.mjs ABSOLUTE_CANDIDATE_MANIFEST ABSOLUTE_NEW_VALIDATION_DIRECTORY");
  const result = await testDesktopOwnedNative(manifest, directory);
  console.log(JSON.stringify(result));
  if (!result.protocolPassed || !result.nativeProcessChainExited || result.shimExitCode !== 0) process.exitCode = 1;
}

import { pathToFileURL } from "node:url";
import { MAX_WORKER_MESSAGE_BYTES, performHostOperation } from "./controller-hosts.mjs";
import { spawnNativeCodex } from "./codex-process.mjs";

function readFirstRequest(input) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    function cleanup() {
      input.off("data", onData);
      input.off("end", onEnd);
      input.off("error", onError);
    }
    function onError(error) { cleanup(); reject(error); }
    function onEnd() { cleanup(); reject(new Error("Worker requires a newline-terminated request.")); }
    function onData(chunk) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const index = buffer.indexOf(10);
      const requestChunk = index < 0 ? buffer : buffer.subarray(0, index);
      bytes += requestChunk.length;
      if (bytes > MAX_WORKER_MESSAGE_BYTES) {
        input.pause();
        cleanup();
        reject(new Error("Worker request exceeds the relay transport size limit."));
        return;
      }
      chunks.push(requestChunk);
      if (index < 0) return;
      input.pause();
      cleanup();
      try {
        resolve({ request: JSON.parse(Buffer.concat(chunks).toString("utf8")), remainder: buffer.subarray(index + 1) });
      } catch { reject(new Error("Worker request is not valid JSON.")); }
    }
    input.on("data", onData);
    input.once("end", onEnd);
    input.once("error", onError);
  });
}

export async function runWorker({ input = process.stdin, output = process.stdout, errorOutput = process.stderr } = {}) {
  let operation = null;
  try {
    const { request, remainder } = await readFirstRequest(input);
    operation = request.operation;
    if (operation === "agent.run") {
      const { startAgentTurnLocal } = await import("./agent-runner.mjs");
      const { runAgentWorker } = await import("./agent-transport.mjs");
      await runAgentWorker(request, remainder, { input, output, startTurn: startAgentTurnLocal });
      return;
    }
    if (request.operation !== "codex.appServer") {
      const result = await performHostOperation(request);
      const line = `${JSON.stringify({ result })}\n`;
      if (Buffer.byteLength(line) > MAX_WORKER_MESSAGE_BYTES) throw new Error("Worker response exceeds the relay transport size limit.");
      output.write(line);
      // One-shot worker does not keep waiting for more commands.
      input.destroy();
      return;
    }
    if (!request.workspace || !Array.isArray(request.args) || request.args[0] !== "app-server" || !request.args.every((arg) => typeof arg === "string")) {
      throw new Error("Invalid Codex app-server worker request.");
    }
    const child = spawnNativeCodex(request.codexBin ?? "codex", request.args, {
      cwd: request.workspace,
      stdio: ["pipe", "pipe", "pipe"]
    });
    child.stdout.pipe(output, { end: false });
    child.stderr.pipe(errorOutput, { end: false });
    child.stdin.on("error", () => {});
    if (remainder.length) child.stdin.write(remainder);
    input.pipe(child.stdin);
    // Closing an SSH session closes its stdin. Always reap the app-server too.
    let killTimer = null;
    const stop = () => {
      if (!child.killed) child.kill();
      killTimer ??= setTimeout(() => child.kill("SIGKILL"), 2000);
      killTimer.unref();
    };
    input.once("end", stop);
    input.once("error", stop);
    const signalHandlers = new Map(["SIGTERM", "SIGINT", "SIGHUP"].map((signal) => [signal, stop]));
    for (const [signal, handler] of signalHandlers) process.on(signal, handler);
    input.resume();
    await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => { process.exitCode = code ?? 1; resolve(); });
    }).finally(() => {
      if (killTimer) clearTimeout(killTimer);
      for (const [signal, handler] of signalHandlers) process.off(signal, handler);
      input.unpipe(child.stdin);
      input.destroy();
    });
  } catch (error) {
    if (operation === "codex.appServer") errorOutput.write(`${error.message}\n`);
    else if (operation === "agent.run") output.write(`${JSON.stringify({ type: "error", error: { message: error.message } })}\n`);
    else output.write(`${JSON.stringify({ error: error.message, code: error.code, retryable: error.retryable })}\n`);
    process.exitCode = 1;
    input.destroy();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runWorker();
}

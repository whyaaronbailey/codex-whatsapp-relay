import http from "node:http";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

import { WhatsAppRuntime } from "../plugins/whatsapp-relay/scripts/runtime.mjs";
import { ControllerConfigStore } from "../plugins/whatsapp-relay/scripts/controller-config.mjs";
import { claimGlobalControllerOwner, releaseGlobalControllerOwner } from "../plugins/whatsapp-relay/scripts/controller-owner.mjs";
import { getControllerProcessStatus, startControllerDaemon } from "../plugins/whatsapp-relay/scripts/controller-process.mjs";

const require = createRequire(import.meta.url);
const QRCode = require("qrcode-terminal/vendor/QRCode");
const QRErrorCorrectLevel = require("qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel");
const MAX_PAIRING_MS = 10 * 60_000;

export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[character]);
}

export function renderQrSvg(value) {
  if (typeof value !== "string" || !value || value.length > 8_192) throw new Error("Invalid pairing code.");
  const qr = new QRCode(-1, QRErrorCorrectLevel.L);
  qr.addData(value);
  qr.make();
  const margin = 4;
  const size = qr.getModuleCount() + 2 * margin;
  const cells = [];
  for (let row = 0; row < qr.getModuleCount(); row++) {
    for (let column = 0; column < qr.getModuleCount(); column++) {
      if (qr.modules[row][column]) cells.push(`M${column + margin},${row + margin}h1v1h-1z`);
    }
  }
  // The QR payload is encoded into geometry only, never embedded as XML text.
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" role="img" aria-label="Scan with WhatsApp" shape-rendering="crispEdges"><rect width="${size}" height="${size}" fill="white"/><path d="${cells.join("")}" fill="black"/></svg>`;
}

export function ownerNumberFromJid(jid) {
  // A linked-device ID must be a phone JID. A LID is not a phone number.
  const match = typeof jid === "string" && jid.match(/^(\d{6,15})(?::\d+)?@(s\.whatsapp\.net|hosted)$/i);
  if (!match) throw new Error("The linked account did not provide a verified phone number. Controller access was not enabled.");
  return `+${match[1]}`;
}

export function renderPairingPage({ status = "waiting", qrSvg = null, message = "Getting ready to link WhatsApp…" } = {}) {
  const finished = ["ready", "failed", "cancelled"].includes(status);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer">${finished ? "" : '<meta http-equiv="refresh" content="2">'}<title>Link WhatsApp</title><style>body{font:18px system-ui,sans-serif;color:#172a24;background:#f4f8f6;margin:0;padding:32px}main{max-width:560px;margin:20px auto;padding:28px;background:white;border-radius:16px}h1{font-size:28px}p{line-height:1.5}svg{display:block;width:100%;max-width:430px;margin:24px auto}small{color:#50605a}</style></head><body><main><h1>Link WhatsApp</h1><p>${escapeHtml(message)}</p>${qrSvg ?? ""}${!finished ? "<p>On your phone, open WhatsApp → Settings or Menu → Linked devices → Link a device.</p><small>Scan the code above. This page updates automatically.</small>" : ""}</main></body></html>`;
}

export async function createPairingServer(getView) {
  const secretPath = `/pair/${randomBytes(32).toString("hex")}`;
  let origin;
  const server = http.createServer((request, response) => {
    response.setHeader("Cache-Control", "no-store, max-age=0");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
    const authorized = request.url === secretPath && request.headers.host === new URL(origin).host &&
      (!request.headers.origin || request.headers.origin === origin) && request.socket.remoteAddress === "127.0.0.1";
    if (!authorized) {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Not found");
      return;
    }
    if (request.method !== "GET") {
      response.writeHead(405, { Allow: "GET", "Content-Type": "text/plain; charset=utf-8" });
      response.end("Method not allowed");
      return;
    }
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(renderPairingPage(getView()));
  });
  server.requestTimeout = 5_000;
  server.headersTimeout = 5_000;
  server.maxHeadersCount = 40;
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  origin = `http://127.0.0.1:${server.address().port}`;
  return {
    url: `${origin}${secretPath}`,
    close: () => new Promise(resolve => {
      server.close(resolve);
      server.closeAllConnections();
    })
  };
}

export async function pairWhatsApp({
  enableController = false,
  timeoutMs = MAX_PAIRING_MS,
  lingerMs = 5_000,
  runtime = new WhatsAppRuntime({ logLevel: "silent" }),
  configStore = new ControllerConfigStore(),
  getStatus = getControllerProcessStatus,
  claimOwner = claimGlobalControllerOwner,
  releaseOwner = releaseGlobalControllerOwner,
  startDaemon = startControllerDaemon,
  createServer = createPairingServer,
  writeLine = line => process.stdout.write(`${line}\n`),
  signal = null
} = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_PAIRING_MS) throw new Error("Pairing timeout must be between 1 millisecond and 10 minutes.");
  if (signal?.aborted) throw new Error("Pairing cancelled.");
  if ((await getStatus()).running) throw new Error("The WhatsApp controller is already running. Stop it before pairing.");
  if (!(await claimOwner()).acquired) throw new Error("Another WhatsApp relay is running or pairing. Close it before pairing here.");
  let ownsLock = true;
  let web;
  let closing = false;
  let completed = false;
  let pendingCredentialSaves = 0;
  let timer;
  const unsubscribers = [];
  const view = { status: "waiting", qrSvg: null, message: "Getting ready to link WhatsApp…" };
  const originalStart = runtime.start.bind(runtime);
  // Runtime reconnect timers may already be queued when authentication finishes.
  runtime.start = options => closing ? Promise.resolve(runtime.socket) : originalStart(options);
  let resolveConnected, rejectConnected;
  const connected = new Promise((resolve, reject) => { resolveConnected = resolve; rejectConnected = reject; });
  const cancel = () => rejectConnected(new Error("Pairing cancelled."));
  const checkCancelled = () => {
    if (signal?.aborted) throw new Error("Pairing cancelled.");
  };
  const waitForCredentialSaves = async () => {
    const deadline = Date.now() + 3_000;
    while (pendingCredentialSaves > 0 || !runtime.hasSavedCreds()) {
      checkCancelled();
      if (Date.now() >= deadline) throw new Error("WhatsApp credentials did not finish saving. Controller startup was skipped.");
      await delay(25);
    }
  };
  const closeSocket = async () => {
    closing = true;
    runtime.closing = true;
    if (runtime.state) runtime.state.currentQrText = null;
    view.qrSvg = null;
    let closeTimer;
    try {
      await Promise.race([
        Promise.resolve(runtime.socket?.end?.()),
        new Promise((_, reject) => { closeTimer = setTimeout(() => reject(new Error("The pairing connection did not close cleanly. Controller startup was skipped.")), 3_000); })
      ]);
    } finally { clearTimeout(closeTimer); }
  };
  try {
    web = await createServer(() => view);
    writeLine(`Open this page to link WhatsApp: ${web.url}`);
    unsubscribers.push(runtime.on("socket.ready", socket => {
      if (closing) {
        Promise.resolve(socket.end?.()).catch(() => {});
        return;
      }
      // Runtime emits socket.ready before attaching its credential writer, and
      // emits creds.update only after that writer has finished saving to disk.
      const saving = () => { pendingCredentialSaves++; };
      socket.ev.on("creds.update", saving);
      unsubscribers.push(() => socket.ev.off("creds.update", saving));
    }));
    unsubscribers.push(runtime.on("creds.update", () => {
      pendingCredentialSaves = Math.max(0, pendingCredentialSaves - 1);
    }));
    unsubscribers.push(runtime.on("connection.update", update => {
      if (closing) return;
      if (update.qr) {
        try {
          view.qrSvg = renderQrSvg(update.qr);
          view.status = "waiting";
          view.message = "Scan this code with WhatsApp on your phone.";
        } catch { rejectConnected(new Error("The WhatsApp pairing code could not be displayed. Try again.")); }
      }
      if (update.connection === "open") resolveConnected(runtime.socket);
      if (update.connection === "close" && runtime.state?.status === "logged_out") {
        rejectConnected(new Error("WhatsApp rejected the saved connection. Existing credentials were preserved; relink the account before trying again."));
      }
    }));
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) throw new Error("Pairing cancelled.");
    timer = setTimeout(() => rejectConnected(new Error("Pairing timed out after 10 minutes. Run the pairing command again to try another code.")), timeoutMs);
    runtime.start({ printQrToTerminal: false, force: false }).catch(() => {
      rejectConnected(new Error("WhatsApp could not connect. Check your connection and try again."));
    });
    const socket = await connected;
    clearTimeout(timer);
    if (signal?.aborted) throw new Error("Pairing cancelled.");
    const number = enableController ? ownerNumberFromJid(socket?.user?.id) : null;
    view.status = "finishing";
    view.message = "WhatsApp is linked. Finishing setup…";
    await closeSocket();
    await waitForCredentialSaves();
    await releaseOwner();
    ownsLock = false;
    if (signal?.aborted) throw new Error("Pairing cancelled.");
    if (enableController) {
      // The phone number comes only from the linked account, never from a URL,
      // form, command-line argument or arbitrary WhatsApp message.
      const config = await configStore.load();
      checkCancelled();
      const existing = config.allowedControllers.find(item => item.phoneKey === number.slice(1));
      await configStore.allowController({ number, label: existing?.label ?? "Linked account owner" });
      checkCancelled();
      await configStore.update({ enabled: true });
      checkCancelled();
      await startDaemon();
    }
    view.status = "ready";
    view.message = enableController
      ? "WhatsApp is linked and the controller is running. Open Message yourself and send /hosts to see your machines. You can close this page."
      : "WhatsApp is linked. You can close this page.";
    completed = true;
    writeLine(enableController ? "WhatsApp linked. Controller running." : "WhatsApp linked.");
    if (lingerMs > 0) await delay(lingerMs, undefined, { signal: signal ?? undefined }).catch(() => {});
    return { connected: true, controllerEnabled: enableController };
  } catch (error) {
    view.status = signal?.aborted ? "cancelled" : "failed";
    view.qrSvg = null;
    view.message = signal?.aborted ? "Pairing was cancelled." : "WhatsApp setup could not finish. Check the pairing command for the next step.";
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", cancel);
    if (!closing) await closeSocket().catch(() => {});
    for (const unsubscribe of unsubscribers) unsubscribe();
    if (ownsLock) await releaseOwner().catch(() => {});
    if (web) await web.close();
    if (!completed) view.qrSvg = null;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args.includes("--help")) {
    process.stdout.write("Usage: node scripts/pair-whatsapp.mjs [--enable-controller]\nLink WhatsApp in a local browser. --enable-controller also allows the linked account owner and starts the controller.\n");
  } else if (args.some(arg => arg !== "--enable-controller")) {
    process.stderr.write("Unknown option. Use --help for pairing instructions.\n");
    process.exitCode = 1;
  } else {
    const abort = new AbortController();
    const cancel = () => abort.abort();
    process.on("SIGINT", cancel);
    process.on("SIGTERM", cancel);
    let exitCode = 0;
    try { await pairWhatsApp({ enableController: args.includes("--enable-controller"), signal: abort.signal }); }
    catch (error) { process.stderr.write(`${error.message}\n`); exitCode = 1; }
    finally {
      process.off("SIGINT", cancel);
      process.off("SIGTERM", cancel);
    }
    // Baileys may have a previously queued reconnect timer. All owned sockets
    // and the local web server have been closed before exiting this helper.
    process.exit(exitCode);
  }
}

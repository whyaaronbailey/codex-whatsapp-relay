import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";

import { createPairingServer, escapeHtml, ownerNumberFromJid, pairWhatsApp, renderPairingPage, renderQrSvg } from "./pair-whatsapp.mjs";
import { ControllerConfigStore } from "../plugins/whatsapp-relay/scripts/controller-config.mjs";

test("SVG encodes the pairing payload as geometry with a four-module quiet zone", () => {
  const payload = '<script>alert("private-qr")</script>';
  const svg = renderQrSvg(payload);
  assert.match(svg, /^<svg /);
  assert.match(svg, /shape-rendering="crispEdges"/);
  assert.match(svg, /M4,4h1v1h-1z/);
  assert.doesNotMatch(svg, /script|private-qr|alert/);
  assert.throws(() => renderQrSvg(""), /Invalid/);
  assert.throws(() => renderQrSvg("x".repeat(8193)), /Invalid/);
});

test("page escapes text, refreshes while pairing, and stops refreshing after success", () => {
  assert.equal(escapeHtml('<a href="x">&\''), "&lt;a href=&quot;x&quot;&gt;&amp;&#39;");
  const waiting = renderPairingPage({ message: "<script>secret</script>" });
  assert.doesNotMatch(waiting, /<script>/);
  assert.match(waiting, /&lt;script&gt;/);
  assert.match(waiting, /http-equiv="refresh"/);
  assert.match(waiting, /Linked devices/);
  assert.doesNotMatch(renderPairingPage({ status: "ready", message: "Linked" }), /http-equiv="refresh"/);
});

test("only verified phone JIDs can become controller owners", () => {
  assert.equal(ownerNumberFromJid("10000000000:4@s.whatsapp.net"), "+10000000000");
  assert.equal(ownerNumberFromJid("10000000000@hosted"), "+10000000000");
  for (const jid of [null, "10000000000@lid", "10000000000@g.us", "10000000000@s.whatsapp.net.evil", "10000000000", "12@s.whatsapp.net", "10000000000000000@s.whatsapp.net"]) {
    assert.throws(() => ownerNumberFromJid(jid), /verified phone number/);
  }
});

test("browser endpoint is loopback-only, secret, read-only and uncached", async (t) => {
  let reads = 0;
  const view = { status: "waiting", qrSvg: renderQrSvg("synthetic-pairing-payload"), message: "Scan this code" };
  const web = await createPairingServer(() => { reads++; return view; });
  t.after(() => web.close());
  const url = new URL(web.url);
  assert.equal(url.hostname, "127.0.0.1");
  assert.match(url.pathname, /^\/pair\/[a-f0-9]{64}$/);
  const good = await fetch(web.url);
  assert.equal(good.status, 200);
  assert.match(good.headers.get("cache-control"), /no-store/);
  assert.equal(good.headers.get("referrer-policy"), "no-referrer");
  assert.match(good.headers.get("content-security-policy"), /frame-ancestors 'none'/);
  assert.match(await good.text(), /<svg/);
  assert.equal((await fetch(`${url.origin}/pair/wrong`)).status, 404);
  const wrongHostStatus = await new Promise((resolve, reject) => {
    http.get(web.url, { headers: { host: "example.invalid" } }, response => {
      response.resume();
      resolve(response.statusCode);
    }).on("error", reject);
  });
  assert.equal(wrongHostStatus, 404);
  assert.equal((await fetch(web.url, { headers: { origin: "https://example.invalid" } })).status, 404);
  assert.equal((await fetch(web.url, { method: "POST", body: "enable-controller=true" })).status, 405);
  assert.equal(reads, 1);
});

async function fixture(t, { connect = true, jid = "10000000000:4@s.whatsapp.net" } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "relay-pairing-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const configStore = new ControllerConfigStore(path.join(directory, "config.json"));
  await configStore.update({ enabled: false, projects: [{ alias: "test", workspace: directory }],
    allowedControllers: [{ number: "+20000000000", label: "Existing controller" }] });
  const events = new EventEmitter();
  const calls = [], output = [];
  const runtime = {
    state: { status: "connecting", currentQrText: null }, closing: false,
    socket: { ev: new EventEmitter(), user: { id: jid }, async end() { calls.push("end"); events.emit("connection.update", { connection: "close" }); } },
    hasSavedCreds: () => true,
    on(name, listener) { events.on(name, listener); return () => events.off(name, listener); },
    async start(options) {
      calls.push({ start: options });
      events.emit("socket.ready", this.socket);
      events.emit("connection.update", { qr: "private-synthetic-pairing-code" });
      if (connect) events.emit("connection.update", { connection: "open" });
      return this.socket;
    }
  };
  let view;
  const options = {
    runtime, configStore, lingerMs: 0, timeoutMs: 100,
    getStatus: async () => ({ running: false }),
    claimOwner: async () => { calls.push("claim"); return { acquired: true }; },
    releaseOwner: async () => { calls.push("release"); },
    startDaemon: async () => { calls.push("daemon"); assert.equal(runtime.closing, true); assert.ok(calls.indexOf("end") < calls.indexOf("release")); },
    createServer: async getView => { view = getView; return { url: "http://127.0.0.1:12345/pair/synthetic", close: async () => calls.push("web-close") }; },
    writeLine: line => output.push(line)
  };
  return { options, runtime, configStore, calls, output, events, getView: () => view?.() };
}

test("explicit enable pairs only the linked owner, preserves allowlist and closes before daemon startup", async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await pairWhatsApp({ ...f.options, enableController: true }), { connected: true, controllerEnabled: true });
  const config = await f.configStore.load();
  assert.equal(config.enabled, true);
  assert.deepEqual(config.allowedControllers.map(item => item.number), ["+20000000000", "+10000000000"]);
  assert.equal(config.allowedControllers[0].label, "Existing controller");
  assert.deepEqual(f.calls.find(item => item.start)?.start, { printQrToTerminal: false, force: false });
  assert.ok(f.calls.indexOf("release") < f.calls.indexOf("daemon"));
  assert.equal(f.calls.at(-1), "web-close");
  assert.equal(f.getView().qrSvg, null);
  assert.equal(f.getView().status, "ready");
  assert.ok(f.output.every(line => !line.includes("private-synthetic-pairing-code") && !line.includes("10000000000")));
  assert.equal(f.events.listenerCount("connection.update"), 0);
});

test("pairing without the enable flag never changes config or starts the controller", async (t) => {
  const f = await fixture(t);
  const before = await fs.readFile(f.configStore.filePath, "utf8");
  await pairWhatsApp(f.options);
  assert.equal(await fs.readFile(f.configStore.filePath, "utf8"), before);
  assert.ok(!f.calls.includes("daemon"));
});

test("handoff waits for in-flight credential saves after closing the authentication socket", async (t) => {
  const f = await fixture(t);
  let saved = false;
  f.runtime.hasSavedCreds = () => saved;
  f.runtime.start = async () => {
    f.events.emit("socket.ready", f.runtime.socket);
    f.runtime.socket.ev.emit("creds.update", {});
    f.events.emit("connection.update", { connection: "open" });
    setTimeout(() => {
      saved = true;
      f.calls.push("saved");
      f.events.emit("creds.update", {});
    }, 40);
    return f.runtime.socket;
  };
  await pairWhatsApp({ ...f.options, enableController: true });
  assert.ok(f.calls.indexOf("end") < f.calls.indexOf("saved"));
  assert.ok(f.calls.indexOf("saved") < f.calls.indexOf("release"));
  assert.ok(f.calls.indexOf("saved") < f.calls.indexOf("daemon"));
  assert.equal(f.runtime.socket.ev.listenerCount("creds.update"), 0);
});

test("a failed socket close cannot enable or start a controller", async (t) => {
  const f = await fixture(t);
  f.runtime.socket.end = async () => { throw new Error("Unable to close pairing socket"); };
  await assert.rejects(pairWhatsApp({ ...f.options, enableController: true }), /Unable to close/);
  assert.equal((await f.configStore.load()).enabled, false);
  assert.ok(!f.calls.includes("daemon"));
  assert.ok(f.calls.includes("release") && f.calls.includes("web-close"));
});

test("logged-out connection fails without replacing saved credentials or changing permissions", async (t) => {
  const f = await fixture(t);
  f.runtime.start = async () => {
    f.runtime.state.status = "logged_out";
    f.events.emit("connection.update", { connection: "close" });
  };
  await assert.rejects(pairWhatsApp({ ...f.options, enableController: true }), /Existing credentials were preserved/);
  assert.equal((await f.configStore.load()).enabled, false);
  assert.ok(!f.calls.includes("daemon"));
});

test("invalid linked identity cannot authorize a controller", async (t) => {
  const f = await fixture(t, { jid: "10000000000@lid" });
  const before = await fs.readFile(f.configStore.filePath, "utf8");
  await assert.rejects(pairWhatsApp({ ...f.options, enableController: true }), /verified phone number/);
  assert.equal(await fs.readFile(f.configStore.filePath, "utf8"), before);
  assert.ok(!f.calls.includes("daemon"));
  assert.ok(f.calls.includes("end") && f.calls.includes("release") && f.calls.includes("web-close"));
});

test("running controller and owner contention refuse pairing before runtime or browser starts", async (t) => {
  const f = await fixture(t);
  await assert.rejects(pairWhatsApp({ ...f.options, getStatus: async () => ({ running: true }) }), /already running/);
  assert.deepEqual(f.calls, []);
  await assert.rejects(pairWhatsApp({ ...f.options, claimOwner: async () => ({ acquired: false }) }), /Another WhatsApp relay/);
  assert.deepEqual(f.calls, []);
});

test("timeout and cancellation close the browser/socket, release ownership and never enable", async (t) => {
  const f = await fixture(t, { connect: false });
  await assert.rejects(pairWhatsApp({ ...f.options, timeoutMs: 10, enableController: true }), /timed out/);
  assert.equal((await f.configStore.load()).enabled, false);
  assert.ok(!f.calls.includes("daemon"));
  assert.ok(f.calls.includes("end") && f.calls.includes("release") && f.calls.includes("web-close"));
  const second = await fixture(t, { connect: false });
  const abort = new AbortController();
  second.options.writeLine = () => abort.abort();
  await assert.rejects(pairWhatsApp({ ...second.options, signal: abort.signal }), /cancelled/);
  assert.equal(second.events.listenerCount("connection.update"), 0);
  assert.ok(second.calls.includes("end") && second.calls.includes("release") && second.calls.includes("web-close"));
});

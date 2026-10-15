import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { stageDesktopBridge } from "./stage-desktop-owned-bridge.mjs";

const windowsCompiler = path.join(process.env.SystemRoot ?? "C:\\Windows", "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe");
const supported = process.platform === "win32" && fs.existsSync(windowsCompiler);
function run(executable, args, { input = "", cwd, env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, env, shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", reject); child.on("close", code => resolve({ code, stdout, stderr })); child.stdin.end(input);
  });
}

test("staged native shim preserves argv, stdin and opaque environment without activating anything", { skip: !supported }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-native-shim-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const fixture = path.join(dir, "harmless-fixture.cjs");
  fs.writeFileSync(fixture, "const deadline=setTimeout(()=>process.exit(97),5000);let input='';process.stdin.on('data',b=>input+=b);process.stdin.on('end',()=>{clearTimeout(deadline);console.log(JSON.stringify({args:process.argv.slice(2),input,opaque:process.env.SYNTHETIC_SHIM_CONTEXT,cwd:process.cwd()}))});");
  const config = { schema: "codex-desktop-owned-bridge-v1", realCliPath: process.execPath, nodePath: process.execPath, bridgePath: fixture, tokenFile: path.join(dir, "not-read-during-stage"), statusFile: path.join(dir, "not-written-during-stage"), port: 4511 };
  const output = path.join(dir, "candidate");
  const manifest = stageDesktopBridge(config, output, { compiler: windowsCompiler });
  assert.equal(manifest.activated, false);
  assert.equal(fs.existsSync(config.tokenFile), false);
  assert.equal(fs.existsSync(config.statusFile), false);
  assert.deepEqual(Object.keys(manifest.expectedHashes).sort(), ["bridge", "config", "script", "server", "shim"]);
  assert.ok(Object.values(manifest.expectedHashes).every(value => /^[a-f0-9]{64}$/.test(value)));
  const args = ["", "space here", 'quote\"here', "trailing\\", "two\\\\\"quotes", "日本語"];
  const env = { ...process.env, SYNTHETIC_SHIM_CONTEXT: "opaque-fixture" };
  const direct = await run(manifest.executable, [fixture, ...args], { cwd: dir, env, input: "hello stdin 😀" });
  assert.equal(direct.code, 0, direct.stderr);
  const directResult = JSON.parse(direct.stdout);
  assert.deepEqual({ ...directResult, cwd: fs.realpathSync.native(directResult.cwd) }, { args, input: "hello stdin 😀", opaque: "opaque-fixture", cwd: fs.realpathSync.native(dir) });
  const nativeArgs = ["-c", "features.code_mode_host=true", "app-server", "--analytics-default-enabled", "-c", 'custom="value with spaces"'];
  const intercepted = await run(manifest.executable, nativeArgs, { cwd: dir, env, input: "desktop-frame\n" });
  assert.equal(intercepted.code, 0, intercepted.stderr);
  assert.deepEqual(JSON.parse(intercepted.stdout).args, ["--config", manifest.configFile, "--", ...nativeArgs]);
  assert.equal(JSON.parse(intercepted.stdout).input, "desktop-frame\n");
  assert.throws(() => stageDesktopBridge(config, output, { compiler: windowsCompiler }), /must be empty/);
});

test("native shim flushes interactive request/reply frames before stdin EOF", { skip: !supported }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-native-interactive-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const fixture = path.join(dir, "interactive.cjs");
  fs.writeFileSync(fixture, "const timer=setTimeout(()=>process.exit(97),5000);let s='';process.stdin.on('data',b=>{s+=b;let i;while((i=s.indexOf('\\n'))>=0){process.stdout.write(JSON.stringify({reply:s.slice(0,i)})+'\\n');s=s.slice(i+1)}});process.stdin.on('end',()=>clearTimeout(timer));");
  const config = { schema: "codex-desktop-owned-bridge-v1", realCliPath: process.execPath, nodePath: process.execPath, bridgePath: fixture, tokenFile: path.join(dir, "unused-token"), statusFile: path.join(dir, "unused-status"), port: 4511 };
  const manifest = stageDesktopBridge(config, path.join(dir, "candidate"), { compiler: windowsCompiler });
  const child = spawn(manifest.executable, ["app-server"], { cwd: dir, shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  child.stderr.resume();
  let stdout = "", receivedBeforeEof = false;
  child.stdout.on("data", chunk => { stdout += chunk; if (stdout.includes("\n")) { receivedBeforeEof = !child.stdin.writableEnded; child.stdin.end(); } });
  const closed = new Promise((resolve, reject) => { child.on("error", reject); child.on("close", resolve); });
  child.stdin.write("interactive frame\n");
  const code = await closed;
  assert.equal(code, 0);
  assert.equal(receivedBeforeEof, true);
  assert.deepEqual(JSON.parse(stdout), { reply: "interactive frame" });
});

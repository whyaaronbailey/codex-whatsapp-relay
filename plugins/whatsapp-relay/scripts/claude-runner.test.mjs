import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { startClaudeTurn, listClaudeThreads, resolveClaudeLaunch } from "./claude-runner.mjs";

async function fixture(t) {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "relay-claude-"));
  t.after(() => fs.rm(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const claudeConfigDir = path.join(workspace, "config");
  const claudeBin = path.join(workspace, "mock-claude.mjs");
  await fs.writeFile(claudeBin, `
    import fs from 'node:fs/promises';
    import path from 'node:path';
    import {spawn} from 'node:child_process';
    const args=process.argv.slice(2);
    const id=args[args.indexOf(args.includes('--resume')?'--resume':'--session-id')+1];
    const send=r=>process.stdout.write(JSON.stringify(r)+'\\n');
    let prompt=''; for await(const chunk of process.stdin)prompt+=chunk;
    const mode=prompt;
    if(mode==='startup-hang'){setInterval(()=>{},1000);}
    else if(mode==='invalid-json'){process.stdout.write('not json\\n');setInterval(()=>{},1000);}
    else if(mode==='oversized'){process.stdout.write('x'.repeat(8*1024*1024+1));setInterval(()=>{},1000);}
    else if(mode==='empty'){}
    else if(mode==='exit-error'){process.stderr.write('Authentication required');process.exitCode=3;}
    else {
      send({type:'system',subtype:'init',session_id:id});
      if(mode==='hang'||mode==='tree-hang'){
        const tool=mode==='tree-hang'?spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true}):null;
        await fs.writeFile(path.join(process.cwd(),'started'),JSON.stringify({pid:process.pid,tool:tool?.pid}));setInterval(()=>{},1000);
      }
      else {
        send({type:'assistant',session_id:id,parent_tool_use_id:'child-tool',message:{id:'hidden',content:[{type:'text',text:'Subagent text'}]}});
        send({type:'assistant',session_id:id,message:{id:'main',content:[{type:'text',text:'Working 🎤'}]}});
        const result={type:'result',subtype:'success',is_error:false,session_id:id,
          result:JSON.stringify({prompt,args,cwd:process.cwd(),config:process.env.CLAUDE_CONFIG_DIR})};
        if(mode==='denied')result.permission_denials=[{tool_name:'Bash'}];
        if(mode==='bad-result')delete result.result;
        if(mode==='wrong-session')result.session_id='other';
        if(mode==='model-error'){result.is_error=true;result.subtype='error_during_execution';result.errors=['Rate limit reached'];}
        if(mode==='auth-error'){
          send({type:'assistant',session_id:id,error:'authentication_failed',isApiErrorMessage:true,message:{content:[{type:'text',text:'Failed to authenticate: OAuth session expired and could not be refreshed'}]}});
          result.is_error=true;result.subtype='error_during_execution';result.result='Failed to authenticate: OAuth session expired and could not be refreshed';result.errors=[];process.exitCode=1;
        }
        const wire=JSON.stringify(result);
        if(mode==='split-unicode'){
          const b=Buffer.from(JSON.stringify({...result,result:'Hello 🎤'}));
          const n=b.indexOf(Buffer.from('🎤'))+2;process.stdout.write(b.subarray(0,n));setTimeout(()=>process.stdout.write(b.subarray(n)),5);
        } else if(mode==='no-newline')process.stdout.write(wire);
        else {send(result);if(mode==='double-result')send(result);}
        if(mode==='result-hang')setInterval(()=>{},1000);
      }
    }
  `);
  return { workspace, claudeConfigDir, claudeBin };
}

async function transcript(config, { id = randomUUID(), cwd = config.workspace, title = "Saved session", prompt = "First native prompt", malformed = false, sidechain = false } = {}) {
  const directory = path.join(config.claudeConfigDir, "projects", config.workspace.replace(/[^a-zA-Z0-9]/g, "-"));
  await fs.mkdir(directory, { recursive: true });
  const file = path.join(directory, `${id}.jsonl`);
  await fs.writeFile(file, [malformed ? "{broken json" : "",
    JSON.stringify({ type: "user", sessionId: id, cwd, timestamp: "2026-01-01T01:00:00Z", isSidechain: sidechain, message: { content: prompt } }),
    JSON.stringify({ type: "custom-title", sessionId: id, customTitle: title })].join("\n") + "\n");
  return { id, file };
}

test("Claude starts a native session with stdin and preserves native configuration", async t => {
  const config = await fixture(t);
  const events = [];
  const prompt = '--resume forged ; $(echo private) `text` "🎤"';
  const run = startClaudeTurn({ ...config, prompt, onLifecycleEvent: event => events.push(event), threadName: "WhatsApp work" });
  const result = await run.resultPromise;
  const payload = JSON.parse(result.replyText);
  assert.equal(payload.prompt, prompt);
  assert.equal(payload.config, config.claudeConfigDir);
  assert.equal(payload.cwd.toLowerCase(), config.workspace.toLowerCase());
  assert.ok(payload.args.includes("--session-id"));
  assert.equal(payload.args[payload.args.indexOf("--session-id") + 1], result.threadId);
  assert.equal(payload.args[payload.args.indexOf("--permission-prompts") + 1], "none");
  assert.equal(payload.args[payload.args.indexOf("--name") + 1], "WhatsApp work");
  for (const flag of ["--continue", "--dangerously-skip-permissions", "--permission-mode", "--bare", "--safe-mode", "--strict-mcp-config"]) assert.ok(!payload.args.includes(flag));
  assert.deepEqual(events.map(e => e.type), ["turnStarted", "agentMessageCompleted", "turnCompleted"]);
  assert.equal(events[1].text, "Working 🎤");
});

test("Claude lists only matching native workspace transcripts and resumes their immutable ID", async t => {
  const config = await fixture(t);
  const saved = await transcript(config, { malformed: true });
  await transcript(config, { cwd: path.join(config.workspace, "other") });
  await transcript(config, { sidechain: true });
  const list = await listClaudeThreads(config);
  assert.equal(list.length, 1);
  assert.equal(list[0].id, saved.id);
  assert.equal(list[0].name, "Saved session");
  assert.equal(list[0].preview, "First native prompt");
  const result = await startClaudeTurn({ ...config, prompt: "continue", threadId: saved.id }).resultPromise;
  const { args } = JSON.parse(result.replyText);
  assert.equal(args[args.indexOf("--resume") + 1], saved.id);
  assert.ok(!args.includes("--continue"));
  assert.equal(result.threadId, saved.id);
});

test("Claude rejects wrong-workspace and missing resumes before spawning", async t => {
  const config = await fixture(t);
  const wrong = await transcript(config, { cwd: path.join(config.workspace, "elsewhere") });
  let spawns = 0;
  const base = { ...config, prompt: "continue", spawnProcess: () => { spawns++; } };
  assert.throws(() => startClaudeTurn({ ...base, threadId: wrong.id }), /not found in this workspace/);
  assert.throws(() => startClaudeTurn({ ...base, threadId: randomUUID() }), /not found in this workspace/);
  assert.throws(() => startClaudeTurn({ ...base, threadId: "../../outside" }), /UUID/);
  assert.equal(spawns, 0);
});

test("Claude host discovery reads indexed directories and returns newest native metadata across workspaces", async t => {
  const config = await fixture(t);
  const otherWorkspace = path.join(config.workspace, "other-native-project");
  const first = await transcript(config, { title: "Older project session" });
  const second = await transcript({ ...config, workspace: otherWorkspace }, { title: "Newest native session" });
  await fs.utimes(first.file, new Date("2026-01-01"), new Date("2026-01-01"));
  await fs.utimes(second.file, new Date("2026-01-02"), new Date("2026-01-02"));
  await transcript(config, { cwd: "relative-project" });
  await transcript(config, { cwd: otherWorkspace + "\n" });
  if (process.platform === "win32") await transcript(config, { cwd: "\\folder" });
  await transcript(config, { sidechain: true });
  const rows = await listClaudeThreads({ ...config, scope: "host", limit: 200 });
  assert.deepEqual(rows.map(row => [row.id, row.cwd, row.name]), [
    [second.id, otherWorkspace, "Newest native session"], [first.id, config.workspace, "Older project session"]
  ]);
  assert.ok(rows.every(row => !Object.hasOwn(row, "status")), "saved transcripts do not prove whether a session is running");
  assert.deepEqual((await listClaudeThreads(config)).map(row => row.id), [first.id]);
  assert.equal((await listClaudeThreads({ ...config, scope: "host", limit: 1 }))[0].id, second.id);
  await assert.rejects(listClaudeThreads({ ...config, scope: "typo" }), /scope/);
});

test("Claude host discovery caps results at 200 and ignores linked project directories", async t => {
  const config = await fixture(t);
  await Promise.all(Array.from({ length: 205 }, () => transcript(config)));
  const external = { ...config, claudeConfigDir: path.join(config.workspace, "external-config") };
  const linked = await transcript(external, { title: "Must not follow linked index" });
  await fs.symlink(path.dirname(linked.file), path.join(config.claudeConfigDir, "projects", "linked-project"), process.platform === "win32" ? "junction" : "dir");
  const rows = await listClaudeThreads({ ...config, scope: "host", limit: 1000 });
  assert.equal(rows.length, 200);
  assert.ok(rows.every(row => row.id !== linked.id));
});

test("Claude permission mappings never request a bypass and surface native denials", async t => {
  const config = await fixture(t);
  for (const [permissionLevel, expected] of [["read-only", "plan"], ["workspace-write", "acceptEdits"]]) {
    const result = await startClaudeTurn({ ...config, prompt: "permission", permissionLevel }).resultPromise;
    const { args } = JSON.parse(result.replyText);
    assert.equal(args[args.indexOf("--permission-mode") + 1], expected);
  }
  assert.throws(() => startClaudeTurn({ ...config, prompt: "unsafe", permissionLevel: "danger-full-access" }), /bypass is not supported/);
  assert.throws(() => startClaudeTurn({ ...config, prompt: "unsafe", permissionLevel: "typo" }), /bypass is not supported/);
  const run = startClaudeTurn({ ...config, prompt: "denied" });
  assert.match((await run.resultPromise).replyText, /denied.*permissions[\s\S]*native Claude Code/);
  await assert.rejects(run.answerApproval("request", "accept"), /not supported/);
});

for (const [prompt, error] of [
  ["invalid-json", /invalid JSON/], ["oversized", /size limit/], ["empty", /without a structured result/],
  ["exit-error", /Authentication required/], ["bad-result", /missing its response/],
  ["wrong-session", /different session ID/], ["double-result", /more than one result/],
  ["model-error", /Rate limit/], ["startup-hang", /startup timeout/], ["result-hang", /did not exit/]
]) {
  test(`Claude fails and cleans up ${prompt}`, async t => {
    const config = await fixture(t);
    const run = startClaudeTurn({ ...config, prompt, startupTimeoutMs: prompt === "startup-hang" ? 100 : 3_000, shutdownTimeoutMs: 200 });
    await assert.rejects(run.resultPromise, error);
    // Let close reap the process; no ongoing model/tool process is retained.
    if (run.child.exitCode === null && run.child.signalCode === null && run.child.pid) {
      await new Promise(resolve => { run.child.once("close", resolve); setTimeout(resolve, 1_000); });
    }
    assert.ok(run.child.exitCode !== null || run.child.signalCode !== null);
  });
}

test("Claude preserves split UTF-8 and a final envelope without newline", async t => {
  const config = await fixture(t);
  assert.equal((await startClaudeTurn({ ...config, prompt: "split-unicode" }).resultPromise).replyText, "Hello 🎤");
  assert.equal(JSON.parse((await startClaudeTurn({ ...config, prompt: "no-newline" }).resultPromise).replyText).prompt, "no-newline");
});

test("Claude interruption and abort stop the owned process and reject the run", async t => {
  const config = await fixture(t);
  for (const abort of [false, true]) {
    const controller = new AbortController();
    const run = startClaudeTurn({ ...config, prompt: "hang", signal: controller.signal, shutdownTimeoutMs: 300 });
    const failure = assert.rejects(run.resultPromise, error => error.code === "INTERRUPTED");
    if (abort) controller.abort(); else await run.interrupt();
    await failure;
    await run.interrupt(); // idempotent after completion
  }
});

test("Claude spawn errors and already aborted requests fail cleanly", async t => {
  const config = await fixture(t);
  await assert.rejects(startClaudeTurn({ ...config, claudeBin: path.join(config.workspace, "missing.exe"), prompt: "hello" }).resultPromise, /ENOENT/);
  assert.throws(() => startClaudeTurn({ ...config, prompt: "hello", signal: AbortSignal.abort() }), /interrupted before startup/);
});

test("Claude preserves structured authentication errors on exit 1 and the native session ID", async t => {
  const config = await fixture(t);
  let started;
  const run = startClaudeTurn({ ...config, prompt: "auth-error", onLifecycleEvent: event => { if (event.type === "turnStarted") started = event.threadId; } });
  await assert.rejects(run.resultPromise, error => {
    assert.match(error.message, /OAuth session expired/);
    assert.equal(error.code, "authentication_failed");
    assert.equal(error.threadId, started);
    return true;
  });
});

test("Claude interruption cleans up a running tool process too", async t => {
  const config = await fixture(t);
  const run = startClaudeTurn({ ...config, prompt: "tree-hang", shutdownTimeoutMs: 500 });
  const failure = assert.rejects(run.resultPromise, /interrupted/);
  let record;
  for (let attempt = 0; attempt < 100 && !record; attempt++) {
    try { record = JSON.parse(await fs.readFile(path.join(config.workspace, "started"), "utf8")); }
    catch { await new Promise(resolve => setTimeout(resolve, 25)); }
  }
  assert.ok(record?.tool, "mock tool started");
  await run.interrupt();
  await failure;
  let alive = true;
  for (let attempt = 0; attempt < 40 && alive; attempt++) {
    try { process.kill(record.tool, 0); await new Promise(resolve => setTimeout(resolve, 25)); }
    catch { alive = false; }
  }
  assert.equal(alive, false, "tool child is no longer running");
});

test("Claude lifecycle callback failures reject and stop the run", async t => {
  const config = await fixture(t);
  const run = startClaudeTurn({ ...config, prompt: "hang", onLifecycleEvent: () => { throw new Error("delivery disconnected"); } });
  await assert.rejects(run.resultPromise, /delivery disconnected/);
});

test("Claude Windows npm launcher is resolved without invoking a command shell", () => {
  const shim = "C:\\bin\\claude.cmd";
  const launcher = "C:\\bin\\node_modules\\@anthropic-ai\\claude-code\\cli.js";
  assert.deepEqual(resolveClaudeLaunch(shim, { platform: "win32", execPath: "node.exe", fileExists: p => [shim, launcher].includes(p) }), { command: "node.exe", argsPrefix: [launcher] });
  assert.throws(() => resolveClaudeLaunch("C:\\bin\\unknown.cmd", { platform: "win32", fileExists: () => false }), /safely launch/);
});

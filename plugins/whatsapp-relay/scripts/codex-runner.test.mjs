import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  buildProjectIntentPrompt,
  buildVoiceCommandIntentPrompt,
  normalizeCodexTurnNotification,
  normalizeProjectIntentSelection,
  normalizeVoiceCommandIntent,
  listCodexThreads,
  startCodexTurn,
  classifyProjectIntent
} from "./codex-runner.mjs";

async function makeMockCodex(t) {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "relay-codex-test-"));
  t.after(() => fs.rm(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }));
  const codexBin = path.join(workspace, "mock-codex.mjs");
  await fs.writeFile(codexBin, `
    import readline from 'node:readline';
    import fs from 'node:fs/promises';
    const args=process.argv.slice(2);
    if(args[0]==='exec') {
      await fs.writeFile(args[args.indexOf('-o')+1],JSON.stringify({outcome:'match',projectAlias:'main',candidateAliases:[]}));
      process.exit(0);
    }
    let initialized=false;
    let thread='native-thread';
    const send=(...messages)=>process.stdout.write(messages.map(x=>JSON.stringify(x)).join('\\n')+'\\n');
    const done=()=>send(
      {method:'item/completed',params:{turnId:'turn-1',item:{type:'agentMessage',id:'message-1',phase:'final_answer',text:'Native reply 🎤'}}},
      {method:'turn/completed',params:{threadId:thread,turn:{id:'turn-1',status:'completed'}}}
    );
    for await(const line of readline.createInterface({input:process.stdin})) {
      const message=JSON.parse(line);
      const reply=result=>send({id:message.id,result});
      if(message.method==='initialized'){initialized=true;continue;}
      if(message.method==='initialize'){reply({});continue;}
      if(!initialized){send({id:message.id,error:{message:'initialized notification missing'}});continue;}
      switch(message.method){
        case 'thread/list': reply({data:[{id:'saved-thread',preview:JSON.stringify({cwd:process.cwd(),home:process.env.CODEX_HOME??null,args,listParams:message.params})}]});break;
        case 'configRequirements/read':reply({requirements:null});break;
        case 'thread/name/set':reply({});break;
        case 'thread/start':reply({thread:{id:thread,status:{type:'idle'}}});break;
        case 'thread/resume':thread=message.params.threadId;reply({thread:{id:thread,status:{type:thread==='busy-thread'?'active':'idle'}}});break;
        case 'turn/start':
          if(message.params.input[0].text==='coalesced'){
            send({id:message.id,result:{turn:{id:'turn-1'}}},
              {method:'item/completed',params:{turnId:'turn-1',item:{type:'agentMessage',id:'message-1',phase:'final_answer',text:'Immediate reply'}}},
              {method:'turn/completed',params:{threadId:thread,turn:{id:'turn-1',status:'completed'}}});
          } else if(message.params.input[0].text==='wait'){
            reply({turn:{id:'turn-1'}});
          } else {
            send({id:message.id,result:{turn:{id:'turn-1'}}},
              {id:'approval-1',method:'item/commandExecution/requestApproval',params:{threadId:thread,turnId:'turn-1',itemId:'command-1',command:message.params.input[0].text}});
          }
          break;
        case 'turn/interrupt':
          if(message.params.threadId!==thread||message.params.turnId!=='turn-1'){
            send({id:message.id,error:{message:'Incorrect interrupt target'}});break;
          }
          reply({});
          // Acknowledgment and terminal notification are independent protocol
          // messages. Keep them in separate reads to exercise the shutdown race.
          setTimeout(()=>send({method:'turn/completed',params:{threadId:thread,turn:{id:'turn-1',status:'interrupted'}}}),50);
          break;
        default:
          if(message.id==='approval-1'&&message.result?.decision==='accept'){
            send({method:'serverRequest/resolved',params:{threadId:thread,turnId:'turn-1',requestId:'approval-1'}});done();
          } else send({id:message.id,error:{message:'Unexpected method'}});
      }
    }
  `);
  return { workspace, codexBin };
}

test("native Codex listing inherits the user's context and completes the app-server handshake", { timeout: 5000 }, async (t) => {
  const fixture = await makeMockCodex(t);
  const [thread] = await listCodexThreads({ ...fixture });
  const preview = JSON.parse(thread.preview);
  assert.equal(thread.id, "saved-thread");
  assert.equal(preview.cwd, fixture.workspace);
  assert.equal(preview.home, process.env.CODEX_HOME ?? null);
  assert.equal(preview.args[0], "app-server");
  assert.deepEqual(preview.listParams.sourceKinds, ["cli", "vscode", "exec", "appServer"]);
  assert.equal(preview.listParams.sortKey, "updated_at");
  assert.deepEqual(preview.listParams.cwd, process.platform === "win32"
    ? [fixture.workspace, fixture.workspace.replaceAll("\\", "/")]
    : fixture.workspace);
});

test("native session discovery refuses an unscoped relative workspace", async () => {
  await assert.rejects(listCodexThreads({ workspace: "relative-directory" }), /absolute workspace/);
});

test("native resume forwards approvals and returns lifecycle events and Unicode reply", { timeout: 5000 }, async (t) => {
  const fixture = await makeMockCodex(t);
  const approvals = [];
  const events = [];
  const prompt = "Write file $(literal) & quoted 'text' 🎤";
  let run;
  let approvalPromise;
  run = startCodexTurn({ ...fixture, threadId: "existing-native-thread", prompt,
    onApprovalRequest(approval) { approvals.push(approval); approvalPromise = run.answerApproval(approval.requestId, "accept"); },
    onLifecycleEvent(event) { events.push(event); }
  });
  t.after(() => run.child.kill());
  const result = await run.resultPromise;
  await approvalPromise;
  assert.deepEqual(result, { threadId: "existing-native-thread", replyText: "Native reply 🎤" });
  assert.equal(approvals[0].command, prompt);
  assert.ok(events.some((event) => event.type === "approvalRequested"));
  assert.ok(events.some((event) => event.type === "approvalResolved"));
  assert.ok(events.some((event) => event.type === "turnCompleted"));
});

test("coalesced turn/start response and completion cannot lose the first native events", { timeout: 5000 }, async (t) => {
  const fixture = await makeMockCodex(t);
  const run = startCodexTurn({ ...fixture, prompt: "coalesced" });
  t.after(() => run.child.kill());
  assert.deepEqual(await run.resultPromise, { threadId: "native-thread", replyText: "Immediate reply" });
});

test("resume rejects a thread that app-server reports as active", { timeout: 5000 }, async (t) => {
  const fixture = await makeMockCodex(t);
  const run = startCodexTurn({ ...fixture, threadId: "busy-thread", prompt: "Do not start" });
  t.after(() => run.child.kill());
  await assert.rejects(run.resultPromise, /already running/);
});

test("native interrupt targets the selected thread and turn", { timeout: 5000 }, async (t) => {
  const fixture = await makeMockCodex(t);
  let run;
  let resolveStarted;
  const events = [];
  const started = new Promise((resolve) => { resolveStarted = resolve; });
  run = startCodexTurn({ ...fixture, prompt: "wait", onLifecycleEvent(event) { events.push(event); if (event.type === "turnStarted") resolveStarted(); } });
  t.after(() => run.child.kill());
  const rejected = assert.rejects(run.resultPromise, /interrupted/);
  await started;
  await run.interrupt();
  await rejected;
  assert.ok(events.some((event) => event.type === "turnCompleted" && event.status === "interrupted"));
});

test("classification uses the configured local host executable", { timeout: 5000 }, async (t) => {
  const fixture = await makeMockCodex(t);
  const result = await classifyProjectIntent({ workspace: fixture.workspace, codexBin: "deliberately-missing", host: { id: "host", transport: "local", codexBin: fixture.codexBin }, intent: "main", projects: [{ alias: "main" }] });
  assert.equal(result.projectAlias, "main");
});

test("buildVoiceCommandIntentPrompt includes project context for Codex classification", () => {
  const prompt = buildVoiceCommandIntentPrompt({
    transcript: "switch to alpha app",
    activeProjectAlias: "current-project",
    projects: [
      { alias: "current-project", workspace: "/workspace/current-project" },
      { alias: "alpha-app", workspace: "/workspace/alpha-app" }
    ]
  });

  assert.match(prompt, /Active project:\ncurrent-project/);
  assert.match(prompt, /Known projects:/);
  assert.match(prompt, /- alpha-app/);
  assert.match(prompt, /Transcript:\nswitch to alpha app/);
  assert.match(prompt, /workspace write/);
  assert.match(prompt, /read only/);
  assert.doesNotMatch(prompt, /workspace\/alpha-app/);
});

test("normalizeVoiceCommandIntent converts structured project controls into bridge commands", () => {
  assert.deepEqual(
    normalizeVoiceCommandIntent(
      { type: "project", payload: "alpha app" },
      "switch to alpha app"
    ),
    { type: "project", payload: "alpha app" }
  );

  assert.deepEqual(
    normalizeVoiceCommandIntent(
      { type: "sessions", payload: "alpha app" },
      "list sessions for alpha app"
    ),
    { type: "sessions", payload: "alpha app" }
  );

  assert.deepEqual(
    normalizeVoiceCommandIntent(
      { type: "connect", payload: "alpha app 2" },
      "session alpha app 2"
    ),
    { type: "connect", payload: "alpha app 2" }
  );

  assert.deepEqual(
    normalizeVoiceCommandIntent(
      { type: "permissions", payload: "ww" },
      "workspace write"
    ),
    { type: "permissions", payload: "ww" }
  );
});

test("normalizeVoiceCommandIntent falls back to a normal prompt when classification is invalid", () => {
  assert.deepEqual(
    normalizeVoiceCommandIntent(
      { type: "project" },
      "switch to alpha app"
    ),
    { type: "prompt", prompt: "switch to alpha app" }
  );

  assert.deepEqual(
    normalizeVoiceCommandIntent(
      { type: "prompt" },
      "please fix the checkout button"
    ),
    { type: "prompt", prompt: "please fix the checkout button" }
  );

  assert.deepEqual(
    normalizeVoiceCommandIntent(
      { type: "prompt", prompt: "please fix the checkout button" },
      "please fix the checkout button",
      false
    ),
    { type: "ignored" }
  );
});

test("buildProjectIntentPrompt includes known project aliases and the raw hint", () => {
  const prompt = buildProjectIntentPrompt({
    intent: "blood project",
    activeProjectAlias: "main",
    projects: [
      { alias: "main", workspace: "/workspace/main" },
      { alias: "sample-service", workspace: "/workspace/sample-service" }
    ]
  });

  assert.match(prompt, /Active project:\nmain/);
  assert.match(prompt, /Known projects:/);
  assert.match(prompt, /- sample-service \(repo: sample-service\)/);
  assert.match(prompt, /Hint:\nblood project/);
  assert.doesNotMatch(prompt, /workspace\/sample-service/);
  assert.match(prompt, /Prefer `noMatch` over guessing/);
});

test("normalizeProjectIntentSelection accepts only known aliases", () => {
  const projects = [
    { alias: "main", workspace: "/workspace/main" },
    { alias: "sample-service", workspace: "/workspace/sample-service" },
    { alias: "sample-web", workspace: "/workspace/sample-web" }
  ];

  assert.deepEqual(
    normalizeProjectIntentSelection(
      { outcome: "match", projectAlias: "sample-service", candidateAliases: [] },
      projects
    ),
    {
      outcome: "match",
      projectAlias: "sample-service",
      candidateAliases: []
    }
  );

  assert.deepEqual(
    normalizeProjectIntentSelection(
      {
        outcome: "ambiguous",
        projectAlias: null,
        candidateAliases: ["sample-service", "unknown-project", "sample-web"]
      },
      projects
    ),
    {
      outcome: "ambiguous",
      projectAlias: null,
      candidateAliases: ["sample-service", "sample-web"]
    }
  );

  assert.deepEqual(
    normalizeProjectIntentSelection(
      { outcome: "match", projectAlias: "invented-project", candidateAliases: [] },
      projects
    ),
    {
      outcome: "noMatch",
      projectAlias: null,
      candidateAliases: []
    }
  );
});

test("normalizeCodexTurnNotification normalizes matching agent and turn events", () => {
  assert.deepEqual(
    normalizeCodexTurnNotification(
      {
        method: "item/started",
        params: {
          turnId: "turn-1",
          item: {
            type: "agentMessage",
            id: "msg-1",
            phase: "analysis",
            text: "Reviewing the failing tests"
          }
        }
      },
      { activeTurnId: "turn-1", resolvedThreadId: "thread-1" }
    ),
    {
      type: "agentMessageStarted",
      turnId: "turn-1",
      itemId: "msg-1",
      phase: "analysis",
      text: "Reviewing the failing tests"
    }
  );

  assert.deepEqual(
    normalizeCodexTurnNotification(
      {
        method: "turn/completed",
        params: {
          turn: {
            id: "turn-1",
            status: "completed",
            error: null
          }
        }
      },
      { activeTurnId: "turn-1", resolvedThreadId: "thread-1" }
    ),
    {
      type: "turnCompleted",
      turnId: "turn-1",
      threadId: "thread-1",
      status: "completed",
      error: null
    }
  );
});

test("normalizeCodexTurnNotification ignores unrelated turns and threads", () => {
  assert.equal(
    normalizeCodexTurnNotification(
      {
        method: "item/agentMessage/delta",
        params: {
          turnId: "turn-other",
          itemId: "msg-1",
          delta: "hello"
        }
      },
      { activeTurnId: "turn-1", resolvedThreadId: "thread-1" }
    ),
    null
  );

  assert.equal(
    normalizeCodexTurnNotification(
      {
        method: "serverRequest/resolved",
        params: {
          threadId: "thread-other",
          requestId: 42
        }
      },
      { activeTurnId: "turn-1", resolvedThreadId: "thread-1" }
    ),
    null
  );
});

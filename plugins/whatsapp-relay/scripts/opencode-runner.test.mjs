import assert from "node:assert/strict";
import test from "node:test";
import { listOpenCodeThreads, startOpenCodeTurn } from "./opencode-runner.mjs";

const workspace = "C:\\Projects\\example";
const session = { id: "ses_example", location: { directory: workspace }, title: "Native session", time: { created: 1000, updated: 2000 }, permissions: [{ action: "*", resource: "*", effect: "deny" }] };
const successfulTimeline = [
  { id: "idle_1", type: "idle", outcome: "succeeded" },
  { id: "assistant_1", type: "assistant", content: [{ type: "text", text: "Finished the requested work." }] },
  { id: "msg_prompt", type: "user" }
];

function fixture(overrides = {}) {
  const requests = [];
  let admitted = false;
  const fetchImpl = async (url, init) => {
    const route = new URL(url);
    const call = { method: init.method, path: route.pathname, search: route.searchParams, body: init.body === undefined ? undefined : JSON.parse(init.body), headers: init.headers, redirect: init.redirect };
    requests.push(call);
    const key = `${call.method} ${call.path}`;
    if (Object.hasOwn(overrides, key)) {
      const response = await overrides[key](call, { admitted, requests });
      if (response instanceof Response) return response;
      return Response.json(response);
    }
    switch (key) {
      case "GET /api/info": return Response.json({ version: "2.0.27" });
      case "GET /api/session": return Response.json({ data: [session] });
      case "POST /api/session": return Response.json({ data: session });
      case "GET /api/session/ses_example": return Response.json({ data: session });
      case "GET /api/session/active": return Response.json({ data: {} });
      case "GET /api/session/ses_example/permission":
      case "GET /api/session/ses_example/form":
      case "GET /api/session/ses_example/inbox": return Response.json({ data: [] });
      case "POST /api/session/ses_example/prompt": admitted = true; return Response.json({ data: { id: "msg_prompt" } });
      case "GET /api/session/ses_example/message": return Response.json({ data: successfulTimeline });
      case "POST /api/session/ses_example/interrupt": return Response.json({ interrupted: true });
      default: throw new Error(`Unexpected fixture request: ${key}`);
    }
  };
  return { requests, options: { opencodeUrl: "http://127.0.0.1:4096", workspace, prompt: "Do the requested work", env: {}, fetchImpl, pollIntervalMs: 1, requestTimeoutMs: 100 } };
}

test("OpenCode v2 lists only this workspace and normalizes native session metadata", async () => {
  const { options, requests } = fixture({ "GET /api/session": () => ({ data: [session, { ...session, id: "ses_other", location: { directory: "C:\\Other" } }] }) });
  const result = await listOpenCodeThreads(options);
  assert.equal(result.length, 1);
  assert.equal(result[0].id, session.id);
  assert.equal(result[0].name, session.title);
  assert.equal(result[0].updatedAt, 2);
  assert.equal(requests[1].search.get("directory"), workspace);
  assert.ok(requests.every((request) => request.method === "GET"));
});

test("OpenCode preserves existing policies and identifies its exact native prompt", async () => {
  const { options, requests } = fixture();
  const events = [];
  const result = await startOpenCodeTurn({ ...options, threadName: "WhatsApp work", onLifecycleEvent: (event) => events.push(event) }).resultPromise;
  assert.deepEqual(result, { threadId: session.id, replyText: "Finished the requested work." });
  const create = requests.find((item) => item.method === "POST" && item.path === "/api/session");
  assert.deepEqual(create.body, { title: "WhatsApp work", location: { directory: workspace } });
  assert.equal(requests.filter((item) => item.path.endsWith("/prompt")).length, 1);
  assert.ok(!requests.some((item) => item.method === "PATCH"));
  assert.ok(events.some((item) => item.type === "turnStarted" && item.turnId === "msg_prompt"));
  assert.equal(events.at(-1).status, "completed");
});

test("OpenCode model/agent overrides only apply explicitly to a new session", async () => {
  const { options, requests } = fixture();
  await startOpenCodeTurn({ ...options, model: "provider/model/submodel", profile: "build" }).resultPromise;
  const created = requests.find((item) => item.method === "POST" && item.path === "/api/session");
  assert.deepEqual(created.body.model, { providerID: "provider", id: "model/submodel" });
  assert.equal(created.body.agent, "build");
});

test("OpenCode refuses Codex sandbox labels instead of widening native policy", () => {
  for (const permissionLevel of ["read-only", "workspace-write", "danger-full-access"]) {
    assert.throws(() => startOpenCodeTurn({ ...fixture().options, permissionLevel }), /native permissions/);
  }
});

test("OpenCode rejects a resumed session outside the selected workspace", async () => {
  const { options, requests } = fixture();
  await assert.rejects(startOpenCodeTurn({ ...options, workspace: "C:\\Other", threadId: session.id }).resultPromise, /different workspace/);
  assert.ok(requests.every((item) => item.method === "GET"));
});

test("OpenCode preserves a resumed session's model and agent", async () => {
  const { options, requests } = fixture();
  await assert.rejects(startOpenCodeTurn({ ...options, threadId: session.id, model: "provider/new-model" }).resultPromise, /settings were preserved/);
  assert.ok(requests.every((item) => item.method === "GET"));
});

test("OpenCode refuses busy and queued native sessions before submitting", async () => {
  for (const overrides of [
    { "GET /api/session/active": () => ({ data: { [session.id]: { started: 1 } } }) },
    { "GET /api/session/ses_example/inbox": () => ({ data: [{ id: "other_prompt" }] }) }
  ]) {
    const { options, requests } = fixture(overrides);
    await assert.rejects(startOpenCodeTurn({ ...options, threadId: session.id }).resultPromise, /already running|queued work/);
    assert.ok(requests.every((item) => item.method === "GET"));
  }
});

test("OpenCode never retries uncertain prompt admission", async () => {
  const { options, requests } = fixture({ "POST /api/session/ses_example/prompt": () => { throw new Error("network lost after admission"); } });
  await assert.rejects(startOpenCodeTurn(options).resultPromise, /admission may have succeeded/);
  assert.equal(requests.filter((item) => item.path.endsWith("/prompt")).length, 1);
});

test("OpenCode waits for its exact prompt anchor and idle marker, following pagination", async () => {
  let pageReads = 0;
  const { options, requests } = fixture({
    "GET /api/session/ses_example/message": (call) => {
      pageReads++;
      if (pageReads === 1) return { data: [{ type: "idle", outcome: "succeeded", id: "old_idle" }] };
      return call.search.has("cursor") ? { data: successfulTimeline.slice(2) } : { data: successfulTimeline.slice(0, 2), cursor: { next: "opaque cursor" } };
    }
  });
  const result = await startOpenCodeTurn(options).resultPromise;
  assert.equal(result.replyText, "Finished the requested work.");
  const page = requests.find((item) => item.search.has("cursor"));
  assert.equal(page.search.get("cursor"), "opaque cursor");
  assert.equal(page.search.has("order"), false);
});

test("OpenCode rejects a second user's prompt before our idle marker", async () => {
  const { options } = fixture({ "GET /api/session/ses_example/message": () => ({ data: [successfulTimeline[0], { id: "msg_other", type: "user" }, ...successfulTimeline.slice(1)] }) });
  await assert.rejects(startOpenCodeTurn(options).resultPromise, /cannot be attributed safely/);
});

test("OpenCode does not infer success from a failed idle or empty answer", async () => {
  for (const timeline of [
    [{ ...successfulTimeline[0], outcome: "failed" }, ...successfulTimeline.slice(1)],
    [successfulTimeline[0], successfulTimeline[2]]
  ]) {
    const { options } = fixture({ "GET /api/session/ses_example/message": () => ({ data: timeline }) });
    await assert.rejects(startOpenCodeTurn(options).resultPromise, /outcome failed|without a visible answer/);
  }
});

test("OpenCode forwards one pending approval and only accepts explicit once grants", async () => {
  let approved = false;
  let answer;
  const { options, requests } = fixture({
    "GET /api/session/ses_example/permission": (_call, state) => ({ data: state.admitted && !approved ? [{ id: "per_request", sessionID: session.id, action: "bash", resources: ["git status"] }] : [] }),
    "GET /api/session/ses_example/message": () => ({ data: approved ? successfulTimeline : [successfulTimeline[2]] }),
    "POST /api/session/ses_example/permission/per_request/reply": () => { approved = true; return new Response(null, { status: 204 }); }
  });
  let resolveApproval;
  const approvalSeen = new Promise((resolve) => { resolveApproval = resolve; });
  const turn = startOpenCodeTurn({ ...options, onApprovalRequest: (approval) => { answer = approval; resolveApproval(); } });
  await approvalSeen;
  assert.deepEqual(answer.availableDecisions, ["accept", "decline", "cancel"]);
  await assert.rejects(turn.answerApproval(answer.requestId, "acceptForSession"), /persistent 'always' grants/);
  await turn.answerApproval(answer.requestId, "accept");
  await turn.resultPromise;
  assert.deepEqual(requests.find((item) => item.path.endsWith("/reply")).body, { decision: "once" });
  await assert.rejects(turn.answerApproval(answer.requestId, "accept"), /no longer active/);
});

test("OpenCode forms require the native UI and are never fabricated or approved", async () => {
  const { options, requests } = fixture({
    "GET /api/session/ses_example/form": (_call, state) => ({ data: state.admitted ? [{ id: "form_request" }] : [] }),
    "GET /api/session/ses_example/message": () => ({ data: [successfulTimeline[2]] })
  });
  await assert.rejects(startOpenCodeTurn(options).resultPromise, /Answer it in OpenCode\/OpenChamber/);
  assert.ok(!requests.some((item) => item.path.includes("form/") || item.path.includes("permission/")));
});

test("OpenCode interrupt cancels its own queued prompt without stopping another UI's execution", async () => {
  let admitted;
  const started = new Promise((resolve) => { admitted = resolve; });
  const { options, requests } = fixture({
    "GET /api/session/ses_example/inbox": (_call, state) => ({ data: state.admitted ? [{ id: "msg_prompt" }] : [] }),
    "GET /api/session/ses_example/message": () => ({ data: [{ type: "user", id: "another_ui_prompt" }] }),
    "DELETE /api/session/ses_example/inbox/msg_prompt": () => new Response(null, { status: 204 })
  });
  const turn = startOpenCodeTurn({ ...options, onLifecycleEvent: (event) => { if (event.turnId === "msg_prompt") admitted(); } });
  await started;
  await turn.interrupt();
  await assert.rejects(turn.resultPromise, /interrupted/);
  assert.ok(requests.some((item) => item.method === "DELETE" && item.path.endsWith("/inbox/msg_prompt")));
  assert.ok(!requests.some((item) => item.path.endsWith("/interrupt")));
});

test("OpenCode stop interrupts only a timeline still owned by its admitted prompt", async () => {
  for (const withOtherPrompt of [false, true]) {
    let admitted;
    const started = new Promise((resolve) => { admitted = resolve; });
    const { options, requests } = fixture({
      "GET /api/session/ses_example/message": () => ({ data: [...(withOtherPrompt ? [{ type: "user", id: "another_prompt" }] : []), successfulTimeline[2]] })
    });
    const turn = startOpenCodeTurn({ ...options, onLifecycleEvent: (event) => { if (event.turnId === "msg_prompt") admitted(); } });
    await started;
    await turn.interrupt();
    await assert.rejects(turn.resultPromise, /interrupted/);
    assert.equal(requests.some((item) => item.path.endsWith("/interrupt")), !withOtherPrompt);
  }
});

test("OpenCode auth uses named environment variables and forbids credential-bearing URLs", async () => {
  const { options, requests } = fixture();
  await listOpenCodeThreads({ ...options, opencodePasswordEnv: "RELAY_OC_PASSWORD", env: { RELAY_OC_PASSWORD: "test-private-password" } });
  assert.equal(requests[0].headers.Authorization, `Basic ${Buffer.from("opencode:test-private-password").toString("base64")}`);
  assert.ok(requests.every((item) => item.redirect === "error"));
  await assert.rejects(listOpenCodeThreads({ ...options, opencodeUrl: "http://user:secret@localhost:4096" }), /without embedded credentials/);
  await assert.rejects(listOpenCodeThreads({ ...options, opencodePasswordEnv: "invalid name" }), /environment variable names/);
});

test("OpenCode authentication failure never falls back to a different API", async () => {
  const { options, requests } = fixture({ "GET /api/info": () => new Response(null, { status: 401 }) });
  await assert.rejects(listOpenCodeThreads(options), /credential environment/);
  assert.equal(requests.length, 1);
});

test("OpenCode v1 supports native sessions, scoped requests and direct response attribution", async () => {
  const { options, requests } = fixture({
    "GET /api/info": () => new Response("missing", { status: 404 }),
    "GET /global/health": () => ({ healthy: true, version: "1.2.27" }),
    "GET /session": () => [{ id: session.id, directory: workspace, title: session.title, time: session.time }],
    "GET /session/ses_example": () => ({ id: session.id, directory: workspace }),
    "GET /session/status": () => ({}),
    "GET /permission": () => [],
    "GET /question": () => [],
    "POST /session/ses_example/message": () => ({ info: { role: "assistant" }, parts: [{ type: "text", text: "v1 reply" }] })
  });
  const sessions = await listOpenCodeThreads(options);
  assert.equal(sessions.length, 1);
  const result = await startOpenCodeTurn({ ...options, threadId: session.id }).resultPromise;
  assert.equal(result.replyText, "v1 reply");
  const message = requests.find((item) => item.method === "POST");
  assert.equal(message.search.get("directory"), workspace);
  assert.deepEqual(message.body, { parts: [{ type: "text", text: options.prompt }] });
});

test("OpenCode v1 fails before prompting when permission/question capability is absent", async () => {
  const { options, requests } = fixture({
    "GET /global/health": () => ({ healthy: true, version: "1.2.27" }),
    "GET /session/ses_example": () => ({ id: session.id, directory: workspace }),
    "GET /session/status": () => ({}),
    "GET /permission": () => new Response(null, { status: 404 })
  });
  await assert.rejects(startOpenCodeTurn({ ...options, opencodeApiVersion: "v1", threadId: session.id }).resultPromise, /HTTP 404/);
  assert.ok(requests.every((item) => item.method === "GET"));
});

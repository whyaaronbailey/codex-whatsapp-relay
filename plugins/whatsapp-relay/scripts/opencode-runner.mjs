import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

// Connect to the server already used by OpenCode/OpenChamber. This adapter never
// launches a second server, changes native permissions, or retries submissions.
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const SESSION_ID = /^ses_[A-Za-z0-9_-]+$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function workspacePath(workspace) {
  const paths = path.win32.isAbsolute(workspace ?? "") ? path.win32 : path.posix;
  if (typeof workspace !== "string" || !paths.isAbsolute(workspace)) {
    throw new Error("OpenCode requires an absolute workspace on the selected host.");
  }
  const normalized = paths.normalize(workspace).replace(/[\\/]$/, "");
  return paths === path.win32 ? normalized.toLowerCase() : normalized;
}

function sessionId(value) {
  if (!SESSION_ID.test(value ?? "")) throw new Error("OpenCode returned an invalid session ID.");
  return value;
}

function listData(value, v2, description) {
  const list = v2 ? value?.data : value;
  if (!Array.isArray(list)) throw new Error(`OpenCode returned an invalid ${description} response.`);
  return list;
}

function nativePermissions(level) {
  if (level !== undefined && level !== null && level !== "native") {
    throw new Error("OpenCode uses native permissions. Codex sandbox levels cannot be applied to an existing OpenCode server.");
  }
}

function modelRef(model, v2) {
  if (!model) return undefined;
  const index = model.indexOf("/");
  if (index < 1 || index === model.length - 1) {
    throw new Error("An OpenCode model override must use provider/model format.");
  }
  return { providerID: model.slice(0, index), [v2 ? "id" : "modelID"]: model.slice(index + 1) };
}

function createClient(options) {
  const { opencodeUrl, opencodeApiVersion = "auto", fetchImpl = fetch, env = process.env } = options;
  let base;
  try { base = new URL(opencodeUrl); } catch { throw new Error("Configure opencodeUrl for the existing OpenCode server."); }
  if (!["http:", "https:"].includes(base.protocol) || base.username || base.password || base.search || base.hash) {
    throw new Error("opencodeUrl must be an HTTP(S) URL without embedded credentials, query or fragment.");
  }
  if (!["auto", "v1", "v2"].includes(opencodeApiVersion)) throw new Error("opencodeApiVersion must be auto, v1 or v2.");
  const passwordName = options.opencodePasswordEnv ?? "OPENCODE_SERVER_PASSWORD";
  const usernameName = options.opencodeUsernameEnv ?? "OPENCODE_SERVER_USERNAME";
  if (!ENV_NAME.test(passwordName) || !ENV_NAME.test(usernameName)) throw new Error("OpenCode credential references must be environment variable names.");
  const password = env[passwordName];
  const headers = { Accept: "application/json" };
  if (password) headers.Authorization = `Basic ${Buffer.from(`${env[usernameName] || "opencode"}:${password}`).toString("base64")}`;
  const workspace = options.workspace;
  workspacePath(workspace);
  let v2;

  async function request(method, route, body, { timeoutMs = options.requestTimeoutMs ?? 15_000, signal = null, scoped = true } = {}) {
    const url = new URL(`${base.href.replace(/\/$/, "")}${route}`);
    if (v2 === false && scoped) url.searchParams.set("directory", workspace);
    const controller = new AbortController();
    const cancel = () => controller.abort();
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) controller.abort();
    const timer = setTimeout(cancel, timeoutMs);
    let response;
    try {
      response = await fetchImpl(url, {
        method, headers: { ...headers, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: controller.signal, redirect: "error"
      });
      if (!response.ok) {
        const error = new Error(`OpenCode ${method} ${url.pathname} failed (HTTP ${response.status}).${[401, 403].includes(response.status) ? " Check the configured credential environment on this host." : ""}`);
        error.status = response.status;
        throw error;
      }
      if (response.status === 204) return null;
      if (!response.headers.get("content-type")?.includes("application/json")) {
        const error = new Error("The OpenCode endpoint returned HTML or another non-JSON response; check its API version and URL.");
        error.notJson = true;
        throw error;
      }
      const reader = response.body.getReader();
      const chunks = [];
      let bytes = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.length;
        if (bytes > MAX_RESPONSE_BYTES) { controller.abort(); throw new Error("OpenCode response exceeds the relay size limit."); }
        chunks.push(Buffer.from(value));
      }
      try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
      catch { throw new Error("OpenCode returned invalid JSON."); }
    } catch (error) {
      // Fetch errors can contain a URL or credentials from the environment.
      if (error.status || error.notJson || error.message?.startsWith("OpenCode")) throw error;
      throw new Error(`OpenCode ${method} ${url.pathname} connection failed or timed out.`);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {});
    }
  }

  async function initialize() {
    if (v2 !== undefined) return;
    if (opencodeApiVersion !== "v1") {
      try {
        const info = await request("GET", "/api/info", undefined, { scoped: false });
        if (!/^2\./.test(info?.version ?? "")) throw new Error("OpenCode returned an unsupported API version.");
        v2 = true;
      } catch (error) {
        if (opencodeApiVersion === "v2" || (!error.notJson && error.status !== 404)) throw error;
      }
    }
    if (v2 === undefined) {
      const health = await request("GET", "/global/health", undefined, { scoped: false });
      if (health?.healthy !== true || !/^1\./.test(health?.version ?? "")) throw new Error("OpenCode v1 health check failed or the API version is unsupported.");
      v2 = false;
    }
  }
  return { initialize, request, get v2() { return v2; }, get prefix() { return v2 ? "/api" : ""; } };
}

export async function listOpenCodeThreads(options) {
  if (options.host?.transport === "ssh") throw new Error("Run the OpenCode adapter inside the selected host's relay worker.");
  const client = createClient(options);
  await client.initialize();
  const limit = Math.max(1, Math.min(100, options.limit ?? 20));
  const query = new URLSearchParams({ directory: options.workspace, limit: String(limit), ...(client.v2 ? { order: "desc" } : {}) });
  const response = await client.request("GET", `${client.prefix}/session?${query}`);
  const sessions = listData(response, client.v2, "sessions");
  const statuses = await client.request("GET", client.v2 ? "/api/session/active" : "/session/status");
  const active = client.v2 ? statuses?.data : statuses;
  if (!active || typeof active !== "object" || Array.isArray(active)) throw new Error("OpenCode returned invalid active-session status.");
  // Do not rely solely on the server's filter: v1 releases differ in behavior.
  return sessions.filter((item) => {
    const directory = client.v2 ? item.location?.directory : item.directory;
    return directory && workspacePath(directory) === workspacePath(options.workspace) && !item.time?.archived;
  }).slice(0, limit).map((item) => ({
    id: sessionId(item.id), name: item.title ?? null, preview: item.title ?? "OpenCode session",
    cwd: client.v2 ? item.location.directory : item.directory,
    createdAt: Math.floor((item.time?.created ?? 0) / 1000),
    updatedAt: Math.floor((item.time?.updated ?? 0) / 1000),
    status: { type: active[item.id] && (client.v2 || active[item.id].type !== "idle") ? "active" : "idle" }, engine: "opencode"
  }));
}

// V2 identifies admitted user inputs in its durable timeline. An idle flag alone
// cannot establish that our input was executed, or attribute another UI's reply.
async function readV2Turn(client, id, promptId) {
  const messages = [];
  let route = `/api/session/${id}/message?limit=200&order=desc`;
  const cursors = new Set();
  for (let page = 0; route && page < 100; page++) {
    const result = await client.request("GET", route);
    const data = listData(result, true, "messages");
    for (const message of data) {
      if (message.id === promptId) {
        if (message.type !== "user") throw new Error("OpenCode prompt ID matched a non-user timeline item.");
        return messages.reverse();
      }
      messages.push(message);
    }
    const next = result.cursor?.next;
    if (!next) return null;
    if (cursors.has(next)) throw new Error("OpenCode message pagination repeated a cursor.");
    cursors.add(next);
    route = `/api/session/${id}/message?limit=200&cursor=${encodeURIComponent(next)}`;
  }
  throw new Error("OpenCode prompt could not be located within 100 timeline pages; inspect the session before continuing.");
}

export function startOpenCodeTurn(options) {
  if (!options.prompt?.trim()) throw new Error("OpenCode prompt cannot be empty.");
  nativePermissions(options.permissionLevel);
  if (options.host?.transport === "ssh") throw new Error("Run the OpenCode adapter inside the selected host's relay worker.");
  if (options.threadId) sessionId(options.threadId);
  const client = createClient(options);
  const stopSignal = new AbortController();
  const pending = new Map();
  let resolvedThreadId = options.threadId ?? null;
  let promptId = null;
  let submitted = false;
  let settled = false;
  let interrupted = false;
  let announcedApproval = null;
  let latestProgress = "";
  const event = (value) => options.onLifecycleEvent?.({ threadId: resolvedThreadId, turnId: promptId, ...value });
  const base = () => `${client.prefix}/session/${resolvedThreadId}`;

  async function pendingInputs() {
    const permissions = await client.request("GET", client.v2 ? `${base()}/permission` : "/permission");
    const questions = await client.request("GET", client.v2 ? `${base()}/form` : "/question");
    return {
      permissions: listData(permissions, client.v2, "permissions").filter((item) => client.v2 || item.sessionID === resolvedThreadId),
      questions: listData(questions, client.v2, "questions").filter((item) => client.v2 || item.sessionID === resolvedThreadId)
    };
  }

  async function refreshApprovals() {
    const current = await pendingInputs();
    if (current.questions.length) {
      throw new Error(`OpenCode needs a question/form response in session ${resolvedThreadId}. Answer it in OpenCode/OpenChamber; WhatsApp does not answer forms. This turn may remain waiting there.`);
    }
    pending.clear();
    for (const permission of current.permissions) {
      if (typeof permission.id !== "string" || !permission.id) throw new Error("OpenCode returned an invalid permission request ID.");
      pending.set(permission.id, permission);
    }
    if (announcedApproval && !pending.has(announcedApproval)) {
      const requestId = announcedApproval;
      announcedApproval = null;
      await options.onApprovalResolved?.({ requestId, threadId: resolvedThreadId, turnId: promptId });
      event({ type: "approvalResolved", requestId });
    }
    const next = current.permissions[0];
    if (!next || announcedApproval) return;
    if (!options.onApprovalRequest) throw new Error("OpenCode requires approval. Continue in OpenCode/OpenChamber; no automatic approval was granted.");
    announcedApproval = next.id;
    const approval = {
      requestId: next.id, threadId: resolvedThreadId, turnId: promptId,
      kind: "permissions", availableDecisions: ["accept", "decline", "cancel"],
      reason: `${next.action ?? next.permission ?? "Permission"}: ${(next.resources ?? next.patterns ?? []).join(", ")}`,
      cwd: options.workspace
    };
    await options.onApprovalRequest(approval);
    event({ type: "approvalRequested", requestId: next.id, kind: "permissions" });
  }

  function publishProgress(text, completed = false) {
    if (!text || (!completed && latestProgress === text)) return;
    latestProgress = text;
    event({ type: completed ? "agentMessageCompleted" : "agentMessageDelta", itemId: promptId, phase: completed ? "final_answer" : "commentary", text, delta: "" });
  }

  async function execute() {
    await client.initialize();
    if (interrupted) throw new Error("OpenCode run was interrupted before submission.");
    const configuredModel = modelRef(options.model, client.v2);
    if (resolvedThreadId) {
      const result = await client.request("GET", base());
      const session = client.v2 ? result.data : result;
      const directory = client.v2 ? session?.location?.directory : session?.directory;
      if (!directory || workspacePath(directory) !== workspacePath(options.workspace)) throw new Error("The OpenCode session belongs to a different workspace.");
      if (client.v2 && ((options.profile && options.profile !== session.agent) || (configuredModel && (configuredModel.id !== session.model?.id || configuredModel.providerID !== session.model?.providerID)))) {
        throw new Error("The OpenCode session has a different native model/agent. Remove the project override or select a matching session; its settings were preserved.");
      }
    } else {
      const created = await client.request("POST", `${client.prefix}/session`, {
        ...(options.threadName ? { title: options.threadName } : {}),
        ...(client.v2 ? { location: { directory: options.workspace }, ...(configuredModel ? { model: configuredModel } : {}), ...(options.profile ? { agent: options.profile } : {}) } : {})
      });
      resolvedThreadId = sessionId(client.v2 ? created?.data?.id : created?.id);
    }
    // Save the native ID even if later admission fails, so the user can inspect it.
    event({ type: "turnStarted" });
    const active = await client.request("GET", client.v2 ? "/api/session/active" : "/session/status");
    const status = client.v2 ? active?.data : active;
    if (!status || typeof status !== "object" || Array.isArray(status)) throw new Error("OpenCode returned invalid active-session status.");
    if (status[resolvedThreadId] && (client.v2 || status[resolvedThreadId].type !== "idle")) throw new Error("This OpenCode session is already running. Wait for its active turn to finish.");
    if (client.v2 && listData(await client.request("GET", `${base()}/inbox`), true, "inbox").length) {
      throw new Error("This OpenCode session already has queued work. Continue it in OpenCode/OpenChamber first.");
    }
    const before = await pendingInputs();
    if (before.permissions.length || before.questions.length) throw new Error("This OpenCode session is already waiting for input. Resolve it in OpenCode/OpenChamber first.");
    if (interrupted) throw new Error("OpenCode run was interrupted before submission.");
    const deadline = Date.now() + (options.turnTimeoutMs ?? 6 * 60 * 60 * 1000);
    const pause = () => delay(options.pollIntervalMs ?? 750, undefined, { signal: stopSignal.signal });
    let replyText;
    if (client.v2) {
      let admission;
      try { admission = await client.request("POST", `${base()}/prompt`, { text: options.prompt, delivery: "queue" }); }
      catch (error) { throw new Error(`${error.message} Prompt admission may have succeeded in session ${resolvedThreadId}; inspect it before resubmitting.`); }
      promptId = admission?.data?.id;
      if (typeof promptId !== "string" || !promptId) throw new Error(`OpenCode prompt admission did not return an ID. Inspect session ${resolvedThreadId} before resubmitting.`);
      submitted = true;
      event({ type: "turnStarted" });
      while (!interrupted) {
        if (Date.now() > deadline) throw new Error(`OpenCode turn reached its time limit. Session ${resolvedThreadId} may still be running; inspect it before resubmitting.`);
        const inbox = listData(await client.request("GET", `${base()}/inbox`), true, "inbox");
        const messages = inbox.some((item) => item.id === promptId) ? null : await readV2Turn(client, resolvedThreadId, promptId);
        const texts = [];
        let complete = false;
        for (const message of messages ?? []) {
          if (message.type === "user") throw new Error("Another OpenCode prompt appeared before this turn completed. Inspect the session; its reply cannot be attributed safely.");
          if (message.type === "idle") {
            if (message.outcome !== "succeeded") throw new Error(`OpenCode run ended with outcome ${message.outcome ?? "unknown"}.`);
            complete = true;
            break;
          }
          if (message.type === "assistant") for (const item of message.content ?? []) if (item.type === "text" && item.text) texts.push(item.text);
        }
        publishProgress(texts.join("\n\n"));
        if (complete) { replyText = texts.join("\n\n"); break; }
        await refreshApprovals();
        await pause();
      }
    } else {
      // The synchronous v1 message response is bound to this exact submission.
      let response;
      let failure;
      let finished = false;
      submitted = true;
      const messageRequest = client.request("POST", `${base()}/message`, {
        parts: [{ type: "text", text: options.prompt }],
        ...(configuredModel ? { model: configuredModel } : {}), ...(options.profile ? { agent: options.profile } : {})
      }, { timeoutMs: options.turnTimeoutMs ?? 6 * 60 * 60 * 1000, signal: stopSignal.signal })
        .then((value) => { response = value; }, (error) => { failure = error; })
        .finally(() => { finished = true; });
      try {
        while (!finished && !interrupted) { await refreshApprovals(); if (!finished) await pause(); }
      } catch (error) {
        stopSignal.abort();
        await messageRequest;
        throw error;
      }
      await messageRequest;
      if (failure && !interrupted) throw new Error(`${failure.message} Session ${resolvedThreadId} may still be running; inspect it before resubmitting.`);
      if (!interrupted) {
        if (response?.info?.role !== "assistant" || response.info.error || !Array.isArray(response.parts)) throw new Error("OpenCode returned a failed or invalid assistant response.");
        replyText = response.parts.filter((item) => item.type === "text").map((item) => item.text ?? "").join("\n\n");
      }
    }
    if (interrupted) throw new Error("OpenCode run was interrupted.");
    if (!replyText?.trim()) throw new Error("OpenCode completed without a visible answer; inspect the session.");
    publishProgress(replyText, true);
    event({ type: "turnCompleted", status: "completed" });
    return { threadId: resolvedThreadId, replyText };
  }

  const resultPromise = execute().catch((error) => {
    const failure = interrupted ? new Error("OpenCode run was interrupted.") : error;
    event({ type: "turnError", error: failure.message, willRetry: false });
    throw failure;
  }).finally(() => { settled = true; stopSignal.abort(); });
  // A transport can fail before the bridge has attached its result handler.
  resultPromise.catch(() => {});

  async function interrupt() {
      if (settled) return;
      interrupted = true;
      // During bootstrap, wait until it observes the flag. It never submits after
      // the final pre-admission check. An in-flight admission is handled below.
      if (!submitted) {
        const waitController = new AbortController();
        try {
          await Promise.race([resultPromise.catch(() => {}), delay(options.requestTimeoutMs ?? 15_000, undefined, { signal: waitController.signal })]);
        } finally { waitController.abort(); }
      }
      if (submitted && resolvedThreadId) {
        if (client.v2 && promptId) {
          const inbox = listData(await client.request("GET", `${base()}/inbox`), true, "inbox");
          if (inbox.some((item) => item.id === promptId)) {
            await client.request("DELETE", `${base()}/inbox/${encodeURIComponent(promptId)}`);
          }
          const messages = await readV2Turn(client, resolvedThreadId, promptId);
          // If our input never reached the timeline it was cancelled while
          // queued. An idle marker or another user input ends our ownership.
          // Do not stop a different client's active turn in this same session.
          if (messages && !messages.some((item) => item.type === "idle" || item.type === "user")) {
            const result = await client.request("POST", `${base()}/interrupt?resume=false`);
            if (result?.interrupted !== true) throw new Error("OpenCode did not confirm interruption. Inspect its native session before assuming execution stopped.");
          }
        } else {
          const result = await client.request("POST", `${base()}/abort`);
          if (result !== true) throw new Error("OpenCode did not confirm interruption. Inspect its native session before assuming execution stopped.");
        }
      }
      stopSignal.abort();
      await resultPromise.catch(() => {});
  }

  return {
    child: null,
    resultPromise,
    interrupt,
    async answerApproval(requestId, decision) {
      if (settled) throw new Error("This OpenCode relay turn is no longer active.");
      if (decision === "acceptForSession") throw new Error("OpenCode cannot grant a session-only approval through this API. Use /approve for this request; persistent 'always' grants are not made by the relay.");
      if (!["accept", "decline", "cancel"].includes(decision)) throw new Error("Unsupported OpenCode approval decision.");
      const requests = (await pendingInputs()).permissions;
      if (!pending.has(requestId) || !requests.some((item) => item.id === requestId)) throw new Error("This OpenCode approval is no longer pending.");
      const reply = decision === "accept" ? "once" : "reject";
      await client.request("POST", client.v2 ? `${base()}/permission/${encodeURIComponent(requestId)}/reply` : `/permission/${encodeURIComponent(requestId)}/reply`, client.v2 ? { decision: reply } : { reply });
      pending.delete(requestId);
      if (announcedApproval === requestId) announcedApproval = null;
      await options.onApprovalResolved?.({ requestId, threadId: resolvedThreadId, turnId: promptId });
      event({ type: "approvalResolved", requestId });
      if (decision === "cancel") await interrupt();
    }
  };
}

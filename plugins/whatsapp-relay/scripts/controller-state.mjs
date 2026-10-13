import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import { normalizeProjectAlias } from "./controller-projects.mjs";
import { controllerStateFile } from "./paths.mjs";

const DEFAULT_PROJECT_ALIAS = "main";
export const DEFAULT_THREAD_NAME = "main";

async function replaceStateFile(tempFile, filePath) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fs.rename(tempFile, filePath);
      return;
    } catch (error) {
      // Windows readers and virus scanners can briefly lock the destination.
      // Keep the previous file intact and retry only the atomic replacement.
      if (process.platform !== "win32" || !["EPERM", "EACCES", "EBUSY"].includes(error?.code) || attempt >= 5) {
        throw error;
      }
      await delay(25 * (attempt + 1));
    }
  }
}

export function normalizeThreadName(value) {
  const name = String(value ?? DEFAULT_THREAD_NAME).trim().toLowerCase();
  return /^(?!__proto__$|constructor$|prototype$)[a-z0-9][a-z0-9_-]{0,47}$/.test(name) ? name : null;
}

// Keep the original project fields as the main slot so existing state consumers
// and pre-named-session installations keep their native thread and queue.
export function projectThreadSession(project = {}, threadName = null, create = false) {
  const name = normalizeThreadName(threadName ?? project.activeThread) ?? DEFAULT_THREAD_NAME;
  if (name === DEFAULT_THREAD_NAME) return project;
  if (create) {
    project.namedThreads ??= {};
    if (!Object.hasOwn(project.namedThreads, name)) project.namedThreads[name] = defaultProjectSession();
  }
  return Object.hasOwn(project.namedThreads ?? {}, name) ? project.namedThreads[name] : defaultProjectSession();
}
const LEGACY_PROJECT_FIELDS = [
  "threadId",
  "permissionLevel",
  "pendingPermissionConfirmation",
  "pendingApproval",
  "lastPromptAt",
  "lastPromptText",
  "lastPromptVoiceReply",
  "lastReplyAt",
  "lastReplyPreview",
  "lastReplyVoiceReply",
  "connectedThreadAt",
  "connectedThreadName",
  "lastThreadChoices",
  "lastThreadChoicesAt",
  "lastErrorAt",
  "lastError"
];

function normalizeQueuedPrompt(value = {}) {
  const prompt = typeof value.prompt === "string" ? value.prompt.trim() : "";
  if (!prompt) {
    return null;
  }

  return {
    prompt,
    forceNewThread: Boolean(value.forceNewThread),
    queuedAt: typeof value.queuedAt === "string" ? value.queuedAt : null,
    projectAlias: typeof value.projectAlias === "string" ? value.projectAlias : null,
    threadName: normalizeThreadName(value.threadName) ?? DEFAULT_THREAD_NAME,
    bindingKey: typeof value.bindingKey === "string" ? value.bindingKey : null,
    voiceReplyOverride:
      value.voiceReplyOverride?.enabled
        ? {
            enabled: true,
            speed: value.voiceReplyOverride.speed ?? null
          }
        : null
  };
}

function normalizeQueuedPromptList(value) {
  return Array.isArray(value)
    ? value.map((item) => normalizeQueuedPrompt(item)).filter(Boolean)
    : [];
}

export function defaultProjectSession() {
  return {
    threadId: null,
    bindingKey: null,
    permissionLevel: null,
    pendingPermissionConfirmation: null,
    pendingApproval: null,
    lastPromptAt: null,
    lastPromptText: null,
    lastPromptVoiceReply: null,
    lastReplyAt: null,
    lastReplyPreview: null,
    lastReplyVoiceReply: null,
    connectedThreadAt: null,
    connectedThreadName: null,
    lastThreadChoices: [],
    lastThreadChoicesAt: null,
    lastErrorAt: null,
    lastError: null,
    queuedPrompts: []
  };
}

export function defaultChatSession(phoneKey = null) {
  return {
    phoneKey,
    label: null,
    remoteJid: null,
    activeProject: DEFAULT_PROJECT_ALIAS,
    voiceReply: null,
    projects: {
      [DEFAULT_PROJECT_ALIAS]: defaultProjectSession()
    },
    btw: {
      lastUsedAt: null,
      queuedPrompts: []
    },
    lastInboundAt: null,
    lastInboundText: null,
    lastInboundType: null,
    lastVoiceTranscriptAt: null,
    lastVoiceTranscriptModel: null,
    lastVoiceTranscriptConfidence: null,
    lastVoiceTranscriptMinConfidence: null
  };
}

function defaultState() {
  return {
    process: {
      pid: null,
      status: "stopped",
      startedAt: null,
      heartbeatAt: null
    },
    sessions: {}
  };
}

function extractLegacyProjectSession(value = {}) {
  return LEGACY_PROJECT_FIELDS.reduce((project, field) => {
    if (value[field] !== undefined) {
      project[field] = value[field];
    }
    return project;
  }, {});
}

function normalizeProjectSession(value = {}) {
  const namedThreads = Object.fromEntries(Object.entries(value.namedThreads ?? {})
    .filter(([name]) => normalizeThreadName(name) === name && name !== DEFAULT_THREAD_NAME)
    .map(([name, slot]) => {
      const { activeThread, namedThreads: nested, ...fields } = slot ?? {};
      return [name, { ...defaultProjectSession(), ...fields,
        queuedPrompts: normalizeQueuedPromptList(fields.queuedPrompts),
        lastThreadChoices: Array.isArray(fields.lastThreadChoices) ? fields.lastThreadChoices : [] }];
    }));
  const activeThread = normalizeThreadName(value.activeThread) ?? DEFAULT_THREAD_NAME;
  if (activeThread !== DEFAULT_THREAD_NAME && !Object.hasOwn(namedThreads, activeThread)) {
    namedThreads[activeThread] = defaultProjectSession();
  }
  return {
    ...defaultProjectSession(),
    ...value,
    lastThreadChoices: Array.isArray(value.lastThreadChoices) ? value.lastThreadChoices : [],
    queuedPrompts: normalizeQueuedPromptList(value.queuedPrompts),
    activeThread,
    namedThreads
  };
}

function normalizeChatSession(value = {}, phoneKey = null) {
  const merged = {
    ...defaultChatSession(phoneKey),
    ...value
  };
  for (const field of LEGACY_PROJECT_FIELDS) {
    delete merged[field];
  }

  const activeProject = normalizeProjectAlias(
    value.activeProject ?? DEFAULT_PROJECT_ALIAS,
    DEFAULT_PROJECT_ALIAS
  );
  const rawProjects =
    value.projects && typeof value.projects === "object" ? value.projects : {};
  const legacyProject = extractLegacyProjectSession(value);
  const projectEntries = Object.entries(rawProjects).map(([alias, project]) => [
    normalizeProjectAlias(alias, DEFAULT_PROJECT_ALIAS),
    normalizeProjectSession(project)
  ]);

  if (!projectEntries.length || Object.keys(legacyProject).length) {
    projectEntries.push([
      activeProject,
      normalizeProjectSession({
        ...(rawProjects[activeProject] ?? {}),
        ...legacyProject
      })
    ]);
  }

  const projects = Object.fromEntries(projectEntries);
  if (!projects[activeProject]) {
    projects[activeProject] = defaultProjectSession();
  }

  return {
    ...merged,
    phoneKey: phoneKey ?? value.phoneKey ?? null,
    activeProject,
    voiceReply: value.voiceReply ?? null,
    projects,
    btw: {
      ...defaultChatSession().btw,
      ...(value.btw ?? {}),
      queuedPrompts: normalizeQueuedPromptList(value.btw?.queuedPrompts)
    }
  };
}

function normalizeState(value = {}) {
  const sessions = Object.fromEntries(
    Object.entries(value.sessions ?? {}).map(([phoneKey, session]) => [
      phoneKey,
      normalizeChatSession(session, phoneKey)
    ])
  );

  return {
    ...defaultState(),
    ...value,
    process: {
      ...defaultState().process,
      ...(value.process ?? {})
    },
    sessions
  };
}

export class ControllerStateStore {
  constructor(filePath = controllerStateFile) {
    this.filePath = filePath;
    this.data = defaultState();
    this.queue = Promise.resolve();
  }

  async load() {
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      this.data = normalizeState(JSON.parse(raw));
    } catch (error) {
      if (error?.code !== "ENOENT" && !(error instanceof SyntaxError)) {
        throw error;
      }
      this.data = defaultState();
    }

    return this.data;
  }

  async save() {
    this.data = normalizeState(this.data);
    const tempFile = path.join(
      path.dirname(this.filePath),
      `.${path.basename(this.filePath)}.${process.pid}.${randomUUID()}.tmp`
    );
    const serialized = JSON.stringify(this.data, null, 2);
    let tempCreated = false;
    try {
      const handle = await fs.open(tempFile, "wx");
      tempCreated = true;
      try { await handle.writeFile(serialized); }
      finally { await handle.close(); }
      await replaceStateFile(tempFile, this.filePath);
    } finally {
      if (tempCreated) await fs.rm(tempFile, { force: true }).catch(() => {});
    }
    return this.data;
  }

  async mutate(mutator) {
    const run = this.queue.then(async () => {
      await this.load();
      await mutator(this.data);
      return this.save();
    });
    this.queue = run.catch(() => {});
    return run;
  }

  async setProcess(partial = {}) {
    return this.mutate((data) => {
      data.process = {
        ...data.process,
        ...partial
      };
      this.data = normalizeState(data);
    });
  }

  async clearProcess() {
    return this.mutate((data) => {
      data.process = defaultState().process;
      this.data = normalizeState(data);
    });
  }

  async upsertSession(phoneKey, partial = {}) {
    return this.mutate((data) => {
      data.sessions[phoneKey] = {
        ...(data.sessions[phoneKey] ?? {}),
        ...partial
      };
      this.data = normalizeState(data);
    });
  }

  // Compute updates only after earlier writes have completed. Callers must not
  // construct whole-session snapshots before joining this queue.
  async mutateSession(phoneKey, mutator) {
    let result;
    await this.mutate(async (data) => {
      const session = normalizeChatSession(data.sessions[phoneKey] ?? {}, phoneKey);
      result = await mutator(session);
      data.sessions[phoneKey] = normalizeChatSession(session, phoneKey);
    });
    return result;
  }

  async removeSession(phoneKey) {
    return this.mutate((data) => {
      delete data.sessions[phoneKey];
      this.data = normalizeState(data);
    });
  }

  getSession(phoneKey) {
    return normalizeChatSession(this.data.sessions[phoneKey] ?? {}, phoneKey);
  }

  listSessions() {
    return Object.entries(this.data.sessions).map(([phoneKey, session]) => {
      const normalized = normalizeChatSession(session, phoneKey);
      const activeProject = normalized.activeProject;
      const activeProjectSession = projectThreadSession(normalized.projects[activeProject]);
      return {
        phoneKey,
        ...normalized,
        threadId: activeProjectSession.threadId ?? null,
        permissionLevel: activeProjectSession.permissionLevel ?? null
      };
    });
  }
}

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { normalizePermissionLevel, resolvePermissionLevel } from "./controller-permissions.mjs";
import { normalizeConfiguredHosts } from "./controller-hosts.mjs";
import { repoRoot } from "./paths.mjs";

const DEFAULT_PROJECT_ALIAS = "main";
const DEFAULT_SEARCH_ROOT_NAMES = ["code", "src", "workspace", "projects", "work"];
const INVISIBLE_PROJECT_SPEC_PATTERN = /[\u200B-\u200F\u202A-\u202E\u2060\uFEFF]/g;
const MARKDOWN_LINK_PATTERN = /\[([^\]]*)\]\(([^)]+)\)/g;
const PATH_REFERENCE_PATTERN = /(?:^|[\s<])((?:[a-z]:[\\/]|\\\\|~[\\/]|\.{1,2}[\\/]|\/)[^\s)>]+)/i;

function stripDiacritics(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "");
}

function normalizeSearchText(value) {
  return stripDiacritics(value)
    .toLowerCase()
    .replace(/[`"'()[\]{}]/g, " ")
    .replace(/[/\\]+/g, " ")
    .replace(/[-_.]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenizeSearchText(value) {
  return normalizeSearchText(value)
    .split(" ")
    .filter(Boolean);
}

function cleanProjectWords(value) {
  return normalizeSearchText(value)
    .replace(/\b(?:directory|folder|repo|repository|project|the|this|that|my|our)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function sanitizeProjectSpec(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(INVISIBLE_PROJECT_SPEC_PATTERN, " ")
    .replace(MARKDOWN_LINK_PATTERN, (_, label, target) => {
      const normalizedTarget = String(target ?? "").trim();
      if (isDirectoryPathLike(normalizedTarget)) {
        return normalizedTarget;
      }

      return String(label ?? "").trim() || normalizedTarget;
    })
    .replace(/\s+/g, " ")
    .trim();
}

function isDirectoryPathLike(value) {
  const source = String(value ?? "").trim();
  return (
    source.startsWith("/") ||
    source.startsWith("~") ||
    source.startsWith(".") ||
    /[\\/]/.test(source)
  );
}

function expandHomePath(value, homeDir = os.homedir()) {
  const source = String(value ?? "").trim();
  if (!source) {
    return "";
  }

  if (source === "~") {
    return homeDir;
  }

  if (source.startsWith("~/")) {
    return path.join(homeDir, source.slice(2));
  }

  return source;
}

async function directoryExists(targetPath) {
  try {
    const stat = await fs.stat(targetPath);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

async function listChildDirectories(rootPath) {
  try {
    const entries = await fs.readdir(rootPath, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(rootPath, entry.name));
  } catch {
    return [];
  }
}

function ensureUniqueAlias(alias, seenAliases) {
  const base = normalizeProjectAlias(alias, DEFAULT_PROJECT_ALIAS);
  if (!seenAliases.has(base)) {
    seenAliases.add(base);
    return base;
  }

  let counter = 2;
  while (seenAliases.has(`${base}-${counter}`)) {
    counter += 1;
  }

  const nextAlias = `${base}-${counter}`;
  seenAliases.add(nextAlias);
  return nextAlias;
}

export function normalizeProjectAlias(value, fallback = DEFAULT_PROJECT_ALIAS) {
  const normalized = stripDiacritics(sanitizeProjectSpec(value))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return normalized || fallback;
}

export function defaultProjectConfig() {
  return {
    alias: DEFAULT_PROJECT_ALIAS,
    host: "host",
    engine: "codex",
    workspace: repoRoot,
    model: null,
    profile: null,
    permissionLevel: null,
    search: null
  };
}

function workspacePathApi(workspace) {
  return /^(?:[a-z]:[\\/]|\\\\)/i.test(workspace) ? path.win32 : path.posix;
}

function workspaceBasename(workspace) {
  return workspacePathApi(workspace).basename(workspace);
}

function normalizeWorkspace(workspace, host) {
  const source = String(workspace ?? "");
  if (host.transport === "local") {
    return path.resolve(source || repoRoot);
  }

  if (!source || /[\u0000-\u001f]/.test(source)) {
    throw new Error(`Project workspace on host ${host.id} must be an absolute remote path.`);
  }
  const pathApi = host.platform === "win32" ? path.win32 : path.posix;
  const isAbsolute = pathApi === path.win32
    ? /^(?:[a-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+)/i.test(source)
    : source.startsWith("/") && !source.startsWith("//") && !source.includes("\\");
  if (!isAbsolute) {
    throw new Error(`Project workspace on host ${host.id} must be an absolute remote path: ${source}`);
  }
  return pathApi.normalize(source);
}

function workspaceKey(project) {
  const pathApi = workspacePathApi(project.workspace);
  let workspace = pathApi.normalize(project.workspace);
  if (workspace !== pathApi.parse(workspace).root) {
    workspace = workspace.replace(/[\\/]+$/, "");
  }
  // Windows workspace names are case-insensitive; POSIX names are not.
  return `${project.host}\u0000${project.engine ?? "codex"}\u0000${workspacePathApi(workspace) === path.win32 ? workspace.toLowerCase() : workspace}`;
}

function normalizeProjectConfig(project = {}, { fallbackAlias = DEFAULT_PROJECT_ALIAS, hosts } = {}) {
  if (!project || typeof project !== "object" || Array.isArray(project)) {
    throw new Error("Each project must be a configuration object.");
  }
  const hostId = project.host ?? "host";
  const host = hosts.find((candidate) => candidate.id === hostId);
  if (!host) {
    throw new Error(`Project ${project.alias ?? fallbackAlias} references unknown host: ${String(hostId)}`);
  }
  const workspace = normalizeWorkspace(project.workspace, host);
  const engine = project.engine ?? "codex";
  if (!["codex", "opencode", "claude"].includes(engine)) throw new Error(`Unsupported project engine: ${engine}`);
  const permission = project.permissionLevel ? normalizePermissionLevel(project.permissionLevel) : null;
  if (project.permissionLevel && !permission) throw new Error(`Unknown permission level for ${project.alias ?? fallbackAlias}.`);
  if (engine === "codex" && permission === "native") throw new Error("Codex projects require a Codex sandbox permission level.");
  if (engine !== "codex" && permission && permission !== "native") throw new Error(`${engine} projects use native permissions; Codex sandbox levels do not apply.`);
  const providerOptions = {};
  if (engine === "opencode") {
    if (!project.opencodeUrl) throw new Error("OpenCode projects require opencodeUrl pointing at the existing server.");
    let endpoint;
    try { endpoint = new URL(project.opencodeUrl); } catch { throw new Error("opencodeUrl must be an HTTP(S) origin."); }
    if (!["http:", "https:"].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== "/") {
      throw new Error("opencodeUrl must be an HTTP(S) origin without credentials, a path, query, or fragment.");
    }
    providerOptions.opencodeUrl = endpoint.origin;
    providerOptions.opencodeApiVersion = project.opencodeApiVersion ?? "auto";
    if (!["auto", "v1", "v2"].includes(providerOptions.opencodeApiVersion)) throw new Error("opencodeApiVersion must be auto, v1, or v2.");
    for (const field of ["opencodeUsernameEnv", "opencodePasswordEnv"]) {
      if (project[field] !== undefined) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(project[field])) throw new Error(`${field} must name an environment variable.`);
        providerOptions[field] = project[field];
      }
    }
  }
  return {
    alias: normalizeProjectAlias(
      project.alias ?? workspaceBasename(workspace) ?? fallbackAlias,
      fallbackAlias
    ),
    host: host.id,
    engine,
    workspace,
    ...providerOptions,
    model: project.model ?? null,
    profile: project.profile ?? null,
    permissionLevel: permission ?? (engine === "codex" ? null : "native"),
    search: typeof project.search === "boolean" ? project.search : null
  };
}

export function normalizeConfiguredProjects(config = {}) {
  const hosts = normalizeConfiguredHosts(config);
  const rawProjects =
    Array.isArray(config.projects) && config.projects.length
      ? config.projects
      : [
          {
            alias: config.defaultProject ?? DEFAULT_PROJECT_ALIAS,
            workspace: config.workspace ?? repoRoot,
            model: config.model ?? null,
            profile: config.profile ?? null,
            permissionLevel: null,
            search: null
          }
        ];

  const seenAliases = new Set();
  const seenWorkspaces = new Set();
  const projects = rawProjects.flatMap((project, index) => {
    const normalized = normalizeProjectConfig(project, {
      fallbackAlias: index === 0 ? DEFAULT_PROJECT_ALIAS : `project-${index + 1}`,
      hosts
    });
    const key = workspaceKey(normalized);
    if (seenWorkspaces.has(key)) {
      return [];
    }

    seenWorkspaces.add(key);
    return [{
      ...normalized,
      alias: ensureUniqueAlias(normalized.alias, seenAliases)
    }];
  });

  const defaultAlias = normalizeProjectAlias(
    config.defaultProject ?? projects[0]?.alias ?? DEFAULT_PROJECT_ALIAS,
    projects[0]?.alias ?? DEFAULT_PROJECT_ALIAS
  );
  const defaultProject =
    projects.find((project) => project.alias === defaultAlias)?.alias ?? projects[0].alias;

  return {
    defaultProject,
    projects,
    workspace:
      projects.find((project) => project.alias === defaultProject)?.workspace ??
      defaultProjectConfig().workspace
  };
}

export function findConfiguredProject(config = {}, token = null, options = {}) {
  return resolveConfiguredProjectSelection(config, token, options).match;
}

function projectsForHost(config, hostId) {
  const normalized = normalizeConfiguredProjects(config);
  if (hostId !== null && hostId !== undefined) {
    const hosts = normalizeConfiguredHosts(config);
    if (!hosts.some((host) => host.id === hostId)) {
      throw new Error(`Unknown host: ${String(hostId)}`);
    }
    normalized.projects = normalized.projects.filter((project) => project.host === hostId);
  }
  return normalized;
}

function extractPathReference(token) {
  // A bare absolute path can contain spaces. Preserve it before looking for an
  // embedded path in prose such as "project /home/user/project".
  if (/^(?:[a-z]:[\\/]|\\\\|~[\\/]|\.{1,2}[\\/]|\/)/i.test(token)) {
    return token;
  }
  return token.match(PATH_REFERENCE_PATTERN)?.[1] ??
    (isDirectoryPathLike(token) ? token : null);
}

function explicitProjectCandidates(config, projects, token, defaultProject) {
  const normalizedToken = normalizeProjectAlias(token, defaultProject);
  const aliasMatch = projects.find((project) => project.alias === normalizedToken);
  if (aliasMatch && !isDirectoryPathLike(token)) {
    return [aliasMatch];
  }
  const hosts = normalizeConfiguredHosts(config);
  const pathReference =
    extractPathReference(token);
  if (pathReference) {
    const workspaceMatches = projects.filter((project) => {
      const host = hosts.find((candidate) => candidate.id === project.host);
      try {
        const workspace = normalizeWorkspace(
          host.transport === "local" ? expandHomePath(pathReference) : pathReference,
          host
        );
        return workspaceKey({ ...project, workspace }) === workspaceKey(project);
      } catch {
        return false;
      }
    });
    if (workspaceMatches.length) {
      return workspaceMatches;
    }
    return [];
  }

  return projects.filter((project) =>
    normalizeProjectAlias(workspaceBasename(project.workspace), project.alias) === normalizedToken
  );
}

export function resolveExplicitConfiguredProject(config = {}, token = null, { hostId } = {}) {
  const { projects, defaultProject } = projectsForHost(config, hostId);
  const sanitizedToken = sanitizeProjectSpec(token);
  if (!sanitizedToken) {
    return null;
  }
  const candidates = explicitProjectCandidates(
    config, projects, sanitizedToken, defaultProject
  );
  return candidates.length === 1 ? candidates[0] : null;
}

export function resolveConfiguredProjectSelection(config = {}, token = null, { hostId } = {}) {
  const { projects, defaultProject } = projectsForHost(config, hostId);
  const sanitizedToken = sanitizeProjectSpec(token);
  if (!sanitizedToken) {
    return {
      match: null,
      candidates: []
    };
  }

  const directCandidates = explicitProjectCandidates(
    config, projects, sanitizedToken, defaultProject
  );
  if (directCandidates.length) {
    return {
      match: directCandidates.length === 1 ? directCandidates[0] : null,
      candidates: directCandidates
    };
  }

  const normalizedToken = normalizeProjectAlias(sanitizedToken, defaultProject);

  const prefixMatches = projects.filter((project) => {
    const workspaceAlias = normalizeProjectAlias(
      workspaceBasename(project.workspace),
      project.alias
    );
    return (
        project.alias.startsWith(normalizedToken) || workspaceAlias.startsWith(normalizedToken)
    );
  });

  if (prefixMatches.length) {
    return {
      match: prefixMatches.length === 1 ? prefixMatches[0] : null,
      candidates: prefixMatches
    };
  }

  return {
    match: null,
    candidates: []
  };
}

export function resolveConfiguredProject(config = {}, token = null, { hostId } = {}) {
  const { projects, defaultProject } = projectsForHost(config, hostId);
  const selection = resolveConfiguredProjectSelection(config, token ?? defaultProject, { hostId });
  if (selection.candidates.length > 1) {
    return null;
  }
  return (
    selection.match ??
    projects.find((project) => project.alias === defaultProject) ??
    projects[0] ?? null
  );
}

function parseWorkspaceReference(spec) {
  const source = cleanProjectWords(spec);
  if (!source) {
    return {
      projectHint: "",
      parentHint: null
    };
  }

  const match = source.match(/^(.*?)\s+(?:inside|under|in)\s+(.+)$/i);
  if (!match) {
    return {
      projectHint: source,
      parentHint: null
    };
  }

  return {
    projectHint: cleanProjectWords(match[1]),
    parentHint: cleanProjectWords(match[2])
  };
}

async function collectSearchRoots({ homeDir, repoRootDir, parentHint }) {
  const roots = new Set();
  const parentRepoDir = path.dirname(repoRootDir);
  roots.add(parentRepoDir);

  for (const rootName of DEFAULT_SEARCH_ROOT_NAMES) {
    roots.add(path.join(homeDir, rootName));
  }

  if (parentHint) {
    const parentTokens = tokenizeSearchText(parentHint);

    const homeChildren = await listChildDirectories(homeDir);
    for (const child of homeChildren) {
      const childTokens = tokenizeSearchText(path.basename(child));
      if (parentTokens.every((token) => childTokens.includes(token))) {
        roots.add(child);
      }
    }

    const directChildren = await listChildDirectories(parentRepoDir);
    for (const child of directChildren) {
      const childTokens = tokenizeSearchText(path.basename(child));
      if (parentTokens.every((token) => childTokens.includes(token))) {
        roots.add(child);
      }
    }
  }

  const candidates = [];
  for (const root of roots) {
    if (await directoryExists(root)) {
      candidates.push(root);
    }
  }

  return candidates;
}

function scoreWorkspaceCandidate(candidatePath, { projectTokens, projectText, parentTokens }) {
  const baseName = path.basename(candidatePath);
  const baseText = normalizeSearchText(baseName);
  const baseTokens = tokenizeSearchText(baseName);
  const parentText = normalizeSearchText(path.basename(path.dirname(candidatePath)));

  let score = 0;

  if (baseText === projectText) {
    score += 100;
  } else if (baseText.startsWith(projectText) || projectText.startsWith(baseText)) {
    score += 80;
  }

  if (projectTokens.every((token) => baseTokens.includes(token))) {
    score += 60;
  } else if (projectTokens.some((token) => baseText.includes(token))) {
    score += 30;
  }

  if (parentTokens.length && parentTokens.every((token) => parentText.includes(token))) {
    score += 20;
  }

  score -= candidatePath.split(path.sep).length;
  return score;
}

async function searchWorkspaceFromReference(spec, { homeDir, repoRootDir }) {
  const reference = parseWorkspaceReference(spec);
  const projectTokens = tokenizeSearchText(reference.projectHint);
  if (!projectTokens.length) {
    return {
      workspace: null,
      candidates: []
    };
  }

  const projectText = projectTokens.join(" ");
  const parentTokens = tokenizeSearchText(reference.parentHint);
  const roots = await collectSearchRoots({
    homeDir,
    repoRootDir,
    parentHint: reference.parentHint
  });

  const candidates = [];
  for (const root of roots) {
    const children = await listChildDirectories(root);
    for (const child of children) {
      const score = scoreWorkspaceCandidate(child, {
        projectTokens,
        projectText,
        parentTokens
      });
      if (score > 0) {
        candidates.push({
          path: child,
          score
        });
      }
    }
  }

  candidates.sort((left, right) => right.score - left.score || left.path.localeCompare(right.path));

  if (!candidates.length) {
    return {
      workspace: null,
      candidates: []
    };
  }

  const best = candidates[0];
  const second = candidates[1] ?? null;
  const unique = !second || best.score > second.score;

  return {
    workspace: unique ? best.path : null,
    candidates: candidates.map((candidate) => candidate.path).slice(0, 10)
  };
}

export function deriveProjectAlias(workspace, config = {}) {
  const { projects } = normalizeConfiguredProjects(config);
  const seenAliases = new Set(projects.map((project) => project.alias));
  return ensureUniqueAlias(workspaceBasename(workspace), seenAliases);
}

export async function resolveProjectReference(
  config = {},
  spec,
  { homeDir = os.homedir(), repoRootDir = repoRoot, skipConfiguredSelection = false, hostId } = {}
) {
  const trimmed = sanitizeProjectSpec(spec);
  if (!trimmed) {
    return null;
  }

  if (!skipConfiguredSelection) {
    const configuredSelection = resolveConfiguredProjectSelection(config, trimmed, { hostId });
    if (configuredSelection.match) {
      return {
        project: configuredSelection.match,
        created: false,
        matchType: "configured"
      };
    }

    if (configuredSelection.candidates.length) {
      return {
        project: null,
        created: false,
        matchType: "ambiguousConfigured",
        candidates: configuredSelection.candidates
      };
    }
  }

  const hosts = normalizeConfiguredHosts(config);
  const defaultHostId = resolveConfiguredProject(config)?.host ?? "host";
  const targetHostId = hostId ?? defaultHostId;
  const targetHost = hosts.find((host) => host.id === targetHostId);
  if (!targetHost) {
    throw new Error(`Unknown host: ${String(targetHostId)}`);
  }
  // Discovery scans this process's filesystem. Never substitute a local
  // directory for a remote path or project with a similar name.
  const configuredSelection = resolveConfiguredProjectSelection(config, trimmed);
  if (targetHost.transport !== "local" ||
      configuredSelection.candidates.some((project) =>
        hosts.find((host) => host.id === project.host)?.transport !== "local"
      )) {
    return null;
  }

  const pathReference = extractPathReference(trimmed);
  const directPath = pathReference
    ? path.resolve(expandHomePath(pathReference, homeDir))
    : null;
  if (directPath && (await directoryExists(directPath))) {
    const existingWorkspace = findConfiguredProject(config, directPath, { hostId: targetHostId });
    if (existingWorkspace) {
      return {
        project: existingWorkspace,
        created: false,
        matchType: "configured"
      };
    }

    return {
      project: {
        ...defaultProjectConfig(),
        host: targetHostId,
        alias: deriveProjectAlias(directPath, config),
        workspace: directPath
      },
      created: true,
      matchType: "workspace"
    };
  }

  const discovered = await searchWorkspaceFromReference(trimmed, {
    homeDir,
    repoRootDir
  });

  if (discovered.workspace) {
    const existingWorkspace = findConfiguredProject(config, discovered.workspace, { hostId: targetHostId });
    if (existingWorkspace) {
      return {
        project: existingWorkspace,
        created: false,
        matchType: "configured"
      };
    }

    return {
      project: {
        ...defaultProjectConfig(),
        host: targetHostId,
        alias: deriveProjectAlias(discovered.workspace, config),
        workspace: discovered.workspace
      },
      created: true,
      matchType: "discovered"
    };
  }

  if (discovered.candidates.length) {
    return {
      project: null,
      created: false,
      matchType: "ambiguous",
      candidates: discovered.candidates
    };
  }

  return null;
}

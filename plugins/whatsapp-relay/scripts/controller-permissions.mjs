const DEFAULT_PERMISSION_LEVEL = "workspace-write";

const PERMISSION_LEVELS = {
  native: {
    description: "Use the coding tool's existing permission rules. This is not a Codex OS sandbox.",
    dangerous: false,
    helpName: "native"
  },
  "read-only": {
    approvalPolicyCli: "never",
    approvalPolicyAppServer: "never",
    description: "Read files only. Codex cannot edit files or run write-enabled commands.",
    dangerous: false,
    helpName: "read-only",
    sandboxModeCli: "read-only",
    sandboxPolicyAppServer: {
      type: "readOnly"
    }
  },
  "workspace-write": {
    approvalPolicyCli: "on-request",
    approvalPolicyAppServer: "on-request",
    description:
      "Read and edit within the workspace, but require explicit approval for guarded actions.",
    dangerous: false,
    helpName: "workspace-write",
    sandboxModeCli: "workspace-write",
    sandboxPolicyAppServer: {
      type: "workspaceWrite"
    }
  },
  "danger-full-access": {
    approvalPolicyCli: "never",
    approvalPolicyAppServer: "never",
    description: "Disable the sandbox and approvals for this chat session.",
    dangerous: true,
    helpName: "danger-full-access",
    sandboxModeCli: "danger-full-access",
    sandboxPolicyAppServer: {
      type: "dangerFullAccess"
    }
  }
};

const LEVEL_ALIASES = new Map([
  ["native", "native"],
  ["auto", "workspace-write"],
  ["danger", "danger-full-access"],
  ["dfa", "danger-full-access"],
  ["danger-full-access", "danger-full-access"],
  ["full-access", "danger-full-access"],
  ["full", "danger-full-access"],
  ["fullauto", "workspace-write"],
  ["ro", "read-only"],
  ["readonly", "read-only"],
  ["read-only", "read-only"],
  ["ww", "workspace-write"],
  ["ws", "workspace-write"],
  ["workspace", "workspace-write"],
  ["workspace-write", "workspace-write"],
  ["write", "workspace-write"],
  ["yolo", "danger-full-access"]
]);

export function defaultPermissionLevel() {
  return DEFAULT_PERMISSION_LEVEL;
}

export function normalizePermissionLevel(value) {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, "-")
    .replace(/-+/g, "-");
  return LEVEL_ALIASES.get(normalized) ?? null;
}

export function resolvePermissionLevel(value) {
  return normalizePermissionLevel(value) ?? DEFAULT_PERMISSION_LEVEL;
}

export function permissionLevelHelpList() {
  return Object.entries(PERMISSION_LEVELS).map(([level, config]) => ({
    level,
    description: config.description,
    dangerous: config.dangerous
  }));
}

export function permissionLevelConfig(level) {
  const resolved = resolvePermissionLevel(level);
  return {
    level: resolved,
    ...PERMISSION_LEVELS[resolved]
  };
}

export function appServerPermissionParams(level) {
  const config = permissionLevelConfig(level);
  if (config.level === "native") throw new Error("Codex requires read-only, workspace-write, or danger-full-access permissions.");
  return {
    approvalPolicy: config.approvalPolicyAppServer,
    sandboxPolicy: {
      ...config.sandboxPolicyAppServer
    }
  };
}

export function cliPermissionOverrides(level) {
  const config = permissionLevelConfig(level);
  if (config.level === "native") throw new Error("Codex requires read-only, workspace-write, or danger-full-access permissions.");
  return {
    approvalPolicy: config.approvalPolicyCli,
    sandboxMode: config.sandboxModeCli
  };
}

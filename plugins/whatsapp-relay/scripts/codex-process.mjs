import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

// Launch npm's Windows Codex package through Node, without invoking cmd.exe.
// A prompt (or a JSON configuration value) must never become shell syntax.
export function resolveCodexLaunch(codexBin = "codex", {
  platform = process.platform,
  env = process.env,
  execPath = process.execPath,
  fileExists = existsSync
} = {}) {
  const bin = String(codexBin || "codex");
  if (/\.(?:mjs|cjs|js)$/i.test(bin)) {
    return { command: execPath, argsPrefix: [bin] };
  }
  if (platform !== "win32") {
    return { command: bin, argsPrefix: [] };
  }

  let resolved = bin;
  const hasDirectory = /[\\/]/.test(bin);
  const candidates = path.win32.extname(bin) ? [bin] : [`${bin}.exe`, `${bin}.cmd`, `${bin}.bat`, bin];
  const pathValue = Object.entries(env).find(([key]) => key.toLowerCase() === "path")?.[1] ?? "";
  const directories = hasDirectory ? [""] : pathValue.split(";").filter(Boolean);
  outer: for (const directory of directories) {
    for (const candidate of candidates) {
      const fullPath = directory ? path.win32.join(directory, candidate) : candidate;
      if (fileExists(fullPath)) {
        resolved = fullPath;
        break outer;
      }
    }
  }

  if (/\.(?:cmd|bat)$/i.test(resolved)) {
    const launcher = path.win32.join(path.win32.dirname(resolved), "node_modules", "@openai", "codex", "bin", "codex.js");
    if (/^codex\.(?:cmd|bat)$/i.test(path.win32.basename(resolved)) && fileExists(launcher)) {
      return { command: execPath, argsPrefix: [launcher] };
    }
    throw new Error("Cannot safely launch this Windows command shim. Set codexBin to codex.exe or the @openai/codex/bin/codex.js launcher.");
  }
  return { command: resolved, argsPrefix: [] };
}

export function spawnNativeCodex(codexBin, args, options = {}, spawnImpl = spawn) {
  const launch = resolveCodexLaunch(codexBin, { env: options.env ?? process.env });
  return spawnImpl(launch.command, [...launch.argsPrefix, ...args], {
    ...options,
    shell: false,
    windowsHide: true
  });
}

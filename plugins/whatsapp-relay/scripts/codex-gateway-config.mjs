import path from "node:path";

// This is trusted installation configuration, never WhatsApp message content.
// Paths belong to the selected host, including when carried over SSH.
export function normalizeCodexGateway(value, platform = process.platform) {
  if (value == null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).some(key => !["pythonBin", "configPath"].includes(key))) {
    throw new Error("codexGateway requires only pythonBin and configPath.");
  }
  const paths = platform === "win32" ? path.win32 : path.posix;
  const configPath = value.configPath;
  const pythonBin = value.pythonBin ?? "python";
  if (typeof configPath !== "string" || !paths.isAbsolute(configPath) || /[\x00-\x1f]/.test(configPath)) {
    throw new Error("codexGateway.configPath must be an absolute path on the selected computer.");
  }
  if (typeof pythonBin !== "string" || !pythonBin.trim() || pythonBin.startsWith("-") || /[\x00-\x1f]/.test(pythonBin) || /\.(?:cmd|bat)$/i.test(pythonBin)) {
    throw new Error("codexGateway.pythonBin must identify a Python executable, not a shell script.");
  }
  return { pythonBin, configPath: paths.normalize(configPath) };
}

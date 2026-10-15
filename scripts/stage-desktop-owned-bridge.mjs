import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { validateBridgeConfig } from "../plugins/whatsapp-relay/scripts/desktop-owned-bridge.mjs";

const SOURCE = fileURLToPath(new URL("./desktop-owned-shim.cs", import.meta.url));
const sha = filename => createHash("sha256").update(fs.readFileSync(filename)).digest("hex");

export function stageDesktopBridge(configInput, outputDirectory, { compiler = path.join(process.env.SystemRoot ?? "C:\\Windows", "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe") } = {}) {
  if (process.platform !== "win32") throw new Error("The desktop-owned shim is a Windows candidate.");
  const config = validateBridgeConfig(configInput);
  if (!path.isAbsolute(outputDirectory)) throw new Error("Use an absolute candidate output directory.");
  if (fs.existsSync(outputDirectory) && fs.readdirSync(outputDirectory).length) throw new Error("Candidate output directory must be empty; no existing installation is overwritten.");
  for (const filename of [compiler, config.realCliPath, config.nodePath, config.bridgePath, SOURCE]) if (!fs.statSync(filename).isFile()) throw new Error("A candidate dependency is not a file.");
  fs.mkdirSync(outputDirectory, { recursive: true });
  const executable = path.join(outputDirectory, "codex-desktop-owned-shim.exe");
  const result = spawnSync(compiler, ["/nologo", "/target:exe", `/out:${executable}`, "/reference:System.Web.Extensions.dll", SOURCE], { shell: false, windowsHide: true, encoding: "utf8" });
  if (result.error || result.status !== 0) throw new Error("Candidate shim compilation failed. No runtime was activated.");
  const configFile = `${executable}.json`;
  fs.writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  const files = [executable, configFile, SOURCE, config.bridgePath, config.nodePath, config.realCliPath].map(filename => ({ path: filename, sha256: sha(filename) }));
  const expectedHashes = { shim: sha(executable), bridge: sha(config.nodePath), server: sha(config.realCliPath), script: sha(config.bridgePath), config: sha(configFile) };
  const manifest = { schema: "codex-desktop-owned-candidate-v1", createdAt: new Date().toISOString(), activated: false, executable, configFile, expectedHashes, files,
    prerequisite: "Review ownership, package/sandbox parity, private token ACLs, native stdio EOF behavior and all-thread quiescence before separately selecting CODEX_CLI_PATH. No process, task, environment or desktop configuration was changed." };
  fs.writeFileSync(path.join(outputDirectory, "candidate-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
  return manifest;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [configPath, output] = process.argv.slice(2);
  if (!configPath || !output) throw new Error("Usage: node stage-desktop-owned-bridge.mjs ABSOLUTE_CONFIG_JSON ABSOLUTE_EMPTY_OUTPUT_DIRECTORY");
  const manifest = stageDesktopBridge(JSON.parse(fs.readFileSync(configPath, "utf8")), output);
  console.log(JSON.stringify({ activated: false, executable: manifest.executable, configFile: manifest.configFile }));
}

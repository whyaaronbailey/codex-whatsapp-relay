import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = fileURLToPath(new URL("../", import.meta.url));
const mode = process.argv[2];
if (!["check", "test"].includes(mode)) throw new Error("Usage: node scripts/verify.mjs check|test");
const files = ["plugins/whatsapp-relay/scripts", "scripts"].flatMap((directory) =>
  fs.readdirSync(path.join(root, directory)).filter((file) => file.endsWith(mode === "test" ? ".test.mjs" : ".mjs"))
    .map((file) => path.join(root, directory, file))
).sort();
if (mode === "test") {
  const result = spawnSync(process.execPath, ["--test", ...files], { cwd: root, stdio: "inherit", windowsHide: true });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} else {
  for (const file of files) {
    const result = spawnSync(process.execPath, ["--check", file], { cwd: root, stdio: "inherit", windowsHide: true });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
  console.log(`Syntax checked ${files.length} JavaScript modules.`);
}

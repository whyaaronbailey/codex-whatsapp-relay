import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

test("full checkout MCP initializes and lists tools from an unrelated cwd", { timeout: 30_000 }, async (t) => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "relay-mcp-packaging-"));
  const client = new Client({ name: "relay-packaging-test", version: "1.0.0" });
  // This is the documented direct MCP registration: the entry point is absolute.
  // It does not assert unverified plugin-cache path substitution behavior.
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL("./mcp-server.mjs", import.meta.url))],
    cwd,
    stderr: "pipe"
  });
  let stderr = "";
  transport.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-8000); });
  t.after(async () => {
    await client.close();
    await fs.rm(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  try {
    // Initialize and tools/list are metadata only. No WhatsApp connection tool is called.
    await client.connect(transport, { timeout: 15_000 });
    const { tools } = await client.listTools({}, { timeout: 10_000 });
    const names = tools.map((tool) => tool.name);
    assert.ok(names.includes("whatsapp_send_file"));
    assert.ok(names.includes("whatsapp_controller_status"));
    assert.ok(names.includes("whatsapp_start_controller_bridge"));
    assert.deepEqual(await fs.readdir(cwd), [], "MCP launch must not create files in its caller's cwd");
  } catch (error) {
    throw new Error(`Absolute MCP launch failed: ${error.message}\n${stderr}`, { cause: error });
  }
});

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ControllerConfigStore } from "./controller-config.mjs";

test("ControllerConfigStore defaults to multilingual Chatterbox for new configs", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "controller-config-test-"));
  const filePath = path.join(tempDir, "controller-config.json");

  try {
    const store = new ControllerConfigStore(filePath);
    const config = await store.load();

    assert.equal(config.ttsProvider, "chatterbox-turbo");
    assert.equal(config.ttsChatterboxAllowNonEnglish, true);
    assert.equal(config.defaultProject, "main");
    assert.equal(config.projects.length, 1);
    assert.equal(config.projects[0].alias, "main");
    assert.equal(config.projects[0].host, "host");
    assert.equal(config.hosts[0].id, "host");
    assert.equal(config.hosts[0].transport, "local");
    assert.equal(config.maxAttachmentBytes, 25 * 1024 * 1024);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("ControllerConfigStore normalizes boolean-like non-English overrides from disk", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "controller-config-test-"));
  const filePath = path.join(tempDir, "controller-config.json");

  try {
    await fs.writeFile(
      filePath,
      JSON.stringify({
        enabled: true,
        ttsProvider: "chatterbox",
        ttsChatterboxAllowNonEnglish: "false",
        allowedControllers: []
      }),
      "utf8"
    );

    const store = new ControllerConfigStore(filePath);
    const config = await store.load();

    assert.equal(config.ttsProvider, "chatterbox-turbo");
    assert.equal(config.ttsChatterboxAllowNonEnglish, false);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("ControllerConfigStore migrates a legacy single-workspace config into projects", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "controller-config-test-"));
  const filePath = path.join(tempDir, "controller-config.json");

  try {
    await fs.writeFile(
      filePath,
      JSON.stringify({
        enabled: true,
        workspace: "/tmp/alpha-app",
        model: "gpt-5.4",
        allowedControllers: []
      }),
      "utf8"
    );

    const store = new ControllerConfigStore(filePath);
    const config = await store.load();

    assert.equal(config.defaultProject, "main");
    assert.equal(config.workspace, path.resolve("/tmp/alpha-app"));
    assert.equal(config.projects.length, 1);
    assert.equal(config.projects[0].alias, "main");
    assert.equal(config.projects[0].workspace, path.resolve("/tmp/alpha-app"));
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("ControllerConfigStore persists independent host projects and attachment limits", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "controller-config-test-"));
  const filePath = path.join(tempDir, "controller-config.json");
  try {
    const store = new ControllerConfigStore(filePath);
    await store.update({
      hosts: [{
        id: "vm", transport: "ssh", target: "user@relay-vm",
        workerPath: "/opt/relay/worker.mjs", platform: "linux"
      }],
      projects: [
        { alias: "pc-service", workspace: path.join(tempDir, "service") },
        { alias: "vm-service", host: "vm", workspace: "/work/service" }
      ],
      defaultProject: "vm-service",
      maxAttachmentBytes: 10 * 1024 * 1024
    });
    const reloaded = await new ControllerConfigStore(filePath).load();
    assert.equal(reloaded.defaultProject, "vm-service");
    assert.equal(reloaded.workspace, "/work/service");
    assert.equal(reloaded.projects[0].host, "host");
    assert.equal(reloaded.projects[1].host, "vm");
    assert.equal(reloaded.projects[1].workspace, "/work/service");
    assert.deepEqual(reloaded.hosts.map((host) => host.id), ["host", "vm"]);
    assert.equal(reloaded.maxAttachmentBytes, 10 * 1024 * 1024);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("ControllerConfigStore rejects invalid attachment limits and unknown host references", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "controller-config-test-"));
  const filePath = path.join(tempDir, "controller-config.json");
  try {
    const store = new ControllerConfigStore(filePath);
    await store.update({});
    for (const maxAttachmentBytes of [0, -1, 1.5, "1024", 25 * 1024 * 1024 + 1, null]) {
      await assert.rejects(store.update({ maxAttachmentBytes }), /maxAttachmentBytes/);
    }
    await assert.rejects(store.update({
      projects: [{ alias: "broken", host: "missing", workspace: "/work/service" }]
    }), /unknown host/);
    const unchanged = await store.load();
    assert.equal(unchanged.projects[0].host, "host");
    assert.equal(unchanged.maxAttachmentBytes, 25 * 1024 * 1024);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

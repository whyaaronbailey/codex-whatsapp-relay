import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { normalizeConfiguredProjects } from "./controller-projects.mjs";
import { normalizeConfiguredHosts } from "./controller-hosts.mjs";
import { appServerPermissionParams, cliPermissionOverrides } from "./controller-permissions.mjs";

const workspace = path.resolve("provider-fixture");
test("different engines retain independent projects in the same host workspace", () => {
  const { projects } = normalizeConfiguredProjects({ projects: [
    { alias: "code", workspace },
    { alias: "open", engine: "opencode", workspace, opencodeUrl: "http://localhost:4096", opencodeApiVersion: "v2" },
    { alias: "claude", engine: "claude", workspace }
  ] });
  assert.equal(projects.length, 3);
  assert.deepEqual(projects.map((project) => project.engine), ["codex", "opencode", "claude"]);
  assert.deepEqual(projects.map((project) => project.permissionLevel), [null, "native", "native"]);
});

test("provider endpoint configuration excludes embedded secrets and unsafe URL forms", () => {
  for (const url of ["file:///tmp/server", "http://user:password@localhost:4096", "http://localhost:4096/path", "http://localhost:4096?token=secret", "http://localhost:4096/#secret"]) {
    assert.throws(() => normalizeConfiguredProjects({ projects: [{ workspace, engine: "opencode", opencodeUrl: url }] }), /opencodeUrl/);
  }
  assert.throws(() => normalizeConfiguredProjects({ projects: [{ workspace, engine: "opencode", opencodeUrl: "http://localhost:4096", opencodePasswordEnv: "PASSWORD; command" }] }), /environment variable/);
  assert.throws(() => normalizeConfiguredProjects({ projects: [{ workspace, engine: "opencode" }] }), /opencodeUrl/);
});

test("provider and Codex permission semantics cannot be silently interchanged", () => {
  assert.throws(() => normalizeConfiguredProjects({ projects: [{ workspace, engine: "codex", permissionLevel: "native" }] }), /sandbox/);
  for (const engine of ["opencode", "claude"]) {
    for (const permissionLevel of ["read-only", "workspace-write", "danger-full-access"]) {
      assert.throws(() => normalizeConfiguredProjects({ projects: [{ workspace, engine, permissionLevel, opencodeUrl: "http://localhost:4096" }] }), /native permissions/);
    }
  }
  assert.throws(() => appServerPermissionParams("native"), /Codex requires/);
  assert.throws(() => cliPermissionOverrides("native"), /Codex requires/);
});

test("SSH host retains native Claude executable override without sharing environment", () => {
  const vm = normalizeConfiguredHosts({ hosts: [{ id: "vm", transport: "ssh", target: "relay-vm", platform: "win32", workerPath: "C:\\Relay\\relay-worker.mjs", claudeBin: "C:\\Users\\agent\\.local\\bin\\claude.exe", env: { SECRET: "do-not-copy" } }] }).find((host) => host.id === "vm");
  assert.equal(vm.claudeBin, "C:\\Users\\agent\\.local\\bin\\claude.exe");
  assert.equal(vm.env, undefined);
});

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  deriveProjectAlias,
  findConfiguredProject,
  normalizeConfiguredProjects,
  normalizeProjectAlias,
  resolveConfiguredProject,
  resolveConfiguredProjectSelection,
  resolveExplicitConfiguredProject,
  resolveProjectReference,
  sanitizeProjectSpec
} from "./controller-projects.mjs";

test("normalizeConfiguredProjects migrates a legacy single-workspace config", () => {
  const normalized = normalizeConfiguredProjects({
    workspace: "/tmp/example",
    defaultProject: "main"
  });

  assert.equal(normalized.defaultProject, "main");
  assert.equal(normalized.workspace, path.resolve("/tmp/example"));
  assert.equal(normalized.projects.length, 1);
  assert.equal(normalized.projects[0].alias, "main");
  assert.equal(normalized.projects[0].workspace, path.resolve("/tmp/example"));
  assert.equal(normalized.projects[0].host, "host");
});

test("normalizeConfiguredProjects collapses duplicate workspaces down to one project", () => {
  const normalized = normalizeConfiguredProjects({
    defaultProject: "main",
    projects: [
      { alias: "retail-dashboard", workspace: "/tmp/retail-dashboard" },
      { alias: "retail-dashboard-2", workspace: "/tmp/retail-dashboard" }
    ]
  });

  assert.equal(normalized.projects.length, 1);
  assert.equal(normalized.projects[0].alias, "retail-dashboard");
  assert.equal(normalized.projects[0].workspace, path.resolve("/tmp/retail-dashboard"));
});

test("resolveConfiguredProject finds aliases and workspace basenames", () => {
  const config = {
    defaultProject: "relay",
    projects: [
      { alias: "relay", workspace: "/tmp/relay" },
      { alias: "alpha-app", workspace: "/tmp/alpha-app" }
    ]
  };

  assert.equal(resolveConfiguredProject(config, "alpha-app")?.workspace, path.resolve("/tmp/alpha-app"));
  assert.equal(resolveConfiguredProject(config, "alpha app")?.workspace, path.resolve("/tmp/alpha-app"));
});

test("findConfiguredProject resolves unique prefixes and existing workspaces", () => {
  const config = {
    defaultProject: "relay",
    projects: [
      { alias: "relay", workspace: "/tmp/relay" },
      { alias: "retail-dashboard", workspace: "/tmp/retail-dashboard" }
    ]
  };

  assert.equal(findConfiguredProject(config, "retail-dash")?.alias, "retail-dashboard");
  assert.equal(
    findConfiguredProject(config, "/tmp/retail-dashboard")?.alias,
    "retail-dashboard"
  );
});

test("resolveExplicitConfiguredProject keeps exact aliases deterministic", () => {
  const config = {
    defaultProject: "main",
    projects: [
      { alias: "sample-service", workspace: "/tmp/sample-service" },
      { alias: "sample-web", workspace: "/tmp/sample-web" }
    ]
  };

  assert.equal(resolveExplicitConfiguredProject(config, "sample-service")?.alias, "sample-service");
  assert.equal(resolveExplicitConfiguredProject(config, "blood")?.alias ?? null, null);
});

test("deriveProjectAlias avoids alias collisions", () => {
  const config = {
    projects: [{ alias: "alpha-app", workspace: "/tmp/alpha-app" }]
  };

  assert.equal(deriveProjectAlias("/tmp/alpha-app", config), "alpha-app-2");
});

test("resolveProjectReference auto-discovers a project from a named home directory", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "controller-projects-test-"));
  const homeDir = path.join(tempDir, "home");
  const repoDir = path.join(homeDir, "repo");
  const codeDir = path.join(homeDir, "code");
  const backendDir = path.join(codeDir, "alpha-app");

  try {
    await fs.mkdir(backendDir, { recursive: true });
    await fs.mkdir(repoDir, { recursive: true });

    const resolved = await resolveProjectReference(
      { projects: [] },
      "alpha app inside code directory",
      { homeDir, repoRootDir: repoDir }
    );

    assert.equal(resolved?.created, true);
    assert.equal(resolved?.project.workspace, backendDir);
    assert.equal(resolved?.project.alias, "alpha-app");
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("resolveProjectReference prefers a pasted absolute path even with WhatsApp formatting noise", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "controller-projects-test-"));
  const homeDir = path.join(tempDir, "home");
  const repoDir = path.join(homeDir, "repo");
  const kioskDir = path.join(homeDir, "code", "retail-kiosk");

  try {
    await fs.mkdir(kioskDir, { recursive: true });
    await fs.mkdir(repoDir, { recursive: true });

    const resolved = await resolveProjectReference(
      { projects: [] },
      `\u2060[retail-kiosk](${kioskDir})`,
      { homeDir, repoRootDir: repoDir }
    );

    assert.equal(resolved?.created, true);
    assert.equal(resolved?.project.workspace, kioskDir);
    assert.equal(resolved?.project.alias, "retail-kiosk");

    const aliasPlusPath = await resolveProjectReference(
      { projects: [] },
      `retail kiosk ${kioskDir}`,
      { homeDir, repoRootDir: repoDir }
    );

    assert.equal(aliasPlusPath?.created, true);
    assert.equal(aliasPlusPath?.project.workspace, kioskDir);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("resolveProjectReference returns configured projects without recreating them", async () => {
  const config = {
    defaultProject: "main",
    projects: [
      { alias: "alpha-app", workspace: "/tmp/alpha-app" }
    ]
  };

  const resolved = await resolveProjectReference(config, "alpha-app");

  assert.equal(resolved?.created, false);
  assert.equal(resolved?.project.alias, "alpha-app");
});

test("resolveProjectReference reuses configured workspaces instead of creating alias duplicates", async () => {
  const config = {
    defaultProject: "main",
    projects: [
      { alias: "retail-dashboard", workspace: "/tmp/retail-dashboard" }
    ]
  };

  const resolved = await resolveProjectReference(config, "retail-dash");

  assert.equal(resolved?.created, false);
  assert.equal(resolved?.project.alias, "retail-dashboard");
});

test("resolveProjectReference can skip configured project matching and keep searching locally", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "controller-projects-test-"));
  const homeDir = path.join(tempDir, "home");
  const repoDir = path.join(homeDir, "repo");
  const codeDir = path.join(homeDir, "code");
  const backendDir = path.join(codeDir, "alpha-app");

  try {
    await fs.mkdir(backendDir, { recursive: true });
    await fs.mkdir(repoDir, { recursive: true });

    const resolved = await resolveProjectReference(
      {
        defaultProject: "main",
        projects: [{ alias: "beta-app", workspace: "/tmp/beta-app" }]
      },
      "alpha app inside code directory",
      { homeDir, repoRootDir: repoDir, skipConfiguredSelection: true }
    );

    assert.equal(resolved?.created, true);
    assert.equal(resolved?.project.alias, "alpha-app");
    assert.equal(resolved?.project.workspace, backendDir);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("normalizeProjectAlias keeps project ids shell-friendly", () => {
  assert.equal(normalizeProjectAlias("Alpha App"), "alpha-app");
  assert.equal(normalizeProjectAlias("api/v2"), "api-v2");
});

test("sanitizeProjectSpec strips invisible characters and unwraps markdown links", () => {
  assert.equal(
    sanitizeProjectSpec("\u2060[retail-dashboard](/tmp/retail-dashboard)"),
    "/tmp/retail-dashboard"
  );
});

function remoteHost(id = "vm", platform = "linux") {
  return {
    id,
    transport: "ssh",
    target: "user@relay-vm",
    workerPath: platform === "win32" ? "C:\\relay\\worker.mjs" : "/opt/relay/worker.mjs",
    platform
  };
}

test("remote POSIX and Windows workspaces preserve their own path semantics", () => {
  const config = normalizeConfiguredProjects({
    hosts: [remoteHost(), remoteHost("win-vm", "win32")],
    projects: [
      { alias: "linux", host: "vm", workspace: "/home/user/My Project" },
      { alias: "windows", host: "win-vm", workspace: "C:\\Users\\user\\My Project" },
      { alias: "share", host: "win-vm", workspace: "\\\\vm\\projects\\service" }
    ]
  });
  assert.equal(config.projects[0].workspace, "/home/user/My Project");
  assert.equal(config.projects[1].workspace, "C:\\Users\\user\\My Project");
  assert.equal(config.projects[2].workspace, "\\\\vm\\projects\\service");
});

test("project normalization rejects unknown hosts and relative or mismatched remote paths", () => {
  assert.throws(() => normalizeConfiguredProjects({
    projects: [{ alias: "broken", host: "missing", workspace: "/work" }]
  }), /unknown host/);
  for (const host of [false, 0, {}, []]) {
    assert.throws(() => normalizeConfiguredProjects({
      projects: [{ alias: "broken", host, workspace: "/work" }]
    }), /unknown host/);
  }
  for (const workspace of [undefined, "", "project", "./project", "../project", "~/project", "C:\\project", "/a\u0000b"]) {
    assert.throws(() => normalizeConfiguredProjects({
      hosts: [remoteHost()],
      projects: [{ host: "vm", workspace }]
    }), /absolute remote path/);
  }
  for (const workspace of ["C:project", "\\project", "/home/user/project"]) {
    assert.throws(() => normalizeConfiguredProjects({
      hosts: [remoteHost("win-vm", "win32")],
      projects: [{ host: "win-vm", workspace }]
    }), /absolute remote path/);
  }
});

test("same workspace on different hosts remains distinct and aliases stay globally unique", () => {
  const config = normalizeConfiguredProjects({
    hosts: [remoteHost("vm"), remoteHost("vm-two")],
    projects: [
      { alias: "service", host: "vm", workspace: "/work/service" },
      { alias: "service", host: "vm-two", workspace: "/work/service" },
      { alias: "duplicate", host: "vm", workspace: "/work/service" }
    ]
  });
  assert.deepEqual(config.projects.map(({ alias, host }) => ({ alias, host })), [
    { alias: "service", host: "vm" },
    { alias: "service-2", host: "vm-two" }
  ]);
});

test("ambiguous cross-host workspace or basename selection requires a host or exact alias", async () => {
  const config = {
    hosts: [remoteHost("vm"), remoteHost("vm-two")],
    projects: [
      { alias: "first", host: "vm", workspace: "/work/service" },
      { alias: "second", host: "vm-two", workspace: "/work/service" }
    ]
  };
  for (const token of ["/work/service", "service"]) {
    const selection = resolveConfiguredProjectSelection(config, token);
    assert.equal(selection.match, null);
    assert.equal(selection.candidates.length, 2);
    assert.equal(resolveExplicitConfiguredProject(config, token), null);
    assert.equal(resolveConfiguredProject(config, token), null);
    assert.equal((await resolveProjectReference(config, token))?.matchType, "ambiguousConfigured");
    assert.equal(resolveConfiguredProjectSelection(config, token, { hostId: "vm-two" }).match.alias, "second");
  }
  assert.equal(resolveExplicitConfiguredProject(config, "second").host, "vm-two");
  assert.throws(() => resolveConfiguredProjectSelection(config, "service", { hostId: "absent" }), /Unknown host/);
});

test("remote project matching handles Windows paths with spaces on every gateway platform", () => {
  const config = {
    hosts: [remoteHost("win-vm", "win32")],
    projects: [{ alias: "win-service", host: "win-vm", workspace: "C:\\Projects\\My Service" }]
  };
  assert.equal(findConfiguredProject(config, "C:\\Projects\\My Service").alias, "win-service");
  assert.equal(findConfiguredProject(config, "c:/projects/My Service").alias, "win-service");
  assert.equal(findConfiguredProject(config, "My Service").alias, "win-service");
  assert.equal(findConfiguredProject(config, "C:\\Projects\\My Service\\").alias, "win-service");
});

test("remote host resolution never discovers a same-named local directory", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "controller-projects-test-"));
  try {
    const repoDir = path.join(tempDir, "repo");
    const localProject = path.join(tempDir, "code", "service");
    await fs.mkdir(repoDir, { recursive: true });
    await fs.mkdir(localProject, { recursive: true });
    const config = {
      hosts: [remoteHost()],
      defaultProject: "vm-service",
      projects: [{ alias: "vm-service", host: "vm", workspace: "/work/service" }]
    };
    const options = { homeDir: tempDir, repoRootDir: repoDir, hostId: "vm" };
    assert.equal(await resolveProjectReference(config, localProject, options), null);
    assert.equal(await resolveProjectReference(config, "service inside code directory", options), null);
    assert.equal(await resolveProjectReference(config, "vm-service", { ...options, skipConfiguredSelection: true }), null);
    assert.equal(await resolveProjectReference(config, "vm-service", { ...options, hostId: "host", skipConfiguredSelection: true }), null);
    assert.equal(await resolveProjectReference(config, "service inside code directory", { homeDir: tempDir, repoRootDir: repoDir }), null);
    assert.equal((await resolveProjectReference(config, "vm-service", options)).project.host, "vm");
    const local = await resolveProjectReference(config, localProject, { ...options, hostId: "host" });
    assert.equal(local.project.host, "host");
    assert.equal(local.project.workspace, localProject);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

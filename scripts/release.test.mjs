import test from "node:test";
import assert from "node:assert/strict";

import {
  CHANGELOG_PATH,
  PACKAGE_JSON_PATH,
  PACKAGE_LOCK_PATH,
  PLUGIN_MANIFEST_PATH,
  README_PATH,
  prepareReleaseArtifacts,
  updateChangelogForRelease,
  updateReadmeReleaseTag
} from "./release.mjs";

test("updateChangelogForRelease moves Unreleased notes into a versioned section", () => {
  const source = `# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Fixed

- Example fix.

## [0.4.2] - 2026-03-29

### Added

- Older release.
`;

  const updated = updateChangelogForRelease(source, "0.4.3", "2026-03-30");

  assert.match(updated, /## \[Unreleased\]\n\n## \[0\.4\.3\] - 2026-03-30/);
  assert.match(updated, /## \[0\.4\.3\] - 2026-03-30\n\n### Fixed\n\n- Example fix\./);
  assert.match(updated, /## \[0\.4\.2\] - 2026-03-29/);
});

test("updateReadmeReleaseTag updates the pinned install tag references", () => {
  const source = `Install the current release tag:
v0.4.2

1. Clone the repo.
2. If it already exists, fetch tags and check out v0.4.2 without deleting unrelated user files.
`;

  const updated = updateReadmeReleaseTag(source, "0.4.3");

  assert.match(updated, /Install the current release tag:\nv0\.4\.3/);
  assert.match(updated, /fetch tags and check out v0\.4\.3 without deleting unrelated user files\./);
});

test("prepareReleaseArtifacts updates all release-managed files together", () => {
  const inputs = {
    [CHANGELOG_PATH]: `# Changelog

## [Unreleased]

### Added

- Thing.
`,
    [PACKAGE_JSON_PATH]: `{
  "name": "codex-whatsapp",
  "version": "0.4.2"
}
`,
    [PACKAGE_LOCK_PATH]: `{
  "name": "codex-whatsapp",
  "version": "0.4.2",
  "packages": {
    "": {
      "name": "codex-whatsapp",
      "version": "0.4.2"
    }
  }
}
`,
    [PLUGIN_MANIFEST_PATH]: `{
  "name": "whatsapp-relay",
  "version": "0.2.0"
}
`,
    [README_PATH]: `Install the current release tag:
v0.4.2

2. If it already exists, fetch tags and check out v0.4.2 without deleting unrelated user files.
`
  };

  const artifacts = prepareReleaseArtifacts(inputs, "0.4.3", "2026-03-30");

  assert.equal(JSON.parse(artifacts[PACKAGE_JSON_PATH]).version, "0.4.3");
  assert.equal(JSON.parse(artifacts[PACKAGE_LOCK_PATH]).version, "0.4.3");
  assert.equal(JSON.parse(artifacts[PACKAGE_LOCK_PATH]).packages[""].version, "0.4.3");
  assert.equal(JSON.parse(artifacts[PLUGIN_MANIFEST_PATH]).version, "0.4.3");
  assert.match(artifacts[README_PATH], /v0\.4\.3/);
  assert.match(artifacts[CHANGELOG_PATH], /## \[0\.4\.3\] - 2026-03-30/);
});

test("release preparation handles Windows README newlines and keeps the clone tag aligned", () => {
  const source = [
    "git clone --branch v0.4.3 https://github.com/whyaaronbailey/codex-whatsapp-relay.git",
    "Install the current release tag:", "v0.4.3", "",
    "2. If it already exists, fetch tags and check out v0.4.3 without deleting unrelated user files."
  ].join("\r\n");
  const updated = updateReadmeReleaseTag(source, "0.5.0");
  assert.match(updated, /git clone --branch v0\.5\.0 /);
  assert.match(updated, /Install the current release tag:\nv0\.5\.0/);
  assert.match(updated, /check out v0\.5\.0 without deleting/);
  assert.doesNotMatch(updated, /v0\.4\.3/);
});

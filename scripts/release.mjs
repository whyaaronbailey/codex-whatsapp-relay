import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

export const PACKAGE_JSON_PATH = path.join(repoRoot, "package.json");
export const PACKAGE_LOCK_PATH = path.join(repoRoot, "package-lock.json");
export const PLUGIN_MANIFEST_PATH = path.join(
  repoRoot,
  "plugins",
  "whatsapp-relay",
  ".codex-plugin",
  "plugin.json"
);
export const README_PATH = path.join(repoRoot, "README.md");
export const CHANGELOG_PATH = path.join(repoRoot, "CHANGELOG.md");

function printHelp() {
  console.log(`Prepare a deterministic release update for this repo.

Usage:
  npm run release:prepare -- --version <X.Y.Z> --date <YYYY-MM-DD>
  npm run release:prepare -- --version <X.Y.Z> --date <YYYY-MM-DD> --dry-run

Options:
  --version   Required. Release version, with or without a leading "v".
  --date      Required. Release date in YYYY-MM-DD format.
  --dry-run   Show the planned updates without writing files.
  --help      Show this help text.

Examples:
  npm run release:prepare -- --version 0.4.3 --date 2026-03-30
  npm run release:prepare -- --version v0.4.3 --date 2026-03-30 --dry-run
`);
}

function fail(message) {
  throw new Error(message);
}

function normalizeVersion(input) {
  const raw = String(input ?? "").trim();
  const normalized = raw.startsWith("v") ? raw.slice(1) : raw;
  if (!/^\d+\.\d+\.\d+$/.test(normalized)) {
    fail(`Invalid version "${raw}". Expected X.Y.Z or vX.Y.Z.`);
  }
  return normalized;
}

function normalizeDate(input) {
  const raw = String(input ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    fail(`Invalid date "${raw}". Expected YYYY-MM-DD.`);
  }
  return raw;
}

function updateJsonVersion(source, version, { includeRootPackageVersion = false } = {}) {
  const parsed = JSON.parse(source);
  parsed.version = version;
  if (includeRootPackageVersion && parsed.packages?.[""]) {
    parsed.packages[""].version = version;
  }
  return `${JSON.stringify(parsed, null, 2)}\n`;
}

export function updateReadmeReleaseTag(source, version) {
  source = source.replace(/\r\n/g, "\n");
  const tag = `v${version}`;
  let updates = 0;

  const installTagPattern = /(Install the current release tag:\n)(v\d+\.\d+\.\d+)/;
  if (!installTagPattern.test(source)) {
    fail("README.md is missing the pinned release tag block.");
  }
  const withInstallTag = source.replace(installTagPattern, (_match, prefix) => {
    updates += 1;
    return `${prefix}${tag}`;
  });

  const checkoutPattern =
    /(If it already exists, fetch tags and check out )v\d+\.\d+\.\d+( without deleting unrelated user files\.)/;
  if (!checkoutPattern.test(withInstallTag)) {
    fail("README.md is missing the pinned release checkout step.");
  }

  const updated = withInstallTag.replace(checkoutPattern, (_match, prefix, suffix) => {
    updates += 1;
    return `${prefix}${tag}${suffix}`;
  });

  if (updates !== 2) {
    fail(`Expected to update 2 README release references, updated ${updates}.`);
  }

  return updated.replace(
    /(git clone --branch )v\d+\.\d+\.\d+( https:\/\/github\.com\/whyaaronbailey\/codex-whatsapp-relay\.git)/g,
    (_match, prefix, suffix) => `${prefix}${tag}${suffix}`
  );
}

export function updateChangelogForRelease(source, version, date) {
  const normalized = source.replace(/\r\n/g, "\n");
  const versionHeading = `## [${version}]`;
  if (normalized.includes(versionHeading)) {
    fail(`CHANGELOG.md already contains a section for ${version}.`);
  }

  const unreleasedHeading = "## [Unreleased]";
  const unreleasedIndex = normalized.indexOf(unreleasedHeading);
  if (unreleasedIndex === -1) {
    fail("CHANGELOG.md is missing the Unreleased section.");
  }

  const nextSectionIndex = normalized.indexOf("\n## [", unreleasedIndex + unreleasedHeading.length);
  const bodyStart = unreleasedIndex + unreleasedHeading.length;
  const unreleasedBody = normalized.slice(
    bodyStart,
    nextSectionIndex === -1 ? normalized.length : nextSectionIndex
  );
  const before = normalized.slice(0, unreleasedIndex);
  const after =
    nextSectionIndex === -1 ? "" : normalized.slice(nextSectionIndex).replace(/^\n+/, "");
  const trimmedBody = unreleasedBody.trim();

  let result = `${before}${unreleasedHeading}\n\n## [${version}] - ${date}`;
  if (trimmedBody) {
    result += `\n\n${trimmedBody}`;
  }
  if (after) {
    result += `\n\n${after}`;
  } else {
    result += "\n";
  }

  return result.endsWith("\n") ? result : `${result}\n`;
}

export function prepareReleaseArtifacts(inputs, version, date) {
  return {
    [CHANGELOG_PATH]: updateChangelogForRelease(inputs[CHANGELOG_PATH], version, date),
    [PACKAGE_JSON_PATH]: updateJsonVersion(inputs[PACKAGE_JSON_PATH], version),
    [PACKAGE_LOCK_PATH]: updateJsonVersion(inputs[PACKAGE_LOCK_PATH], version, {
      includeRootPackageVersion: true
    }),
    [PLUGIN_MANIFEST_PATH]: updateJsonVersion(inputs[PLUGIN_MANIFEST_PATH], version),
    [README_PATH]: updateReadmeReleaseTag(inputs[README_PATH], version)
  };
}

function parseArgs(argv) {
  const options = {
    dryRun: false,
    help: false,
    version: null,
    date: null
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (arg === "--version") {
      options.version = argv[index + 1] ?? null;
      index += 1;
      continue;
    }
    if (arg === "--date") {
      options.date = argv[index + 1] ?? null;
      index += 1;
      continue;
    }
    fail(`Unknown argument "${arg}". Use --help for usage.`);
  }

  return options;
}

async function readInputs() {
  const entries = await Promise.all(
    [CHANGELOG_PATH, PACKAGE_JSON_PATH, PACKAGE_LOCK_PATH, PLUGIN_MANIFEST_PATH, README_PATH].map(
      async (filePath) => [filePath, await fs.readFile(filePath, "utf8")]
    )
  );
  return Object.fromEntries(entries);
}

function buildDiffSummary(before, after) {
  if (before === after) {
    return "no changes";
  }

  const beforeLines = before.split("\n");
  const afterLines = after.split("\n");
  let lineNumber = 0;
  while (
    lineNumber < beforeLines.length &&
    lineNumber < afterLines.length &&
    beforeLines[lineNumber] === afterLines[lineNumber]
  ) {
    lineNumber += 1;
  }

  return `first change at line ${lineNumber + 1}`;
}

async function writeArtifacts(artifacts) {
  await Promise.all(
    Object.entries(artifacts).map(([filePath, content]) => fs.writeFile(filePath, content))
  );
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    printHelp();
    return;
  }

  if (!options.version || !options.date) {
    printHelp();
    fail("Both --version and --date are required.");
  }

  const version = normalizeVersion(options.version);
  const date = normalizeDate(options.date);
  const inputs = await readInputs();
  const artifacts = prepareReleaseArtifacts(inputs, version, date);
  const changedFiles = Object.entries(artifacts).map(([filePath, nextContent]) => ({
    filePath,
    summary: buildDiffSummary(inputs[filePath], nextContent)
  }));

  if (options.dryRun) {
    console.log(`Dry run for release v${version} (${date})`);
    for (const entry of changedFiles) {
      console.log(`- ${path.relative(repoRoot, entry.filePath)}: ${entry.summary}`);
    }
    return;
  }

  await writeArtifacts(artifacts);

  console.log(`Prepared release v${version} (${date})`);
  for (const entry of changedFiles) {
    console.log(`- updated ${path.relative(repoRoot, entry.filePath)} (${entry.summary})`);
  }
  console.log("");
  console.log("Next steps:");
  console.log("- Review the diff.");
  console.log("- Run npm run check && npm test.");
  console.log("- Commit the release prep, tag vX.Y.Z, and push.");
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  main().catch((error) => {
    console.error(`release:prepare failed: ${error.message}`);
    process.exitCode = 1;
  });
}

#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  closeSync,
  fstatSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const checkOnly = process.argv.includes("--check");
const unknownArguments = process.argv
  .slice(2)
  .filter((argument) => argument !== "--check");

if (unknownArguments.length > 0) {
  fail(`Unknown argument(s): ${unknownArguments.join(", ")}`);
}

const noticePath = join(repositoryRoot, "THIRD_PARTY_NOTICES.md");
const licenseBundlePath = join(repositoryRoot, "THIRD_PARTY_LICENSES.txt");
const overrideManifestPath = join(
  repositoryRoot,
  "third-party",
  "license-overrides.json",
);
const maxMetadataFileBytes = 8 * 1024 * 1024;
const maxLicenseFileBytes = 2 * 1024 * 1024;

const npmComponents = collectNpmComponents();
const cargoComponents = collectCargoComponents();
const licenseOverrides = loadLicenseOverrides(overrideManifestPath);
const components = applyLicenseOverrides(
  [...npmComponents, ...cargoComponents],
  licenseOverrides,
).sort(compareComponents);

if (components.length === 0) {
  fail("No third-party components were discovered.");
}

const componentsWithoutLicenseText = components.filter(
  (component) => component.licenseFiles.length === 0,
);
if (componentsWithoutLicenseText.length > 0) {
  fail(
    `Windows production components without license text: ${componentsWithoutLicenseText
      .map(
        (component) =>
          `${component.ecosystem}:${component.name}@${component.version}`,
      )
      .join(", ")}`,
  );
}

const notice = renderNotice(components);
const licenseBundle = renderLicenseBundle(components);

if (checkOnly) {
  checkGeneratedFile(noticePath, notice);
  checkGeneratedFile(licenseBundlePath, licenseBundle);
  console.log(
    `Third-party notices are current (${npmComponents.length} npm, ${cargoComponents.length} Cargo components).`,
  );
} else {
  writeFileSync(noticePath, notice, "utf8");
  writeFileSync(licenseBundlePath, licenseBundle, "utf8");
  console.log(
    `Generated THIRD_PARTY_NOTICES.md and THIRD_PARTY_LICENSES.txt (${npmComponents.length} npm, ${cargoComponents.length} Cargo components).`,
  );
}

function collectNpmComponents() {
  const lockPath = join(repositoryRoot, "package-lock.json");
  const lock = readJson(lockPath, { root: repositoryRoot });
  const nodeModulesRoot = resolveContainedRealPath(
    repositoryRoot,
    join(repositoryRoot, "node_modules"),
  );

  if (lock.lockfileVersion < 2 || typeof lock.packages !== "object") {
    fail("package-lock.json must use the packages-based npm lockfile format.");
  }

  const components = [];
  for (const [packagePath, record] of Object.entries(lock.packages)) {
    if (
      packagePath === "" ||
      !packagePath.includes("node_modules/") ||
      record.dev === true
    ) {
      continue;
    }

    const name = npmNameFromLockPath(packagePath);
    const installedDirectory = resolveNpmPackageDirectory(
      nodeModulesRoot,
      packagePath,
    );
    const installedManifest = join(installedDirectory, "package.json");
    const manifest =
      readJson(installedManifest, {
        optional: true,
        root: nodeModulesRoot,
      }) ?? {};

    components.push({
      ecosystem: "npm",
      name: manifest.name ?? name,
      version: manifest.version ?? record.version ?? "unknown",
      license:
        normalizeLicense(manifest.license) ??
        normalizeLicense(record.license) ??
        "Not declared",
      repository: normalizeRepository(
        manifest.repository ?? record.repository ?? manifest.homepage,
      ),
      licenseFiles: collectLicenseFiles(installedDirectory, manifest.license),
    });
  }

  return deduplicateComponents(components);
}

function resolveNpmPackageDirectory(nodeModulesRoot, packagePath) {
  const components = packagePath.split("/");
  if (
    components[0] !== "node_modules" ||
    components.some(
      (component) =>
        component === "" ||
        component === "." ||
        component === ".." ||
        component.includes("\\") ||
        component.includes(":"),
    )
  ) {
    fail(`Unsafe package-lock.json package path: ${packagePath}`);
  }

  const installedDirectory = resolve(
    nodeModulesRoot,
    ...components.slice(1),
  );
  assertPathIsInside(
    nodeModulesRoot,
    installedDirectory,
    `package-lock.json package path ${packagePath}`,
  );
  return installedDirectory;
}

function collectCargoComponents() {
  const cargo = spawnSync(
    "cargo",
    [
      "metadata",
      "--format-version",
      "1",
      "--locked",
      "--filter-platform",
      "x86_64-pc-windows-msvc",
      "--manifest-path",
      join(repositoryRoot, "src-tauri", "Cargo.toml"),
    ],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
    },
  );

  if (cargo.error) {
    fail(`Unable to run cargo metadata: ${cargo.error.message}`);
  }
  if (cargo.status !== 0) {
    fail(
      `cargo metadata failed:\n${(cargo.stderr || cargo.stdout).trim()}`,
    );
  }

  let metadata;
  try {
    metadata = JSON.parse(cargo.stdout);
  } catch (error) {
    fail(`cargo metadata returned invalid JSON: ${error.message}`);
  }

  const resolvedIds = new Set(metadata.resolve?.nodes?.map((node) => node.id));
  const workspaceIds = new Set(metadata.workspace_members ?? []);
  const components = [];

  for (const cargoPackage of metadata.packages ?? []) {
    if (
      workspaceIds.has(cargoPackage.id) ||
      !resolvedIds.has(cargoPackage.id)
    ) {
      continue;
    }

    const packageDirectory = dirname(cargoPackage.manifest_path);
    components.push({
      ecosystem: "Cargo",
      name: cargoPackage.name,
      version: cargoPackage.version,
      license: normalizeLicense(cargoPackage.license) ?? "Not declared",
      repository: normalizeRepository(
        cargoPackage.repository ?? cargoPackage.homepage,
      ),
      licenseFiles: collectLicenseFiles(
        packageDirectory,
        cargoPackage.license,
        cargoPackage.license_file,
      ),
    });
  }

  return deduplicateComponents(components);
}

function collectLicenseFiles(
  packageDirectory,
  declaredLicense,
  declaredLicenseFile,
) {
  const directory = readDirectoryIfPresent(packageDirectory);
  if (directory === undefined) {
    return [];
  }
  const packageRoot = directory.path;
  const directoryEntries = directory.entries;

  const candidates = new Set();
  if (declaredLicenseFile) {
    const declaredCandidate = resolve(packageRoot, declaredLicenseFile);
    const packageRelativePath = relative(packageRoot, declaredCandidate);
    if (
      packageRelativePath !== "" &&
      packageRelativePath !== ".." &&
      !packageRelativePath.startsWith(`..\\`) &&
      !packageRelativePath.startsWith("../") &&
      !isAbsolute(packageRelativePath)
    ) {
      candidates.add(declaredCandidate);
    }
  }

  for (const entry of directoryEntries) {
    if (
      entry.isFile() &&
      /^(licen[cs]e|copying|notice)(?:$|[._-])/i.test(entry.name)
    ) {
      candidates.add(join(packageRoot, entry.name));
    }
  }

  const files = [];
  for (const candidate of [...candidates].sort((left, right) =>
      left.localeCompare(right, "en", { sensitivity: "base" }),
  )) {
    const bytes = readBoundedRegularFile(
      candidate,
      maxLicenseFileBytes,
      packageRoot,
    );
    if (bytes === undefined || bytes.length === 0) {
      continue;
    }

    const text = normalizeText(bytes.toString("utf8"));
    if (text.includes("\0") || text.length === 0) {
      continue;
    }

    files.push({
      name: relative(packageRoot, candidate).replaceAll("\\", "/"),
      text,
      sha256: createHash("sha256").update(text, "utf8").digest("hex"),
    });
  }

  if (files.length === 0 && normalizeLicense(declaredLicense)) {
    return [];
  }
  return files;
}

function loadLicenseOverrides(path) {
  const manifest = readJson(path, { root: repositoryRoot });
  if (manifest.version !== 1) {
    fail("third-party/license-overrides.json must have version 1.");
  }
  if (!Array.isArray(manifest.bodies) || !Array.isArray(manifest.components)) {
    fail(
      "third-party/license-overrides.json must contain bodies and components arrays.",
    );
  }

  const manifestDirectory = dirname(path);
  const bodies = new Map();

  for (const entry of manifest.bodies) {
    requireNonEmptyString(entry.id, "Override body id");
    requireSha256(entry.sha256, `Override body ${entry.id}`);
    requireNonEmptyString(entry.sourceFile, `Override body ${entry.id} sourceFile`);
    requireHttpsUrl(entry.sourceUrl, `Override body ${entry.id} sourceUrl`);

    if (bodies.has(entry.id)) {
      fail(`Duplicate override body id: ${entry.id}`);
    }

    let file;
    if (entry.path !== undefined) {
      requireNonEmptyString(entry.path, `Override body ${entry.id} path`);
      const absolutePath = resolve(manifestDirectory, entry.path);
      const manifestRelativePath = relative(manifestDirectory, absolutePath);
      if (
        manifestRelativePath === "" ||
        manifestRelativePath === ".." ||
        manifestRelativePath.startsWith(`..\\`) ||
        manifestRelativePath.startsWith("../") ||
        isAbsolute(manifestRelativePath)
      ) {
        fail(`Override body ${entry.id} path escapes third-party/.`);
      }
      const bytes = readBoundedRegularFile(
        absolutePath,
        maxLicenseFileBytes,
        manifestDirectory,
      );
      if (bytes === undefined) {
        fail(`Override body ${entry.id} is missing: ${entry.path}`);
      }

      const text = normalizeText(bytes.toString("utf8"));
      const actualSha256 = createHash("sha256")
        .update(text, "utf8")
        .digest("hex");
      if (actualSha256 !== entry.sha256) {
        fail(
          `Override body ${entry.id} SHA-256 mismatch: expected ${entry.sha256}, got ${actualSha256}.`,
        );
      }

      file = {
        name: relative(repositoryRoot, absolutePath).replaceAll("\\", "/"),
        text,
        sha256: actualSha256,
        sourceUrl: entry.sourceUrl,
        verifiedOverride: true,
      };
    }

    bodies.set(entry.id, {
      ...entry,
      file,
    });
  }

  return {
    bodies,
    components: manifest.components,
  };
}

function applyLicenseOverrides(allComponents, overrides) {
  const componentIndex = new Map();
  const bundledTexts = new Map();

  for (const component of allComponents) {
    const key = componentIdentity(component);
    if (componentIndex.has(key)) {
      fail(`Duplicate discovered component: ${key}`);
    }
    componentIndex.set(key, component);

    for (const file of component.licenseFiles) {
      const existing = bundledTexts.get(file.sha256);
      if (existing && existing.text !== file.text) {
        fail(`SHA-256 collision while indexing license text ${file.sha256}.`);
      }
      bundledTexts.set(file.sha256, file);
    }
  }

  const overriddenComponents = new Set();
  const usedBodies = new Set();

  for (const entry of overrides.components) {
    requireNonEmptyString(entry.ecosystem, "Override component ecosystem");
    requireNonEmptyString(entry.name, "Override component name");
    requireNonEmptyString(entry.version, "Override component version");
    requireHttpsUrl(
      entry.sourceUrl,
      `Override component ${entry.ecosystem}:${entry.name}@${entry.version} sourceUrl`,
    );
    if (!Array.isArray(entry.bodyIds) || entry.bodyIds.length === 0) {
      fail(
        `Override component ${entry.ecosystem}:${entry.name}@${entry.version} must name at least one body.`,
      );
    }
    if (entry.sourceAvailabilityUrl !== undefined) {
      requireHttpsUrl(
        entry.sourceAvailabilityUrl,
        `Override component ${entry.ecosystem}:${entry.name}@${entry.version} sourceAvailabilityUrl`,
      );
    }

    const key = componentIdentity(entry);
    if (overriddenComponents.has(key)) {
      fail(`Duplicate override component: ${key}`);
    }
    overriddenComponents.add(key);

    const component = componentIndex.get(key);
    if (!component) {
      fail(`Override component is not in the Windows dependency graph: ${key}`);
    }

    component.repository = entry.sourceUrl;
    component.verifiedOverride = true;
    component.sourceAvailabilityUrl = entry.sourceAvailabilityUrl;

    for (const bodyId of entry.bodyIds) {
      const body = overrides.bodies.get(bodyId);
      if (!body) {
        fail(`Override component ${key} references unknown body ${bodyId}.`);
      }
      usedBodies.add(bodyId);

      const sourceFile = body.file ?? bundledTexts.get(body.sha256);
      if (!sourceFile) {
        fail(
          `Override body ${body.id} expected already-bundled SHA-256 ${body.sha256}, but it was not discovered.`,
        );
      }
      if (sourceFile.sha256 !== body.sha256) {
        fail(`Override body ${body.id} resolved to the wrong SHA-256.`);
      }

      component.licenseFiles.push({
        name:
          body.file?.name ??
          `verified-shared-text:${body.id}/${body.sourceFile}`,
        text: sourceFile.text,
        sha256: sourceFile.sha256,
        sourceUrl: body.sourceUrl,
        verifiedOverride: true,
      });
    }

    component.licenseFiles = deduplicateLicenseFiles(component.licenseFiles);
  }

  for (const bodyId of overrides.bodies.keys()) {
    if (!usedBodies.has(bodyId)) {
      fail(`Unused override body: ${bodyId}`);
    }
  }

  return allComponents;
}

function renderNotice(allComponents) {
  const rows = allComponents.map((component) => {
    const licenseTextStatus =
      component.verifiedOverride ? "Included (verified override)" : "Included";
    return `| ${escapeMarkdown(component.ecosystem)} | ${escapeMarkdown(component.name)} | ${escapeMarkdown(component.version)} | ${escapeMarkdown(component.license)} | ${licenseTextStatus} | ${formatRepository(component.repository)} |`;
  });

  const npmCount = allComponents.filter(
    (component) => component.ecosystem === "npm",
  ).length;
  const cargoCount = allComponents.filter(
    (component) => component.ecosystem === "Cargo",
  ).length;
  const sourceAvailability = allComponents
    .filter((component) => component.sourceAvailabilityUrl)
    .map(
      (component) =>
        `- \`${component.ecosystem}:${component.name}@${component.version}\` includes MPL-2.0-covered code. Its exact Source Code Form is available at [the recorded upstream revision](${component.sourceAvailabilityUrl}).`,
    );

  return normalizeText(`# Third-party notices

> Generated by \`scripts/generate-third-party-notices.mjs\` from the committed npm and Cargo lockfiles plus the hash-verified override manifest at \`third-party/license-overrides.json\`. Do not edit this file directly.

CrowFlix includes or is built with the third-party components listed below. Their license texts are collected in \`THIRD_PARTY_LICENSES.txt\`. Package metadata is reproduced for attribution and does not imply endorsement by the package authors.

## Runtime data and external services

CrowFlix does not bundle or relicense channel, programme-guide, stream, logo, artwork, or linked-site content. At runtime it may retrieve or open data and content from IPTV-org, Apsattv, EPGShare, independent providers, and user-configured sources. Each source and service remains subject to its own terms, availability, permissions, and regional restrictions. Listing or accessing a source does not imply endorsement by CrowFlix or endorsement of CrowFlix by that source.

## Covered source-code availability

${sourceAvailability.join("\n")}

## Dependency inventory

Inventory: ${allComponents.length} components (${npmCount} npm, ${cargoCount} Cargo).

| Ecosystem | Package | Version | Declared license | License text | Upstream |
| --- | --- | --- | --- | --- | --- |
${rows.join("\n")}

Every Windows production component has an included package licence or a SHA-256-verified override. “Included (verified override)” identifies components whose published package omitted a standalone root licence, copyright, or notice file, or whose embedded binary carried additional upstream terms.
`);
}

function renderLicenseBundle(allComponents) {
  const groups = new Map();

  for (const component of allComponents) {
    const componentName = `${component.ecosystem}:${component.name}@${component.version}`;
    for (const licenseFile of component.licenseFiles) {
      let group = groups.get(licenseFile.sha256);
      if (!group) {
        group = {
          sha256: licenseFile.sha256,
          text: licenseFile.text,
          files: new Set(),
          components: new Set(),
          overrideSources: new Set(),
        };
        groups.set(licenseFile.sha256, group);
      }
      group.files.add(licenseFile.name);
      group.components.add(componentName);
      if (licenseFile.sourceUrl) {
        group.overrideSources.add(licenseFile.sourceUrl);
      }
    }
  }

  const sections = [...groups.values()]
    .sort((left, right) => {
      const leftName = [...left.components].sort()[0];
      const rightName = [...right.components].sort()[0];
      return leftName.localeCompare(rightName) || left.sha256.localeCompare(right.sha256);
    })
    .map((group) => {
      const componentList = [...group.components].sort().join(", ");
      const fileList = [...group.files].sort().join(", ");
      const overrideSourceList = [...group.overrideSources].sort().join(", ");
      return `${"=".repeat(80)}
Components: ${componentList}
Source files: ${fileList}
${overrideSourceList ? `Verified override sources: ${overrideSourceList}\n` : ""}Text SHA-256: ${group.sha256}
${"-".repeat(80)}
${group.text}`;
    });

  return normalizeText(`CROWFLIX THIRD-PARTY LICENSE TEXTS

Generated by scripts/generate-third-party-notices.mjs from installed package
contents resolved by package-lock.json and src-tauri/Cargo.lock, with exact
omissions supplied by third-party/license-overrides.json.

Identical license texts are stored once and attributed to every component that
provided or was explicitly associated with that text. Every checked-in override
body and every reused package text is validated by SHA-256 before generation.

${sections.join("\n\n")}
`);
}

function checkGeneratedFile(path, expected) {
  const bytes = readBoundedRegularFile(
    path,
    maxMetadataFileBytes,
    repositoryRoot,
  );
  if (bytes === undefined) {
    fail(
      `${relative(repositoryRoot, path)} is missing. Run "npm run notices" and commit the result.`,
    );
  }
  const actual = bytes.toString("utf8");
  if (actual !== expected) {
    fail(
      `${relative(repositoryRoot, path)} is stale. Run "npm run notices" and commit the result.`,
    );
  }
}

function deduplicateComponents(components) {
  const byIdentity = new Map();
  for (const component of components) {
    const key = `${component.ecosystem}\0${component.name}\0${component.version}`;
    const existing = byIdentity.get(key);
    if (!existing) {
      byIdentity.set(key, component);
      continue;
    }

    const files = new Map(
      [...existing.licenseFiles, ...component.licenseFiles].map((file) => [
        `${file.name}\0${file.sha256}`,
        file,
      ]),
    );
    existing.licenseFiles = [...files.values()];
    if (!existing.repository && component.repository) {
      existing.repository = component.repository;
    }
  }
  return [...byIdentity.values()];
}

function deduplicateLicenseFiles(files) {
  const unique = new Map();
  for (const file of files) {
    const key = `${file.sha256}\0${file.sourceUrl ?? ""}`;
    if (!unique.has(key)) {
      unique.set(key, file);
    }
  }
  return [...unique.values()];
}

function componentIdentity(component) {
  return `${component.ecosystem}:${component.name}@${component.version}`;
}

function compareComponents(left, right) {
  return (
    left.ecosystem.localeCompare(right.ecosystem) ||
    left.name.localeCompare(right.name) ||
    left.version.localeCompare(right.version)
  );
}

function npmNameFromLockPath(packagePath) {
  const marker = "node_modules/";
  return packagePath.slice(packagePath.lastIndexOf(marker) + marker.length);
}

function normalizeLicense(value) {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  if (value && typeof value === "object" && typeof value.type === "string") {
    return value.type.trim() || undefined;
  }
  return undefined;
}

function normalizeRepository(value) {
  if (value && typeof value === "object") {
    value = value.url;
  }
  if (typeof value !== "string") {
    return "";
  }

  return value
    .trim()
    .replace(/^git\+/, "")
    .replace(/^git:\/\/github\.com\//, "https://github.com/")
    .replace(/^github:/, "https://github.com/");
}

function formatRepository(repository) {
  if (!repository) {
    return "Not declared";
  }
  if (/^https?:\/\//i.test(repository)) {
    const escapedUrl = repository.replaceAll(")", "%29");
    return `[source](${escapedUrl})`;
  }
  return escapeMarkdown(repository);
}

function escapeMarkdown(value) {
  return String(value)
    .replaceAll("\\", "\\\\")
    .replaceAll("|", "\\|")
    .replaceAll("\r", " ")
    .replaceAll("\n", " ");
}

function normalizeText(text) {
  return text.replace(/^\uFEFF/, "").replaceAll("\r\n", "\n").trimEnd() + "\n";
}

function readJson(path, { optional = false, root } = {}) {
  if (typeof root !== "string" || root.length === 0) {
    fail(`No containment root was supplied for ${relative(repositoryRoot, path)}.`);
  }

  let bytes;
  try {
    bytes = readBoundedRegularFile(path, maxMetadataFileBytes, root);
  } catch (error) {
    fail(`Unable to read ${relative(repositoryRoot, path)}: ${error.message}`);
  }
  if (bytes === undefined) {
    if (optional) {
      return undefined;
    }
    fail(`Unable to read ${relative(repositoryRoot, path)}: file is missing.`);
  }

  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    fail(`Unable to parse ${relative(repositoryRoot, path)}: ${error.message}`);
  }
}

function readDirectoryIfPresent(path) {
  try {
    const physicalPath = realpathSync.native(path);
    return {
      path: physicalPath,
      entries: readdirSync(physicalPath, { withFileTypes: true }),
    };
  } catch (error) {
    if (isMissingPathError(error)) {
      return undefined;
    }
    throw error;
  }
}

function readBoundedRegularFile(path, maxBytes, root) {
  let physicalPath;
  try {
    physicalPath = resolveContainedRealPath(root, path);
  } catch (error) {
    if (isMissingPathError(error)) {
      return undefined;
    }
    throw error;
  }

  let descriptor;
  try {
    descriptor = openSync(physicalPath, "r");
  } catch (error) {
    if (isMissingPathError(error)) {
      return undefined;
    }
    throw error;
  }

  try {
    const metadata = fstatSync(descriptor);
    if (!metadata.isFile() || metadata.size > maxBytes) {
      return undefined;
    }

    const bytes = Buffer.allocUnsafe(maxBytes + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const bytesRead = readSync(
        descriptor,
        bytes,
        offset,
        bytes.length - offset,
        null,
      );
      if (bytesRead === 0) {
        break;
      }
      offset += bytesRead;
    }

    if (offset > maxBytes) {
      return undefined;
    }
    return bytes.subarray(0, offset);
  } finally {
    closeSync(descriptor);
  }
}

function resolveContainedRealPath(root, path) {
  const lexicalRoot = resolve(root);
  const lexicalPath = resolve(path);
  assertPathIsInside(lexicalRoot, lexicalPath, `path ${path}`);

  const physicalRoot = realpathSync.native(lexicalRoot);
  const physicalPath = realpathSync.native(lexicalPath);
  assertPathIsInside(physicalRoot, physicalPath, `physical path ${path}`);
  return physicalPath;
}

function assertPathIsInside(root, path, label) {
  const relativePath = relative(root, path);
  if (
    relativePath === "" ||
    relativePath === ".." ||
    relativePath.startsWith(`..\\`) ||
    relativePath.startsWith("../") ||
    isAbsolute(relativePath)
  ) {
    fail(`${label} escapes its permitted directory.`);
  }
}

function isMissingPathError(error) {
  return (
    error !== null &&
    typeof error === "object" &&
    ["EISDIR", "ELOOP", "ENOENT", "ENOTDIR"].includes(error.code)
  );
}

function requireNonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    fail(`${label} must be a non-empty string.`);
  }
}

function requireSha256(value, label) {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    fail(`${label} must provide a lowercase SHA-256 digest.`);
  }
}

function requireHttpsUrl(value, label) {
  requireNonEmptyString(value, label);
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail(`${label} must be a valid URL.`);
  }
  if (parsed.protocol !== "https:") {
    fail(`${label} must use HTTPS.`);
  }
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

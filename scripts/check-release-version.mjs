#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageManifest = readJson("package.json");
const packageLock = readJson("package-lock.json");
const tauriConfig = readJson("src-tauri/tauri.conf.json");
const cargoManifest = readText("src-tauri/Cargo.toml");
const cargoLock = readText("src-tauri/Cargo.lock");
const appSource = readText("src/App.tsx");

const expectedVersion = packageManifest.version;
if (
  typeof expectedVersion !== "string" ||
  !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(expectedVersion)
) {
  fail(`package.json has an invalid release version: ${expectedVersion}`);
}

const declarations = [
  ["package-lock.json top level", packageLock.version],
  ["package-lock.json root package", packageLock.packages?.[""]?.version],
  ["src-tauri/tauri.conf.json", tauriConfig.version],
  ["src-tauri/Cargo.toml package", cargoPackageVersion(cargoManifest)],
  ["src-tauri/Cargo.lock crowflix package", cargoLockVersion(cargoLock)],
];

for (const [location, actualVersion] of declarations) {
  if (actualVersion !== expectedVersion) {
    fail(
      `Release version mismatch: ${location} is ${String(actualVersion)}, expected ${expectedVersion}.`,
    );
  }
}

const displayedVersions = [
  ...appSource.matchAll(
    /\bCrowFlix\s+(?:<strong>)?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/g,
  ),
].map((match) => match[1]);

if (displayedVersions.length === 0) {
  fail("No in-app CrowFlix release version display was found in src/App.tsx.");
}
for (const displayedVersion of displayedVersions) {
  if (displayedVersion !== expectedVersion) {
    fail(
      `Release version mismatch: src/App.tsx displays ${displayedVersion}, expected ${expectedVersion}.`,
    );
  }
}

console.log(
  `Release version consistency check passed: ${expectedVersion} (${declarations.length + 1} manifests/lockfiles, ${displayedVersions.length} in-app displays).`,
);

function cargoPackageVersion(manifest) {
  const packageSection = manifest.match(
    /^\[package\]\s*$([\s\S]*?)(?=^\[[^\]]+\]\s*$|(?![\s\S]))/m,
  );
  if (!packageSection) {
    fail("Could not find the [package] section in src-tauri/Cargo.toml.");
  }
  const version = packageSection[1].match(/^version\s*=\s*"([^"]+)"\s*$/m);
  if (!version) {
    fail("Could not find the package version in src-tauri/Cargo.toml.");
  }
  return version[1];
}

function cargoLockVersion(lockfile) {
  const packages = [
    ...lockfile.matchAll(
      /\[\[package\]\]\s*\nname\s*=\s*"crowflix"\s*\nversion\s*=\s*"([^"]+)"/g,
    ),
  ];
  if (packages.length !== 1) {
    fail(
      `Expected exactly one crowflix package in src-tauri/Cargo.lock, found ${packages.length}.`,
    );
  }
  return packages[0][1];
}

function readJson(relativePath) {
  try {
    return JSON.parse(readText(relativePath));
  } catch (error) {
    fail(`Unable to parse ${relativePath}: ${error.message}`);
  }
}

function readText(relativePath) {
  try {
    return readFileSync(join(repositoryRoot, relativePath), "utf8");
  } catch (error) {
    fail(`Unable to read ${relativePath}: ${error.message}`);
  }
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

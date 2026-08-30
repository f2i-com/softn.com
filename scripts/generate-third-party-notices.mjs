#!/usr/bin/env node
/**
 * Build the third-party licence inventory for the static softn.com deployment.
 *
 * This deliberately reads package-lock.json rather than `npm ls`: the lock is
 * the reproducible record of exact versions, registry tarballs and integrity
 * hashes. The dependency walk starts only at the four browser apps, so desktop,
 * test and build-only packages do not leak into the deployment inventory.
 *
 * Usage:
 *   node scripts/generate-third-party-notices.mjs
 *   node scripts/generate-third-party-notices.mjs --check
 *   node scripts/generate-third-party-notices.mjs --out-dir path/to/dist
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOCK_FILE = path.join(ROOT, 'package-lock.json');
const OVERRIDES_FILE = path.join(ROOT, 'scripts', 'third-party-license-overrides.json');
const ZIPP_SOURCE_FILE = path.join(ROOT, 'packages', '@softn', 'core', 'wasm-zipp', 'SOURCE.json');

const DEPLOYED_WORKSPACES = [
  'apps/softn-site',
  'apps/softn-web',
  'apps/softn-builder',
  'apps/softn-studio',
];

// Workbox is a build dependency, but these packages become the service-worker
// runtime copied into dist. A production-only dependency walk would otherwise
// omit the licence for code the PWA actually serves.
const EMITTED_BUILD_PACKAGES = [
  'workbox-cacheable-response',
  'workbox-core',
  'workbox-expiration',
  'workbox-precaching',
  'workbox-routing',
  'workbox-strategies',
  'workbox-window',
];

// These are real npm dependency edges, but not browser-runtime edges. The
// Transformers browser entry never includes its Node inference/image stack,
// and zxing-wasm's two declarations-only packages produce no deployed bytes.
// Keeping this list narrow and parent-qualified prevents a package name from
// being excluded when another runtime dependency genuinely uses it.
const STATIC_BROWSER_OMISSIONS = new Map([
  ['@huggingface/transformers', new Set(['onnxruntime-node', 'sharp'])],
  ['zxing-wasm', new Set(['@types/emscripten', 'type-fest'])],
]);

const LICENSE_FILE = /^(?:licen[cs]e|copying|notice)(?:$|[._-])/i;

function fail(message) {
  throw new Error(message);
}

function readJson(file, what) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    fail(`Could not read ${what} at ${relative(file)}: ${error.message}`);
  }
}

function relative(file) {
  return path.relative(ROOT, file).replaceAll('\\', '/');
}

function lockPath(value) {
  return String(value || '')
    .replaceAll('\\', '/')
    .replace(/^\.\//, '')
    .replace(/\/$/, '');
}

function diskPath(location) {
  const resolved = path.resolve(ROOT, ...lockPath(location).split('/'));
  if (resolved !== ROOT && !resolved.startsWith(`${ROOT}${path.sep}`)) {
    fail(`Lockfile location escapes the repository: ${location}`);
  }
  return resolved;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function normalizedText(file) {
  const value = fs
    .readFileSync(file, 'utf8')
    .replace(/^\uFEFF/, '')
    .replaceAll('\r\n', '\n')
    .trim();
  if (!value || value.includes('\0')) fail(`Licence text is empty or binary: ${relative(file)}`);
  return `${value}\n`;
}

function parseArgs() {
  let check = false;
  let outDir = path.join(ROOT, 'dist');
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--check') {
      check = true;
    } else if (args[i] === '--out-dir') {
      if (!args[i + 1]) fail('--out-dir requires a path');
      outDir = path.resolve(ROOT, args[++i]);
    } else {
      fail(`Unknown argument: ${args[i]}`);
    }
  }
  return { check, outDir };
}

const { check, outDir } = parseArgs();
const lock = readJson(LOCK_FILE, 'package-lock.json');
if (lock.lockfileVersion !== 3 || !lock.packages || typeof lock.packages !== 'object') {
  fail('The licence generator requires package-lock.json lockfileVersion 3 with a packages map.');
}
const packages = lock.packages;

const overrideDocument = readJson(OVERRIDES_FILE, 'the curated licence overrides');
if (overrideDocument.formatVersion !== 1 || !overrideDocument.packages) {
  fail('third-party-license-overrides.json has an unsupported format.');
}
const overrides = overrideDocument.packages;
const usedOverrides = new Set();

function resolveDependency(fromLocation, dependency, optional = false) {
  const candidates = [];
  let current = lockPath(fromLocation);
  while (current && current !== '.') {
    candidates.push(lockPath(path.posix.join(current, 'node_modules', dependency)));
    const parent = lockPath(path.posix.dirname(current));
    if (!parent || parent === current || parent === '.') break;
    current = parent;
  }
  candidates.push(`node_modules/${dependency}`);

  for (const candidate of new Set(candidates)) {
    if (packages[candidate] && fs.existsSync(diskPath(candidate))) return candidate;
  }
  if (optional) return null;
  fail(`${fromLocation} depends on ${dependency}, but no installed lockfile package resolves it.`);
}

function installedPackage(location) {
  const packageFile = path.join(diskPath(location), 'package.json');
  if (!fs.existsSync(packageFile)) fail(`Installed package has no package.json: ${location}`);
  return readJson(packageFile, `${location}/package.json`);
}

const selected = new Set();
const queue = [...DEPLOYED_WORKSPACES];

function walkQueue() {
  while (queue.length > 0) {
    const location = lockPath(queue.shift());
    if (selected.has(location)) continue;
    const metadata = packages[location];
    if (!metadata) fail(`package-lock.json has no entry for deployment root ${location}.`);
    selected.add(location);

    if (metadata.link) {
      if (!metadata.resolved) fail(`Workspace link ${location} has no resolved location.`);
      queue.push(lockPath(metadata.resolved));
      continue;
    }

    const manifest = installedPackage(location);
    const omitted = STATIC_BROWSER_OMISSIONS.get(manifest.name) || new Set();

    for (const dependency of Object.keys(metadata.dependencies || {}).sort()) {
      if (!omitted.has(dependency)) queue.push(resolveDependency(location, dependency));
    }
    for (const dependency of Object.keys(metadata.optionalDependencies || {}).sort()) {
      if (omitted.has(dependency)) continue;
      const resolved = resolveDependency(location, dependency, true);
      if (resolved) queue.push(resolved);
    }
    for (const dependency of Object.keys(metadata.peerDependencies || {}).sort()) {
      if (metadata.peerDependenciesMeta?.[dependency]?.optional || omitted.has(dependency))
        continue;
      queue.push(resolveDependency(location, dependency));
    }
  }
}

walkQueue();
for (const dependency of EMITTED_BUILD_PACKAGES) {
  queue.push(resolveDependency('', dependency));
}
walkQueue();

const textGroups = new Map();
const inventoryPackages = [];

function addText(packageKey, file, isOverride) {
  const text = normalizedText(file);
  const hash = sha256(text);
  let group = textGroups.get(hash);
  if (!group) {
    group = { sha256: hash, text, packages: new Set(), files: new Set() };
    textGroups.set(hash, group);
  }
  group.packages.add(packageKey);
  group.files.add(relative(file));
  return { path: relative(file), sha256: hash, override: isOverride || undefined };
}

const externalLocations = [...selected]
  .filter(
    (location) => location.includes('node_modules/') && !location.startsWith('node_modules/@softn/')
  )
  .sort((a, b) => a.localeCompare(b));

for (const location of externalLocations) {
  const metadata = packages[location];
  if (metadata.link) continue;
  const manifest = installedPackage(location);
  if (!manifest.name || !manifest.version)
    fail(`${location}/package.json is missing name or version.`);
  if (metadata.version !== manifest.version) {
    fail(
      `${location} is ${manifest.version} on disk but ${metadata.version} in package-lock.json.`
    );
  }
  const license = metadata.license || manifest.license;
  if (!license || typeof license !== 'string')
    fail(`${manifest.name}@${manifest.version} has no licence metadata.`);

  const packageKey = `${manifest.name}@${manifest.version}`;
  const packageDir = diskPath(location);
  let files = fs
    .readdirSync(packageDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && LICENSE_FILE.test(entry.name))
    .map((entry) => path.join(packageDir, entry.name))
    .sort((a, b) => a.localeCompare(b));
  let isOverride = false;

  if (files.length === 0) {
    const override = overrides[packageKey];
    if (!override || !Array.isArray(override.files) || override.files.length === 0) {
      fail(`${packageKey} ships no licence/notice file and has no curated override.`);
    }
    usedOverrides.add(packageKey);
    isOverride = true;
    files = override.files.map((file) => {
      const resolved = diskPath(file);
      if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
        fail(`Curated licence file for ${packageKey} is missing: ${file}`);
      }
      return resolved;
    });
  }

  const licenseFiles = files.map((file) => addText(packageKey, file, isOverride));
  inventoryPackages.push({
    name: manifest.name,
    version: manifest.version,
    license,
    location,
    resolved: metadata.resolved || undefined,
    integrity: metadata.integrity || undefined,
    licenseFiles,
  });
}

for (const packageKey of Object.keys(overrides).sort()) {
  if (!usedOverrides.has(packageKey)) {
    fail(`Curated licence override is stale or outside the static deployment graph: ${packageKey}`);
  }
}

inventoryPackages.sort(
  (a, b) =>
    a.name.localeCompare(b.name) ||
    a.version.localeCompare(b.version) ||
    a.location.localeCompare(b.location)
);

const zipp = readJson(ZIPP_SOURCE_FILE, 'the zipp source provenance');
for (const field of ['repository', 'revision', 'license', 'artifact', 'sha256']) {
  if (!zipp[field] || typeof zipp[field] !== 'string')
    fail(`zipp SOURCE.json is missing ${field}.`);
}
if (!/^[0-9a-f]{40}$/i.test(zipp.revision))
  fail('zipp SOURCE.json revision is not a full Git commit.');
if (!/^[0-9a-f]{64}$/i.test(zipp.sha256)) fail('zipp SOURCE.json sha256 is invalid.');
const zippArtifact = path.resolve(path.dirname(ZIPP_SOURCE_FILE), zipp.artifact);
if (
  !zippArtifact.startsWith(`${path.dirname(ZIPP_SOURCE_FILE)}${path.sep}`) ||
  !fs.existsSync(zippArtifact)
) {
  fail(`zipp SOURCE.json names a missing or unsafe artifact: ${zipp.artifact}`);
}
const actualZippHash = sha256(fs.readFileSync(zippArtifact));
if (actualZippHash !== zipp.sha256.toLowerCase()) {
  fail(
    `zipp provenance hash is stale: SOURCE.json has ${zipp.sha256}, artifact is ${actualZippHash}.`
  );
}

const zippKey = `zipp-wasm@${zipp.revision}`;
const zippLicense = path.join(ROOT, 'LICENSE');
const zippLicenseFile = addText(zippKey, zippLicense, false);
const vendored = [
  {
    name: 'zipp-wasm',
    revision: zipp.revision,
    repository: zipp.repository,
    license: zipp.license,
    artifact: relative(zippArtifact),
    sha256: actualZippHash,
    licenseFiles: [zippLicenseFile],
  },
];

const lockfileHash = sha256(fs.readFileSync(LOCK_FILE));
const inventory = {
  formatVersion: 1,
  lockfile: 'package-lock.json',
  lockfileSha256: lockfileHash,
  roots: DEPLOYED_WORKSPACES,
  emittedBuildPackages: EMITTED_BUILD_PACKAGES,
  packages: inventoryPackages,
  vendored,
};

const noticeLines = [
  'SOFTN THIRD-PARTY LICENCES AND NOTICES',
  '',
  'Generated deterministically from package-lock.json and the vendored zipp provenance.',
  `Lockfile SHA-256: ${lockfileHash}`,
  'SoftN itself is licensed under the Apache License 2.0 in ./LICENSE.',
  '',
  'PACKAGES',
  '========',
  '',
  ...inventoryPackages.map((entry) => `${entry.name}@${entry.version} — ${entry.license}`),
  `zipp-wasm@${zipp.revision} — ${zipp.license}`,
  '',
  'LICENCE AND NOTICE TEXTS',
  '========================',
  '',
];

for (const group of [...textGroups.values()].sort((a, b) => a.sha256.localeCompare(b.sha256))) {
  noticeLines.push('-'.repeat(72));
  noticeLines.push(`SHA-256: ${group.sha256}`);
  noticeLines.push('Applies to:');
  for (const packageKey of [...group.packages].sort()) noticeLines.push(`  - ${packageKey}`);
  noticeLines.push('Source files:');
  for (const file of [...group.files].sort()) noticeLines.push(`  - ${file}`);
  noticeLines.push('-'.repeat(72));
  noticeLines.push('');
  noticeLines.push(group.text.trimEnd());
  noticeLines.push('');
}

const notice = `${noticeLines.join('\n').trimEnd()}\n`;
const inventoryJson = `${JSON.stringify(inventory, null, 2)}\n`;

if (!check) {
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'THIRD-PARTY-NOTICES.txt'), notice);
  fs.writeFileSync(path.join(outDir, 'THIRD-PARTY-INVENTORY.json'), inventoryJson);
}

console.log(
  `${check ? 'Validated' : 'Generated'} ${inventoryPackages.length} npm package records, ` +
    `${vendored.length} vendored engine and ${textGroups.size} unique licence/notice texts.`
);
if (!check) console.log(`Wrote deployment inventory to ${relative(outDir)}/`);

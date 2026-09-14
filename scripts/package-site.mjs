#!/usr/bin/env node
/**
 * Package `dist/` — the complete static release that `build:site` writes — as
 * one archive ready to upload to a web host, and prove the archive is right.
 *
 *   node scripts/package-site.mjs --tag v0.0.1 [--out release] [--allow-dirty]
 *
 * The archive is `softn-website-<tag>-zipp-<engine release>.zip`, the engine
 * release taken from BUILD-INFO.json so the name says what is inside. Every
 * file under dist/ is included, `.htaccess` and the other dotfiles among them
 * (a host upload that misses `.htaccess` serves brotli as text), with the
 * directory layout intact so the contents can be dropped into a document root.
 * The plain-language README.md from scripts/release-packages.mjs is written
 * into dist/ first, so it is the first thing a person sees after unzipping.
 *
 * The writing itself — store the already-compressed files, deflate the rest,
 * refuse zip64, read the finished file back and compare every entry byte for
 * byte, write the `.sha256` sidecar — is scripts/lib/archive.mjs, shared with
 * the other package scripts so the release's archives are all made one way.
 * Written without dependencies so the release workflow and a laptop produce
 * the same bytes from the same dist/.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { engineLabel } from './release-packages.mjs';
import { FRONT_DOOR, startHere } from './release-explainers.mjs';
import { writeArchive } from './lib/archive.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distDir = path.join(root, 'dist');

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};
const allowDirty = args.includes('--allow-dirty');
const outDir = path.resolve(root, opt('--out') ?? 'release');
let tag = opt('--tag');
if (!tag) {
  // Without --tag, the archive is named for the tag on HEAD, and only that.
  try {
    tag = execFileSync('git', ['describe', '--tags', '--exact-match'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    fail('No --tag given and HEAD is not at a tag. Name the release: --tag v0.0.1');
  }
}
if (!/^v\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(tag)) {
  fail(`The tag must look like v1.2.3 or v1.2.3-beta.1, not "${tag}".`);
}

function fail(message) {
  console.error(`package-site: ${message}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// What is being packaged
// ---------------------------------------------------------------------------
const infoPath = path.join(distDir, 'BUILD-INFO.json');
if (!fs.existsSync(path.join(distDir, 'index.html')) || !fs.existsSync(infoPath)) {
  fail('dist/ is missing or incomplete. Run `npm run build:site` first.');
}
const info = JSON.parse(fs.readFileSync(infoPath, 'utf8'));
if (info.softn?.dirty && !allowDirty) {
  fail(
    'BUILD-INFO.json says the tree was dirty when dist/ was built. A release is built from a clean checkout; pass --allow-dirty for a local trial.'
  );
}
if (!fs.existsSync(path.join(distDir, '.htaccess'))) {
  fail('dist/.htaccess is missing; the archive would deploy without its server rules.');
}
// The engine's release tag, version or short commit, as release-packages.mjs
// spells it: it goes into the file name, and the explainers name that file.
const engine = engineLabel(info.zipp ?? {});
const archiveName = `softn-website-${tag}-zipp-${engine}.zip`;
// The plain-language explainer at the root of the archive, written into
// dist/ first so the archive and the directory it is verified against agree.
fs.writeFileSync(path.join(distDir, FRONT_DOOR), startHere('site', { tag, engine }));

// Sorted, forward-slash, relative — the same order and names on every OS.
function walk(dir, prefix = '') {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...walk(path.join(dir, entry.name), rel));
    else if (entry.isFile()) out.push(rel);
  }
  return out;
}
// The directory API's state lives under data/ and is never part of a release:
// a dist/ that has been served locally holds a database, uploaded bundles and
// a config with the site's admin key, none of which belongs on another host.
// Only the rules that keep the directory unserved travel.
const DATA_KEEP = new Set(['data/.htaccess', 'data/README.txt']);
const files = walk(distDir)
  .filter((name) => !(name === 'data' || name.startsWith('data/')) || DATA_KEEP.has(name))
  .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
if (files.length === 0) fail('dist/ has no files.');
for (const required of DATA_KEEP) {
  if (!files.includes(required)) fail(`dist/${required} is missing; the directory would deploy unprotected.`);
}
for (const name of files) {
  if (/\.sqlite$/.test(name) || name === 'data/config.json' || name === 'data/seeded') fail(`${name}: the directory's state must not ship`);
}

// ---------------------------------------------------------------------------
// Write, read back, compare
// ---------------------------------------------------------------------------
fs.mkdirSync(outDir, { recursive: true });
const archivePath = path.join(outDir, archiveName);
let result;
try {
  result = writeArchive(
    files.map((name) => [name, fs.readFileSync(path.join(distDir, name))]),
    archivePath,
    // Entry timestamps: the build's own time, so two archives of one build agree.
    { stamp: new Date(info.builtAt ?? Date.now()) }
  );
} catch (error) {
  fail(error.message);
}
if (!result.entries.some((e) => e.name === '.htaccess')) {
  fs.rmSync(archivePath, { force: true });
  fail('.htaccess is not in the archive');
}

const mb = (n) => (n / 1048576).toFixed(1);
console.log(`package-site: ${archiveName}`);
console.log(`  ${result.entries.length} files, ${mb(result.rawBytes)} MB in dist/ -> ${mb(result.size)} MB archived`);
console.log(`  ${result.entries.filter((e) => e.method === 0).length} stored (${mb(result.storedBytes)} MB), ${result.entries.filter((e) => e.method === 8).length} deflated (${mb(result.deflatedBytes)} MB)`);
console.log(`  softn ${String(info.softn?.revision ?? '').slice(0, 7)}${info.softn?.dirty ? ' (dirty)' : ''}, zipp ${engine}, built ${info.builtAt ?? 'unknown'}`);
console.log(`  read back and compared byte for byte with dist/: all ${result.entries.length} entries identical`);
console.log(`  sha256 ${result.sha256}`);
console.log(`  ${path.relative(root, archivePath)}`);

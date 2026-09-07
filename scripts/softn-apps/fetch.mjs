#!/usr/bin/env node
/**
 * Download every app in repos.json from its GitHub release into one folder a
 * SoftN site loads: scripts/softn-apps/apps/ (ignored by git), or --out.
 *
 *   npm run apps:fetch [-- --out <folder>] [--include-unlisted]
 *
 * The folder comes out in the shape the directory's seed reads: index.json
 * beside the .softn files, with thumbs/ for the screenshots that
 * screenshot.mjs adds. Each bundle is checked against the release's own
 * checksums (catalogue.json for softn-Examples, SHA256SUMS.txt for a game
 * repository); a bundle already on disk with the right hash is not fetched
 * again. Bundles that have left every release are removed from the folder so
 * a site fed it retires them too.
 *
 * A private repository needs a token: GITHUB_TOKEN in the environment, or
 * the one git already stores for github.com (`git credential fill`), which
 * is also what keeps GitHub's anonymous rate limit out of the way.
 *
 * No dependencies: Node 22.
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const outArg = flag('--out', process.env.SOFTN_APPS_DIR || '');
const outDir = outArg ? path.resolve(process.cwd(), outArg) : path.join(here, 'apps');
const includeUnlisted = args.includes('--include-unlisted');

const config = JSON.parse(fs.readFileSync(path.join(here, 'repos.json'), 'utf8'));
const sources = Array.isArray(config.sources) ? config.sources : [];
if (sources.length === 0) {
  console.error('repos.json lists no sources.');
  process.exit(1);
}

// ── GitHub ───────────────────────────────────────────────────────────────
function githubToken() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  const r = spawnSync('git', ['credential', 'fill'], {
    input: 'protocol=https\nhost=github.com\n\n',
    encoding: 'utf8',
    env: { ...process.env, GCM_INTERACTIVE: 'never', GIT_TERMINAL_PROMPT: '0' },
  });
  const line = (r.stdout || '').split('\n').find((l) => l.startsWith('password='));
  return line ? line.slice('password='.length).trim() : null;
}
const token = githubToken();
const headers = (accept) => ({
  Accept: accept,
  'User-Agent': 'softn-apps',
  ...(token ? { Authorization: `Bearer ${token}` } : {}),
});
async function api(route) {
  const res = await fetch(`https://api.github.com${route}`, { headers: headers('application/vnd.github+json') });
  if (!res.ok) throw new Error(`${route} answered ${res.status}${token ? '' : ' (no GitHub token; a private repository needs one)'}`);
  return res.json();
}
async function assetBytes(asset) {
  // The asset API serves private repositories' files too; a browser download
  // URL would not. Both redirect to storage, and fetch follows.
  const res = await fetch(asset.url, { headers: headers('application/octet-stream') });
  if (!res.ok) throw new Error(`${asset.name} answered ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

// ── A manifest out of a bundle, with no zip library ─────────────────────
function readZipEntry(zip, wanted) {
  const b = Buffer.from(zip.buffer, zip.byteOffset, zip.byteLength);
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 65557); i--) {
    if (b.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('not a zip');
  const count = b.readUInt16LE(eocd + 10);
  let p = b.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    if (b.readUInt32LE(p) !== 0x02014b50) throw new Error('bad central directory');
    const method = b.readUInt16LE(p + 10);
    const csize = b.readUInt32LE(p + 20);
    const nameLen = b.readUInt16LE(p + 28);
    const extraLen = b.readUInt16LE(p + 30);
    const commentLen = b.readUInt16LE(p + 32);
    const local = b.readUInt32LE(p + 42);
    const name = b.toString('utf8', p + 46, p + 46 + nameLen);
    if (name === wanted) {
      const lnameLen = b.readUInt16LE(local + 26);
      const lextraLen = b.readUInt16LE(local + 28);
      const start = local + 30 + lnameLen + lextraLen;
      const data = b.subarray(start, start + csize);
      if (method === 0) return data;
      if (method === 8) return zlib.inflateRawSync(data);
      throw new Error(`${wanted} uses zip method ${method}`);
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}
function manifestOf(bytes) {
  const raw = readZipEntry(bytes, 'manifest.json');
  if (!raw) throw new Error('the bundle has no manifest.json');
  return JSON.parse(raw.toString('utf8'));
}

/** The directory's own slug rule: ASCII letters and digits, dashes between, at most 48. */
function slugify(name) {
  const s = String(name)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return (s || 'app').slice(0, 48);
}

function parseSums(text) {
  const sums = new Map();
  for (const line of text.split('\n')) {
    const m = /^([0-9a-f]{64})\s+\*?(.+?)\s*$/i.exec(line);
    if (m) sums.set(m[2], m[1].toLowerCase());
  }
  return sums;
}

// ── The work ─────────────────────────────────────────────────────────────
fs.mkdirSync(outDir, { recursive: true });
const entries = [];
const kept = new Set();
let fetched = 0;
let reused = 0;

function place(file, bytes, expectedSha) {
  const hash = sha256(bytes);
  if (expectedSha && hash !== expectedSha) throw new Error(`${file}: hash ${hash} does not match the release's ${expectedSha}`);
  fs.writeFileSync(path.join(outDir, file), bytes);
  return hash;
}
function onDisk(file, expectedSha) {
  const p = path.join(outDir, file);
  if (!expectedSha || !fs.existsSync(p)) return null;
  const bytes = fs.readFileSync(p);
  return sha256(bytes) === expectedSha ? bytes : null;
}

for (const source of sources) {
  const repo = String(source.repo || '');
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    console.error(`skipping a source with no repository: ${JSON.stringify(source)}`);
    continue;
  }
  const release = await api(source.tag ? `/repos/${repo}/releases/tags/${encodeURIComponent(source.tag)}` : `/repos/${repo}/releases/latest`);
  const assets = new Map(release.assets.map((a) => [a.name, a]));
  const tag = release.tag_name;
  const common = {
    repository: repo,
    tag,
    ...(source.category ? { category: String(source.category) } : {}),
    ...(source.tags ? { tags: String(source.tags) } : {}),
    ...(source.author ? { author: String(source.author) } : {}),
  };

  if (source.kind === 'catalogue') {
    const cat = assets.get('catalogue.json');
    if (!cat) throw new Error(`${repo} ${tag} has no catalogue.json`);
    const catalogue = JSON.parse(Buffer.from(await assetBytes(cat)).toString('utf8'));
    const list = [...(catalogue.bundles || []), ...(includeUnlisted ? catalogue.unlisted || [] : [])];
    for (const b of list) {
      const asset = assets.get(b.file);
      if (!asset) {
        console.error(`${repo} ${tag}: catalogue lists ${b.file} but the release has no such asset`);
        continue;
      }
      let bytes = onDisk(b.file, b.sha256);
      if (bytes) reused++;
      else {
        bytes = await assetBytes(asset);
        fetched++;
      }
      const hash = place(b.file, bytes, b.sha256);
      kept.add(b.file);
      entries.push({
        id: b.id || slugify(b.name || b.file.replace(/\.softn$/, '')),
        file: b.file,
        name: b.name || b.file.replace(/\.softn$/, ''),
        description: b.description || '',
        ...(b.primary ? { primary: b.primary } : {}),
        version: b.version || '',
        size: bytes.length,
        sha256: hash,
        source: b.source || asset.browser_download_url,
        ...common,
      });
      console.log(`${b.file.padEnd(28)} ${tag.padEnd(8)} ${(bytes.length / 1024).toFixed(0).padStart(7)} KB  ${repo}`);
    }
    continue;
  }

  const sumsAsset = assets.get('SHA256SUMS.txt') || assets.get('SHA256SUMS');
  const sums = sumsAsset ? parseSums(Buffer.from(await assetBytes(sumsAsset)).toString('utf8')) : new Map();
  for (const asset of release.assets) {
    if (!/\.softn$/i.test(asset.name)) continue;
    const expected = sums.get(asset.name) || null;
    let bytes = onDisk(asset.name, expected);
    if (bytes) reused++;
    else {
      bytes = await assetBytes(asset);
      fetched++;
    }
    const hash = place(asset.name, bytes, expected);
    const manifest = manifestOf(bytes);
    const name = typeof manifest.name === 'string' && manifest.name.trim() ? manifest.name.trim() : asset.name.replace(/\.softn$/i, '');
    const primary = manifest.config && manifest.config.theme && typeof manifest.config.theme.primary === 'string' ? manifest.config.theme.primary : null;
    kept.add(asset.name);
    entries.push({
      id: slugify(name),
      file: asset.name,
      name,
      description: typeof manifest.description === 'string' ? manifest.description.trim() : '',
      ...(primary ? { primary } : {}),
      version: typeof manifest.version === 'string' ? manifest.version : '',
      size: bytes.length,
      sha256: hash,
      source: asset.browser_download_url,
      ...common,
    });
    console.log(`${asset.name.padEnd(28)} ${tag.padEnd(8)} ${(bytes.length / 1024).toFixed(0).padStart(7)} KB  ${repo}${expected ? '' : '  (no checksum in the release)'}`);
  }
}

// Bundles no source names any more leave the folder, thumbnail and all.
for (const f of fs.readdirSync(outDir)) {
  if (/\.softn$/i.test(f) && !kept.has(f)) {
    fs.rmSync(path.join(outDir, f));
    for (const ext of ['webp', 'png', 'jpg']) fs.rmSync(path.join(outDir, 'thumbs', f.replace(/\.softn$/i, `.${ext}`)), { force: true });
    console.log(`${f.padEnd(28)} removed: no release lists it`);
  }
}

entries.sort((a, b) => a.name.localeCompare(b.name, 'en'));
fs.writeFileSync(path.join(outDir, 'index.json'), `${JSON.stringify(entries, null, 2)}\n`);
fs.mkdirSync(path.join(outDir, 'thumbs'), { recursive: true });
const missingShots = entries.filter((e) => !['webp', 'png', 'jpg'].some((ext) => fs.existsSync(path.join(outDir, 'thumbs', e.file.replace(/\.softn$/i, `.${ext}`)))));
console.log(`\n${entries.length} apps in ${outDir} (${fetched} fetched, ${reused} already there)`);
if (missingShots.length) console.log(`${missingShots.length} without a screenshot yet: npm run apps:screenshot${outArg ? ` -- --dir ${outArg}` : ''}`);

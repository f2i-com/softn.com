#!/usr/bin/env node
/**
 * Download, verify, cache, and stage the prebuilt Android WebView native
 * library bundle (`zipp-browser-<tag>-android-webview.zip`) from
 * `f2i-com/zipp-browser` GitHub Releases into `apps/softn-android/android/app/src/main/jniLibs/`.
 *
 * Allows SoftN Android APKs to be packaged without Rust or the Android NDK.
 *
 * Usage:
 *   node apps/softn-android/scripts/fetch-zipp-webview.mjs [--tag v0.1.3] [--abi x86_64|arm64-v8a|all] [--local path/to/android-webview.zip]
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { strFromU8, unzipSync } from 'fflate';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ANDROID_ROOT = path.resolve(HERE, '..');
const SOFTN_ROOT = path.resolve(ANDROID_ROOT, '..', '..');
const CACHE_ROOT = path.join(SOFTN_ROOT, '.zipp-browser-release');
const DEFAULT_JNI_LIBS_DIR = path.join(ANDROID_ROOT, 'android', 'app', 'src', 'main', 'jniLibs');

function validateRepoSlug(repo) {
  if (typeof repo !== 'string' || repo.length > 128 || !/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repo)) {
    throw new Error(`Invalid ZIPP_BROWSER_REPO slug: ${JSON.stringify(repo)}`);
  }
  return repo;
}

const ZIPP_BROWSER_REPO = validateRepoSlug(process.env.ZIPP_BROWSER_REPO || 'f2i-com/zipp-browser');
const SUPPORTED_ABIS = ['arm64-v8a', 'x86_64'];
const MAX_WEBVIEW_ZIP_BYTES = 256 * 1024 * 1024;
const MAX_WEBVIEW_ENTRY_BYTES = 128 * 1024 * 1024;
const MAX_WEBVIEW_ENTRIES = 512;
const DOWNLOAD_TIMEOUT_MS = 60_000;
const ALLOWED_DOWNLOAD_HOSTS = new Set([
  'api.github.com',
  'github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
]);

function validateDownloadUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid download URL: ${JSON.stringify(rawUrl)}`);
  }
  if (parsed.protocol !== 'https:') {
    throw new Error(`Refusing non-HTTPS download URL: ${parsed.protocol}`);
  }
  const host = parsed.hostname.toLowerCase();
  if (!ALLOWED_DOWNLOAD_HOSTS.has(host)) {
    throw new Error(`Refusing download from untrusted host: ${host}`);
  }
  return parsed.toString();
}

export function validateReleaseTag(tag) {
  if (typeof tag !== 'string' || tag.length === 0 || tag.length > 64 || tag.includes('..') || !/^[a-zA-Z0-9._-]+$/.test(tag)) {
    throw new Error(`Invalid release tag: ${JSON.stringify(tag)}`);
  }
  return tag;
}

function validateAssetName(name) {
  if (
    typeof name !== 'string' ||
    name.length > 160 ||
    name.includes('..') ||
    !/^zipp-browser-[a-zA-Z0-9._-]+-android-webview\.zip$/.test(name)
  ) {
    throw new Error(`Invalid Android WebView asset name: ${JSON.stringify(name)}`);
  }
  return name;
}

export function validateAbis(abis) {
  if (!Array.isArray(abis) || abis.length === 0) {
    throw new Error('At least one Android ABI must be specified');
  }
  for (const abi of abis) {
    if (!SUPPORTED_ABIS.includes(abi)) {
      throw new Error(`Unsupported Android ABI: ${JSON.stringify(abi)}`);
    }
  }
  return abis;
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function ghHeaders() {
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'softn-android-packager',
  };
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

export function parseChecksums(text) {
  const map = new Map();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^([0-9a-fA-F]{64})\s+\*?(.+)$/);
    if (m) {
      map.set(m[2].trim().replace(/\\/g, '/'), m[1].toLowerCase());
    }
  }
  return map;
}

async function fetchReleaseMetadata(tag, fetchImpl = globalThis.fetch) {
  const endpoint = tag
    ? `https://api.github.com/repos/${ZIPP_BROWSER_REPO}/releases/tags/${encodeURIComponent(tag)}`
    : `https://api.github.com/repos/${ZIPP_BROWSER_REPO}/releases/latest`;
  const resp = await fetchImpl(endpoint, {
    headers: ghHeaders(),
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });
  if (!resp.ok) {
    throw new Error(`Failed to query ${endpoint}: HTTP ${resp.status}`);
  }
  const release = await resp.json();
  const assets = Array.isArray(release.assets) ? release.assets : [];
  const webviewAsset = assets.find((a) => /^zipp-browser-.*-android-webview\.zip$/.test(a.name));
  const sumsAsset = assets.find((a) => a.name === 'SHA256SUMS.txt' || a.name === 'SHA256SUMS');
  if (!webviewAsset) {
    throw new Error(
      `Release ${release.tag_name || tag || 'latest'} on ${ZIPP_BROWSER_REPO} does not include a zipp-browser-*-android-webview.zip asset yet. Build locally with --build-local or supply --webview-zip <file>.`
    );
  }
  return {
    tag: release.tag_name,
    webviewAsset,
    sumsAsset,
  };
}

async function downloadBytes(url, fetchImpl = globalThis.fetch, maxBytes = MAX_WEBVIEW_ZIP_BYTES) {
  let currentUrl = validateDownloadUrl(url);
  for (let hop = 0; hop < 6; hop++) {
    const headers = { 'User-Agent': 'softn-android-packager' };
    const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
    if (token && currentUrl.startsWith('https://api.github.com/')) {
      headers.Authorization = `Bearer ${token}`;
      headers.Accept = 'application/octet-stream';
    }
    const resp = await fetchImpl(currentUrl, {
      headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
    if (resp.status >= 300 && resp.status < 400 && resp.headers?.get?.('location')) {
      const nextUrl = new URL(resp.headers.get('location'), currentUrl).toString();
      currentUrl = validateDownloadUrl(nextUrl);
      continue;
    }
    if (!resp.ok) {
      throw new Error(`Download failed for ${currentUrl}: HTTP ${resp.status}`);
    }
    if (resp.body && typeof resp.body.getReader === 'function') {
      const reader = resp.body.getReader();
      const chunks = [];
      let total = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value) continue;
          total += value.byteLength;
          if (total > maxBytes) {
            throw new Error(`Downloaded asset from ${currentUrl} exceeds ${maxBytes} byte limit`);
          }
          chunks.push(value);
        }
      } finally {
        reader.releaseLock();
      }
      const out = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return out;
    }
    const buf = new Uint8Array(await resp.arrayBuffer());
    if (buf.byteLength > maxBytes) {
      throw new Error(`Downloaded asset from ${currentUrl} exceeds ${maxBytes} byte limit`);
    }
    return buf;
  }
  throw new Error(`Too many redirects downloading ${url}`);
}

/**
 * Verify internal SHA256SUMS.txt + manifest.json and extract the requested
 * ABI `libsoftn_mobile.so` binaries into `jniLibsDir`.
 */
export function extractVerifiedAndroidWebView(zipBytes, { abis = SUPPORTED_ABIS, jniLibsDir = DEFAULT_JNI_LIBS_DIR } = {}) {
  validateAbis(abis);
  if (zipBytes.byteLength > MAX_WEBVIEW_ZIP_BYTES) {
    throw new Error(`Android WebView archive exceeds ${MAX_WEBVIEW_ZIP_BYTES / (1024 * 1024)} MB limit`);
  }
  const wantedEntries = new Set(['SHA256SUMS.txt', 'manifest.json']);
  for (const abi of abis) {
    wantedEntries.add(`jniLibs/${abi}/libsoftn_mobile.so`);
  }
  let entryCount = 0;
  const entries = unzipSync(zipBytes, {
    filter(file) {
      entryCount++;
      if (entryCount > MAX_WEBVIEW_ENTRIES) {
        throw new Error(`Android WebView archive exceeds maximum entry count (${MAX_WEBVIEW_ENTRIES})`);
      }
      if (!wantedEntries.has(file.name)) return false;
      if (file.originalSize > MAX_WEBVIEW_ENTRY_BYTES) {
        throw new Error(`Android WebView archive entry '${file.name}' exceeds size limit`);
      }
      return true;
    },
  });
  for (const [entryName, entryBytes] of Object.entries(entries)) {
    const cap = entryName.endsWith('.so') ? MAX_WEBVIEW_ENTRY_BYTES : 1024 * 1024;
    if (entryBytes.byteLength > cap) {
      throw new Error(`Android WebView archive entry '${entryName}' exceeds size limit after decompression`);
    }
  }
  const sumsRaw = entries['SHA256SUMS.txt'] ? strFromU8(entries['SHA256SUMS.txt']) : null;
  if (!sumsRaw) {
    throw new Error('Android WebView archive is missing SHA256SUMS.txt');
  }
  const sums = parseChecksums(sumsRaw);

  let manifest = null;
  if (entries['manifest.json']) {
    manifest = JSON.parse(strFromU8(entries['manifest.json']));
  }

  const staged = [];
  for (const abi of abis) {
    const rel = `jniLibs/${abi}/libsoftn_mobile.so`;
    const soBytes = entries[rel];
    if (!soBytes) {
      throw new Error(`Android WebView archive is missing ${rel} (available: ${Object.keys(entries).join(', ')})`);
    }
    const expected = sums.get(rel) || manifest?.sha256?.[rel];
    if (!expected) {
      throw new Error(`Android WebView archive SHA256SUMS.txt is missing digest for ${rel}`);
    }
    const actual = sha256(soBytes);
    if (actual !== expected.toLowerCase()) {
      throw new Error(`SHA-256 mismatch for ${rel}: expected ${expected}, got ${actual}`);
    }

    const destDir = path.join(jniLibsDir, abi);
    fs.mkdirSync(destDir, { recursive: true });
    const destPath = path.join(destDir, 'libsoftn_mobile.so');
    fs.writeFileSync(destPath, soBytes);
    staged.push({ abi, path: destPath, bytes: soBytes.length, sha256: actual });
  }

  return { manifest, staged };
}

function verifyCachedZipAgainstSums(cachedZip, zipBytes, cachedSums) {
  if (!fs.existsSync(cachedSums)) {
    throw new Error(`Cached archive ${path.basename(cachedZip)} is missing SHA256SUMS.txt; refusing unverified cache.`);
  }
  const sumsText = fs.readFileSync(cachedSums, 'utf8');
  const sumsMap = parseChecksums(sumsText);
  const expected = sumsMap.get(path.basename(cachedZip));
  if (!expected) {
    throw new Error(`Cached SHA256SUMS.txt is missing digest for ${path.basename(cachedZip)}`);
  }
  const actual = sha256(zipBytes);
  if (actual !== expected) {
    throw new Error(`Cached archive SHA-256 mismatch for ${path.basename(cachedZip)}: expected ${expected}, got ${actual}`);
  }
}

function findLatestCachedWebView(cacheRoot) {
  if (!fs.existsSync(cacheRoot)) return null;
  let dirs;
  try {
    dirs = fs
      .readdirSync(cacheRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return null;
  }
  const candidates = [];
  for (const tag of dirs) {
    if (tag.includes('..') || !/^[a-zA-Z0-9._-]+$/.test(tag)) continue;
    const dir = path.join(cacheRoot, tag);
    const zipPath = path.join(dir, `zipp-browser-${tag}-android-webview.zip`);
    if (fs.existsSync(zipPath)) {
      const stat = fs.statSync(zipPath);
      candidates.push({ tag, zipPath, sumsPath: path.join(dir, 'SHA256SUMS.txt'), mtimeMs: stat.mtimeMs });
    }
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates[0] || null;
}

/**
 * Ensure prebuilt Android WebView `.so` libraries for `abis` are staged in `jniLibsDir`.
 * Reuses `.zipp-browser-release/<tag>/` cache when already downloaded & verified,
 * and falls back gracefully to the newest verified cached archive if GitHub is unreachable.
 */
export async function ensureAndroidWebView({
  abis = SUPPORTED_ABIS,
  tag = process.env.ZIPP_BROWSER_RELEASE || null,
  localZip = process.env.ZIPP_BROWSER_WEBVIEW_ZIP || null,
  jniLibsDir = DEFAULT_JNI_LIBS_DIR,
  cacheRoot = CACHE_ROOT,
  fetchImpl = globalThis.fetch,
} = {}) {
  validateAbis(abis);
  if (tag) validateReleaseTag(tag);

  if (localZip) {
    const absZip = path.resolve(localZip);
    if (!fs.existsSync(absZip)) {
      throw new Error(`Local Android WebView archive not found: ${absZip}`);
    }
    const zipBytes = new Uint8Array(fs.readFileSync(absZip));
    const res = extractVerifiedAndroidWebView(zipBytes, { abis, jniLibsDir });
    console.log(
      `[softn-apk] Embedded prebuilt Zipp Browser Android WebView from ${absZip} (${res.staged.map((s) => `${s.abi} ${(s.bytes / 1048576).toFixed(2)} MB`).join(', ')})`
    );
    return res;
  }

  // If a specific tag is cached locally and verified, skip GitHub API completely.
  if (tag) {
    const cachedDir = path.join(cacheRoot, tag);
    const cachedZip = path.join(cachedDir, `zipp-browser-${tag}-android-webview.zip`);
    const cachedSums = path.join(cachedDir, 'SHA256SUMS.txt');
    if (fs.existsSync(cachedZip)) {
      const zipBytes = new Uint8Array(fs.readFileSync(cachedZip));
      verifyCachedZipAgainstSums(cachedZip, zipBytes, cachedSums);
      const res = extractVerifiedAndroidWebView(zipBytes, { abis, jniLibsDir });
      console.log(
        `[softn-apk] Reused cached Zipp Browser ${tag} Android WebView (${res.staged.map((s) => `${s.abi} ${(s.bytes / 1048576).toFixed(2)} MB`).join(', ')})`
      );
      return res;
    }
  }

  let meta;
  try {
    meta = await fetchReleaseMetadata(tag, fetchImpl);
  } catch (err) {
    if (!tag) {
      const fallback = findLatestCachedWebView(cacheRoot);
      if (fallback) {
        const zipBytes = new Uint8Array(fs.readFileSync(fallback.zipPath));
        verifyCachedZipAgainstSums(fallback.zipPath, zipBytes, fallback.sumsPath);
        const res = extractVerifiedAndroidWebView(zipBytes, { abis, jniLibsDir });
        console.warn(
          `[softn-apk] GitHub release lookup failed (${err.message}); reusing verified cached Zipp Browser ${fallback.tag} Android WebView (${res.staged.map((s) => `${s.abi} ${(s.bytes / 1048576).toFixed(2)} MB`).join(', ')})`
        );
        return res;
      }
    }
    throw err;
  }
  const resolvedTag = validateReleaseTag(meta.tag);
  const assetName = validateAssetName(meta.webviewAsset.name);
  const cacheDir = path.join(cacheRoot, resolvedTag);
  const cachedZip = path.join(cacheDir, assetName);
  const cachedSums = path.join(cacheDir, 'SHA256SUMS.txt');

  let zipBytes;
  if (fs.existsSync(cachedZip)) {
    zipBytes = new Uint8Array(fs.readFileSync(cachedZip));
    verifyCachedZipAgainstSums(cachedZip, zipBytes, cachedSums);
  } else {
    if (!meta.sumsAsset) {
      throw new Error(
        `Release ${resolvedTag} on ${ZIPP_BROWSER_REPO} is missing SHA256SUMS.txt; refusing unverified binary download.`
      );
    }
    fs.mkdirSync(cacheDir, { recursive: true });
    console.log(`[softn-apk] Downloading Zipp Browser ${resolvedTag} Android WebView (${assetName})...`);
    zipBytes = await downloadBytes(meta.webviewAsset.browser_download_url, fetchImpl);

    const sumsBytes = await downloadBytes(meta.sumsAsset.browser_download_url, fetchImpl, 1024 * 1024);
    const sumsText = new TextDecoder().decode(sumsBytes);
    const sumsMap = parseChecksums(sumsText);
    const expectedZipHash = sumsMap.get(assetName);
    if (!expectedZipHash) {
      throw new Error(
        `Release ${resolvedTag} SHA256SUMS.txt is missing an entry for ${assetName}; refusing unverified binary download.`
      );
    }
    const actualZipHash = sha256(zipBytes);
    if (actualZipHash !== expectedZipHash) {
      throw new Error(
        `Release SHA-256 mismatch for ${assetName}: expected ${expectedZipHash}, got ${actualZipHash}`
      );
    }
    fs.writeFileSync(cachedSums, sumsBytes);

    const tmpZip = `${cachedZip}.tmp`;
    fs.writeFileSync(tmpZip, zipBytes);
    fs.renameSync(tmpZip, cachedZip);
  }

  const res = extractVerifiedAndroidWebView(zipBytes, { abis, jniLibsDir });
  console.log(
    `[softn-apk] Staged Zipp Browser ${resolvedTag} Android WebView (${res.staged.map((s) => `${s.abi} ${(s.bytes / 1048576).toFixed(2)} MB`).join(', ')})`
  );
  return res;
}

async function main() {
  const args = process.argv.slice(2);
  let tag = null;
  let localZip = null;
  let abiArg = 'all';
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--tag') tag = args[++i];
    else if (a === '--local') localZip = args[++i];
    else if (a === '--abi') abiArg = args[++i];
  }
  const abis = abiArg === 'all' ? SUPPORTED_ABIS : abiArg.split(',').map((s) => s.trim()).filter(Boolean);
  await ensureAndroidWebView({ abis, tag, localZip });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`[fetch-zipp-webview] ERROR: ${err.message}`);
    process.exit(1);
  });
}

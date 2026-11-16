#!/usr/bin/env node
/**
 * Stages tiered ZIPP `.wasm` engines, same-origin `.glue.js` modules (for strict
 * `script-src 'self'` CSP hosts), and hosted `/runtime/vendor/` libraries
 * into `dist/runtime/` so any static HTTP server or Vite host can serve `<softn-app>`.
 *
 * Verifies every ZIPP `.wasm` and `.wasm.br` tier against the declared ZIPP release's
 * `RELEASE-SHA256SUMS`, downloading missing tiers into `.zipp-release/<release>/` when needed.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CACHE_DIR,
  REPOSITORY,
  ensureReleaseEngine,
  releaseOptions,
} from '../../core/scripts/fetch-zipp-release.mjs';

const PKG_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = path.resolve(PKG_DIR, '..', '..', '..');
const RUNTIME_DIR = path.join(PKG_DIR, 'dist', 'runtime');
const ENGINES_DIR = path.join(RUNTIME_DIR, 'engines');
const VENDOR_DIR = path.join(RUNTIME_DIR, 'vendor');
const CORE_DIR = path.resolve(PKG_DIR, '..', 'core');

fs.mkdirSync(ENGINES_DIR, { recursive: true });
fs.mkdirSync(VENDOR_DIR, { recursive: true });

const sha256File = (filePath) => createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');

// Ensure core's declared ZIPP release install exists before staging tiers
const wasmDir = path.join(CORE_DIR, 'wasm-zipp');
let zippSource = null;
try {
  zippSource = await ensureReleaseEngine({ ...releaseOptions(), dir: wasmDir });
} catch (err) {
  if (fs.existsSync(path.join(wasmDir, 'SOURCE.json'))) {
    zippSource = JSON.parse(fs.readFileSync(path.join(wasmDir, 'SOURCE.json'), 'utf8'));
  } else {
    console.warn(`[container] Could not ensure ZIPP release install: ${err.message}`);
  }
}

const version = zippSource?.version || '0.0.35';
const releaseTag = zippSource?.release || `v${version}`;
const sumsPath = path.join(wasmDir, 'RELEASE-SHA256SUMS');
const expectedSums = new Map();
if (fs.existsSync(sumsPath)) {
  for (const line of fs.readFileSync(sumsPath, 'utf8').split(/\r?\n/)) {
    const m = /^([0-9a-f]{64})\s+\*?(\S+)\s*$/.exec(line.trim());
    if (m) expectedSums.set(m[2], m[1]);
  }
}

const releaseCacheDir = path.join(CACHE_DIR, releaseTag);
// A folder of the release's files given by hand (ZIPP_RELEASE_DIR), then this checkout's
// cache of what was downloaded before. No other place: a path on one person's machine was
// here, which a build anywhere else skipped and a build there took from first.
const candidateDirs = [
  process.env.ZIPP_RELEASE_DIR ? path.resolve(process.env.ZIPP_RELEASE_DIR) : null,
  releaseCacheDir,
].filter(Boolean);

const API = REPOSITORY.replace('https://github.com/', 'https://api.github.com/repos/');
let cachedReleaseAssetsPromise = null;

function apiHeaders(accept) {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  return {
    Accept: accept,
    'User-Agent': 'softn-container-sync',
    'X-GitHub-Api-Version': '2022-11-28',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

function getReleaseAssetsMap() {
  if (!cachedReleaseAssetsPromise) {
    cachedReleaseAssetsPromise = fetch(`${API}/releases/tags/${encodeURIComponent(releaseTag)}`, {
      headers: apiHeaders('application/vnd.github+json'),
      redirect: 'follow',
    })
      .then(async (resp) => {
        if (!resp.ok) return null;
        const data = await resp.json();
        return new Map((data.assets ?? []).map((asset) => [asset.name, asset.url]));
      })
      .catch(() => null);
  }
  return cachedReleaseAssetsPromise;
}

async function resolveReleaseArtifact(artifactName, optional = false) {
  // Only a file the release's own checksums name, and only when its bytes are those: a file
  // with nothing to hold it to was taken as it was.
  const expected = expectedSums.get(artifactName);
  if (!expected) return null;
  for (const dir of candidateDirs) {
    const candidate = path.join(dir, artifactName);
    if (fs.existsSync(candidate) && sha256File(candidate) === expected) {
      return candidate;
    }
  }
  if (process.env.ZIPP_RELEASE_DIR) {
    return null;
  }
  // Fetch via GitHub API asset endpoint first (same resilience as fetch-zipp-release.mjs), then fallback to browser release URL
  try {
    fs.mkdirSync(releaseCacheDir, { recursive: true });
    let resp = null;
    const assetsMap = await getReleaseAssetsMap();
    const apiAssetUrl = assetsMap?.get(artifactName);
    if (apiAssetUrl) {
      resp = await fetch(apiAssetUrl, {
        headers: apiHeaders('application/octet-stream'),
        redirect: 'follow',
      }).catch(() => null);
    }
    if (!resp || !resp.ok) {
      const url = `${REPOSITORY}/releases/download/${encodeURIComponent(releaseTag)}/${encodeURIComponent(artifactName)}`;
      resp = await fetch(url, {
        headers: { 'User-Agent': 'softn-container-sync' },
        redirect: 'follow',
      });
    }
    if (!resp.ok) {
      if (!optional) console.warn(`[container] Download HTTP ${resp.status} for ${artifactName}`);
      return null;
    }
    const bytes = new Uint8Array(await resp.arrayBuffer());
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (digest !== expected) {
      throw new Error(`SHA-256 mismatch for ${artifactName}: expected ${expected}, got ${digest}`);
    }
    const cached = path.join(releaseCacheDir, artifactName);
    fs.writeFileSync(cached, bytes);
    return cached;
  } catch (err) {
    if (!optional) console.warn(`[container] Could not download ${artifactName}: ${err.message}`);
    return null;
  }
}

function copyFirstExisting(candidates, destDir, destName) {
  for (const src of candidates) {
    if (src && fs.existsSync(src)) {
      const dest = path.join(destDir, destName);
      fs.copyFileSync(src, dest);
      const kb = (fs.statSync(dest).size / 1024).toFixed(1);
      console.log(`[container] Staged ${destName} (${kb} KB) from ${path.basename(src)}`);
      return dest;
    }
  }
  return null;
}

async function extractGlueForWasm(wasmPath, fallbackGluePath) {
  if (!wasmPath || !fs.existsSync(wasmPath)) return;
  const glueDest = wasmPath.replace(/\.wasm$/, '.glue.js');
  try {
    const raw = fs.readFileSync(wasmPath);
    const mod = await WebAssembly.compile(new Uint8Array(raw));
    const sections = WebAssembly.Module.customSections(mod, 'zipp.glue');
    if (sections.length > 0) {
      const glueText = new TextDecoder().decode(sections[0]);
      fs.writeFileSync(glueDest, glueText, 'utf8');
      console.log(`[container] Extracted ${path.basename(glueDest)} (${(glueText.length / 1024).toFixed(1)} KB)`);
      return;
    }
  } catch (err) {
    console.warn(`[container] Could not extract zipp.glue from ${path.basename(wasmPath)}:`, err);
  }
  if (fallbackGluePath && fs.existsSync(fallbackGluePath)) {
    fs.copyFileSync(fallbackGluePath, glueDest);
    console.log(`[container] Copied fallback ${path.basename(glueDest)}`);
  }
}

const coreJsWasm = path.join(CORE_DIR, 'wasm-zipp-web', 'zipp_wasm_bg.wasm');
const coreJsGlue = path.join(CORE_DIR, 'wasm-zipp-web', 'zipp_wasm.js');
const corePyWasm = path.join(CORE_DIR, 'wasm-zipp', 'zipp_wasm_bg.wasm');
const corePyGlue = path.join(CORE_DIR, 'wasm-zipp', 'zipp_wasm.js');
const coreTorchWasm = path.join(CORE_DIR, 'wasm-zipp-torch', 'zipp_torch.wasm');

const liteWasmSrc = await resolveReleaseArtifact(`zipp-${version}-javascript-lite.wasm`);
const liteBrSrc = await resolveReleaseArtifact(`zipp-${version}-javascript-lite.wasm.br`, true);
const jsWasmSrc = await resolveReleaseArtifact(`zipp-${version}-javascript.wasm`, true);
const jsBrSrc = await resolveReleaseArtifact(`zipp-${version}-javascript.wasm.br`, true);
const tsWasmSrc = await resolveReleaseArtifact(`zipp-${version}-javascript-typescript.wasm`);
const tsBrSrc = await resolveReleaseArtifact(`zipp-${version}-javascript-typescript.wasm.br`, true);
const pyBrSrc = await resolveReleaseArtifact(`zipp-${version}-javascript-python-base.wasm.br`, true);
const torchBrSrc = await resolveReleaseArtifact(`zipp-${version}-torch-package.wasm.br`, true);

// Each tier is its own engine or the build stops. A tier's file used to be whichever engine
// could be found (a download that failed left core's JavaScript engine under the name
// `zipp-typescript.wasm`), and the build passed: every TypeScript app then failed where it
// ran. The `javascript` tier's engine is the one core installs as its JavaScript-only build,
// the same file of the same release, so that one may come from core.
function required(staged, name, how) {
  if (staged) return staged;
  console.error(`[container] ${name} is missing: ${how}`);
  process.exit(1);
}
const fromRelease = `it is ZIPP ${releaseTag}'s own file, taken from ZIPP_RELEASE_DIR, from ${path.relative(REPO_ROOT, releaseCacheDir)}, or downloaded from the release (this build could not reach it)`;

const stagedLite = required(copyFirstExisting([liteWasmSrc], ENGINES_DIR, 'zipp-javascript-lite.wasm'), 'zipp-javascript-lite.wasm', fromRelease);
copyFirstExisting([liteBrSrc], ENGINES_DIR, 'zipp-javascript-lite.wasm.br');

const stagedJs = required(copyFirstExisting([jsWasmSrc, coreJsWasm], ENGINES_DIR, 'zipp-javascript.wasm'), 'zipp-javascript.wasm', `${fromRelease}; or core's packages/@softn/core/wasm-zipp-web/ (run fetch-zipp-release.mjs --ensure)`);
copyFirstExisting([jsBrSrc], ENGINES_DIR, 'zipp-javascript.wasm.br');

const stagedTs = required(copyFirstExisting([tsWasmSrc], ENGINES_DIR, 'zipp-typescript.wasm'), 'zipp-typescript.wasm', fromRelease);
copyFirstExisting([tsBrSrc], ENGINES_DIR, 'zipp-typescript.wasm.br');

const stagedPy = required(copyFirstExisting([corePyWasm], ENGINES_DIR, 'zipp-python-base.wasm'), 'zipp-python-base.wasm', "it is core's engine, packages/@softn/core/wasm-zipp/ (run fetch-zipp-release.mjs --ensure)");
copyFirstExisting([pyBrSrc], ENGINES_DIR, 'zipp-python-base.wasm.br');

copyFirstExisting([coreTorchWasm], ENGINES_DIR, 'zipp-torch.wasm');
copyFirstExisting([torchBrSrc], ENGINES_DIR, 'zipp-torch.wasm.br');

await extractGlueForWasm(stagedLite, fs.existsSync(coreJsGlue) ? coreJsGlue : corePyGlue);
await extractGlueForWasm(stagedJs, fs.existsSync(coreJsGlue) ? coreJsGlue : corePyGlue);
await extractGlueForWasm(stagedTs, corePyGlue);
await extractGlueForWasm(stagedPy, corePyGlue);

// Stage externally hosted vendor libraries (`/runtime/vendor/three.js`)
copyFirstExisting(
  [path.join(REPO_ROOT, 'node_modules', 'three', 'build', 'three.module.min.js')],
  VENDOR_DIR,
  'three.js'
);

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
import zlib from 'node:zlib';
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
const { version, release: releaseTag } = await ensureReleaseEngine({ ...releaseOptions(), dir: wasmDir });
const sumsPath = path.join(wasmDir, 'RELEASE-SHA256SUMS');
const expectedSums = new Map();
for (const line of fs.readFileSync(sumsPath, 'utf8').split(/\r?\n/)) {
  const m = /^([0-9a-f]{64})\s+\*?(\S+)\s*$/.exec(line.trim());
  if (m) expectedSums.set(m[2], m[1]);
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

/**
 * An engine's bindings, written beside it: the ones it carries (`zipp.glue`), or `ownGlue`, the
 * bindings file of that same engine where an install keeps them apart (core's). Never another
 * engine's, and never none: an engine that carried no bindings was given whichever of core's
 * was at hand (the TypeScript engine got the Python engine's, which import what it does not
 * have) or left without, and the build passed either way; the tier then failed where it ran.
 */
async function extractGlueForWasm(wasmPath, ownGlue) {
  const name = path.basename(wasmPath);
  const glueDest = wasmPath.replace(/\.wasm$/, '.glue.js');
  let why = 'it carries no zipp.glue section';
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
    why = `it could not be read as WebAssembly (${err.message})`;
  }
  if (ownGlue && fs.existsSync(ownGlue)) {
    fs.copyFileSync(ownGlue, glueDest);
    console.log(`[container] ${path.basename(glueDest)} is ${path.relative(REPO_ROOT, ownGlue)}, the bindings installed with that engine`);
    return;
  }
  console.error(`[container] ${name} has no bindings: ${why}, and no bindings of its own are installed beside it. The tier cannot run without them.`);
  process.exit(1);
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

const stagedJs = required(copyFirstExisting([jsWasmSrc, coreJsWasm], ENGINES_DIR, 'zipp-javascript.wasm'), 'zipp-javascript.wasm', `${fromRelease}; or core's packages/@softn/core/wasm-zipp-web/ (run fetch-zipp-release.mjs --ensure)`);

const stagedTs = required(copyFirstExisting([tsWasmSrc], ENGINES_DIR, 'zipp-typescript.wasm'), 'zipp-typescript.wasm', fromRelease);

const stagedPy = required(copyFirstExisting([corePyWasm], ENGINES_DIR, 'zipp-python-base.wasm'), 'zipp-python-base.wasm', "it is core's engine, packages/@softn/core/wasm-zipp/ (run fetch-zipp-release.mjs --ensure)");

copyFirstExisting([coreTorchWasm], ENGINES_DIR, 'zipp-torch.wasm');

// A server may prefer the .br file even after the underlying .wasm changes.
// An incremental build can keep only the compressed copies verified for this release.
for (const [tier, compressed] of Object.entries({
  'javascript-lite': liteBrSrc, javascript: jsBrSrc, typescript: tsBrSrc, 'python-base': pyBrSrc, torch: torchBrSrc,
})) {
  const name = `zipp-${tier}.wasm.br`;
  if (!copyFirstExisting([compressed], ENGINES_DIR, name)) fs.rmSync(path.join(ENGINES_DIR, name), { force: true });
}

// The two engines core installs have core's own bindings file to fall back on, each its own;
// the two only the container has must carry theirs.
const jsIsCores = !(jsWasmSrc && fs.existsSync(jsWasmSrc));
await extractGlueForWasm(stagedLite, null);
await extractGlueForWasm(stagedJs, jsIsCores ? coreJsGlue : null);
await extractGlueForWasm(stagedTs, null);
await extractGlueForWasm(stagedPy, corePyGlue);

// Optional full-stack backend WASM tiers (`zipp-php.wasm`, `zipp-rust.wasm`) from a local
// ZIPP dev checkout (`ZIPP_DEV_REPO` or sibling `zipp.org`) or `ZIPP_RELEASE_DIR`, plus
// embedded XDB SQLite WASM (`xdb-wasm.wasm` + `xdb-wasm.glue.js`) from `XDB_REPO` or sibling `xdb/xdb-rs`.
function findEmbeddedVariant(dirs, suffix) {
  for (const dir of dirs) {
    if (!dir || !fs.existsSync(dir)) continue;
    const direct = path.join(dir, suffix);
    if (fs.existsSync(direct)) return direct;
    try {
      const files = fs.readdirSync(dir).filter((f) => f.endsWith(suffix)).sort().reverse();
      if (files.length > 0) return path.join(dir, files[0]);
    } catch {
      // ignore
    }
  }
  return null;
}

const zippDevRoots = [
  process.env.ZIPP_DEV_REPO ? path.resolve(process.env.ZIPP_DEV_REPO, 'crates', 'zipp-wasm', 'dist', 'embedded') : null,
  process.env.ZIPP_RELEASE_DIR ? path.resolve(process.env.ZIPP_RELEASE_DIR) : null,
  path.resolve(REPO_ROOT, '..', 'zipp.org', 'crates', 'zipp-wasm', 'dist', 'embedded'),
].filter(Boolean);

function ensureBrotliTwin(wasmPath, existingBrSrc, destName) {
  if (copyFirstExisting([existingBrSrc], ENGINES_DIR, destName)) return;
  if (!wasmPath || !fs.existsSync(wasmPath)) return;
  const dest = path.join(ENGINES_DIR, destName);
  const compressed = zlib.brotliCompressSync(fs.readFileSync(wasmPath), {
    params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 6 },
  });
  fs.writeFileSync(dest, compressed);
  console.log(`[container] Compressed ${destName} (${(compressed.byteLength / 1024).toFixed(1)} KB)`);
}

const phpReleaseWasm = await resolveReleaseArtifact(`zipp-${version}-javascript-php.wasm`, true);
const phpReleaseBr = await resolveReleaseArtifact(`zipp-${version}-javascript-php.wasm.br`, true);
const phpWasmSrc = phpReleaseWasm ?? findEmbeddedVariant(zippDevRoots, '-javascript-php.wasm') ?? findEmbeddedVariant(zippDevRoots, 'zipp-php.wasm');
const phpBrSrc = phpReleaseBr ?? findEmbeddedVariant(zippDevRoots, '-javascript-php.wasm.br') ?? findEmbeddedVariant(zippDevRoots, 'zipp-php.wasm.br');
const stagedPhp = copyFirstExisting([phpWasmSrc], ENGINES_DIR, 'zipp-php.wasm');
ensureBrotliTwin(stagedPhp, phpBrSrc, 'zipp-php.wasm.br');
if (stagedPhp) await extractGlueForWasm(stagedPhp, null);

const rustReleaseWasm = await resolveReleaseArtifact(`zipp-${version}-javascript-rust.wasm`, true);
const rustReleaseBr = await resolveReleaseArtifact(`zipp-${version}-javascript-rust.wasm.br`, true);
const rustWasmSrc = rustReleaseWasm ?? findEmbeddedVariant(zippDevRoots, '-javascript-rust.wasm') ?? findEmbeddedVariant(zippDevRoots, 'zipp-rust.wasm');
const rustBrSrc = rustReleaseBr ?? findEmbeddedVariant(zippDevRoots, '-javascript-rust.wasm.br') ?? findEmbeddedVariant(zippDevRoots, 'zipp-rust.wasm.br');
const stagedRust = copyFirstExisting([rustWasmSrc], ENGINES_DIR, 'zipp-rust.wasm');
ensureBrotliTwin(stagedRust, rustBrSrc, 'zipp-rust.wasm.br');
if (stagedRust) await extractGlueForWasm(stagedRust, null);

// Embedded XDB SQLite WASM (`xdb-wasm.wasm`, `xdb-wasm.wasm.br`, `xdb-wasm.glue.js`):
// Fetch SHA256SUMS-verified release assets from f2i-com/xdb.org (cached in .xdb-release/<tag>/),
// with optional local override via XDB_WASM_DIR or sibling xdb-rs checkout fallback.
const XDB_REPOSITORY = 'https://github.com/f2i-com/xdb.org';
const XDB_RELEASE_TAG = process.env.XDB_RELEASE || 'v0.1.0';
const XDB_VERSION = XDB_RELEASE_TAG.replace(/^v/, '');
const XDB_SUMS_SHA256 = process.env.XDB_SUMS_SHA256 || '3074389101142825e56f07a4653c388d78f27b099145d14538c155b0c2206393';
const xdbCacheDir = path.join(REPO_ROOT, '.xdb-release', XDB_RELEASE_TAG);

async function fetchXdbReleaseAssets() {
  if (process.env.XDB_WASM_DIR) return null;
  try {
    fs.mkdirSync(xdbCacheDir, { recursive: true });
    const sumsCache = path.join(xdbCacheDir, 'SHA256SUMS');
    let sumsBytes = fs.existsSync(sumsCache) ? fs.readFileSync(sumsCache) : null;
    if (!sumsBytes || createHash('sha256').update(sumsBytes).digest('hex') !== XDB_SUMS_SHA256) {
      const sumsUrl = `${XDB_REPOSITORY}/releases/download/${encodeURIComponent(XDB_RELEASE_TAG)}/SHA256SUMS`;
      const resp = await fetch(sumsUrl, { headers: { 'User-Agent': 'softn-container-sync' }, redirect: 'follow' });
      if (!resp.ok) return null;
      sumsBytes = Buffer.from(await resp.arrayBuffer());
      const got = createHash('sha256').update(sumsBytes).digest('hex');
      if (got !== XDB_SUMS_SHA256) {
        throw new Error(`XDB ${XDB_RELEASE_TAG} SHA256SUMS mismatch: expected ${XDB_SUMS_SHA256}, got ${got}`);
      }
      fs.writeFileSync(sumsCache, sumsBytes);
    }
    const xdbSums = new Map();
    for (const line of sumsBytes.toString('utf8').split(/\r?\n/)) {
      const m = /^([0-9a-f]{64})\s+\*?(\S+)\s*$/.exec(line.trim());
      if (m) xdbSums.set(m[2], m[1]);
    }
    const resolveXdb = async (assetName) => {
      const expected = xdbSums.get(assetName);
      if (!expected) return null;
      const cached = path.join(xdbCacheDir, assetName);
      if (fs.existsSync(cached) && sha256File(cached) === expected) return cached;
      const url = `${XDB_REPOSITORY}/releases/download/${encodeURIComponent(XDB_RELEASE_TAG)}/${encodeURIComponent(assetName)}`;
      const resp = await fetch(url, { headers: { 'User-Agent': 'softn-container-sync' }, redirect: 'follow' });
      if (!resp.ok) return null;
      const bytes = Buffer.from(await resp.arrayBuffer());
      const digest = createHash('sha256').update(bytes).digest('hex');
      if (digest !== expected) {
        throw new Error(`SHA-256 mismatch for ${assetName}: expected ${expected}, got ${digest}`);
      }
      fs.writeFileSync(cached, bytes);
      return cached;
    };
    const wasm = await resolveXdb(`xdb-${XDB_VERSION}-wasm.wasm`);
    const br = await resolveXdb(`xdb-${XDB_VERSION}-wasm.wasm.br`);
    const glue = await resolveXdb(`xdb-${XDB_VERSION}-wasm.js`);
    return { wasm, br, glue };
  } catch (err) {
    console.warn(`[container] Could not fetch XDB ${XDB_RELEASE_TAG} release assets: ${err.message}`);
    return null;
  }
}

const xdbRelease = await fetchXdbReleaseAssets();
const xdbPkgDirs = [
  process.env.XDB_WASM_DIR ? path.resolve(process.env.XDB_WASM_DIR) : null,
  process.env.XDB_REPO ? path.resolve(process.env.XDB_REPO, 'crates', 'xdb-wasm', 'dist') : null,
  process.env.XDB_REPO ? path.resolve(process.env.XDB_REPO, 'crates', 'xdb-wasm', 'pkg') : null,
  path.resolve(REPO_ROOT, '..', 'xdb', 'xdb-rs', 'crates', 'xdb-wasm', 'dist'),
  path.resolve(REPO_ROOT, '..', 'xdb', 'xdb-rs', 'crates', 'xdb-wasm', 'pkg'),
].filter(Boolean);

const xdbWasmSrc = xdbRelease?.wasm ?? findEmbeddedVariant(xdbPkgDirs, '-wasm.wasm') ?? findEmbeddedVariant(xdbPkgDirs, 'xdb_wasm_bg.wasm');
const xdbBrSrc = xdbRelease?.br ?? findEmbeddedVariant(xdbPkgDirs, '-wasm.wasm.br');
const xdbGlueSrc = xdbRelease?.glue ?? findEmbeddedVariant(xdbPkgDirs, '-wasm.js') ?? findEmbeddedVariant(xdbPkgDirs, 'xdb_wasm.js');
const stagedXdb = copyFirstExisting([xdbWasmSrc], ENGINES_DIR, 'xdb-wasm.wasm');
ensureBrotliTwin(stagedXdb, xdbBrSrc, 'xdb-wasm.wasm.br');
copyFirstExisting([xdbGlueSrc], ENGINES_DIR, 'xdb-wasm.glue.js');

// Stage externally hosted vendor libraries (`/runtime/vendor/three.js` + `/runtime/vendor/gltf-loader.js`)
copyFirstExisting(
  [path.join(REPO_ROOT, 'node_modules', 'three', 'build', 'three.module.min.js')],
  VENDOR_DIR,
  'three.js'
);

// Bundle GLTFLoader + MeshoptDecoder against external `./three.js` so `ThreeWorkerHost`
// can load `.glb` / `.gltf` models natively inside `container-worker.js` using the exact
// same Three.js namespace (with zero extra copies of Three.js).
{
  const gltfLoaderSrc = path.join(REPO_ROOT, 'node_modules', 'three', 'examples', 'jsm', 'loaders', 'GLTFLoader.js');
  const meshoptSrc = path.join(REPO_ROOT, 'node_modules', 'three', 'examples', 'jsm', 'libs', 'meshopt_decoder.module.js');
  if (fs.existsSync(gltfLoaderSrc) && fs.existsSync(meshoptSrc)) {
    const esbuild = await import('esbuild');
    const outFile = path.join(VENDOR_DIR, 'gltf-loader.js');
    await esbuild.build({
      stdin: {
        contents: `export { GLTFLoader } from ${JSON.stringify(gltfLoaderSrc)};\nexport { MeshoptDecoder } from ${JSON.stringify(meshoptSrc)};\n`,
        resolveDir: path.dirname(gltfLoaderSrc),
        loader: 'js',
      },
      bundle: true,
      format: 'esm',
      minify: true,
      outfile: outFile,
      plugins: [
        {
          name: 'external-three',
          setup(build) {
            build.onResolve({ filter: /^three$/ }, () => ({ path: './three.js', external: true }));
          },
        },
      ],
    });
    const kb = (fs.statSync(outFile).size / 1024).toFixed(1);
    console.log(`[container] Bundled gltf-loader.js (${kb} KB)`);
  }
}

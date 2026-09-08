/**
 * The production build's module graph, read from Vite's manifest.
 *
 * What a visitor downloads before the first document renders is the entry
 * chunk and everything it imports statically — its closure. The claim
 * under test is that no Three.js, model loader or post-processing code is
 * in that closure: registerRuntimeComponents() in main.tsx reaches every
 * feature through import(), so each is a dynamic chunk the manifest lists
 * under `dynamicImports` and nowhere under `imports`. The service worker's
 * precache follows the same line — the closure is in it, the features are
 * not — and the sizes are printed so a regression is a number in the CI log
 * rather than a surprise on a phone.
 *
 * Runs against dist/; CI builds before it tests, and locally
 * `npm run build -w @softn/web` first.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

interface ManifestChunk {
  file: string;
  isEntry?: boolean;
  isDynamicEntry?: boolean;
  imports?: string[];
  dynamicImports?: string[];
  css?: string[];
}

const dist = resolve(dirname(fileURLToPath(import.meta.url)), '../dist');
const manifestPath = resolve(dist, '.vite/manifest.json');
const built = existsSync(manifestPath);
if (!built) {
  console.warn(`[build-graph] ${manifestPath} is absent; build @softn/web first — skipped`);
}

const HEAVY = /three|scene3d|gltf|fbx|obj|stl|postprocessing/i;
const FEATURES = ['scene3d', 'charts', 'editors', 'smart', 'media', 'animation'];
// The Three addons Scene3D reaches through its own import() — the model
// loaders, the controls, the room environment, the post-processing set,
// SkeletonUtils and the Meshopt decoder, as docs/SCENE3D_LOADING.md lists
// them: "fetched on demand, once per page, the first time a scene asks for
// it". Each is a chunk named after its module. The claim under test is that
// none is in the scene3d chunk's STATIC closure — the manifest lists each
// under scene3d's `dynamicImports` and under nothing's `imports` reachable
// from it — so a scene with one glTF and no effects fetches GLTFLoader and
// nothing else. The vendor-three group used to sweep them all into Three's
// own chunk (740 KB against 571 KB for three/build/ alone).
const THREE_ADDONS = [
  'GLTFLoader',
  'OBJLoader',
  'FBXLoader',
  'STLLoader',
  'OrbitControls',
  'RoomEnvironment',
  'SkeletonUtils',
  'EffectComposer',
  'RenderPass',
  'UnrealBloomPass',
  'OutputPass',
  'ShaderPass',
  'meshopt_decoder.module',
];
// What the post-processing chunks share between them (Pass, CopyShader),
// emitted as chunks of their own. Dynamic only by way of the chunks that
// import them; held out of the scene3d closure and the precache like the rest.
const THREE_ADDON_SHARED = ['Pass', 'CopyShader'];
/** Matches a manifest key for a module under three's addons. */
const ADDON_KEY = /three[\\/]examples[\\/]jsm[\\/]|three[\\/]addons[\\/]/;
/** Matches an emitted addon (or shared helper) chunk file by name. */
const ADDON_FILE = new RegExp(
  `/(?:${[...THREE_ADDONS, ...THREE_ADDON_SHARED].join('|')})-[^/]+\\.js$`
);
// Core's on-demand modules that only some apps reach — the AI managers and
// the runtimes behind them, the peer and server sync runtimes — by the name
// each chunk starts with. vite.config.ts keeps these out of the precache
// (`onDemandRuntimeChunks`); the per-app install fetches the sync one for an
// app that asked for `sync`, and the AI ones stay online by design.
const ON_DEMAND_RUNTIME = [
  'ai-manager',
  'ai-onnx-manager',
  'ai-transformers-manager',
  'ai-gpu-compute-manager',
  'transformers.web',
  'ort.bundle.min',
  'xdb-sync',
  'xdb-server-sync',
];
// The inflate worker imports the archive reader from `@softn/core/bundle`,
// core's own entry for it; through the barrel it measured 1.35 MB. Well
// above the ~10 KB it is, well below what the barrel would make it.
const ZIP_WORKER_CAP = 50_000;
// Three.js alone is ~700 KB minified, so an entry closure under this cannot
// hold it whatever else it holds. The closure was 724 KB when the cap was
// set (1,780,427 bytes before the registry loaded features on demand).
const CLOSURE_CAP = 1_000_000;

function readManifest(): Record<string, ManifestChunk> {
  return JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, ManifestChunk>;
}

function sizeOf(file: string): number {
  return statSync(resolve(dist, file)).size;
}

/** Every chunk reachable from `roots` over static imports only. */
function staticClosure(
  manifest: Record<string, ManifestChunk>,
  roots: string[]
): Map<string, ManifestChunk> {
  const closure = new Map<string, ManifestChunk>();
  const queue = [...roots];
  while (queue.length) {
    const key = queue.shift()!;
    if (closure.has(key)) continue;
    const chunk = manifest[key];
    if (!chunk) throw new Error(`manifest names ${key} but has no entry for it`);
    closure.set(key, chunk);
    queue.push(...(chunk.imports ?? []));
  }
  return closure;
}

/** Every chunk reachable from the entries over static imports only. */
function entryClosure(manifest: Record<string, ManifestChunk>): Map<string, ManifestChunk> {
  return staticClosure(
    manifest,
    Object.entries(manifest)
      .filter(([, chunk]) => chunk.isEntry)
      .map(([key]) => key)
  );
}

describe.skipIf(!built)('softn-web build graph', () => {
  const manifest = built ? readManifest() : {};
  const closure = built ? entryClosure(manifest) : new Map<string, ManifestChunk>();
  const closureFiles = [...closure.values()].map((chunk) => chunk.file);
  const closureBytes = closureFiles.reduce((sum, file) => sum + sizeOf(file), 0);

  it('has an entry', () => {
    expect(closure.size).toBeGreaterThan(0);
  });

  it('keeps Three.js, the model loaders and post-processing out of the entry closure', () => {
    const sizes = closureFiles.map((file) => `${file} (${sizeOf(file)} B)`);
    process.stdout.write(
      `[build-graph] entry closure: ${closureBytes} bytes over ${closure.size} chunk(s)\n  ${sizes.join('\n  ')}\n`
    );
    for (const file of closureFiles) {
      expect(file, `entry closure contains ${file}`).not.toMatch(HEAVY);
    }
    for (const [key] of closure) {
      expect(key, `entry closure contains ${key}`).not.toMatch(HEAVY);
    }
  });

  it(`stays under ${CLOSURE_CAP} bytes, per file and in total`, () => {
    for (const file of closureFiles) {
      expect(sizeOf(file), `${file} alone is ${sizeOf(file)} bytes`).toBeLessThan(CLOSURE_CAP);
    }
    expect(closureBytes, `entry closure is ${closureBytes} bytes`).toBeLessThan(CLOSURE_CAP);
  });

  it('reaches every feature, Scene3D included, only through a dynamic import', () => {
    const dynamicTargets = new Set(
      Object.values(manifest).flatMap((chunk) => chunk.dynamicImports ?? [])
    );
    const staticTargets = new Set(Object.values(manifest).flatMap((chunk) => chunk.imports ?? []));
    const featureChunks: string[] = [];
    for (const feature of FEATURES) {
      const key = Object.keys(manifest).find((k) => k.endsWith(`/components/dist/${feature}.js`));
      expect(key, `no chunk for the ${feature} feature`).toBeDefined();
      const chunk = manifest[key!];
      expect(chunk.isDynamicEntry, `${feature} is not a dynamic entry`).toBe(true);
      expect(dynamicTargets.has(key!), `${feature} is not dynamically imported`).toBe(true);
      expect(staticTargets.has(key!), `${feature} is statically imported`).toBe(false);
      expect(closure.has(key!), `${feature} is in the entry closure`).toBe(false);
      featureChunks.push(`${chunk.file} (${sizeOf(chunk.file)} B)`);
    }
    const three = Object.entries(manifest).find(([, chunk]) => /vendor-three/.test(chunk.file));
    expect(three, 'no vendor-three chunk').toBeDefined();
    expect(closure.has(three![0])).toBe(false);
    featureChunks.push(`${three![1].file} (${sizeOf(three![1].file)} B)`);
    process.stdout.write(
      `[build-graph] dynamic feature chunks:\n  ${featureChunks.join('\n  ')}\n`
    );
  });

  it("keeps every Three addon out of the scene3d chunk's static closure and reaches it by dynamic import", () => {
    const scene3dKey = Object.keys(manifest).find((k) => k.endsWith('/components/dist/scene3d.js'));
    expect(scene3dKey, 'no chunk for the scene3d feature').toBeDefined();
    const sceneClosure = staticClosure(manifest, [scene3dKey!]);
    for (const [key, chunk] of sceneClosure) {
      expect(key, `scene3d's static closure contains ${key}`).not.toMatch(ADDON_KEY);
      expect(chunk.file, `scene3d's static closure contains ${chunk.file}`).not.toMatch(ADDON_FILE);
    }
    // Three itself is the one static import: every scene needs the renderer,
    // the geometries and the materials.
    const three = Object.entries(manifest).find(([, chunk]) => /vendor-three/.test(chunk.file));
    expect(three, 'no vendor-three chunk').toBeDefined();
    expect(sceneClosure.has(three![0]), 'scene3d does not import vendor-three statically').toBe(true);

    const dynamic = new Set(manifest[scene3dKey!].dynamicImports ?? []);
    const addons: string[] = [];
    for (const addon of THREE_ADDONS) {
      const key = Object.keys(manifest).find((k) => ADDON_KEY.test(k) && k.endsWith(`/${addon}.js`));
      expect(key, `no chunk for the ${addon} addon`).toBeDefined();
      expect(dynamic.has(key!), `${addon} is not dynamically imported by scene3d`).toBe(true);
      expect(closure.has(key!), `${addon} is in the entry closure`).toBe(false);
      addons.push(`${manifest[key!].file} (${sizeOf(manifest[key!].file)} B)`);
    }
    const sceneBytes = [...sceneClosure.values()].reduce((sum, chunk) => sum + sizeOf(chunk.file), 0);
    process.stdout.write(
      `[build-graph] scene3d static closure: ${sceneBytes} bytes over ${sceneClosure.size} chunk(s)\n` +
        `[build-graph] Three addon chunks (dynamic from scene3d):\n  ${addons.join('\n  ')}\n`
    );
  });

  /** The URLs sw.js precaches, as its precacheAndRoute call lists them. */
  function precachedUrls(): Set<string> {
    const sw = readFileSync(resolve(dist, 'sw.js'), 'utf8');
    const list = /precacheAndRoute\((\[[\s\S]*?\])\s*[,)]/.exec(sw);
    expect(list, 'sw.js has no precacheAndRoute call').not.toBeNull();
    const precached = new Set([...list![1].matchAll(/url:"([^"]+)"/g)].map((m) => m[1]));
    expect(precached.size).toBeGreaterThan(0);
    return precached;
  }

  it('precaches the entry closure and not the feature chunks', () => {
    const precached = precachedUrls();

    const shell = [...closureFiles, ...[...closure.values()].flatMap((chunk) => chunk.css ?? [])];
    for (const file of shell) {
      expect(precached.has(file), `${file} is not precached`).toBe(true);
    }
    for (const url of precached) {
      expect(url, `${url} is precached`).not.toMatch(/\/vendor-three-/);
      expect(url, `${url} is precached`).not.toMatch(ADDON_FILE);
      for (const feature of FEATURES) {
        expect(url, `${url} is precached`).not.toMatch(new RegExp(`/${feature}-[^/]+\\.js$`));
      }
    }
    // Each addon ignore pattern names something the build emitted, so the
    // list in vite.config.ts cannot go stale silently either.
    const assets = readdirSync(resolve(dist, 'assets'));
    for (const name of [...THREE_ADDONS, ...THREE_ADDON_SHARED]) {
      expect(
        assets.some((file) => file.startsWith(`${name}-`) && file.endsWith('.js')),
        `no ${name} chunk was emitted`
      ).toBe(true);
    }
    const precachedJs = [...precached].filter((url) => url.endsWith('.js'));
    process.stdout.write(
      `[build-graph] precached scripts: ${precachedJs.length}\n  ${precachedJs.join('\n  ')}\n`
    );
  });

  it('leaves the on-demand runtime chunks to the runtime cache and keeps the inflate worker and XDB precached', () => {
    const precached = precachedUrls();
    const assets = readdirSync(resolve(dist, 'assets')).filter((file) => file.endsWith('.js'));

    // Each on-demand module is emitted — the ignore patterns are not
    // vacuous — and none of it is in the precache.
    const onDemand: string[] = [];
    for (const name of ON_DEMAND_RUNTIME) {
      const files = assets.filter((file) => file.startsWith(`${name}-`));
      expect(files.length, `no ${name} chunk was emitted`).toBeGreaterThan(0);
      for (const file of files) {
        expect(precached.has(`assets/${file}`), `assets/${file} is precached`).toBe(false);
        onDemand.push(`assets/${file} (${sizeOf(`assets/${file}`)} B)`);
      }
    }

    // What every app does need, on the other hand, is in it: the XDB module
    // (its name starts with `xdb-` and is none of the sync runtimes) and the
    // inflate worker, which the shell references from app source.
    const xdb = assets.filter(
      (file) => /^xdb-/.test(file) && !ON_DEMAND_RUNTIME.some((name) => file.startsWith(`${name}-`))
    );
    expect(xdb.length, 'no xdb chunk was emitted').toBeGreaterThan(0);
    for (const file of xdb) expect(precached.has(`assets/${file}`), `assets/${file} is not precached`).toBe(true);

    const worker = assets.find((file) => /^zipWorker-[^/]+\.js$/.test(file));
    expect(worker, 'no zipWorker chunk was emitted').toBeDefined();
    expect(precached.has(`assets/${worker}`), `assets/${worker} is not precached`).toBe(true);
    expect(sizeOf(`assets/${worker}`), `the inflate worker is ${sizeOf(`assets/${worker}`)} bytes`).toBeLessThan(ZIP_WORKER_CAP);

    process.stdout.write(
      `[build-graph] on-demand runtime chunks (runtime-cached, not precached):\n  ${onDemand.join('\n  ')}\n` +
        `[build-graph] inflate worker: assets/${worker} (${sizeOf(`assets/${worker}`)} B)\n`
    );
  });
});

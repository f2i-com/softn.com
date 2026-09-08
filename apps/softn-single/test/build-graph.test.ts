/**
 * The standalone build's module graph, read from Vite's manifest.
 *
 * The same claim as softn-web's build-graph test, for the other host: the
 * entry chunk and everything it imports statically hold no Three.js, model
 * loader or post-processing code, because registerRuntimeComponents() in
 * main.tsx reaches every feature through import(). Each feature is a
 * dynamic chunk the manifest lists under `dynamicImports` and nowhere under
 * `imports`. There is no service worker here, so no precache to check.
 *
 * Runs against dist/; CI builds before it tests, and locally
 * `npm run build -w @softn/single` first.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, statSync } from 'node:fs';
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
  console.warn(`[build-graph] ${manifestPath} is absent; build @softn/single first — skipped`);
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
// Three.js alone is ~700 KB minified, so an entry closure under this cannot
// hold it whatever else it holds. The closure was 624 KB when the cap was
// set (1,680,681 bytes before the registry loaded features on demand).
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

describe.skipIf(!built)('softn-single build graph', () => {
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
});

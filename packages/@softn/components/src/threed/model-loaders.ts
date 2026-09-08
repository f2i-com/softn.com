/**
 * The parts of three.js a scene pays for only when it uses them.
 *
 * `three` itself — the renderer, geometry, materials — is imported
 * statically: every scene needs it. Everything else used to be imported the
 * same way, so a page with one text app carried the glTF, OBJ, FBX and STL
 * loaders, orbit controls, the studio environment and the bloom pipeline in
 * its entry chunk whether or not any scene existed, let alone one that used
 * them (the 0.0.7 baseline in scripts/bench/results measures it). Each is
 * now a dynamic import behind a function, taken when the format or feature
 * is actually requested.
 *
 * The in-flight promise is cached at module scope so a page with twenty
 * scenes fetches each chunk once, and a failed import is forgotten so a
 * chunk the network dropped is retried by the next scene that asks rather
 * than poisoning the page.
 */

import * as THREE from 'three';
import { isSafeUrl } from '@softn/core';
import type { GLTF, GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import {
  createLoadResources,
  type LoadResources,
  type ModelResourcePolicySource,
} from './model-resources';

export type ModelFormat = 'gltf' | 'obj' | 'fbx' | 'stl';

function cachedImport<T>(load: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | null = null;
  return () => {
    if (!pending) {
      pending = load().catch((err: unknown) => {
        pending = null;
        throw err;
      });
    }
    return pending;
  };
}

export const importGLTFLoader = cachedImport(() => import('three/addons/loaders/GLTFLoader.js'));
export const importOBJLoader = cachedImport(() => import('three/addons/loaders/OBJLoader.js'));
export const importFBXLoader = cachedImport(() => import('three/addons/loaders/FBXLoader.js'));
export const importSTLLoader = cachedImport(() => import('three/addons/loaders/STLLoader.js'));
export const importOrbitControls = cachedImport(
  () => import('three/addons/controls/OrbitControls.js')
);
export const importRoomEnvironment = cachedImport(
  () => import('three/addons/environments/RoomEnvironment.js')
);
export const importSkeletonUtils = cachedImport(() => import('three/addons/utils/SkeletonUtils.js'));

/**
 * The bloom pipeline is five modules that are only ever used together, so
 * they are fetched together and handed over as one object.
 */
export const importPostprocessing = cachedImport(async () => {
  const [composer, render, bloom, output, shader] = await Promise.all([
    import('three/addons/postprocessing/EffectComposer.js'),
    import('three/addons/postprocessing/RenderPass.js'),
    import('three/addons/postprocessing/UnrealBloomPass.js'),
    import('three/addons/postprocessing/OutputPass.js'),
    import('three/addons/postprocessing/ShaderPass.js'),
  ]);
  return {
    EffectComposer: composer.EffectComposer,
    RenderPass: render.RenderPass,
    UnrealBloomPass: bloom.UnrealBloomPass,
    OutputPass: output.OutputPass,
    ShaderPass: shader.ShaderPass,
  };
});
export type PostprocessingModules = Awaited<ReturnType<typeof importPostprocessing>>;

/**
 * Meshopt's decoder is self-contained JavaScript (its wasm is inlined), so
 * it can be taken on demand like a loader. Draco and KTX2 are not: their
 * decoders are separate binaries this build does not ship, so a model that
 * needs them is refused early, by name, rather than failing deep inside the
 * parser.
 */
export const importMeshoptDecoder = cachedImport(async () => {
  const { MeshoptDecoder } = await import('three/addons/libs/meshopt_decoder.module.js');
  await MeshoptDecoder.ready;
  return MeshoptDecoder;
});

export const GLTF_DRACO = 'KHR_draco_mesh_compression';
export const GLTF_BASISU = 'KHR_texture_basisu';
export const GLTF_MESHOPT = 'EXT_meshopt_compression';

/** The format a file name, URL or archive path implies; glTF when it says nothing. */
export function detectModelFormat(name: string): ModelFormat {
  const clean = name.split('?')[0].split('#')[0].toLowerCase();
  if (clean.endsWith('.glb') || clean.endsWith('.gltf')) return 'gltf';
  if (clean.endsWith('.obj')) return 'obj';
  if (clean.endsWith('.fbx')) return 'fbx';
  if (clean.endsWith('.stl')) return 'stl';
  return 'gltf';
}

/** What a loader produced: the root and the clips that came with it. */
export interface ModelTemplate {
  object: THREE.Object3D;
  animations: THREE.AnimationClip[];
}

export interface ModelLoadRequest {
  url: string;
  format: ModelFormat;
  /** The scene's policy, or a getter for it, read on every URL the load asks about. */
  policy: ModelResourcePolicySource;
}

const GLB_MAGIC = 0x46546c67;
const GLB_JSON_CHUNK = 0x4e4f534a;

/**
 * The extensions a glTF declares, read from its JSON before the parser
 * sees it. A .glb's first chunk is that JSON; a .gltf is that JSON. Anything
 * unreadable reports nothing and leaves the parser to say what is wrong.
 */
export function peekGltfExtensions(data: ArrayBuffer): { used: string[]; required: string[] } {
  const none = { used: [], required: [] };
  try {
    const view = new DataView(data);
    let text: string;
    if (data.byteLength >= 20 && view.getUint32(0, true) === GLB_MAGIC) {
      if (view.getUint32(16, true) !== GLB_JSON_CHUNK) return none;
      const length = Math.min(view.getUint32(12, true), data.byteLength - 20);
      text = new TextDecoder().decode(new Uint8Array(data, 20, length));
    } else {
      text = new TextDecoder().decode(new Uint8Array(data));
    }
    const json = JSON.parse(text) as { extensionsUsed?: unknown; extensionsRequired?: unknown };
    const names = (value: unknown): string[] =>
      Array.isArray(value) ? value.filter((s): s is string => typeof s === 'string') : [];
    return { used: names(json.extensionsUsed), required: names(json.extensionsRequired) };
  } catch {
    return none;
  }
}

async function prepareGltfCodecs(loader: GLTFLoader, data: ArrayBuffer): Promise<void> {
  const { used, required } = peekGltfExtensions(data);
  const wants = new Set([...used, ...required]);
  // three throws on Draco whether or not the file calls it required, so the
  // decoder's absence is the answer either way.
  if (wants.has(GLTF_DRACO)) {
    throw new Error('model needs the Draco decoder, which this runtime does not ship');
  }
  if (required.includes(GLTF_BASISU)) {
    throw new Error('model needs the KTX2 texture transcoder, which this runtime does not ship');
  }
  if (wants.has(GLTF_MESHOPT)) loader.setMeshoptDecoder(await importMeshoptDecoder());
}

function fetchModelBytes(url: string, manager: THREE.LoadingManager): Promise<ArrayBuffer> {
  const loader = new THREE.FileLoader(manager);
  loader.setResponseType('arraybuffer');
  return loader.loadAsync(url).then((data) => {
    if (!(data instanceof ArrayBuffer)) throw new Error(`Model at ${url} did not arrive as bytes`);
    return data;
  });
}

async function parseModel(
  format: ModelFormat,
  url: string,
  resources: LoadResources
): Promise<ModelTemplate> {
  const bytes = fetchModelBytes(url, resources.manager);
  // The loader chunk and the bytes travel together; if the chunk fails the
  // bytes' own rejection must not surface as an unhandled one.
  bytes.catch(() => undefined);
  switch (format) {
    case 'gltf': {
      const [{ GLTFLoader }, data] = await Promise.all([importGLTFLoader(), bytes]);
      const loader = new GLTFLoader(resources.manager);
      await prepareGltfCodecs(loader, data);
      const gltf = await new Promise<GLTF>((resolve, reject) =>
        loader.parse(data, resources.resourcePath, resolve, reject)
      );
      return { object: gltf.scene, animations: gltf.animations ?? [] };
    }
    case 'obj': {
      const [{ OBJLoader }, data] = await Promise.all([importOBJLoader(), bytes]);
      const group = new OBJLoader(resources.manager).parse(new TextDecoder().decode(data));
      return { object: group, animations: [] };
    }
    case 'fbx': {
      const [{ FBXLoader }, data] = await Promise.all([importFBXLoader(), bytes]);
      const group = new FBXLoader(resources.manager).parse(data, resources.resourcePath);
      return { object: group, animations: group.animations ?? [] };
    }
    case 'stl': {
      const [{ STLLoader }, data] = await Promise.all([importSTLLoader(), bytes]);
      const geometry = new STLLoader(resources.manager).parse(data);
      const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: '#6366f1' }));
      return { object: mesh, animations: [] };
    }
    default:
      throw new Error(`Unsupported model format: ${String(format)}`);
  }
}

/**
 * The failure a scene reports. When the load refused something, that is the
 * reason the model is missing, whatever the parser said about the empty
 * buffer it was handed instead.
 */
function describeLoadFailure(err: unknown, resources: LoadResources): Error {
  const original = err instanceof Error ? err : new Error(String(err));
  if (resources.refused.length === 0) return original;
  const [first] = resources.refused;
  const more = resources.refused.length - 1;
  return new Error(
    `Refused to fetch "${first.url}" (${first.reason})${more > 0 ? ` and ${more} more` : ''}; ` +
      `the model could not be built without it: ${original.message}`
  );
}

/**
 * Fetch and parse one model into a template — the object as the loader
 * produced it, never placed in a scene. Instances are cloned from it by the
 * cache. The URL has the same scheme check every bundle-supplied source
 * gets; its subresources are authorised by the per-load manager.
 */
export async function loadModelTemplate(request: ModelLoadRequest): Promise<ModelTemplate> {
  const { url, format, policy } = request;
  if (!isSafeUrl(url)) throw new Error(`Unsafe model URL: ${url}`);
  const resources = createLoadResources(url, policy);
  let template: ModelTemplate;
  try {
    template = await parseModel(format, url, resources);
  } catch (err) {
    throw describeLoadFailure(err, resources);
  }
  if (resources.refused.length > 0) {
    // The parser coped — an optional texture, say — but the scene is showing
    // less than the asset asked for, and the author should know which part.
    console.warn(
      `[Scene3D] Model ${url} loaded without ${resources.refused.length} refused ` +
        `subresource(s): ${resources.refused.map((r) => `${r.url} (${r.reason})`).join(', ')}`
    );
  }
  // A clip's tracks name the node they drive, and three's glTF loader names
  // a node the file left unnamed by its uuid. An instance is a clone, and a
  // clone has a uuid of its own, so a track bound on the clone would find
  // no node and the clip would silently do nothing. A name survives cloning
  // and is what a binding matches first: every unnamed node is given its
  // uuid as its name here, before the first instance is cut.
  template.object.traverse((node) => {
    if (node.name === '') node.name = node.uuid;
  });
  return template;
}

/**
 * The model template cache: one load per key, a clone per instance, and
 * ownership that survives the instances coming and going.
 *
 * Pinned: concurrent acquires share one load; instances have their own
 * materials and skeletons but one geometry and one set of textures;
 * releasing one instance disposes nothing shared; an idle template keeps
 * its resources until the cache evicts it; the idle set is bounded; a
 * failed load is forgotten so a retry fetches; an invalidated template is
 * disposed only when its last holder lets go.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { ModelTemplateCache, modelTemplateAddress, modelTemplateKey } from '../src/threed/model-cache';
import { loadModelTemplate, type ModelTemplate } from '../src/threed/model-loaders';
import { stubFetch } from './scene3d-doubles';

function makeTemplate(): ModelTemplate {
  const geometry = new THREE.BoxGeometry();
  const map = new THREE.Texture();
  const material = new THREE.MeshStandardMaterial({ map });
  const root = new THREE.Group();
  root.name = 'root';
  root.add(new THREE.Mesh(geometry, material));
  const clip = new THREE.AnimationClip('spin', 1, []);
  return { object: root, animations: [clip] };
}

function makeSkinnedTemplate(): ModelTemplate {
  const geometry = new THREE.BoxGeometry();
  const skinIndex = new THREE.Uint16BufferAttribute(new Uint16Array(geometry.attributes.position.count * 4), 4);
  const skinWeight = new THREE.Float32BufferAttribute(new Float32Array(geometry.attributes.position.count * 4), 4);
  geometry.setAttribute('skinIndex', skinIndex);
  geometry.setAttribute('skinWeight', skinWeight);
  const material = new THREE.MeshStandardMaterial();
  const mesh = new THREE.SkinnedMesh(geometry, material);
  const bone = new THREE.Bone();
  mesh.add(bone);
  mesh.bind(new THREE.Skeleton([bone]));
  const root = new THREE.Group();
  root.add(mesh);
  return { object: root, animations: [] };
}

function loaderOf(make: () => ModelTemplate) {
  const calls: string[] = [];
  const load = (key: string) => () => {
    calls.push(key);
    return Promise.resolve(make());
  };
  return { calls, load };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('ModelTemplateCache', () => {
  it('loads once for concurrent acquires and hands each its own clone', async () => {
    const cache = new ModelTemplateCache(16);
    const { calls, load } = loaderOf(makeTemplate);
    const key = modelTemplateKey('app', 'https://m.test/a.glb', 'gltf');
    const [one, two] = await Promise.all([cache.acquire(key, load(key)), cache.acquire(key, load(key))]);
    expect(calls).toHaveLength(1);
    expect(cache.stats().loads).toBe(1);
    expect(one.object).not.toBe(two.object);
    // Distinct roots: a mixer on each animates only its own.
    expect(new THREE.AnimationMixer(one.object).getRoot()).not.toBe(
      new THREE.AnimationMixer(two.object).getRoot()
    );
    const meshOf = (root: THREE.Object3D) => root.children[0] as THREE.Mesh;
    expect(meshOf(one.object).material).not.toBe(meshOf(two.object).material);
    expect(meshOf(one.object).geometry).toBe(meshOf(two.object).geometry);
    expect((meshOf(one.object).material as THREE.MeshStandardMaterial).map).toBe(
      (meshOf(two.object).material as THREE.MeshStandardMaterial).map
    );
    expect(one.animations).toBe(two.animations);
  });

  it('keys templates by app, so two apps naming one URL do not share', async () => {
    const cache = new ModelTemplateCache(16);
    const { calls, load } = loaderOf(makeTemplate);
    const a = modelTemplateKey('app-a', 'https://m.test/a.glb', 'gltf');
    const b = modelTemplateKey('app-b', 'https://m.test/a.glb', 'gltf');
    expect(a).not.toBe(b);
    await Promise.all([cache.acquire(a, load(a)), cache.acquire(b, load(b))]);
    expect(calls).toEqual([a, b]);
    expect(modelTemplateKey(undefined, 'u', 'obj')).toBe('_default|u|obj');
  });

  it('releasing one instance leaves the shared geometry and textures alone', async () => {
    const cache = new ModelTemplateCache(16);
    const { load } = loaderOf(makeTemplate);
    const key = 'k';
    const geometryDispose = vi.spyOn(THREE.BufferGeometry.prototype, 'dispose');
    const textureDispose = vi.spyOn(THREE.Texture.prototype, 'dispose');
    const one = await cache.acquire(key, load(key));
    const two = await cache.acquire(key, load(key));
    const oneMaterial = (one.object.children[0] as THREE.Mesh).material as THREE.Material;
    const materialDispose = vi.spyOn(oneMaterial, 'dispose');

    one.release();
    expect(materialDispose).toHaveBeenCalledOnce();
    expect(geometryDispose).not.toHaveBeenCalled();
    expect(textureDispose).not.toHaveBeenCalled();
    expect(cache.refs(key)).toBe(1);

    // Releasing twice is a no-op, not a second decrement.
    one.release();
    expect(cache.refs(key)).toBe(1);

    two.release();
    expect(cache.refs(key)).toBe(0);
    expect(geometryDispose).not.toHaveBeenCalled();
    expect(cache.stats()).toMatchObject({ entries: 1, idle: 1, referenced: 0 });

    expect(cache.clearIdle()).toBe(1);
    expect(geometryDispose).toHaveBeenCalledOnce();
    expect(textureDispose).toHaveBeenCalledOnce();
    expect(cache.stats()).toMatchObject({ entries: 0, evicted: 1 });
  });

  it('bounds the idle set, evicting the least recently used first', async () => {
    const cache = new ModelTemplateCache(2);
    const { load } = loaderOf(makeTemplate);
    const disposed: string[] = [];
    for (const key of ['a', 'b', 'c']) {
      const instance = await cache.acquire(key, load(key));
      const geometry = (instance.object.children[0] as THREE.Mesh).geometry;
      vi.spyOn(geometry, 'dispose').mockImplementation(() => disposed.push(key));
      instance.release();
    }
    expect(cache.stats()).toMatchObject({ entries: 2, idle: 2, evicted: 1 });
    expect(disposed).toEqual(['a']);
    expect(cache.has('a')).toBe(false);
    expect(cache.has('b')).toBe(true);
    expect(cache.has('c')).toBe(true);
  });

  it('never evicts a template that is in use, however many idle ones arrive', async () => {
    const cache = new ModelTemplateCache(1);
    const { load } = loaderOf(makeTemplate);
    const held = await cache.acquire('held', load('held'));
    for (const key of ['a', 'b', 'c']) (await cache.acquire(key, load(key))).release();
    expect(cache.has('held')).toBe(true);
    expect(cache.stats()).toMatchObject({ referenced: 1, idle: 1 });
    held.release();
  });

  it('forgets a failed load so the next acquire fetches again', async () => {
    const cache = new ModelTemplateCache(16);
    let attempts = 0;
    const load = () => {
      attempts += 1;
      return attempts === 1 ? Promise.reject(new Error('offline')) : Promise.resolve(makeTemplate());
    };
    await expect(cache.acquire('k', load)).rejects.toThrow('offline');
    expect(cache.has('k')).toBe(false);
    const instance = await cache.acquire('k', load);
    expect(attempts).toBe(2);
    expect(instance.object).toBeInstanceOf(THREE.Group);
    instance.release();
  });

  it('shares a failure between acquires in flight', async () => {
    const cache = new ModelTemplateCache(16);
    let attempts = 0;
    const load = () => {
      attempts += 1;
      return Promise.reject(new Error('offline'));
    };
    const results = await Promise.allSettled([cache.acquire('k', load), cache.acquire('k', load)]);
    expect(results.map((r) => r.status)).toEqual(['rejected', 'rejected']);
    expect(attempts).toBe(1);
    expect(cache.stats().entries).toBe(0);
  });

  it('invalidates a held template without pulling it from under its holders', async () => {
    const cache = new ModelTemplateCache(16);
    const { calls, load } = loaderOf(makeTemplate);
    const first = await cache.acquire('k', load('k'));
    const geometry = (first.object.children[0] as THREE.Mesh).geometry;
    const geometryDispose = vi.spyOn(geometry, 'dispose');

    cache.invalidate('k');
    expect(cache.has('k')).toBe(false);
    expect(geometryDispose).not.toHaveBeenCalled();

    const second = await cache.acquire('k', load('k'));
    expect(calls).toHaveLength(2);
    expect((second.object.children[0] as THREE.Mesh).geometry).not.toBe(geometry);

    first.release();
    expect(geometryDispose).toHaveBeenCalledOnce();
    second.release();
    expect(cache.stats().entries).toBe(1);
  });

  it('gives a skinned template its own skeleton per instance', async () => {
    const cache = new ModelTemplateCache(16);
    const { load } = loaderOf(makeSkinnedTemplate);
    const one = await cache.acquire('s', load('s'));
    const two = await cache.acquire('s', load('s'));
    const skinnedOf = (root: THREE.Object3D) => root.children[0] as THREE.SkinnedMesh;
    expect(skinnedOf(one.object).skeleton).not.toBe(skinnedOf(two.object).skeleton);
    expect(skinnedOf(one.object).skeleton.bones[0]).not.toBe(skinnedOf(two.object).skeleton.bones[0]);
    // The clone's bones are its own hierarchy, not the template's.
    expect(skinnedOf(one.object).skeleton.bones[0].parent).toBe(skinnedOf(one.object));
    expect(skinnedOf(one.object).geometry).toBe(skinnedOf(two.object).geometry);
    one.release();
    two.release();
  });

  it('refuses a budget that is not a count', () => {
    expect(() => new ModelTemplateCache(-1)).toThrow(RangeError);
    expect(() => new ModelTemplateCache(1.5)).toThrow(RangeError);
  });
});

/** Thirty-two bytes: keyframe times [0, 1], then translations (0,0,0) → (0,10,0). */
function riseBytes(): Uint8Array<ArrayBuffer> {
  return new Uint8Array(new Float32Array([0, 1, 0, 0, 0, 0, 10, 0]).buffer);
}

/** A glTF whose one node has no name, and a clip that lifts it ten units in a second. */
function risingGltf(): string {
  return JSON.stringify({
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{}],
    buffers: [{ uri: 'rise.bin', byteLength: 32 }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: 8 },
      { buffer: 0, byteOffset: 8, byteLength: 24 },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 2, type: 'SCALAR', min: [0], max: [1] },
      { bufferView: 1, componentType: 5126, count: 2, type: 'VEC3' },
    ],
    animations: [
      {
        name: 'rise',
        channels: [{ sampler: 0, target: { node: 0, path: 'translation' } }],
        samplers: [{ input: 0, output: 1, interpolation: 'LINEAR' }],
      },
    ],
  });
}

describe('loadModelTemplate', () => {
  // three names a track after its node, and an unnamed node after its uuid;
  // a clone has a uuid of its own, so the track would bind to nothing.
  it('names an unnamed node so a clip bound on an instance still moves it', async () => {
    stubFetch({
      'https://m.test/rise.gltf': () => risingGltf(),
      'https://m.test/rise.bin': () => riseBytes(),
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cache = new ModelTemplateCache(16);
    const instance = await cache.acquire('rise', () =>
      loadModelTemplate({
        url: 'https://m.test/rise.gltf',
        format: 'gltf',
        policy: { judge: () => ({ allowed: true as const }) },
      })
    );
    const node = instance.object.children[0];
    expect(instance.animations).toHaveLength(1);
    expect(instance.animations[0].tracks[0].name).toBe(`${node.name}.position`);
    expect(node.name).not.toBe(node.uuid);

    const mixer = new THREE.AnimationMixer(instance.object);
    mixer.clipAction(instance.animations[0]).play();
    mixer.update(0.5);
    expect(node.position.y).toBeCloseTo(5, 5);
    expect(warn).not.toHaveBeenCalled();
    instance.release();
  });
});

describe('modelTemplateAddress', () => {
  it('files a bundle model under its archive path, so a fresh object URL finds it again', () => {
    const first = modelTemplateAddress('app', 'blob:https://h/1', 'gltf', 'models/x.gltf');
    const second = modelTemplateAddress('app', 'blob:https://h/2', 'gltf', 'models/x.gltf');
    expect(first).toEqual({ key: 'app|bundle:models/x.gltf|gltf', keepIdle: true });
    expect(second.key).toBe(first.key);
    // Another app's file of the same name is another file.
    expect(modelTemplateAddress('other', 'blob:https://h/3', 'gltf', 'models/x.gltf').key).not.toBe(
      first.key
    );
  });

  it('files everything else under its URL, and keeps no idle template for a blob: URL', () => {
    expect(modelTemplateAddress('app', 'https://m.test/a.glb', 'gltf', undefined)).toEqual({
      key: modelTemplateKey('app', 'https://m.test/a.glb', 'gltf'),
      keepIdle: true,
    });
    expect(modelTemplateAddress('app', 'blob:https://h/4', 'gltf', undefined).keepIdle).toBe(false);
    // No app id to file a path under: the URL it is, and a blob: URL is not kept.
    expect(modelTemplateAddress(undefined, 'blob:https://h/5', 'gltf', 'models/x.gltf')).toEqual({
      key: '_default|blob:https://h/5|gltf',
      keepIdle: false,
    });
  });
});

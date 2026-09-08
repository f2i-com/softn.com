/**
 * Parsed models, shared between the instances that show them.
 *
 * A scene with a hundred crates loaded the crate a hundred times: every
 * object with a `modelUrl` fetched, decoded and uploaded its own copy, and
 * two scenes of the same app did the same again. Decoding is most of a
 * model's startup cost and the geometry and textures are most of its
 * memory, and neither varies between instances.
 *
 * So one load per key produces a TEMPLATE — the object as the loader made
 * it, never placed in a scene — and each instance is a clone of it. What a
 * clone shares and what it owns is fixed here, because the bugs are all in
 * the boundary:
 *
 * - Geometry and textures are shared, owned by the template, disposed only
 *   when the template is evicted. An instance's disposal never touches them.
 * - Materials are cloned per instance, so `applyMaterialOverrides` and
 *   `applyModelAppearance` on one crate cannot recolour another.
 * - Skeletons are cloned per instance (SkeletonUtils), so two animated
 *   figures do not share bones and play each other's clips.
 * - Clips are shared: a mixer binds them to its own root.
 *
 * Templates are reference counted by their instances. One with no
 * instances left stays for reuse — a tab closed and reopened gets its model
 * back — up to `maxIdle` idle templates across the page, least recently
 * used first out. A template in use is never evicted. Concurrent acquires
 * of one key share the one load in flight; a failed load is forgotten so
 * the next acquire (a retry) fetches again.
 *
 * The key carries the app id, so two apps that happen to name the same URL
 * do not hand each other their models — the same isolation rule as their
 * stores. A bundle model is keyed by its archive path rather than the
 * object URL the host minted for it, and a template that could only ever
 * be named by an object URL is not kept once idle: see
 * `modelTemplateAddress`.
 */

import * as THREE from 'three';
import { importSkeletonUtils, type ModelTemplate } from './model-loaders';

/** What an object in a scene holds: its own clone, and a lease on the template. */
export interface ModelInstance {
  object: THREE.Object3D;
  animations: THREE.AnimationClip[];
  key: string;
  /** Give the instance back. Its materials and skeletons go; the template's geometry and textures stay. */
  release(): void;
}

interface Entry {
  key: string;
  promise: Promise<ModelTemplate>;
  template: ModelTemplate | null;
  /** Instances alive plus acquires in flight. */
  refs: number;
  /** No longer in the map: invalidated or failed. Disposed when the last holder lets go. */
  dropped: boolean;
  /** Whether the template stays for reuse once idle, or goes with its last holder. */
  keepIdle: boolean;
}

export interface AcquireOptions {
  /**
   * False when nothing can name this key again once its holders are gone,
   * so an idle template would be dead weight. Decided by the first acquire
   * of a key; later ones share what it made.
   */
  keepIdle?: boolean;
}

export interface ModelTemplateCacheStats {
  entries: number;
  referenced: number;
  idle: number;
  maxIdle: number;
  evicted: number;
  /** Loads started, over the life of the cache: a dedupe check for tests. */
  loads: number;
}

export function modelTemplateKey(appId: string | undefined, url: string, format: string): string {
  return `${appId ?? '_default'}|${url}|${format}`;
}

export interface ModelTemplateAddress {
  key: string;
  keepIdle: boolean;
}

/**
 * Where a model's template is filed, and whether it may stay once idle.
 *
 * A host hands a bundle model to the scene as an object URL it minted for
 * this open of the app, and revokes it when the app closes; the next open
 * mints a fresh one. A template filed under that URL is found again by no
 * one — up to `maxIdle` dead models would sit decoded in the heap — so a
 * bundle model is filed under its archive path instead, which names the
 * same bytes for as long as the app id does (softn-web's app id is the
 * bundle's digest), and a tab closed and reopened finds its model. That
 * needs an app id to file under. With none, or with a URL the resolver
 * cannot map to a path, the template is filed under the URL, and a `blob:`
 * URL so filed is not kept once idle: the cache cannot see it revoked, and
 * nothing will name it again.
 */
export function modelTemplateAddress(
  appId: string | undefined,
  url: string,
  format: string,
  bundlePath: string | undefined
): ModelTemplateAddress {
  if (appId !== undefined && bundlePath !== undefined) {
    return { key: `${appId}|bundle:${bundlePath}|${format}`, keepIdle: true };
  }
  return { key: modelTemplateKey(appId, url, format), keepIdle: !/^blob:/i.test(url) };
}

function eachMaterial(node: THREE.Object3D, fn: (material: THREE.Material) => void): void {
  const holder = node as THREE.Mesh;
  if (!holder.isMesh && !(node as THREE.Points).isPoints && !(node as THREE.Line).isLine) return;
  const materials = Array.isArray(holder.material) ? holder.material : [holder.material];
  for (const material of materials) if (material) fn(material);
}

/** Every texture a material holds, whatever slot it sits in. */
function eachTexture(material: THREE.Material, fn: (texture: THREE.Texture) => void): void {
  for (const value of Object.values(material)) {
    if (value && (value as THREE.Texture).isTexture) fn(value as THREE.Texture);
  }
}

/** The template's own resources: everything the loader made. */
function disposeTemplate(root: THREE.Object3D): void {
  root.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (mesh.geometry && typeof mesh.geometry.dispose === 'function') mesh.geometry.dispose();
    eachMaterial(node, (material) => {
      eachTexture(material, (texture) => texture.dispose());
      material.dispose();
    });
    const skinned = node as THREE.SkinnedMesh;
    if (skinned.isSkinnedMesh && skinned.skeleton) skinned.skeleton.dispose();
  });
}

/** An instance's own resources: its material clones and its skeletons, nothing shared. */
function disposeInstance(root: THREE.Object3D): void {
  root.traverse((node) => {
    eachMaterial(node, (material) => material.dispose());
    const skinned = node as THREE.SkinnedMesh;
    if (skinned.isSkinnedMesh && skinned.skeleton) skinned.skeleton.dispose();
  });
}

/**
 * A clone that owns its materials and, when it has bones, its skeleton.
 * SkeletonUtils is fetched only for a skinned template: an Object3D clone
 * already shares geometry and rebinds nothing, which is exactly right for a
 * model without bones.
 */
async function instantiate(source: THREE.Object3D): Promise<THREE.Object3D> {
  let skinned = false;
  source.traverse((node) => {
    if ((node as THREE.SkinnedMesh).isSkinnedMesh) skinned = true;
  });
  const clone = skinned ? (await importSkeletonUtils()).clone(source) : source.clone();
  clone.traverse((node) => {
    const holder = node as THREE.Mesh;
    if (!holder.isMesh && !(node as THREE.Points).isPoints && !(node as THREE.Line).isLine) return;
    holder.material = Array.isArray(holder.material)
      ? holder.material.map((material) => material.clone())
      : holder.material.clone();
  });
  return clone;
}

export class ModelTemplateCache {
  /** Insertion order is recency: the last entry is the most recently used. */
  private readonly entries = new Map<string, Entry>();
  private evicted = 0;
  private loads = 0;

  constructor(private readonly maxIdle: number) {
    if (!Number.isInteger(maxIdle) || maxIdle < 0) {
      throw new RangeError(`maxIdle must be a non-negative integer, not ${maxIdle}`);
    }
  }

  /**
   * An instance of the template for `key`, loading it with `load` if no
   * one has yet. Counted against the template from this call on, so an
   * acquire in flight holds the template as surely as an instance does.
   */
  async acquire(
    key: string,
    load: () => Promise<ModelTemplate>,
    options: AcquireOptions = {}
  ): Promise<ModelInstance> {
    let entry = this.entries.get(key);
    if (!entry) {
      this.loads += 1;
      const fresh: Entry = {
        key,
        promise: null as never,
        template: null,
        refs: 0,
        dropped: false,
        keepIdle: options.keepIdle !== false,
      };
      fresh.promise = load().then(
        (template) => {
          fresh.template = template;
          return template;
        },
        (err: unknown) => {
          this.drop(fresh);
          throw err;
        }
      );
      this.entries.set(key, fresh);
      entry = fresh;
    }
    entry.refs += 1;
    this.touch(entry);

    let template: ModelTemplate;
    let object: THREE.Object3D;
    try {
      template = await entry.promise;
      object = await instantiate(template.object);
    } catch (err) {
      this.releaseEntry(entry);
      throw err;
    }

    const held = entry;
    let released = false;
    return {
      object,
      animations: template.animations,
      key,
      release: () => {
        if (released) return;
        released = true;
        disposeInstance(object);
        this.releaseEntry(held);
      },
    };
  }

  /**
   * Forget the template for `key` so the next acquire loads afresh — a
   * retry, or a file that changed at the same URL. Instances already
   * holding it keep it; it is disposed when the last of them is released.
   */
  invalidate(key: string): void {
    const entry = this.entries.get(key);
    if (entry) this.drop(entry);
  }

  has(key: string): boolean {
    return this.entries.has(key);
  }

  /** How many holders a key has; 0 when idle, -1 when absent. */
  refs(key: string): number {
    const entry = this.entries.get(key);
    return entry ? entry.refs : -1;
  }

  stats(): ModelTemplateCacheStats {
    let referenced = 0;
    for (const entry of this.entries.values()) if (entry.refs > 0) referenced += 1;
    return {
      entries: this.entries.size,
      referenced,
      idle: this.entries.size - referenced,
      maxIdle: this.maxIdle,
      evicted: this.evicted,
      loads: this.loads,
    };
  }

  /** Dispose every idle template now. Templates in use stay. */
  clearIdle(): number {
    let dropped = 0;
    for (const [key, entry] of [...this.entries]) {
      if (entry.refs > 0) continue;
      this.entries.delete(key);
      this.disposeEntry(entry);
      dropped += 1;
    }
    this.evicted += dropped;
    return dropped;
  }

  private drop(entry: Entry): void {
    if (this.entries.get(entry.key) === entry) this.entries.delete(entry.key);
    entry.dropped = true;
    if (entry.refs === 0) this.disposeEntry(entry);
  }

  private releaseEntry(entry: Entry): void {
    if (entry.refs === 0) return;
    entry.refs -= 1;
    if (entry.refs > 0) return;
    // Already out of the map, or never worth keeping idle: it goes with its
    // last holder rather than taking a slot nothing will ever hit.
    if (entry.dropped || !entry.keepIdle) {
      this.drop(entry);
      return;
    }
    this.touch(entry);
    this.trimIdle();
  }

  private disposeEntry(entry: Entry): void {
    const template = entry.template;
    entry.template = null;
    if (template) disposeTemplate(template.object);
  }

  private touch(entry: Entry): void {
    if (this.entries.get(entry.key) !== entry) return;
    this.entries.delete(entry.key);
    this.entries.set(entry.key, entry);
  }

  private trimIdle(): void {
    let idle = 0;
    for (const entry of this.entries.values()) if (entry.refs === 0) idle += 1;
    if (idle <= this.maxIdle) return;
    for (const [key, entry] of this.entries) {
      if (entry.refs > 0) continue;
      this.entries.delete(key);
      this.disposeEntry(entry);
      this.evicted += 1;
      idle -= 1;
      if (idle <= this.maxIdle) return;
    }
  }
}

/**
 * Sixteen idle templates: a count rather than a byte estimate, because a
 * glTF's real cost is on the GPU where nothing here can measure it, and a
 * count is at least honest. Sixteen keeps every model of a typical app
 * between its tabs and drops the rest of a page that has opened many.
 */
export const MODEL_TEMPLATE_IDLE_BUDGET = 16;
export const modelTemplateCache = new ModelTemplateCache(MODEL_TEMPLATE_IDLE_BUDGET);

/** Cache counts, for a development inspector. Not for apps. */
export function modelTemplateCacheStats(): ModelTemplateCacheStats {
  return modelTemplateCache.stats();
}

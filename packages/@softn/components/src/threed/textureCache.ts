/**
 * A bounded, reference-counted cache for textures that scenes share.
 *
 * Scene3D generates procedural textures — brick, grass, a bullet hole — from
 * a type, a colour and a repeat, and caches them so a hundred bricks share
 * one canvas. The cache was a bare Map that only ever grew: every distinct
 * combination a page ever asked for stayed in memory, on the GPU as well as
 * in JS, for the life of the page, and a scene that varied colours freely
 * could retain hundreds of canvases and their uploads.
 *
 * Two facts have to hold at once. A texture a live material is using must not
 * be disposed under it — a black mesh, or a use-after-dispose re-upload on
 * the next frame. And a texture nothing is using must not be kept for ever.
 * So each entry counts its users: `acquire` when a material takes the
 * texture, `release` when that material is disposed. Referenced entries are
 * never evicted, whatever the budget. Unreferenced ones are kept for reuse
 * up to `maxIdle`, least recently used first out.
 *
 * Generic over anything with `dispose()` so it can be exercised without a
 * renderer.
 */

export interface Disposable {
  dispose(): void;
}

interface Entry<T> {
  value: T;
  refs: number;
}

export interface TextureCacheStats {
  /** Entries in the cache, referenced or not. */
  entries: number;
  /** Entries some live material is using. */
  referenced: number;
  /** Entries kept for reuse; at most `maxIdle` after any release. */
  idle: number;
  maxIdle: number;
  /** Entries disposed by eviction since the cache was made. */
  evicted: number;
}

export class BoundedTextureCache<T extends Disposable> {
  /** Insertion order is recency: the last entry is the most recently used. */
  private readonly entries = new Map<string, Entry<T>>();
  private evicted = 0;

  constructor(private readonly maxIdle: number) {
    if (!Number.isInteger(maxIdle) || maxIdle < 0) throw new RangeError(`maxIdle must be a non-negative integer, not ${maxIdle}`);
  }

  /**
   * The texture for `key`, made by `make` if it is not cached, counted as in
   * use by the caller until the matching `release`. `make` may return null
   * (no document, no 2D context), in which case nothing is cached.
   */
  acquire(key: string, make: () => T | null): T | null {
    const hit = this.entries.get(key);
    if (hit) {
      hit.refs += 1;
      this.touch(key, hit);
      return hit.value;
    }
    const value = make();
    if (value === null) return null;
    this.entries.set(key, { value, refs: 1 });
    return value;
  }

  /**
   * One user fewer. When the last one goes the entry becomes idle, and if
   * more entries are idle than the budget allows, the least recently used
   * idle entries are disposed. Releasing a key that is not cached, or more
   * times than it was acquired, is ignored: a disposal path that runs twice
   * must not evict a texture someone else still holds.
   */
  release(key: string): void {
    const entry = this.entries.get(key);
    if (!entry || entry.refs === 0) return;
    entry.refs -= 1;
    if (entry.refs === 0) {
      this.touch(key, entry);
      this.trimIdle();
    }
  }

  has(key: string): boolean {
    return this.entries.has(key);
  }

  /** How many live users a key has; 0 when idle, -1 when absent. */
  refs(key: string): number {
    const entry = this.entries.get(key);
    return entry ? entry.refs : -1;
  }

  stats(): TextureCacheStats {
    let referenced = 0;
    for (const entry of this.entries.values()) if (entry.refs > 0) referenced += 1;
    return {
      entries: this.entries.size,
      referenced,
      idle: this.entries.size - referenced,
      maxIdle: this.maxIdle,
      evicted: this.evicted,
    };
  }

  /** Dispose every idle entry now. Referenced entries stay. */
  clearIdle(): number {
    let dropped = 0;
    for (const [key, entry] of [...this.entries]) {
      if (entry.refs > 0) continue;
      this.entries.delete(key);
      entry.value.dispose();
      dropped += 1;
    }
    this.evicted += dropped;
    return dropped;
  }

  private touch(key: string, entry: Entry<T>): void {
    this.entries.delete(key);
    this.entries.set(key, entry);
  }

  private trimIdle(): void {
    let idle = 0;
    for (const entry of this.entries.values()) if (entry.refs === 0) idle += 1;
    if (idle <= this.maxIdle) return;
    for (const [key, entry] of this.entries) {
      if (entry.refs > 0) continue;
      this.entries.delete(key);
      entry.value.dispose();
      this.evicted += 1;
      idle -= 1;
      if (idle <= this.maxIdle) return;
    }
  }
}

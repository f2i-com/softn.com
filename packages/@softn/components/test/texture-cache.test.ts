/**
 * The procedural texture cache: shared while used, bounded when not.
 *
 * What is pinned: a texture a live material holds is never disposed under
 * it; idle textures are kept for reuse up to the budget and then the least
 * recently used go; a disposal path that runs twice cannot evict someone
 * else's texture; and repeated open/close of scenes settles within the
 * budget rather than growing.
 */

import { describe, expect, it } from 'vitest';
import { BoundedTextureCache } from '../src/threed/textureCache';

class FakeTexture {
  disposed = 0;
  constructor(public readonly key: string) {}
  dispose(): void {
    this.disposed += 1;
  }
}

function cache(maxIdle: number) {
  const made: FakeTexture[] = [];
  const c = new BoundedTextureCache<FakeTexture>(maxIdle);
  const get = (key: string) =>
    c.acquire(key, () => {
      const t = new FakeTexture(key);
      made.push(t);
      return t;
    });
  return { c, get, made };
}

describe('BoundedTextureCache', () => {
  it('shares one texture between users of the same key', () => {
    const { c, get, made } = cache(4);
    const a = get('brick_#f00_1_1');
    const b = get('brick_#f00_1_1');
    expect(a).toBe(b);
    expect(made.length).toBe(1);
    expect(c.refs('brick_#f00_1_1')).toBe(2);
  });

  it('never disposes a texture a live material still holds', () => {
    const { c, get, made } = cache(0);
    get('live');
    for (let i = 0; i < 10; i++) {
      get(`idle-${i}`);
      c.release(`idle-${i}`);
    }
    expect(made[0].disposed).toBe(0);
    expect(c.has('live')).toBe(true);
    expect(c.stats().referenced).toBe(1);
    expect(c.stats().idle).toBe(0);
  });

  it('keeps idle textures up to the budget and evicts the least recently used past it', () => {
    const { c, get, made } = cache(2);
    for (const key of ['a', 'b', 'c']) {
      get(key);
      c.release(key);
    }
    // a was released first, so it goes; b and c stay.
    expect(made.map((t) => `${t.key}:${t.disposed}`)).toEqual(['a:1', 'b:0', 'c:0']);
    expect(c.has('a')).toBe(false);
    expect(c.stats()).toMatchObject({ entries: 2, idle: 2, evicted: 1 });

    // Reusing b makes it recent; the next eviction takes c.
    get('b');
    c.release('b');
    get('d');
    c.release('d');
    expect(c.has('c')).toBe(false);
    expect(c.has('b')).toBe(true);
    expect(c.has('d')).toBe(true);
  });

  it('is unmoved by a release it was not owed', () => {
    const { c, get, made } = cache(0);
    get('x');
    c.release('x');
    c.release('x');
    c.release('never-acquired');
    expect(made[0].disposed).toBe(1);
    // Acquired again after eviction: a fresh texture, not the disposed one.
    const again = get('x')!;
    expect(again).not.toBe(made[0]);
    expect(c.refs('x')).toBe(1);
    // A second user, then one double release from the first, must not free it for the second.
    get('x');
    c.release('x');
    c.release('x');
    c.release('x');
    expect(again.disposed).toBe(1);
    expect(c.has('x')).toBe(false);
  });

  it('settles within the budget across repeated scenes with unique materials', () => {
    const { c, get, made } = cache(8);
    for (let scene = 0; scene < 20; scene++) {
      const keys = Array.from({ length: 30 }, (_, i) => `scene${scene}-mat${i}`);
      for (const key of keys) get(key);
      expect(c.stats().referenced).toBe(30);
      for (const key of keys) c.release(key);
      expect(c.stats().idle).toBeLessThanOrEqual(8);
      expect(c.stats().entries).toBeLessThanOrEqual(8);
    }
    const alive = made.filter((t) => t.disposed === 0).length;
    expect(alive).toBeLessThanOrEqual(8);
    expect(c.stats().evicted).toBe(made.length - alive);
  });

  it('caches nothing when the maker has nothing to give', () => {
    const c = new BoundedTextureCache<FakeTexture>(4);
    expect(c.acquire('k', () => null)).toBeNull();
    expect(c.has('k')).toBe(false);
  });

  it('can be emptied of idle entries on request', () => {
    const { c, get, made } = cache(10);
    get('held');
    get('a');
    get('b');
    c.release('a');
    c.release('b');
    expect(c.clearIdle()).toBe(2);
    expect(c.has('held')).toBe(true);
    expect(made.filter((t) => t.disposed).map((t) => t.key).sort()).toEqual(['a', 'b']);
  });
});

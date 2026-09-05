/**
 * Boundary repairs from the September 2026 engineering audit, pinned in
 * isolation: the render-cache key, the host-bound sync identity, the
 * retryable engine start, the ordered event coalescer and the one egress
 * evaluator. Each of these is a small pure module precisely so that its
 * contract can be stated here without a VM, a worker or a browser.
 */

import { describe, it, expect, vi } from 'vitest';
import { buildSyncCacheKey } from '../src/runtime/sync-cache-key';
import { bindSyncOptions } from '../src/runtime/host-bound-sync-options';
import { retryableSingleFlight } from '../src/runtime/retryable-single-flight';
import { EventCoalescer, coalescePolicyFor, type FrameScheduler } from '../src/runtime/event-coalescer';
import {
  describeHostAllowlist,
  describeMarkupEgress,
  describeNetDestination,
  describeSocketDestination,
  describeSrcSetEgress,
  filterSignalingUrls,
} from '../src/runtime/egress-policy';

describe('the render cache key', () => {
  it('keeps distinct primitive tuples distinct', () => {
    // Every one of these collapsed onto a neighbour under the old key: the
    // signed zero through String(), the rest through JSON.stringify.
    const values: unknown[][] = [
      [0],
      [-0],
      [null, 1],
      [undefined, 1],
      [NaN, 1],
      [Infinity, 1],
      [1n, 1],
      ['1', 1],
      [1, '1'],
      ['a', 'b'],
      ['ab', ''],
    ];
    const keys = values.map((args) => buildSyncCacheKey('f', args));
    expect(keys.every((k) => k !== null)).toBe(true);
    expect(new Set(keys).size).toBe(values.length);
  });

  it('cannot be forged by an argument that contains the separator', () => {
    expect(buildSyncCacheKey('f', ['1|2'])).not.toBe(buildSyncCacheKey('f', ['1', '2']));
    expect(buildSyncCacheKey('f', ['a:b'])).not.toBe(buildSyncCacheKey('f', ['a', 'b']));
  });

  it('keys the name as well as the arguments', () => {
    expect(buildSyncCacheKey('f', [1])).not.toBe(buildSyncCacheKey('g', [1]));
    expect(buildSyncCacheKey('f', [])).not.toBe(buildSyncCacheKey('g', []));
  });

  it('declines to describe a reference value rather than serialising it', () => {
    let visits = 0;
    expect(
      buildSyncCacheKey('f', [
        {
          toJSON() {
            visits++;
            return 1;
          },
        },
      ])
    ).toBeNull();
    expect(visits).toBe(0);
    expect(buildSyncCacheKey('f', [[1, 2, 3]])).toBeNull();
    expect(buildSyncCacheKey('f', [1, () => 2])).toBeNull();
  });

  it('bounds the key rather than growing without limit', () => {
    expect(buildSyncCacheKey('f', ['x'.repeat(70_000)])).toBeNull();
    expect(buildSyncCacheKey('f', new Array(65).fill(1))).toBeNull();
  });
});

describe('host-bound sync options', () => {
  it('lets the host name the app and the room, whatever the options say', () => {
    expect(bindSyncOptions('room', { appId: 'requested', room: 'ignored' }, 'host')).toEqual({
      appId: 'host',
      room: 'room',
    });
  });

  it('does not let a host with no identity acquire one from the guest', () => {
    expect(bindSyncOptions('room', { appId: 'requested' }, undefined)).toEqual({ room: 'room' });
    expect(bindSyncOptions('room', { appId: 'requested' }, '')).toEqual({ room: 'room' });
  });

  it('keeps every other option and leaves the input alone', () => {
    const options = Object.freeze({ displayName: 'Ann', persist: false });
    expect(bindSyncOptions('r', options, 'app')).toEqual({
      displayName: 'Ann',
      persist: false,
      room: 'r',
      appId: 'app',
    });
    expect(bindSyncOptions('r', undefined, 'app')).toEqual({ room: 'r', appId: 'app' });
  });
});

describe('retryable single flight', () => {
  it('shares one attempt between concurrent callers', async () => {
    let attempts = 0;
    const start = retryableSingleFlight(async () => {
      attempts++;
      return 'ready';
    });
    await expect(Promise.all([start(), start(), start()])).resolves.toEqual([
      'ready',
      'ready',
      'ready',
    ]);
    expect(attempts).toBe(1);
    await start();
    expect(attempts).toBe(1);
  });

  it('forgets a failed attempt so the next caller can try again', async () => {
    let attempts = 0;
    const start = retryableSingleFlight(() => {
      if (++attempts === 1) throw new Error('fixture');
      return 1;
    });
    await expect(start()).rejects.toThrow('fixture');
    await expect(start()).resolves.toBe(1);
    expect(attempts).toBe(2);
  });

  it('does not let a late rejection discard a retry already under way', async () => {
    let resolveFirst!: (v: number) => void;
    let rejectFirst!: (e: Error) => void;
    let calls = 0;
    const start = retryableSingleFlight(
      () =>
        new Promise<number>((resolve, reject) => {
          calls++;
          if (calls === 1) {
            resolveFirst = resolve;
            rejectFirst = reject;
          } else {
            resolve(2);
          }
        })
    );
    const first = start();
    // The initializer runs on a microtask, so its resolvers exist after one.
    await Promise.resolve();
    rejectFirst(new Error('late'));
    await expect(first).rejects.toThrow('late');
    const second = start();
    // The first attempt's promise is already settled; nothing more it does
    // may touch the cache the second attempt now occupies.
    resolveFirst(1);
    await expect(second).resolves.toBe(2);
    await expect(start()).resolves.toBe(2);
    expect(calls).toBe(2);
  });
});

/** A frame scheduler the test drives by hand. */
function manualFrames(): FrameScheduler & { fire(): void; pending(): number } {
  const callbacks = new Map<number, () => void>();
  let next = 1;
  return {
    request(cb) {
      const id = next++;
      callbacks.set(id, cb);
      return id;
    },
    cancel(id) {
      callbacks.delete(id);
    },
    fire() {
      const due = Array.from(callbacks.values());
      callbacks.clear();
      for (const cb of due) cb();
    },
    pending() {
      return callbacks.size;
    },
  };
}

describe('the event coalescer', () => {
  it('names a policy for the high-frequency events and none for the rest', () => {
    expect(coalescePolicyFor('pointermove')).toBe('accumulate');
    expect(coalescePolicyFor('wheel')).toBe('accumulate');
    expect(coalescePolicyFor('resize')).toBe('latest');
    expect(coalescePolicyFor('keydown')).toBeNull();
    expect(coalescePolicyFor('click')).toBeNull();
  });

  it('never delivers an older sample after a newer one', () => {
    // The old throttle parked an early event in a frame and delivered a
    // later one immediately, so the parked, older one landed last.
    const frames = manualFrames();
    let now = 0;
    const delivered: number[] = [];
    const c = new EventCoalescer('latest', (p) => delivered.push(p.x as number), frames, () => now);
    c.push({ x: 1 }); // delivered at once: nothing recent
    now = 5;
    c.push({ x: 2 }); // inside the window: parked
    now = 30;
    c.push({ x: 3 }); // outside the window, but something is parked: joins it
    expect(delivered).toEqual([1]);
    frames.fire();
    expect(delivered).toEqual([1, 3]);
  });

  it('sums the relative parts of accumulated samples and keeps the newest of the rest', () => {
    const frames = manualFrames();
    let now = 0;
    const delivered: Record<string, unknown>[] = [];
    const c = new EventCoalescer('accumulate', (p) => delivered.push(p), frames, () => now);
    c.push({ deltaY: 100, clientX: 1 });
    now = 4;
    c.push({ deltaY: 100, movementX: 2, clientX: 2 });
    now = 8;
    c.push({ deltaY: -50, movementX: 3, clientX: 3 });
    frames.fire();
    expect(delivered).toEqual([
      { deltaY: 100, clientX: 1 },
      { deltaY: 50, movementX: 5, clientX: 3 },
    ]);
  });

  it('replaces rather than sums under the latest policy', () => {
    const frames = manualFrames();
    let now = 0;
    const delivered: Record<string, unknown>[] = [];
    const c = new EventCoalescer('latest', (p) => delivered.push(p), frames, () => now);
    c.push({ width: 100 });
    now = 4;
    c.push({ width: 200 });
    now = 8;
    c.push({ width: 300 });
    frames.fire();
    expect(delivered).toEqual([{ width: 100 }, { width: 300 }]);
  });

  it('cancels its frame on disposal and delivers nothing afterwards', () => {
    const frames = manualFrames();
    let now = 0;
    const deliver = vi.fn();
    const c = new EventCoalescer('latest', deliver, frames, () => now);
    c.push({ x: 1 });
    now = 4;
    c.push({ x: 2 });
    expect(frames.pending()).toBe(1);
    c.dispose();
    expect(frames.pending()).toBe(0);
    frames.fire();
    c.push({ x: 3 });
    expect(deliver).toHaveBeenCalledTimes(1);
  });
});

describe('the egress evaluator', () => {
  const scoped = { enabled: true, allowed_hosts: ['api.example'] };

  it('judges a destination by scheme, http and host list', () => {
    expect(describeNetDestination('https://api.example/x', scoped).allowed).toBe(true);
    expect(describeNetDestination('https://other.example/x', scoped).allowed).toBe(false);
    expect(describeNetDestination('http://api.example/x', scoped).allowed).toBe(false);
    expect(
      describeNetDestination('http://api.example/x', { ...scoped, allow_http: true }).allowed
    ).toBe(true);
    expect(describeNetDestination('file:///etc/passwd', undefined).allowed).toBe(false);
    expect(describeNetDestination('javascript:alert(1)', undefined).allowed).toBe(false);
    expect(describeNetDestination('not a url', undefined).allowed).toBe(false);
    expect(describeNetDestination('https://anything.example/x', { enabled: true }).allowed).toBe(true);
  });

  it('holds a socket to the same rule as a fetch', () => {
    expect(describeSocketDestination('wss://api.example/sync', scoped).allowed).toBe(true);
    expect(describeSocketDestination('wss://other.example/sync', scoped).allowed).toBe(false);
    expect(describeSocketDestination('ws://api.example/sync', scoped).allowed).toBe(false);
  });

  it('applies only the host list where the scheme is policed elsewhere', () => {
    expect(describeHostAllowlist('ws://localhost:3000/sync', { enabled: true }).allowed).toBe(true);
    expect(describeHostAllowlist('ws://localhost:3000/sync', scoped).allowed).toBe(false);
    expect(describeHostAllowlist('wss://api.example/sync', scoped).allowed).toBe(true);
  });

  it('lets markup that is not egress through with no capability at all', () => {
    for (const url of ['logo.png', '/x.png', 'data:image/png;base64,AAAA', 'blob:local/x', '#top']) {
      expect(describeMarkupEgress(url, { permissions: {} }).allowed).toBe(true);
    }
  });

  it('withholds remote markup while consent is pending, and enforces net after it', () => {
    const url = 'https://cdn.example/x.png';
    expect(describeMarkupEgress(url, { consentPending: true, permissions: {} }).allowed).toBe(false);
    expect(describeMarkupEgress(url, { permissions: {} }).allowed).toBe(false);
    expect(describeMarkupEgress(url, { permissions: { net: { enabled: true } } }).allowed).toBe(true);
    expect(describeMarkupEgress(url, { permissions: { net: scoped } }).allowed).toBe(false);
    expect(describeMarkupEgress('https://api.example/x.png', { permissions: { net: scoped } }).allowed).toBe(true);
  });

  it('judges a protocol-relative URL by the host and the scheme of the page', () => {
    // `//host/x` takes the page's scheme; under jsdom that is http, so the
    // host list alone is not enough and `allow_http` decides.
    const scopedHttp = { ...scoped, allow_http: true };
    expect(describeMarkupEgress('//api.example/x.png', { permissions: { net: scopedHttp } }).allowed).toBe(true);
    expect(describeMarkupEgress('//other.example/x.png', { permissions: { net: scopedHttp } }).allowed).toBe(false);
  });

  it('does not enforce when no host has published a config', () => {
    expect(describeMarkupEgress('https://cdn.example/x.png', null).allowed).toBe(true);
    expect(describeMarkupEgress('https://cdn.example/x.png', undefined).allowed).toBe(true);
  });

  it('holds a script-chosen signalling server to the same rule', () => {
    const urls = ['wss://api.example/signal', 'wss://attacker.example/signal', 'ws://api.example/signal'];
    const scopedNet = { permissions: { net: scoped } };
    expect(filterSignalingUrls(urls, scopedNet).allowed).toEqual(['wss://api.example/signal']);
    expect(filterSignalingUrls(urls, scopedNet).refused).toHaveLength(2);
    // No net at all: nothing the script names is reached, whatever the host.
    expect(filterSignalingUrls(urls, { permissions: {} }).allowed).toEqual([]);
    expect(filterSignalingUrls(urls, { consentPending: true, permissions: {} }).allowed).toEqual([]);
    // No host enforcing: the list is the script's to choose.
    expect(filterSignalingUrls(urls, null).allowed).toEqual(urls);
    expect(filterSignalingUrls('not a list', scopedNet).allowed).toEqual([]);
  });

  it('judges every candidate of a srcset', () => {
    const config = { permissions: { net: scoped } };
    expect(describeSrcSetEgress('a.png 1x, https://api.example/b.png 2x', config).allowed).toBe(true);
    expect(describeSrcSetEgress('a.png 1x, https://other.example/b.png 2x', config).allowed).toBe(false);
  });
});

/**
 * What an update asks for that the build before it did not.
 */

import { describe, expect, it } from 'vitest';
import { diffCapabilities, previousBuildFor } from '../src/lib/consentDiff';
import type { CachedApp } from '../src/lib/appCache';

function cached(over: Partial<CachedApp>): CachedApp {
  return { id: 'x', name: 'Notes', version: '1.0.0', bundleData: new Uint8Array(), cachedAt: 0, lastOpened: 0, ...over };
}

describe('diffCapabilities', () => {
  it('names what was added and what was dropped', () => {
    expect(diffCapabilities(['net', 'files'], ['net'])).toEqual({ added: ['files'], removed: [] });
    expect(diffCapabilities(['net'], ['net', 'camera'])).toEqual({ added: [], removed: ['camera'] });
    expect(diffCapabilities(['net'], ['net'])).toEqual({ added: [], removed: [] });
    expect(diffCapabilities([], ['net'])).toEqual({ added: [], removed: ['net'] });
    expect(diffCapabilities(['camera', 'mic'], [])).toEqual({ added: ['camera', 'mic'], removed: [] });
  });
});

describe('previousBuildFor', () => {
  it('is the most recently opened other build with the same name', () => {
    const apps = [
      cached({ id: 'a', origin: 'A', version: '1.0.0', lastOpened: 10 }),
      cached({ id: 'b', origin: 'B', version: '1.1.0', lastOpened: 20 }),
      cached({ id: 'c', origin: 'C', version: '2.0.0', lastOpened: 30 }),
      cached({ id: 'z', name: 'Other', origin: 'Z', version: '9', lastOpened: 99 }),
    ];
    expect(previousBuildFor(apps, 'Notes', 'C')?.id).toBe('b');
    expect(previousBuildFor(apps, 'Notes', 'B')?.id).toBe('c');
    expect(previousBuildFor(apps, 'Notes', 'new')?.id).toBe('c');
  });

  it('is nothing for a first build, or where the only same-name record has no identity', () => {
    expect(previousBuildFor([cached({ id: 'a', origin: 'A' })], 'Notes', 'A')).toBeNull();
    expect(previousBuildFor([cached({ id: 'legacy' })], 'Notes', 'A')).toBeNull();
    expect(previousBuildFor([], 'Notes', 'A')).toBeNull();
  });
});

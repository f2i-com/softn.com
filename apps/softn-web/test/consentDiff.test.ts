/**
 * What an update asks for that the build before it did not.
 */

import { describe, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { describePreviousBuild, diffCapabilities, previousBuildFor } from '../src/lib/consentDiff';
import type { CachedApp } from '../src/lib/appCache';

/** A bundle declaring `permissions` in its permission.json. */
function bundleDeclaring(permissions: unknown): Uint8Array {
  return zipSync({
    'manifest.json': strToU8(JSON.stringify({ name: 'Weather', version: '1.0.0', main: 'ui/main.ui' })),
    'permission.json': strToU8(JSON.stringify({ permissions })),
    'ui/main.ui': strToU8('<App/>'),
  });
}

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

// The bar said "The same as v1." of any update asking for the same capabilities, whatever
// each covered: a v2 that dropped v1's host list reaches any host.
describe('describePreviousBuild', () => {
  const v1 = cached({ bundleData: bundleDeclaring({ net: { enabled: true, allowed_hosts: ['api.weather.gov'] } }) });

  it('is the same declaration only when it declares the same', () => {
    expect(describePreviousBuild(v1, { permissions: { net: { enabled: true, allowed_hosts: ['api.weather.gov'] } } })).toEqual({
      version: '1.0.0',
      capabilities: ['net'],
      sameDeclaration: true,
    });
    expect(describePreviousBuild(v1, { permissions: { net: { enabled: true } } })).toMatchObject({ capabilities: ['net'], sameDeclaration: false });
  });

  it('does not say either way of a build it cannot read', () => {
    expect(describePreviousBuild(cached({ bundleData: strToU8('not a zip'), requestedCapabilities: ['net'] }), { permissions: { net: { enabled: true } } }))
      .toEqual({ version: '1.0.0', capabilities: ['net'], sameDeclaration: undefined });
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

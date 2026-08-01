/**
 * Permission handling.
 *
 * Both of these made a bundle *more* privileged than the author declared, and
 * neither produced any visible sign of it.
 */

import { describe, it, expect } from 'vitest';
import { extractPermissions, requestedCapabilities } from '../src/lib/bundleProcessor';
import type { BundleManifest } from '../src/lib/bundleProcessor';

const manifest = { name: 'T', version: '1.0.0', main: 'ui/main.ui' } as unknown as BundleManifest;

function files(permissionJson?: string): Map<string, string> {
  const m = new Map<string, string>();
  if (permissionJson !== undefined) m.set('permission.json', permissionJson);
  return m;
}

describe('a permission.json that does not parse', () => {
  it('denies rather than falling back to allow-everything', () => {
    // A null config means "no permission.json at all", which the runtime treats
    // as a legacy bundle and allows everything — so a trailing comma granted
    // strictly more than valid JSON declaring nothing.
    const config = extractPermissions(files('{ "permissions": { "net": { "enabled": true }, }'), manifest);

    expect(config).not.toBeNull();
    expect(requestedCapabilities(config!)).toEqual([]);
  });

  it('reads a valid file normally', () => {
    const config = extractPermissions(
      files(JSON.stringify({ permissions: { net: { enabled: true }, qr: { enabled: true } } })),
      manifest
    );
    expect(requestedCapabilities(config!).sort()).toEqual(['net', 'qr']);
  });

  it('still treats an absent file as a legacy bundle', () => {
    // Deliberately unchanged: that behaviour is documented, and tightening it
    // is a policy decision rather than a bug fix.
    expect(extractPermissions(files(), manifest)).toBeNull();
  });
});

describe('the capability list a grant is compared against', () => {
  it('includes ai, gpu, sync and mic', () => {
    // The grant record used to enumerate four capabilities by hand and omit
    // ai, gpu and sync, so approval for them was never written down. mic
    // arrived later and is the same shape of hazard — a capability the runtime
    // enforces is worthless if consent for it is never asked or recorded.
    const config = extractPermissions(
      files(
        JSON.stringify({
          permissions: {
            ai: { enabled: true },
            gpu: { enabled: true },
            sync: { enabled: true },
            mic: { enabled: true },
          },
        })
      ),
      manifest
    );
    expect(requestedCapabilities(config!).sort()).toEqual(['ai', 'gpu', 'mic', 'sync']);
  });

  it('ignores a capability that is declared but not enabled', () => {
    const config = extractPermissions(
      files(JSON.stringify({ permissions: { net: { enabled: false }, qr: { enabled: true } } })),
      manifest
    );
    expect(requestedCapabilities(config!)).toEqual(['qr']);
  });

  it('detects the case a stored grant does not cover', () => {
    // This is the consent bypass: v1 asked for qr and was approved; v2 — or any
    // unrelated bundle with the same manifest name — asks for three more.
    const v2 = extractPermissions(
      files(
        JSON.stringify({
          permissions: {
            qr: { enabled: true },
            net: { enabled: true },
            camera: { enabled: true },
          },
        })
      ),
      manifest
    );
    const storedGrant: Record<string, boolean> = { qr: true };

    const covered = requestedCapabilities(v2!).every((c) => storedGrant[c]);
    expect(covered).toBe(false);
  });

  it('accepts a grant that does cover everything asked for', () => {
    const config = extractPermissions(
      files(JSON.stringify({ permissions: { qr: { enabled: true } } })),
      manifest
    );
    const storedGrant: Record<string, boolean> = { qr: true, net: true };

    expect(requestedCapabilities(config!).every((c) => storedGrant[c])).toBe(true);
  });
});

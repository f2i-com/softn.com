/**
 * readManifest is the one manifest read every host shares: lenient where
 * core has always been lenient, refusing with the inspector's words where a
 * bundle cannot run at all.
 */

import { describe, expect, it, vi } from 'vitest';
import { ManifestError, extractPermissions, normalizeManifest, readManifest } from '../src/bundle/manifest';

const files = (manifest: unknown, extra: Record<string, string> = {}) =>
  new Map<string, string>([
    ['manifest.json', typeof manifest === 'string' ? manifest : JSON.stringify(manifest)],
    ['ui/main.ui', '<App/>'],
    ...Object.entries(extra),
  ]);

describe('readManifest', () => {
  it('opens a manifest that names only its entry (no files, no version)', () => {
    const m = readManifest(files({ name: 'Notes', main: 'ui/main.ui' }));
    expect(m.name).toBe('Notes');
    expect(m.main).toBe('ui/main.ui');
    expect(m.version).toBe('');
    expect(m.files).toEqual({ ui: [], logic: [], xdb: [], assets: [] });
  });

  it('defaults every group to a list and keeps groups the author added', () => {
    const m = readManifest(
      files({ name: 'Notes', version: '1.2.0', main: 'ui/main.ui', files: { logic: ['logic/a.logic'], server: ['server/x.logic'] } })
    );
    expect(m.version).toBe('1.2.0');
    expect(m.files.ui).toEqual([]);
    expect(m.files.logic).toEqual(['logic/a.logic']);
    expect(m.files.xdb).toEqual([]);
    expect(m.files.assets).toEqual([]);
    expect(m.files.server).toEqual(['server/x.logic']);
  });

  it('does not require the entry to be listed in files.ui, and keeps a path a group lists but the bundle lacks', () => {
    const m = readManifest(files({ name: 'Notes', main: 'ui/main.ui', files: { ui: ['ui/other.ui'], xdb: ['data/missing.xdb'] } }));
    expect(m.files.ui).toEqual(['ui/other.ui']);
    expect(m.files.xdb).toEqual(['data/missing.xdb']);
  });

  it('keeps every other field as written, and drops list entries that are not paths', () => {
    const m = readManifest<{ config?: { execution?: string }; permissions?: { network?: boolean } }>(
      files({ name: ' Notes ', version: 3, main: 'ui/main.ui', config: { execution: 'worker' }, permissions: { network: true }, files: { ui: ['ui/main.ui', 7, null] } })
    );
    expect(m.name).toBe('Notes');
    expect(m.version).toBe('3');
    expect(m.config).toEqual({ execution: 'worker' });
    expect(m.permissions).toEqual({ network: true });
    expect(m.files.ui).toEqual(['ui/main.ui']);
  });

  it('reads raw archive entries as well as decoded text', () => {
    const bytes = new TextEncoder().encode(JSON.stringify({ name: 'Bytes', main: 'ui/main.ui' }));
    const m = readManifest(new Map<string, Uint8Array | string>([['manifest.json', bytes], ['ui/main.ui', '<App/>']]));
    expect(m.name).toBe('Bytes');
  });

  it('lets a host say what it has, for legacy paths written without their folder', () => {
    const m = readManifest(files({ name: 'Old', main: 'main.ui' }), { has: (p) => p === 'main.ui' });
    expect(m.main).toBe('main.ui');
  });

  const refusal = (manifest: unknown, extra?: Record<string, string>): ManifestError => {
    try {
      readManifest(files(manifest, extra));
    } catch (e) {
      if (e instanceof ManifestError) return e;
      throw e;
    }
    throw new Error('expected a ManifestError');
  };

  it('refuses, in the inspector\'s words, what cannot run at all', () => {
    expect(() => readManifest(new Map())).toThrow(/The bundle has no manifest\.json\./);
    expect(refusal('{ nope').code).toBe('malformed');
    expect(refusal('{ nope').message).toMatch(/not valid JSON/);
    expect(refusal('[1]').message).toMatch(/not a JSON object/);
    expect(refusal('null').code).toBe('malformed');
    expect(refusal({ main: 'ui/main.ui' }).code).toBe('no-name');
    expect(refusal({ name: '  ', main: 'ui/main.ui' }).message).toBe('The manifest has no name.');
    expect(refusal({ name: 'Notes' }).message).toBe('The manifest names no entry file (main).');
    expect(refusal({ name: 'Notes', main: 'ui/missing.ui' }).code).toBe('entry-missing');
    expect(refusal({ name: 'Notes', main: 'ui/missing.ui' }).message).toMatch(/entry file is not in the bundle: ui\/missing\.ui/);
    expect(refusal({ name: 'Notes', main: 'ui/main.ui', files: [] }).message).toBe('manifest.files must be an object of file groups.');
    expect(refusal({ name: 'Notes', main: 'ui/main.ui', files: { ui: 'ui/main.ui' } }).message).toBe('manifest.files.ui must be a list of paths.');
  });

  it('is what normalizeManifest does after the JSON parse', () => {
    const m = normalizeManifest({ name: 'N', main: 'a.ui' }, () => true);
    expect(m.files.logic).toEqual([]);
    expect(() => normalizeManifest('text', () => true)).toThrow(ManifestError);
  });
});

describe('extractPermissions', () => {
  const text = (permission?: string) => new Map(permission === undefined ? [] : [['permission.json', permission]]);

  it('prefers permission.json and hands it back as written', () => {
    const declared = { permissions: { net: { enabled: true } }, app: { id: 'x' } };
    expect(extractPermissions(text(JSON.stringify(declared)), { permissions: { network: false } })).toEqual(declared);
  });

  it('maps the legacy manifest block the way the browser runtime always has', () => {
    expect(extractPermissions(text(), { permissions: { network: true, filesystem: 'read', clipboard: true } })).toEqual({
      permissions: { net: { enabled: true }, files: { enabled: true } },
    });
    expect(extractPermissions(text(), { permissions: { network: false } })).toEqual({
      permissions: { net: undefined, files: undefined },
    });
  });

  it('is null for a bundle that declared nothing, and an empty declaration for one that declared it badly', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(extractPermissions(text(), {})).toBeNull();
      expect(extractPermissions(text(), null)).toBeNull();
      expect(extractPermissions(text(''), { permissions: { network: true } })).toEqual({
        permissions: { net: { enabled: true }, files: undefined },
      });
      expect(extractPermissions(text('{ "permissions": { "net": { "enabled": true }, }'), { permissions: { network: true } })).toEqual({ permissions: {} });
      expect(extractPermissions(text('[1]'), null)).toEqual({ permissions: {} });
    } finally {
      error.mockRestore();
    }
  });
});

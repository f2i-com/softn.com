/**
 * The declaration a Builder bundle carries.
 *
 * Builder wrote no permission.json, so every app it made was granted nothing
 * — its logic could not fetch, could not keep server records — and the icon
 * on the project was never written to the archive. Both now round-trip:
 * declared here, written on export, read back on open.
 */

import { describe, it, expect } from 'vitest';
import { strToU8 } from 'fflate';
import { inspectBundle, readBundleEntries } from '@softn/core';
import { buildPermissionJson, readPermissionJson, emptyDeclaration } from './permissions';
import { exportMultiFileBundle, exportBundle } from './bundleExporter';
import { loadBundle } from './bundleLoader';
import { decodeIconDataUrl } from './buildProjectBundle';
import type { UIFileState, LogicFileState } from '../types/builder';

const decl = {
  capabilities: ['net', 'storage'] as const,
  allowedHosts: ['api.example.com'],
  allowHttp: false,
  storagePolicies: { notes: 'private' as const },
};

// A 1x1 PNG.
const PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

function uiFile(path: string, source: string): UIFileState {
  return { id: path, path, elements: new Map(), rootId: 'root', imports: [], originalSource: source };
}
function logicFile(path: string, content: string): LogicFileState {
  return { id: path, path, content, imports: [], exports: [] };
}

describe('buildPermissionJson', () => {
  it('writes only what is declared, in the schema shape', () => {
    const json = buildPermissionJson({ ...decl, capabilities: [...decl.capabilities] });
    expect(JSON.parse(json!)).toEqual({
      permissions: {
        net: { enabled: true, allowed_hosts: ['api.example.com'] },
        storage: { enabled: true, collections: { notes: 'private' } },
      },
    });
  });

  it('writes nothing for an app that declares nothing', () => {
    expect(buildPermissionJson(emptyDeclaration())).toBeNull();
  });

  it('reads back what it wrote', () => {
    const json = buildPermissionJson({ ...decl, capabilities: [...decl.capabilities] })!;
    expect(readPermissionJson(json)).toEqual({ ...decl, capabilities: ['net', 'storage'] });
  });

  it('drops a capability the schema does not know rather than carrying it', () => {
    const read = readPermissionJson(JSON.stringify({ permissions: { network: { enabled: true }, qr: { enabled: true } } }));
    expect(read.capabilities).toEqual(['qr']);
  });
});

describe('an exported bundle', () => {
  const icon = decodeIconDataUrl(PNG_DATA_URL)!;

  it('carries permission.json and the icon at its own path, listed once', async () => {
    const bytes = await exportMultiFileBundle({
      name: 'Notes',
      version: '1.0.0',
      description: 'Keeps notes',
      themeMode: 'light',
      uiFiles: new Map([['a', uiFile('ui/main.ui', '<App></App>')]]),
      logicFiles: new Map([['b', logicFile('logic/main.logic', 'let x = 1')]]),
      collections: [{ name: 'notes', alias: 'notes', fields: [], seedData: [] }],
      assets: [{ name: 'icon.png', type: 'image/png', data: icon.bytes }],
      permissions: { ...decl, capabilities: [...decl.capabilities] },
      icon: icon.bytes,
      iconPath: icon.path,
    });
    const entries = readBundleEntries(bytes);
    expect(entries.has('permission.json')).toBe(true);
    const manifest = JSON.parse(new TextDecoder().decode(entries.get('manifest.json')!));
    expect(manifest.icon).toBe('assets/icon.png');
    expect(manifest.files.assets.filter((p: string) => p === 'assets/icon.png')).toHaveLength(1);

    const report = inspectBundle(bytes);
    expect(report.problem).toBeNull();
    expect(report.capabilities).toEqual(['net', 'storage']);
    expect(report.storagePolicies).toEqual({ notes: 'private' });
    expect(report.iconDataUrl).toBe(PNG_DATA_URL);
  });

  it('comes back into the builder with its declaration and icon', async () => {
    const bytes = await exportBundle({
      name: 'Notes',
      version: '1.0.0',
      description: '',
      themeMode: 'dark',
      elements: new Map([['root', { id: 'root', componentType: 'App', props: {}, children: [], parentId: null } as never]]),
      rootId: 'root',
      logicSource: '',
      collections: [],
      assets: [],
      permissions: { ...decl, capabilities: [...decl.capabilities] },
      icon: icon.bytes,
      iconPath: 'assets/icon.png',
    });
    const loaded = await loadBundle(bytes);
    expect(loaded.permissions).toEqual({ ...decl, capabilities: ['net', 'storage'] });
    expect(loaded.iconDataUrl).toBe(PNG_DATA_URL);
  });

  it('writes no permission.json when nothing is declared, and the inspector says so', async () => {
    const bytes = await exportMultiFileBundle({
      name: 'Plain',
      version: '1.0.0',
      description: 'No capabilities',
      themeMode: 'light',
      uiFiles: new Map([['a', uiFile('ui/main.ui', '<App></App>')]]),
      logicFiles: new Map(),
      collections: [],
      assets: [],
      permissions: emptyDeclaration(),
    });
    expect(readBundleEntries(bytes).has('permission.json')).toBe(false);
    const report = inspectBundle(bytes);
    expect(report.problem).toBeNull();
    expect(report.report.map((l) => l.text)).toContainEqual(expect.stringMatching(/No permission\.json/));
  });
});

describe('decodeIconDataUrl', () => {
  it('turns the store’s data URL into bytes and a path by type', () => {
    const png = decodeIconDataUrl(PNG_DATA_URL)!;
    expect(png.path).toBe('assets/icon.png');
    expect(png.bytes.slice(0, 4)).toEqual(strToU8('\x89PNG', true));
    expect(decodeIconDataUrl('data:image/svg+xml;base64,PHN2Zy8+')!.path).toBe('assets/icon.svg');
    expect(decodeIconDataUrl(null)).toBeNull();
    expect(decodeIconDataUrl('not a data url')).toBeNull();
  });
});

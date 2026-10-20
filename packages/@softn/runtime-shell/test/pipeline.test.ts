/**
 * What the desktop loader's own copy of the pipeline was tested for, held by
 * the shared one it now uses: assets keep their paths so a model finds its
 * siblings, a path guard that refuses whatever either copy refused, a
 * manifest that names only its entry, the one-block composer, and a seed
 * that stops once its load has been replaced.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getXDB, readManifest } from '@softn/core';
import { createAssetResolver, loadXDBData, processBundle } from '../src/bundleProcessor';

afterEach(() => vi.restoreAllMocks());

describe('assets', () => {
  it('resolves a model and its sibling resources with reverse paths and releases them', () => {
    const created = vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:asset-${created.mock.calls.length}`);
    const revoked = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const assets = createAssetResolver(
      new Map([['models/mesh.bin', new Uint8Array([1, 2])]]),
      new Map([['models/scene.gltf', '{"buffers":[{"uri":"mesh.bin"}]}']])
    );
    const scene = assets('models/scene.gltf');
    expect(assets.pathOf(scene)).toBe('models/scene.gltf');
    const sibling = assets('models/mesh.bin');
    expect(assets.pathOf(sibling)).toBe('models/mesh.bin');
    expect(assets('./models/scene.gltf')).toBe(scene);
    expect(created).toHaveBeenCalledTimes(2);
    expect(assets('missing.png')).toBe('');
    assets.dispose();
    assets.dispose();
    expect(revoked.mock.calls).toEqual([[scene], [sibling]]);
    expect(assets('models/scene.gltf')).toBe('');
    expect(assets.pathOf(scene)).toBeUndefined();
  });

  it('refuses every path either copy of the guard refused, backslashes read as separators', () => {
    const created = vi.spyOn(URL, 'createObjectURL').mockImplementation(() => 'blob:asset');
    const assets = createAssetResolver(new Map([['models/mesh.bin', new Uint8Array([1])]]), new Map());
    for (const path of ['../scene.gltf', 'models/../../x.bin', 'a..b.bin', '/etc/passwd', '\\\\server\\share\\x.bin', '..\\x.bin', 'C:\\x.bin', 'c:/x.bin', 'https://cdn.example/x.bin', 'data:text/plain,x', 'blob:x']) {
      expect(assets(path), path).toBe('');
    }
    expect(created).not.toHaveBeenCalled();
    // A Windows author's separator finds the entry.
    expect(assets('models\\mesh.bin')).toBe('blob:asset');
  });
});

describe('composing and seeding', () => {
  it('composes and seeds a manifest that names only its entry (no files)', async () => {
    const textFiles = new Map([['ui/main.ui', '<App><logic>let n = 1;</logic><Text>{n}</Text></App>']]);
    const manifest = readManifest(new Map([...textFiles, ['manifest.json', JSON.stringify({ name: 'Bare', main: 'ui/main.ui' })]]));
    expect(manifest.files).toEqual({ ui: [], logic: [], xdb: [], assets: [] });
    expect(processBundle(textFiles, manifest).source).toContain('let n = 1;');
    expect(processBundle(textFiles, { main: 'ui/main.ui' }).source).toContain('let n = 1;');
    await expect(loadXDBData(textFiles, {}, `bare-${Date.now()}`)).resolves.toBe(0);
  });

  it('uses the one-block composer', () => {
    const result = processBundle(
      new Map([
        ['ui/main.ui', '<import Card from="./Card.ui" /><logic>let mainReady = true;</logic><Card />'],
        ['ui/Card.ui', '<logic src="../logic/card.logic" /><Text>Card</Text>'],
        ['logic/card.logic', 'import "./card-helper.logic";\nlet cardReady = true;'],
      ]),
      { main: 'ui/main.ui', files: { logic: ['logic/card.logic'] } }
    );
    expect(result.source.match(/<logic>/g)).toHaveLength(1);
    expect(result.source).toContain('let mainReady = true;');
    expect(result.source).toContain('let cardReady = true;');
    expect(result.source).toContain('import "logic/card-helper.logic";');
  });

  it('does not seed after an awaited load loses ownership', async () => {
    const appId = `stale-loader-${Date.now()}-${Math.random()}`;
    const xdb = getXDB(appId);
    xdb.clearAll();
    const originalReady = xdb.isReady;
    let releaseReady!: () => void;
    xdb.isReady = new Promise<void>((resolve) => {
      releaseReady = resolve;
    });
    let active = true;
    try {
      const loading = loadXDBData(
        new Map([['data/tasks.xdb', JSON.stringify({ collection: 'tasks', records: [{ id: 'stale', title: 'Must not be written' }] })]]),
        { files: { xdb: ['data/tasks.xdb'] } },
        appId,
        () => active
      );
      active = false;
      releaseReady();
      await expect(loading).resolves.toBe(0);
      expect(xdb.getAllRaw('tasks')).toEqual([]);
    } finally {
      xdb.isReady = originalReady;
      xdb.clearAll();
    }
  });

  it('counts the records it seeds', async () => {
    const appId = `seed-count-${Date.now()}-${Math.random()}`;
    const xdb = getXDB(appId);
    xdb.clearAll();
    try {
      const inserted = await loadXDBData(
        new Map([['data/tasks.xdb', JSON.stringify({ collection: 'tasks', records: [{ id: 'a', title: 'One' }, { id: 'b', title: 'Two' }] })]]),
        { files: { xdb: ['data/tasks.xdb'] } },
        appId
      );
      expect(inserted).toBe(2);
    } finally {
      xdb.clearAll();
    }
  });
});

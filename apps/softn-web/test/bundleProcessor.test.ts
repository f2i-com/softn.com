import { afterEach, describe, it, expect, vi } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import {
  collectAssetLiterals,
  createAssetResolver,
  createImportResolver,
  extractIconDataUrl,
  firstScreenAssets,
  loadXDBData,
  readZip,
  processBundle,
  FIRST_SCREEN_WARM_MAX_BYTES,
  FIRST_SCREEN_WARM_MAX_ENTRIES,
  type BundleManifest,
} from '../src/lib/bundleProcessor';
import { warmFirstScreen } from '../src/lib/zipWarmup';
import { getXDB } from '@softn/core';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function makeZip(files: Record<string, string | Uint8Array>, level = 6): Uint8Array {
  const entries: Record<string, Uint8Array> = {};
  for (const [path, content] of Object.entries(files)) {
    entries[path] = typeof content === 'string' ? strToU8(content) : content;
  }
  return zipSync(entries, { level: level as 0 | 6 });
}

describe('bundleProcessor', () => {
  it('adds missing flat XDB seeds without reviving a deleted seed', async () => {
    const appId = `bundle-processor-${Date.now()}-${Math.random()}`;
    const xdb = getXDB(appId);
    xdb.writeRecord('tasks', {
      id: 'deleted-seed',
      collection: 'tasks',
      data: { title: 'Removed locally' },
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-02T00:00:00.000Z',
      deleted: true,
    });

    await loadXDBData(
      new Map([
        [
          'data/tasks.xdb',
          JSON.stringify({
            collection: 'tasks',
            records: [
              { id: 'deleted-seed', title: 'Bundled copy' },
              { id: 'new-seed', title: 'New task', completed: false },
            ],
          }),
        ],
      ]),
      {
        name: 'XDB compatibility',
        version: '1.0.0',
        main: 'ui/main.ui',
        files: { xdb: ['data/tasks.xdb'] },
      },
      appId
    );

    const records = xdb.getAllRaw('tasks');
    expect(records).toHaveLength(2);
    expect(records.find((record) => record.id === 'deleted-seed')?.deleted).toBe(true);
    expect(records.find((record) => record.id === 'new-seed')).toMatchObject({
      data: { title: 'New task', completed: false },
      created_at: '1970-01-01T00:00:00.000Z',
      updated_at: '1970-01-01T00:00:00.000Z',
      deleted: false,
    });
    xdb.clearAll();
  });

  it('inlines nested imports and logic files', () => {
    const zip = makeZip({
      'manifest.json': JSON.stringify({
        name: 'Test',
        version: '1.0.0',
        main: 'ui/main.ui',
        files: {
          ui: ['ui/main.ui', 'ui/components/Inner.ui'],
          logic: ['logic/main.logic'],
          xdb: [],
          assets: [],
        },
      }),
      'ui/main.ui': [
        '<import Inner from="./components/Inner.ui" />',
        '<logic src="../logic/main.logic" />',
        '<div><Inner /></div>',
      ].join('\n'),
      'ui/components/Inner.ui': ['<import Leaf from="./Leaf.ui" />', '<div><Leaf /></div>'].join(
        '\n'
      ),
      'ui/components/Leaf.ui': '<span>Leaf</span>',
      'logic/main.logic': 'let counter = 0;',
    });

    const { textFiles } = readZip(zip);
    const { source } = processBundle(textFiles, {
      name: 'Test',
      version: '1.0.0',
      main: 'ui/main.ui',
      files: {},
    });

    expect(source).toContain('<span>Leaf</span>');
    expect(source).toContain('<logic>');
    expect(source).toContain('let counter = 0;');
    expect(source).not.toContain('<import');
  });

  it('skips circular imports without crashing', () => {
    const zip = makeZip({
      'manifest.json': JSON.stringify({
        name: 'Test',
        version: '1.0.0',
        main: 'ui/main.ui',
        files: { ui: ['ui/main.ui', 'ui/A.ui', 'ui/B.ui'], logic: [], xdb: [], assets: [] },
      }),
      'ui/main.ui': '<import A from="./A.ui" /><A />',
      'ui/A.ui': '<import B from="./B.ui" /><div>A<B /></div>',
      'ui/B.ui': '<import A from="./A.ui" /><div>B</div>',
    });

    const { textFiles } = readZip(zip);
    const { source } = processBundle(textFiles, {
      name: 'Test',
      version: '1.0.0',
      main: 'ui/main.ui',
      files: {},
    });

    expect(source).toContain('<div>A');
    expect(source).toContain('<div>B</div>');
  });

  it('rejects UI imports that escape the bundle root', () => {
    const textFiles = new Map([
      ['ui/main.ui', '<import Secret from="../../secret.ui" /><Secret />'],
      ['secret.ui', '<Text>should not be reachable</Text>'],
    ]);

    expect(() =>
      processBundle(textFiles, {
        name: 'Traversal',
        version: '1.0.0',
        main: 'ui/main.ui',
        files: {},
      })
    ).toThrow(/Unsafe import path/);
  });

  it('emits manifest logic only once when imported UI files also reference it', () => {
    const textFiles = new Map([
      [
        'ui/main.ui',
        '<import Panel from="./Panel.ui" /><logic src="../logic/main.logic" /><Panel />',
      ],
      ['ui/Panel.ui', '<logic src="../logic/main.logic" /><Text>Panel</Text>'],
      ['logic/helpers.logic', 'let helper = 1;'],
      ['logic/main.logic', 'let main = helper;'],
    ]);

    const { source } = processBundle(textFiles, {
      name: 'One logic block',
      version: '1.0.0',
      main: 'ui/main.ui',
      files: { logic: ['logic/helpers.logic', 'logic/main.logic'] },
    });

    expect(source.match(/let helper = 1;/g)).toHaveLength(1);
    expect(source.match(/let main = helper;/g)).toHaveLength(1);
  });

  it('includes distinct component logic once even when it is not manifest-listed', () => {
    const textFiles = new Map([
      [
        'ui/main.ui',
        '<import Panel from="./Panel.ui" /><logic src="../logic/main.logic" /><Panel /><Panel />',
      ],
      ['ui/Panel.ui', '<logic src="../logic/panel.logic" /><Text>Panel</Text>'],
      ['logic/helpers.logic', 'function helper() { return 1; }'],
      ['logic/main.logic', 'let main = helper();'],
      ['logic/panel.logic', 'let panelReady = true;'],
    ]);

    const result = processBundle(textFiles, {
      name: 'Distinct component logic',
      version: '1.0.0',
      main: 'ui/main.ui',
      files: { logic: ['logic/helpers.logic', 'logic/main.logic'] },
    });

    expect(result.source.match(/function helper\(\)/g)).toHaveLength(1);
    expect(result.source.match(/let main = helper\(\);/g)).toHaveLength(1);
    expect(result.source.match(/let panelReady = true;/g)).toHaveLength(1);
    expect(result.source.match(/<logic>/g)).toHaveLength(1);
    expect(result.source.indexOf('function helper()')).toBeLessThan(
      result.source.indexOf('let main = helper();')
    );
    expect(result.source.indexOf('let panelReady = true;')).toBeLessThan(
      result.source.indexOf('let main = helper();')
    );
    expect(result.logicBasePath).toBe('logic/main.logic');
    expect(result.preIncludedLogicPaths).toEqual(['logic/helpers.logic', 'logic/panel.logic']);
  });

  it('preserves inline main logic together with imported component logic', () => {
    const result = processBundle(
      new Map([
        [
          'ui/main.ui',
          [
            '<import Panel from="./components/Panel.ui" />',
            '<logic>import "../logic/main-helper.logic";\nlet mainReady = true;</logic>',
            '<Panel />',
          ].join('\n'),
        ],
        [
          'ui/components/Panel.ui',
          '<logic src="../../logic/widgets/panel.logic" /><Text>Panel</Text>',
        ],
        ['logic/main-helper.logic', 'function mainHelper() { return true; }'],
        [
          'logic/widgets/panel.logic',
          'import "./helper.logic";\nlet panelReady = widgetHelper();',
        ],
        ['logic/widgets/helper.logic', 'function widgetHelper() { return true; }'],
      ]),
      {
        name: 'Inline and component logic',
        version: '1.0.0',
        main: 'ui/main.ui',
        files: { logic: ['logic/widgets/panel.logic'] },
      }
    );

    expect(result.source.match(/<logic>/g)).toHaveLength(1);
    expect(result.source.match(/<\/logic>/g)).toHaveLength(1);
    expect(result.source).toContain('let mainReady = true;');
    expect(result.source).toContain('let panelReady = widgetHelper();');
    expect(result.source).toContain('import "logic/main-helper.logic";');
    expect(result.source).toContain('import "logic/widgets/helper.logic";');
    expect(result.logicBasePath).toBe('ui/main.ui');
    expect(result.preIncludedLogicPaths).toContain('logic/widgets/panel.logic');
  });

  it('canonicalizes same-named relative imports from each logic file independently', () => {
    const result = processBundle(
      new Map([
        [
          'ui/main.ui',
          '<import Panel from="./Panel.ui" /><logic src="../logic/main/main.logic" /><Panel />',
        ],
        ['ui/Panel.ui', '<logic src="../logic/panel/panel.logic" /><Text>Panel</Text>'],
        ['logic/main/main.logic', 'import "./helper.logic";\nlet main = mainHelper();'],
        ['logic/main/helper.logic', 'function mainHelper() { return 1; }'],
        ['logic/panel/panel.logic', 'import "./helper.logic";\nlet panel = panelHelper();'],
        ['logic/panel/helper.logic', 'function panelHelper() { return 2; }'],
      ]),
      {
        name: 'Per-file bases',
        version: '1.0.0',
        main: 'ui/main.ui',
        files: { logic: ['logic/main/main.logic', 'logic/panel/panel.logic'] },
      }
    );

    expect(result.source).toContain('import "logic/main/helper.logic";');
    expect(result.source).toContain('import "logic/panel/helper.logic";');
    expect(result.source).not.toContain('import "./helper.logic";');
    expect(result.source.match(/<logic>/g)).toHaveLength(1);
  });

  it('rejects oversize bundle input', () => {
    const tooLarge = new Uint8Array(210 * 1024 * 1024);
    expect(() => readZip(tooLarge)).toThrow('Bundle too large');
  });

  it('applies network permissions to remote imports', async () => {
    const fetchMock = vi.fn(async () => new Response('remote logic'));
    vi.stubGlobal('fetch', fetchMock);

    const omitted = createImportResolver(new Map());
    expect(await omitted('https://modules.example/logic.softn')).toBeNull();

    const denied = createImportResolver(new Map(), { permissions: {} });
    expect(await denied('https://modules.example/logic.softn')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();

    const allowed = createImportResolver(new Map(), {
      permissions: { net: { enabled: true, allowed_hosts: ['modules.example'] } },
    });
    expect(await allowed('https://modules.example/logic.softn')).toBe('remote logic');
    expect(await allowed('https://other.example/logic.softn')).toBeNull();
    expect(await allowed('http://modules.example/logic.softn')).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('re-checks redirects and caps remote import bodies', async () => {
    const redirected = new Response('not allowed');
    Object.defineProperty(redirected, 'url', { value: 'https://other.example/logic.softn' });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(redirected)
      .mockResolvedValueOnce(new Response(new Uint8Array(1024 * 1024 + 1)));
    vi.stubGlobal('fetch', fetchMock);
    const resolve = createImportResolver(new Map(), {
      permissions: { net: { enabled: true, allowed_hosts: ['modules.example'] } },
    });

    expect(await resolve('https://modules.example/redirect.softn')).toBeNull();
    expect(await resolve('https://modules.example/large.softn')).toBeNull();
  });

  it('cancels response bodies on every early remote-import rejection', async () => {
    const canceled = [vi.fn(), vi.fn(), vi.fn()];
    const body = (index: number) =>
      new ReadableStream<Uint8Array>({
        cancel: canceled[index],
      });

    const nonOk = new Response(body(0), { status: 503 });
    const redirected = new Response(body(1));
    Object.defineProperty(redirected, 'url', {
      value: 'https://other.example/redirect.logic',
    });
    const declaredLarge = new Response(body(2), {
      headers: { 'content-length': String(1024 * 1024 + 1) },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(nonOk).mockResolvedValueOnce(redirected).mockResolvedValueOnce(declaredLarge)
    );

    const resolve = createImportResolver(new Map(), {
      permissions: { net: { enabled: true, allowed_hosts: ['modules.example'] } },
    });
    expect(await resolve('https://modules.example/unavailable.logic')).toBeNull();
    expect(await resolve('https://modules.example/redirect.logic')).toBeNull();
    expect(await resolve('https://modules.example/large.logic')).toBeNull();
    expect(canceled.every((cancel) => cancel.mock.calls.length === 1)).toBe(true);
  });

  it('aborts owned remote imports when the resolver is disposed', async () => {
    let requestSignal: AbortSignal | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string | URL | Request, init?: RequestInit) => {
        requestSignal = init?.signal ?? undefined;
        return new Promise<Response>((_resolve, reject) => {
          requestSignal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
        });
      })
    );
    const resolve = createImportResolver(new Map([['local.logic', 'local']]), {
      permissions: { net: { enabled: true, allowed_hosts: ['modules.example'] } },
    });

    const pending = resolve('https://modules.example/pending.logic');
    expect(requestSignal?.aborted).toBe(false);
    resolve.dispose();
    resolve.dispose();

    expect(requestSignal?.aborted).toBe(true);
    await expect(pending).resolves.toBeNull();
    await expect(resolve('local.logic')).resolves.toBeNull();
  });

  it('cancels an active response reader when the resolver is disposed', async () => {
    const pull = vi.fn();
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ pull, cancel });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body)));
    const resolve = createImportResolver(new Map(), {
      permissions: { net: { enabled: true, allowed_hosts: ['modules.example'] } },
    });

    const pending = resolve('https://modules.example/streaming.logic');
    await vi.waitFor(() => expect(pull).toHaveBeenCalled());
    resolve.dispose();

    await vi.waitFor(() => expect(cancel).toHaveBeenCalledTimes(1));
    await expect(pending).resolves.toBeNull();
  });

  it('releases cached asset URLs when a SoftN tab is closed', () => {
    const create = vi.fn(() => 'blob:asset');
    const revoke = vi.fn();
    vi.stubGlobal('URL', { createObjectURL: create, revokeObjectURL: revoke });
    const resolve = createAssetResolver(
      new Map([['assets/pixel.png', new Uint8Array([1, 2, 3])]]),
      new Map()
    );

    expect(resolve('assets/pixel.png')).toBe('blob:asset');
    expect(resolve('assets/pixel.png')).toBe('blob:asset');
    expect(create).toHaveBeenCalledTimes(1);
    resolve.dispose();
    resolve.dispose();
    expect(revoke).toHaveBeenCalledOnce();
    expect(resolve('assets/pixel.png')).toBe('');
  });

  it('maps a minted asset URL back to its bundle path until disposed', () => {
    let minted = 0;
    const create = vi.fn(() => `blob:asset-${++minted}`);
    vi.stubGlobal('URL', { createObjectURL: create, revokeObjectURL: vi.fn() });
    const resolve = createAssetResolver(
      new Map([
        ['models/robot/robot.gltf', new Uint8Array([1])],
        ['models/robot/robot.bin', new Uint8Array([2])],
      ]),
      new Map([['models/robot/notes.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>']])
    );

    const gltf = resolve('./models/robot/robot.gltf');
    const bin = resolve('models/robot/robot.bin');
    const svg = resolve('models/robot/notes.svg');
    expect(new Set([gltf, bin, svg]).size).toBe(3);
    expect(resolve.pathOf(gltf)).toBe('models/robot/robot.gltf');
    expect(resolve.pathOf(bin)).toBe('models/robot/robot.bin');
    expect(resolve.pathOf(svg)).toBe('models/robot/notes.svg');
    expect(resolve.pathOf('blob:someone-elses')).toBeUndefined();
    expect(resolve.pathOf('')).toBeUndefined();
    resolve.dispose();
    expect(resolve.pathOf(gltf)).toBeUndefined();
  });

  it('asks fetch to refuse redirects for a permitted remote import', async () => {
    const fetchMock = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) => new Response('remote logic')
    );
    vi.stubGlobal('fetch', fetchMock);
    const resolve = createImportResolver(new Map(), {
      permissions: { net: { enabled: true, allowed_hosts: ['modules.example'] } },
    });

    expect(await resolve('https://modules.example/logic.softn')).toBe('remote logic');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ redirect: 'error' });
  });

  it('makes no follow-up request when the browser refuses a redirect', async () => {
    // Under `redirect: 'error'` a redirect response rejects the fetch with a
    // TypeError, the same shape as a network failure; the target is never asked.
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    vi.stubGlobal('fetch', fetchMock);
    const resolve = createImportResolver(new Map(), {
      permissions: { net: { enabled: true, allowed_hosts: ['modules.example'] } },
    });

    expect(await resolve('https://modules.example/bounce.softn')).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('caches a permitted remote import after one request', async () => {
    const fetchMock = vi.fn(async () => new Response('remote logic'));
    vi.stubGlobal('fetch', fetchMock);
    const resolve = createImportResolver(new Map(), {
      permissions: { net: { enabled: true, allowed_hosts: ['modules.example'] } },
    });

    expect(await resolve('https://modules.example/logic.softn')).toBe('remote logic');
    expect(await resolve('https://modules.example/logic.softn')).toBe('remote logic');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

/** Offset of `needle` in `haystack`, or -1. */
function indexOfBytes(haystack: Uint8Array, needle: Uint8Array): number {
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let k = 0; k < needle.length; k++) if (haystack[i + k] !== needle[k]) continue outer;
    return i;
  }
  return -1;
}

const MANIFEST = JSON.stringify({
  name: 'Demand',
  version: '1.0.0',
  main: 'ui/main.ui',
  icon: 'assets/icon.png',
  files: { ui: ['ui/main.ui'], assets: ['assets/a.png', 'assets/b.glb', 'assets/icon.png'] },
});

/** Compressible bytes, so the entries are real deflate streams rather than stored copies. */
const pattern = (n: number, seed: number) =>
  Uint8Array.from({ length: n }, (_, i) => (i * seed) % 5);

function demandZip(level = 6): Uint8Array {
  return makeZip(
    {
      'manifest.json': MANIFEST,
      'ui/main.ui': '<Image src={asset("assets/a.png")} /><Model src={asset(\'assets/b.glb\')} />',
      'assets/a.png': pattern(2048, 3),
      'assets/b.glb': pattern(4096, 7),
      'assets/icon.png': pattern(256, 11),
    },
    level
  );
}

describe('readZip demand semantics', () => {
  it('reads text at open and each binary once, on the first get that asks', () => {
    const { textFiles, binaryFiles, archive } = readZip(demandZip());
    expect([...textFiles.keys()]).toEqual(['manifest.json', 'ui/main.ui']);
    expect([...binaryFiles.keys()]).toEqual(['assets/a.png', 'assets/b.glb', 'assets/icon.png']);
    expect(binaryFiles.size).toBe(3);
    // Listing the binaries read none of them.
    for (const path of binaryFiles.keys()) expect(binaryFiles.isRead(path)).toBe(false);
    expect(binaryFiles.declaredSize('assets/b.glb')).toBe(4096);
    expect(binaryFiles.declaredSize('ui/main.ui')).toBeUndefined();
    // The text is held as the strings the composer reads, not as bytes too.
    expect(archive.heldBytes()).toBe(0);

    const marked = vi.spyOn(performance, 'mark');
    const first = binaryFiles.get('assets/a.png');
    expect(first).toEqual(pattern(2048, 3));
    expect(binaryFiles.isRead('assets/a.png')).toBe(true);
    expect(archive.heldBytes()).toBe(2048);
    expect(binaryFiles.get('assets/a.png')).toBe(first);
    expect(archive.heldBytes()).toBe(2048);
    expect(marked.mock.calls.map((call) => String(call[0]))).toEqual([
      'softn:asset-extract:start',
      'softn:asset-extract:end',
    ]);
    expect(binaryFiles.isRead('assets/b.glb')).toBe(false);

    // Text is not a binary, whatever the archive holds under the name.
    expect(binaryFiles.has('ui/main.ui')).toBe(false);
    expect(binaryFiles.get('ui/main.ui')).toBeUndefined();
    expect(binaryFiles.get('missing.png')).toBeUndefined();

    // Iterating is the Map behaviour: every entry, read.
    expect([...binaryFiles].map(([path]) => path)).toEqual([...binaryFiles.keys()]);
    const visited: string[] = [];
    binaryFiles.forEach((bytes, path) => visited.push(`${path}:${bytes.byteLength}`));
    expect(visited).toEqual(['assets/a.png:2048', 'assets/b.glb:4096', 'assets/icon.png:256']);
    // Everything produced once: the archive has let go of the bundle bytes
    // and still answers every binary from what it holds.
    expect(archive.compacted).toBe(true);
    expect(archive.released).toBe(false);
    expect(binaryFiles.get('assets/b.glb')).toHaveLength(4096);

    binaryFiles.release();
    expect(archive.released).toBe(true);
    expect(binaryFiles.has('assets/a.png')).toBe(true);
    expect(() => binaryFiles.get('assets/a.png')).toThrow(/released/);
  });

  it('holds no text entry as bytes after the open, only as the string it decoded to', () => {
    const big = 'x'.repeat(64 * 1024);
    const zip = makeZip({
      'manifest.json': MANIFEST,
      'ui/main.ui': '<div />',
      'models/mesh.obj': big,
      'assets/a.png': pattern(2048, 3),
    });
    const { textFiles, binaryFiles, archive } = readZip(zip);
    expect(textFiles.get('models/mesh.obj')).toBe(big);
    expect(binaryFiles.has('models/mesh.obj')).toBe(false);
    for (const name of ['manifest.json', 'ui/main.ui', 'models/mesh.obj']) {
      expect(archive.isRead(name)).toBe(false);
    }
    expect(archive.heldBytes()).toBe(0);
    expect(archive.compacted).toBe(false);
    binaryFiles.get('assets/a.png');
    expect(archive.heldBytes()).toBe(2048);
    expect(archive.compacted).toBe(true);
  });

  it('opens a bundle whose binary is corrupt and fails only that asset', () => {
    const zip = demandZip(0);
    const marker = pattern(4096, 7).subarray(0, 64);
    const at = indexOfBytes(zip, marker);
    expect(at).toBeGreaterThan(0);
    zip.fill(0xff, at, at + 8);

    vi.stubGlobal('URL', { createObjectURL: vi.fn(() => 'blob:asset'), revokeObjectURL: vi.fn() });
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { textFiles, binaryFiles } = readZip(zip);
    expect(textFiles.get('manifest.json')).toBe(MANIFEST);
    expect(() => binaryFiles.get('assets/b.glb')).toThrow(/checksum mismatch for assets\/b\.glb/);

    const resolve = createAssetResolver(binaryFiles, textFiles);
    expect(resolve('assets/a.png')).toBe('blob:asset');
    expect(resolve('assets/b.glb')).toBe('');
    expect(resolve('assets/b.glb')).toBe('');
    expect(error).toHaveBeenCalledTimes(1);
    resolve.dispose();
  });

  it('mints one URL per path from demand reads, maps it back, and releases on dispose', () => {
    let minted = 0;
    const create = vi.fn(() => `blob:asset-${++minted}`);
    const revoke = vi.fn();
    vi.stubGlobal('URL', { createObjectURL: create, revokeObjectURL: revoke });
    const { textFiles, binaryFiles, archive } = readZip(demandZip());
    const resolve = createAssetResolver(binaryFiles, textFiles);

    const a = resolve('./assets/a.png');
    expect(a).toBe('blob:asset-1');
    expect(resolve('assets/a.png')).toBe(a);
    expect(binaryFiles.isRead('assets/a.png')).toBe(true);
    expect(binaryFiles.isRead('assets/b.glb')).toBe(false);
    expect(resolve.pathOf(a)).toBe('assets/a.png');
    expect(resolve.pathOf(resolve('assets/b.glb'))).toBe('assets/b.glb');
    expect(create).toHaveBeenCalledTimes(2);

    resolve.dispose();
    expect(revoke).toHaveBeenCalledTimes(2);
    expect(archive.released).toBe(true);
    expect(resolve('assets/a.png')).toBe('');
    expect(resolve.pathOf(a)).toBeUndefined();
  });

  it('reads one entry for the icon', () => {
    const { binaryFiles } = readZip(demandZip());
    const icon = extractIconDataUrl(binaryFiles, JSON.parse(MANIFEST));
    expect(icon).toMatch(/^data:image\/png;base64,/);
    expect(binaryFiles.isRead('assets/icon.png')).toBe(true);
    expect(binaryFiles.isRead('assets/a.png')).toBe(false);
    expect(binaryFiles.isRead('assets/b.glb')).toBe(false);
  });
});

describe('first-screen warm-up policy', () => {
  it('collects asset() string literals and ignores everything else', () => {
    const source = [
      '<Image src={asset("a.png")} />',
      "<Model src={asset('b.glb')} />",
      '<Image src={asset(variable)} />',
      '<Image src={asset("a.png")} />',
      '<Image src={asset( "./c.png" )} />',
      '<Image src={asset("x" + y)} />',
      '<Image src={asset(`d.png`)} />',
      'let url = asset("e.webp");',
    ].join('\n');
    expect(collectAssetLiterals(source)).toEqual(['a.png', 'b.glb', 'c.png', 'e.webp']);
    expect(collectAssetLiterals('')).toEqual([]);
  });

  it('names the literal paths first, then the manifest assets, that the bundle holds unread', () => {
    const { binaryFiles } = readZip(demandZip());
    const manifest = JSON.parse(MANIFEST) as BundleManifest;
    // Literals lead, whatever the manifest's order; the manifest fills in the
    // rest in its own order; a path named both ways is named once.
    expect(
      firstScreenAssets('<Model src={asset("assets/b.glb")} />', manifest, binaryFiles)
    ).toEqual(['assets/b.glb', 'assets/a.png', 'assets/icon.png']);
    // No literals at all: the manifest's order is the order.
    expect(
      firstScreenAssets(
        '<Model src={asset(item.src)} />',
        { files: { assets: ['assets/icon.png', 'assets/b.glb', 'assets/a.png'] } },
        binaryFiles
      )
    ).toEqual(['assets/icon.png', 'assets/b.glb', 'assets/a.png']);
    // Already read — the icon both hosts extract before asking — is skipped.
    extractIconDataUrl(binaryFiles, manifest);
    const source = '<Image src={asset("assets/a.png")} /><Image src={asset("assets/nope.png")} />';
    expect(firstScreenAssets(source, manifest, binaryFiles)).toEqual([
      'assets/a.png',
      'assets/b.glb',
    ]);
    // Text-classified names, names the bundle lacks, a `./` prefix and a
    // duplicate in the manifest contribute nothing or once.
    expect(
      firstScreenAssets(
        '',
        {
          files: {
            assets: [
              'ui/main.ui',
              'assets/ghost.png',
              './assets/b.glb',
              'assets/b.glb',
              'assets/a.png',
            ],
          },
        },
        binaryFiles
      )
    ).toEqual(['assets/b.glb', 'assets/a.png']);
    expect(firstScreenAssets('', {}, binaryFiles)).toEqual([]);
    expect(firstScreenAssets('', { files: {} }, binaryFiles)).toEqual([]);
  });

  it('stops at the first path past either bound, literals and manifest alike', () => {
    const sized = (sizes: Record<string, number>) => ({
      has: (path: string) => path in sizes,
      isRead: () => false,
      declaredSize: (path: string) => sizes[path],
    });
    const many = Array.from({ length: FIRST_SCREEN_WARM_MAX_ENTRIES + 4 }, (_, i) => `i${i}.png`);
    const manySource = many.map((path) => `asset("${path}")`).join(' ');
    const chosen = firstScreenAssets(
      manySource,
      {},
      sized(Object.fromEntries(many.map((path) => [path, 1])))
    );
    expect(chosen).toEqual(many.slice(0, FIRST_SCREEN_WARM_MAX_ENTRIES));

    // The manifest fills what the literals left of the entry budget, and no more.
    const literals = many.slice(0, FIRST_SCREEN_WARM_MAX_ENTRIES - 2);
    const listed = ['m0.png', 'm1.png', 'm2.png', 'm3.png'];
    const filled = firstScreenAssets(
      literals.map((path) => `asset("${path}")`).join(' '),
      { files: { assets: listed } },
      sized(Object.fromEntries([...literals, ...listed].map((path) => [path, 1])))
    );
    expect(filled).toEqual([...literals, 'm0.png', 'm1.png']);
    expect(filled).toHaveLength(FIRST_SCREEN_WARM_MAX_ENTRIES);

    const half = FIRST_SCREEN_WARM_MAX_BYTES / 2;
    const heavy = firstScreenAssets(
      'asset("one.glb") asset("two.glb") asset("three.png")',
      {},
      sized({ 'one.glb': half, 'two.glb': half + 1, 'three.png': 1 })
    );
    expect(heavy).toEqual(['one.glb']);

    // The byte budget is one budget: a literal spends it, a manifest asset
    // past it is the cut, and nothing after the cut is considered.
    const shared = firstScreenAssets(
      'asset("one.glb")',
      { files: { assets: ['two.glb', 'three.png'] } },
      sized({ 'one.glb': half, 'two.glb': half + 1, 'three.png': 1 })
    );
    expect(shared).toEqual(['one.glb']);
  });

  it('warms without a Worker and leaves nothing to inflate', async () => {
    expect(typeof Worker).toBe('undefined');
    const zip = demandZip();
    const { textFiles, binaryFiles, archive } = readZip(zip);
    const manifest = JSON.parse(MANIFEST) as BundleManifest;
    const names = firstScreenAssets(textFiles.get('ui/main.ui')!, manifest, binaryFiles);
    expect(names).toEqual(['assets/a.png', 'assets/b.glb', 'assets/icon.png']);

    const marked = vi.spyOn(performance, 'mark');
    const warmup = warmFirstScreen(archive, zip, names);
    await expect(warmup.done).resolves.toBeUndefined();
    for (const name of names) expect(binaryFiles.isRead(name)).toBe(true);
    expect(marked.mock.calls.map((call) => String(call[0]))).toEqual([
      'softn:asset-warm:start',
      'softn:asset-warm:end',
    ]);

    // Nothing to do is not a phase.
    marked.mockClear();
    await expect(warmFirstScreen(archive, zip, names).done).resolves.toBeUndefined();
    await expect(warmFirstScreen(archive, zip, []).done).resolves.toBeUndefined();
    expect(marked).not.toHaveBeenCalled();

    binaryFiles.release();
    await expect(warmFirstScreen(archive, zip, ['assets/a.png']).done).resolves.toBeUndefined();
  });
});

import { afterEach, describe, it, expect, vi } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import {
  createAssetResolver,
  createImportResolver,
  loadXDBData,
  readZip,
  processBundle,
} from '../src/lib/bundleProcessor';
import { getXDB } from '@softn/core';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function makeZip(files: Record<string, string | Uint8Array>): Uint8Array {
  const entries: Record<string, Uint8Array> = {};
  for (const [path, content] of Object.entries(files)) {
    entries[path] = typeof content === 'string' ? strToU8(content) : content;
  }
  return zipSync(entries, { level: 6 });
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
});

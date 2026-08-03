import { afterEach, describe, it, expect, vi } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import { createAssetResolver, createImportResolver, readZip, processBundle } from '../src/lib/bundleProcessor';

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
  it('inlines nested imports and logic files', () => {
    const zip = makeZip({
      'manifest.json': JSON.stringify({
        name: 'Test',
        version: '1.0.0',
        main: 'ui/main.ui',
        files: { ui: ['ui/main.ui', 'ui/components/Inner.ui'], logic: ['logic/main.logic'], xdb: [], assets: [] },
      }),
      'ui/main.ui': [
        '<import Inner from="./components/Inner.ui" />',
        '<logic src="../logic/main.logic" />',
        '<div><Inner /></div>',
      ].join('\n'),
      'ui/components/Inner.ui': [
        '<import Leaf from="./Leaf.ui" />',
        '<div><Leaf /></div>',
      ].join('\n'),
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

  it('releases cached asset URLs when a SoftN tab is closed', () => {
    const create = vi.fn(() => 'blob:asset');
    const revoke = vi.fn();
    vi.stubGlobal('URL', { createObjectURL: create, revokeObjectURL: revoke });
    const resolve = createAssetResolver(
      new Map([['assets/pixel.png', new Uint8Array([1, 2, 3])]]),
      new Map(),
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

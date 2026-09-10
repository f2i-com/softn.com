import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseConfig, parsePermissions, fetchBytes, digest } from '../src/config';
const base = 'https://example.test/nested/runtime.config.json';
const config = { version: 1, id: 'example', title: 'Example', bundle: './app.softn' };
afterEach(() => vi.unstubAllGlobals());
describe('single application configuration', () => {
  it('resolves files relative to the deployment directory', () => {
    expect(parseConfig({ ...config, permissions: './permission.json' }, base)).toMatchObject({
      bundle: 'https://example.test/nested/app.softn',
      permissions: 'https://example.test/nested/permission.json',
      theme: 'dark',
    });
  });
  it.each([
    'https://other.test/app.softn',
    'javascript:alert(1)',
    'data:text/plain,test',
    'https://user:secret@example.test/a',
    './a#fragment',
  ])('rejects unsafe locations: %s', (bundle) => {
    expect(() => parseConfig({ ...config, bundle }, base)).toThrow();
  });
  it.each([
    { version: 2 },
    { id: '../other' },
    { title: '' },
    { theme: 'script' },
    { sha256: 'bad' },
    { unexpected: true },
    { permissionMode: 'always' },
    { permissionMode: 'preapproved' },
    { trusted: true },
    { directory: [] },
    { directory: { runs: 'https://other.test/runs' } },
    { directory: { page: '/app/x' } },
  ])('rejects unsupported settings: %j', (extra) => {
    expect(() => parseConfig({ ...config, ...extra }, base)).toThrow();
  });
  it('accepts explicit preapproval only for a pinned deployment and defaults to prompting', () => {
    expect(parseConfig(config, base).permissionMode).toBe('prompt');
    expect(parseConfig({ ...config, permissionMode: 'preapproved', sha256: 'a'.repeat(64) }, base).permissionMode).toBe('preapproved');
  });
  it('resolves the directory endpoints on the same origin as the page', () => {
    const page = 'https://example.test/play/snake';
    expect(
      parseConfig(
        {
          ...config,
          bundle: '/api/apps/snake/bundle.softn?v=3',
          directory: { runs: '/api/apps/snake/runs', storage: '/api/apps/snake/storage' },
        },
        page
      )
    ).toMatchObject({
      bundle: 'https://example.test/api/apps/snake/bundle.softn?v=3',
      directory: {
        runs: 'https://example.test/api/apps/snake/runs',
        storage: 'https://example.test/api/apps/snake/storage',
      },
    });
    expect(parseConfig({ ...config, directory: {} }, base).directory).toEqual({
      runs: undefined,
      storage: undefined,
    });
    expect(parseConfig(config, base).directory).toBeUndefined();
  });
  it('validates declarations without broadening malformed or missing permissions', () => {
    expect(
      parsePermissions({ permissions: { net: { enabled: true, allowed_hosts: ['example.test'] } } })
        .permissions.net?.enabled
    ).toBe(true);
    for (const value of [
      null,
      {},
      { permissions: null },
      { permissions: [] },
      { permissions: { unknown: { enabled: true } } },
      { permissions: { net: { enabled: 'true' } } },
    ])
      expect(() => parsePermissions(value)).toThrow();
  });
  it('different policies and bundles yield different grant identities', async () => {
    expect(await digest(new TextEncoder().encode('bundle:a;net:x'))).not.toBe(
      await digest(new TextEncoder().encode('bundle:a;net:y'))
    );
  });
});
describe('bounded fetch', () => {
  it('does not follow redirects or cache bundle responses', async () => {
    const request = vi.fn(async () => new Response('hello'));
    vi.stubGlobal('fetch', request);
    expect(new TextDecoder().decode(await fetchBytes(base, new AbortController().signal, 10))).toBe(
      'hello'
    );
    expect(request.mock.calls[0]?.length).toBe(2);
    expect(request).toHaveBeenCalledWith(
      base,
      expect.objectContaining({ redirect: 'error', cache: 'no-store' })
    );
  });
  it('lets a caller opt a version-addressed bundle into the browser cache', async () => {
    const request = vi.fn(async () => new Response('hello'));
    vi.stubGlobal('fetch', request);
    await fetchBytes(base, new AbortController().signal, 10, 'default');
    expect(request).toHaveBeenCalledWith(
      base,
      expect.objectContaining({ redirect: 'error', cache: 'default' })
    );
  });
  it('rejects HTTP failures', async () => {
    vi.stubGlobal('fetch', async () => new Response('missing', { status: 404 }));
    await expect(fetchBytes(base, new AbortController().signal, 10)).rejects.toThrow();
  });
  it('enforces the size cap for streamed responses without Content-Length', async () => {
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(new Uint8Array(6));
              c.enqueue(new Uint8Array(6));
              c.close();
            },
          })
        )
    );
    await expect(fetchBytes(base, new AbortController().signal, 10)).rejects.toThrow('size');
  });
});

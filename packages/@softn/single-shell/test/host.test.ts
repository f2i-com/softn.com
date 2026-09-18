import { describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config';
import { loadHost, type HostBackendCall } from '../src/host';

const base = 'https://example.test/nested/runtime.config.json';
const config = { version: 1, id: 'example', title: 'Example', bundle: './app.softn' };

describe('a host module named by the configuration', () => {
  it('is optional, and absent means no backend rather than an error', async () => {
    const parsed = parseConfig(config, base);
    expect(parsed.host).toBeUndefined();
    await expect(loadHost(parsed, () => Promise.reject(Error('should not import')))).resolves.toBeUndefined();
  });

  it('resolves beside the configuration, like the bundle', () => {
    expect(parseConfig({ ...config, host: './host.mjs' }, base).host).toBe(
      'https://example.test/nested/host.mjs'
    );
    expect(parseConfig({ ...config, host: '/modules/host.mjs' }, base).host).toBe(
      'https://example.test/modules/host.mjs'
    );
  });

  // It runs with the page's own authority, outside the bundle's sandbox, so a
  // location the bundle rule would refuse is refused here too.
  it.each([
    'https://other.test/host.mjs',
    'javascript:alert(1)',
    'data:text/javascript,export default () => () => 0',
    'https://user:secret@example.test/host.mjs',
    './host.mjs#fragment',
    '',
    42,
  ])('refuses an unsafe location: %j', (host) => {
    expect(() => parseConfig({ ...config, host }, base)).toThrow();
  });

  it('hands the factory the configuration and returns what it produces', async () => {
    const parsed = parseConfig({ ...config, host: './host.mjs' }, base);
    const call: HostBackendCall = async (action) => ({ result: action });
    let seen: unknown;
    let imported = '';
    const loaded = await loadHost(parsed, async (url) => {
      imported = url;
      return {
        default: (context: { config: unknown }) => {
          seen = context.config;
          return call;
        },
      };
    });
    expect(imported).toBe('https://example.test/nested/host.mjs');
    expect(seen).toBe(parsed);
    expect(loaded).toBe(call);
  });

  it('waits for an asynchronous factory', async () => {
    const parsed = parseConfig({ ...config, host: './host.mjs' }, base);
    const call: HostBackendCall = async () => null;
    await expect(loadHost(parsed, async () => ({ default: async () => call }))).resolves.toBe(call);
  });

  // Fails closed: an app deployed with a host and running without one looks
  // broken in ways that point everywhere except at the host.
  it.each([
    ['exports nothing', {}],
    ['exports something that is not a function', { default: { call: () => 0 } }],
    ['produces something that is not a function', { default: () => 'backend' }],
  ])('refuses a module that %s', async (_, module) => {
    const parsed = parseConfig({ ...config, host: './host.mjs' }, base);
    await expect(loadHost(parsed, async () => module)).rejects.toThrow();
  });

  it('passes a failure to import through rather than swallowing it', async () => {
    const parsed = parseConfig({ ...config, host: './host.mjs' }, base);
    await expect(
      loadHost(parsed, () => Promise.reject(Error('404 host.mjs')))
    ).rejects.toThrow('404 host.mjs');
  });
});

describe('the layout a configuration asks for', () => {
  it('defaults to an app pinned to the viewport', () => {
    expect(parseConfig(config, base).layout).toBe('app');
  });
  it.each(['app', 'page'] as const)('accepts %s', (layout) => {
    expect(parseConfig({ ...config, layout }, base).layout).toBe(layout);
  });
  it.each(['document', 'PAGE', '', 1, true])('refuses %j', (layout) => {
    expect(() => parseConfig({ ...config, layout }, base)).toThrow();
  });
});

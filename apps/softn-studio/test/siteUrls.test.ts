import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

async function urls(base: string, dev = true) {
  vi.resetModules();
  vi.stubEnv('BASE_URL', base);
  vi.stubEnv('DEV', dev);
  vi.stubEnv('VITE_WEB_URL', '');
  vi.stubEnv('VITE_SITE_URL', '');
  return import('../src/lib/siteUrls');
}

it('uses the shared site and runtime paths under the integrated /studio/ dev base', async () => {
  expect(await urls('/studio/')).toMatchObject({ SITE_URL: '/', PUBLISH_URL: '/publish', RUNTIME_URL: '/web/' });
});

it('retains standalone dev defaults and same-origin production defaults', async () => {
  expect(await urls('/')).toMatchObject({ SITE_URL: 'http://localhost:1421', RUNTIME_URL: 'http://localhost:1420' });
  expect(await urls('/', false)).toMatchObject({ SITE_URL: '/', PUBLISH_URL: '/publish', RUNTIME_URL: '/web/' });
});

it('honors explicitly configured receiver URLs', async () => {
  await urls('/studio/');
  vi.resetModules();
  vi.stubEnv('VITE_WEB_URL', '/tools/runtime/');
  vi.stubEnv('VITE_SITE_URL', 'https://example.com/apps/');
  expect(await import('../src/lib/siteUrls')).toMatchObject({ SITE_URL: 'https://example.com/apps/', PUBLISH_URL: 'https://example.com/apps/publish', RUNTIME_URL: '/tools/runtime/' });
});

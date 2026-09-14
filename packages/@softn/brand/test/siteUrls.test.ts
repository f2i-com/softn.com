import { describe, expect, it } from 'vitest';
import { resolveSiteUrls } from '../src/siteUrls';

describe('resolveSiteUrls', () => {
  it('uses same-origin paths in production', () => {
    expect(resolveSiteUrls({ dev: false, baseUrl: '/builder/', env: {} })).toMatchObject({
      SITE_URL: '/', RUNTIME_URL: '/web/', STUDIO_URL: '/studio/', BUILDER_URL: '/builder/', PUBLISH_URL: '/publish', PRODUCT_URLS: undefined,
    });
  });

  it('points at the standalone dev ports only when the app is its own origin', () => {
    expect(resolveSiteUrls({ dev: true, baseUrl: '/', env: {} })).toMatchObject({
      SITE_URL: 'http://localhost:1421', RUNTIME_URL: 'http://localhost:1420', STUDIO_URL: 'http://localhost:1423', BUILDER_URL: 'http://localhost:1422',
    });
    // The integrated launcher serves the editor under the public path: same origin again.
    expect(resolveSiteUrls({ dev: true, baseUrl: '/studio/', env: {} })).toMatchObject({ SITE_URL: '/', PUBLISH_URL: '/publish', RUNTIME_URL: '/web/' });
    expect(resolveSiteUrls({ dev: true, baseUrl: '/builder/', env: {} })).toMatchObject({ SITE_URL: '/', RUNTIME_URL: '/web/', STUDIO_URL: '/studio/' });
  });

  it('honours explicitly configured receivers', () => {
    expect(resolveSiteUrls({ dev: true, baseUrl: '/studio/', env: { VITE_WEB_URL: '/tools/runtime/', VITE_SITE_URL: 'https://example.com/apps/' } })).toMatchObject({
      SITE_URL: 'https://example.com/apps/', PUBLISH_URL: 'https://example.com/apps/publish', RUNTIME_URL: '/tools/runtime/',
    });
  });

  it('sends a desktop build to softn.com, product bar included', () => {
    const urls = resolveSiteUrls({ desktop: true, dev: true, baseUrl: './', env: { VITE_WEB_URL: 'http://localhost:1420' } });
    expect(urls).toMatchObject({ SITE_URL: 'https://softn.com/', RUNTIME_URL: 'https://softn.com/web/', STUDIO_URL: 'https://softn.com/studio/', PUBLISH_URL: 'https://softn.com/publish' });
    expect(urls.PRODUCT_URLS).toMatchObject({ home: 'https://softn.com/', apps: 'https://softn.com/apps', builder: 'https://softn.com/builder/', docs: 'https://softn.com/docs/' });
  });
});

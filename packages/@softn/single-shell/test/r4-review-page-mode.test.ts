/**
 * Page mode and the engine check, read as the composer reads a site
 * (audit round 4).
 *
 * - The files a page names were fetched as written: `main.js?v=3` (how a site
 *   outruns a cache) was refused as "not a file beside the page", and a
 *   root-relative `/main.js` on a page at the site's root was not fetched, so
 *   the composer, which reads both as `main.js` (core's pageFilePath), then
 *   said the file was not in the bundle. The app did not open.
 * - A page served at a clean address (`/notes/about`, as hosts serve
 *   `about.html`) is an HTML answer for a path without `.html`, which this read
 *   as "the site has no such file": "The page is empty".
 * - Whether an app needs the full engine read every code file but its HTML
 *   pages, which are a Studio project's usual pages.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('@softn/runtime-shell/bundleProcessor', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  loadXDBData: vi.fn(async () => {}),
}));
import { loadPageApplication } from '../src/page';
import { needsFullEngine } from '../src/assemble';

/** The site's files; a path not here is a 404. Pages are answered as HTML. */
function serve(site: string, files: Record<string, string>) {
  const asked: string[] = [];
  vi.stubGlobal('fetch', async (input: URL | string) => {
    const url = new URL(String(input));
    asked.push(url.pathname + url.search);
    const path = url.pathname.slice(new URL(site).pathname.length);
    if (url.origin !== new URL(site).origin || !(path in files)) return new Response('not here', { status: 404 });
    const html = !/\.(?:js|css|json|xdb)$/.test(path);
    return new Response(files[path], { headers: { 'content-type': html ? 'text/html' : 'text/plain' } });
  });
  return asked;
}

afterEach(() => vi.unstubAllGlobals());

const load = (pageUrl: string) => loadPageApplication({ pageUrl, runtimeScripts: [] }, new AbortController().signal);

describe('a page that names its files as a site does', () => {
  it('loads a script and a stylesheet written with a query', async () => {
    const site = 'https://example.test/notes/';
    const asked = serve(site, {
      'index.html': '<!DOCTYPE html><html><head><link rel="stylesheet" href="styles.css?v=2"><script src="main.js?v=3"></script></head><body><h1>{title}</h1></body></html>',
      'styles.css': 'h1 { color: teal }',
      'main.js': 'let title = "Notes"',
    });
    await expect(load(`${site}index.html`)).resolves.toBeDefined();
    expect(asked).toContain('/notes/main.js');
    expect(asked).toContain('/notes/styles.css');
  });

  it('loads a file named from the site’s root, for a page at the root', async () => {
    const site = 'https://example.test/';
    const asked = serve(site, {
      'index.html': '<!DOCTYPE html><html><head><script src="/main.js"></script></head><body><h1>{title}</h1></body></html>',
      'main.js': 'let title = "Notes"',
    });
    await expect(load(`${site}index.html`)).resolves.toBeDefined();
    expect(asked).toContain('/main.js');
  });

  it('opens a page served at a clean address', async () => {
    const site = 'https://example.test/notes/';
    serve(site, {
      about: '<!DOCTYPE html><html><head><title>About</title></head><body><p>About us</p></body></html>',
    });
    await expect(load(`${site}about`)).resolves.toBeDefined();
  });
});

describe('whether an app needs the full engine', () => {
  it('reads its HTML pages too', () => {
    const javascript = { languages: ['javascript'], source: '<p>{n}</p>' };
    const files = new Map([
      ['index.html', '<a href="pages/report.html">Report</a>'],
      ['pages/report.html', '<p>{total.toLocaleString("en")}</p>'],
    ]);
    expect(needsFullEngine(javascript, files)).toBe(true);
    expect(needsFullEngine(javascript, new Map([['index.html', '<p>plain</p>']]))).toBe(false);
  });
});

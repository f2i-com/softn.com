/**
 * A page of a site as the app (page.ts): the page and what it names, fetched
 * from beside it and assembled as a bundle's text is.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('@softn/runtime-shell/bundleProcessor', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  loadXDBData: vi.fn(async () => {}),
}));
import { loadPageApplication, withoutRuntimeScripts } from '../src/page';

const SITE = 'https://example.test/notes/';
const RUNTIME = [`${SITE}softn/softn.js`];

const PAGE = `<!DOCTYPE html>
<html><head>
<script src="softn/softn.js"></script>
<title>Field notes</title>
<link rel="stylesheet" href="styles.css">
<link rel="stylesheet" href="https://fonts.example.com/a.css">
<script src="js/main.js"></script>
<script src="https://cdn.example.com/lib.js"></script>
</head><body>
<import About from="./pages/about.html" />
<data><collection name="tasks" as="tasks" /></data>
<h1>{notes.length}</h1>
<About />
</body></html>`;

/** The site's files; a path not here is a 404. */
function serve(files: Record<string, string>) {
  const asked: string[] = [];
  vi.stubGlobal('fetch', async (input: URL | string) => {
    const url = new URL(String(input));
    asked.push(url.pathname);
    const path = url.pathname.slice(new URL(SITE).pathname.length);
    return url.origin === new URL(SITE).origin && path in files
      ? new Response(files[path])
      : new Response('not here', { status: 404 });
  });
  return asked;
}

const FILES = {
  'index.html': PAGE,
  'styles.css': 'h1 { color: teal }',
  'js/main.js': 'import { count } from "./count.js"\nexport let notes = []',
  'js/count.js': 'export function count() { return 1 }',
  'pages/about.html': '<p>About</p>',
  'xdb/tasks.xdb': '{"collection":"tasks","records":[]}',
};

afterEach(() => vi.unstubAllGlobals());

describe('a page of a site', () => {
  it('is the app, with every file it names fetched from beside it', async () => {
    const asked = serve(FILES);
    const app = await loadPageApplication(
      { pageUrl: `${SITE}index.html#top`, runtimeScripts: [`${SITE}softn/softn.js`] },
      new AbortController().signal
    );
    expect([...app.textFiles.keys()].sort()).toEqual([
      'index.html',
      'js/count.js',
      'js/main.js',
      'manifest.json',
      'pages/about.html',
      'styles.css',
      'xdb/tasks.xdb',
    ]);
    // Nothing from another site, and not the runtime's own script.
    expect(asked.some((path) => path.includes('softn.js') || path.includes('lib.js'))).toBe(false);
    expect(app.textFiles.get('index.html')).not.toContain('softn/softn.js');
    const manifest = JSON.parse(app.textFiles.get('manifest.json')!);
    expect(manifest).toMatchObject({
      name: 'Field notes',
      main: 'index.html',
      files: { ui: ['index.html', 'pages/about.html'], logic: ['js/main.js', 'js/count.js'], xdb: ['xdb/tasks.xdb'] },
    });
    expect(app.config).toMatchObject({ title: 'Field notes', layout: 'page', theme: 'light', id: 'site' });
    // The page's code, its stylesheet and the imported page are composed in.
    expect(app.source).toContain('h1 { color: teal }');
    expect(app.source).toContain('<p>About</p>');
    expect(app.source).toContain('let notes = []');
    // Granted nothing it did not declare, and keyed to the site's folder.
    expect(app.declared).toEqual({ permissions: {} });
    expect(app.appId).toBe('page:/notes/:site');
  });

  it('is keyed to the site, so every page of it reads the same records', async () => {
    serve({ ...FILES, 'other.html': '<p>{1}</p>' });
    const signal = new AbortController().signal;
    const index = await loadPageApplication({ pageUrl: `${SITE}index.html`, runtimeScripts: RUNTIME }, signal);
    const other = await loadPageApplication({ pageUrl: `${SITE}other.html`, runtimeScripts: RUNTIME }, signal);
    expect(other.appId).toBe(index.appId);
  });

  it('reads a manifest.json and a permission.json the site keeps, and stays the main page itself', async () => {
    serve({
      ...FILES,
      'manifest.json': JSON.stringify({ id: 'field-notes', name: 'Notes app', main: 'ui/main.ui', config: { theme: { mode: 'dark' } } }),
      'permission.json': JSON.stringify({ permissions: { storage: { enabled: true } } }),
    });
    const app = await loadPageApplication({ pageUrl: `${SITE}index.html`, runtimeScripts: RUNTIME }, new AbortController().signal);
    const manifest = JSON.parse(app.textFiles.get('manifest.json')!);
    expect(manifest.main).toBe('index.html');
    expect(manifest.config).toEqual({ theme: { mode: 'dark' } });
    expect(app.themeMode).toBe('dark');
    expect(app.appId).toBe('page:/notes/:field-notes');
    expect(app.declared.permissions).toMatchObject({ storage: { enabled: true } });
  });

  it('answers asset() with the path, for the browser to read from the site', async () => {
    serve(FILES);
    const app = await loadPageApplication({ pageUrl: `${SITE}index.html`, runtimeScripts: RUNTIME }, new AbortController().signal);
    expect(app.assets('images/logo.png')).toBe('images/logo.png');
    expect(app.assets('./images/logo.png')).toBe('images/logo.png');
    expect(app.assets('../secret.png')).toBe('');
    expect(app.assets('https://example.com/a.png')).toBe('');
  });

  it('is read from its folder’s address, as a server answers that with its default page', async () => {
    const asked = serve(FILES);
    const stub = globalThis.fetch;
    vi.stubGlobal('fetch', async (input: URL | string) =>
      new URL(String(input)).href === SITE ? new Response(PAGE) : (stub as typeof fetch)(input)
    );
    const app = await loadPageApplication({ pageUrl: SITE, runtimeScripts: RUNTIME }, new AbortController().signal);
    expect(JSON.parse(app.textFiles.get('manifest.json')!).main).toBe('index.html');
    expect(app.source).toContain('<p>About</p>');
    expect(asked).not.toContain('/notes/index.html');
  });

  it('refuses a page on another site, and says when it is empty', async () => {
    serve({ 'index.html': '   ' });
    await expect(loadPageApplication({ pageUrl: 'ftp://example.test/index.html' }, new AbortController().signal)).rejects.toThrow();
    await expect(loadPageApplication({ pageUrl: `${SITE}index.html`, runtimeScripts: RUNTIME }, new AbortController().signal)).rejects.toThrow('The page is empty');
  });
});

describe('the runtime scripts on a page', () => {
  it('are taken off it, wherever they are written and however they are spelled', () => {
    const page = '<script src="softn/softn.js"></script><script src="./softn/softn.js" /><script src="js/main.js"></script>';
    expect(withoutRuntimeScripts(page, `${SITE}index.html`, [`${SITE}softn/softn.js`])).toBe('<script src="js/main.js"></script>');
  });
});

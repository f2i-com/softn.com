// @vitest-environment jsdom
/**
 * A page run by softn.js keeps the layout its head declares. softn.js turns
 * everything after its tag into text, the head's metas included, so the
 * shell puts the page's viewport, theme-color and color-scheme into the
 * document itself; without the viewport a page drew at 980 pixels on a phone.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('@softn/runtime-shell/bundleProcessor', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  loadXDBData: vi.fn(async () => {}),
}));
import { adoptHeadMetas, loadPageApplication, pageHeadMetas } from '../src/page';

const SITE = 'https://example.test/notes/';

function headMetas() {
  return [...document.head.querySelectorAll('meta[name]')].map((element) => ({
    name: element.getAttribute('name'),
    content: element.getAttribute('content'),
    media: element.getAttribute('media'),
  }));
}

afterEach(() => {
  document.head.replaceChildren();
  vi.unstubAllGlobals();
});

describe('the page’s layout metas, in the document', () => {
  it('are added to a head that has none', () => {
    adoptHeadMetas([
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { name: 'theme-color', content: '#fff', media: '(prefers-color-scheme: light)' },
      { name: 'theme-color', content: '#000', media: '(prefers-color-scheme: dark)' },
    ]);
    expect(headMetas()).toEqual([
      { name: 'viewport', content: 'width=device-width, initial-scale=1', media: null },
      { name: 'theme-color', content: '#fff', media: '(prefers-color-scheme: light)' },
      { name: 'theme-color', content: '#000', media: '(prefers-color-scheme: dark)' },
    ]);
  });

  it('replace what the head has under the same name rather than doubling it', () => {
    document.head.innerHTML =
      '<meta name="viewport" content="width=980"><meta name="description" content="kept"><meta name="theme-color" content="red">';
    adoptHeadMetas([{ name: 'viewport', content: 'width=device-width' }]);
    expect(headMetas()).toEqual([
      { name: 'description', content: 'kept', media: null },
      { name: 'theme-color', content: 'red', media: null },
      { name: 'viewport', content: 'width=device-width', media: null },
    ]);
  });

  it('leave a meta the browser already read, when it is the page’s own', () => {
    // A page that names its metas before softn.js: the browser read them,
    // and the very same element stays, so the layout is not thrown and redone.
    document.head.innerHTML = '<meta name="viewport" content="width=device-width, initial-scale=1">';
    const read = document.head.firstElementChild;
    adoptHeadMetas(pageHeadMetas('<head><meta name="viewport" content="width=device-width, initial-scale=1"></head>'));
    expect(document.head.firstElementChild).toBe(read);
    expect(document.head.querySelectorAll('meta').length).toBe(1);
  });

  it('do nothing without a document', () => {
    expect(() => adoptHeadMetas([{ name: 'viewport', content: 'width=device-width' }], undefined)).not.toThrow();
  });

  it('are in the document once a page run by softn.js starts', async () => {
    const page = `<!DOCTYPE html><html><head>
<script src="softn/softn.js"></script>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Notes</title>
</head><body><h1>Notes</h1></body></html>`;
    vi.stubGlobal('fetch', async (input: URL | string) => {
      const url = new URL(String(input));
      return url.pathname === '/notes/index.html' ? new Response(page) : new Response('not here', { status: 404 });
    });
    await loadPageApplication({ pageUrl: `${SITE}index.html`, runtimeScripts: [`${SITE}softn/softn.js`] }, new AbortController().signal);
    expect(headMetas()).toEqual([{ name: 'viewport', content: 'width=device-width, initial-scale=1', media: null }]);
  });
});

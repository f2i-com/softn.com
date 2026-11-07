/**
 * What an ordinary HTML page writes, as the parser, the composer and the renderer's helpers read it. Each of these was
 * run in a real browser through the runtime and did not work: a root path or a `?v=3` kept the app from opening, a
 * handler with `document` or `alert` in it did nothing, `<body onload>` never ran, and a formatter's multi-line import
 * was a syntax error.
 */
import { describe, expect, it } from 'vitest';
import { bundlePageAt, composeBundleSource, mainPage, pageFilePath } from '../src/bundle';
import { codeWithoutText, hasPageHandlers } from '../src/document-shell/names';
import { parse } from '../src/parser';
import { bundlePathOf, keepFormOnPage } from '../src/renderer/html-elements';
import { moduleSyntaxAsScript } from '../src/runtime/module-syntax';

const manifest = JSON.stringify({ id: 'local.page', name: 'Page', version: '1.0.0', main: 'index.html' });
const files = (more: Record<string, string>) => new Map(Object.entries({ 'manifest.json': manifest, ...more }));
const element = (source: string) => parse(source).template[0] as unknown as { tag: string; events: { name: string }[]; props: { name: string }[] };

describe('a page’s paths', () => {
  it('a leading / is the project’s root, and a ?query or #fragment says nothing about the file', () => {
    expect(pageFilePath('index.html', '/js/app.js')).toBe('js/app.js');
    expect(pageFilePath('pages/about.html', '/js/app.js')).toBe('js/app.js');
    expect(pageFilePath('index.html', 'main.js?v=3')).toBe('main.js');
    expect(pageFilePath('pages/about.html', '../site.css#top')).toBe('site.css');
    expect(() => pageFilePath('index.html', '../../outside.js')).toThrow(/Unsafe import path/);
    expect(() => pageFilePath('index.html', '/../outside.js')).toThrow(/Unsafe import path/);
  });

  it('a page with them opens, with its script and its stylesheet', () => {
    const composed = composeBundleSource(
      files({
        'index.html': '<html><head><link rel="stylesheet" href="/css/site.css?v=3"><script src="/js/app.js?v=3"></script></head><body><p>Hi</p></body></html>',
        'js/app.js': 'let word = "from the root";',
        'css/site.css': 'p { color: rgb(1, 2, 3); }',
      }),
      'index.html'
    );
    expect(composed.source).toContain('from the root');
    expect(composed.source).toContain('rgb(1, 2, 3)');
  });

  it('an image from the root is the project’s file, and another site’s stays another site’s', () => {
    expect(bundlePathOf('/images/x.png')).toBe('images/x.png');
    expect(bundlePathOf('images/x.png?v=1')).toBe('images/x.png');
    expect(bundlePathOf('../images/x.png')).toBe('images/x.png');
    expect(bundlePathOf('//cdn.example/x.png')).toBeNull();
    expect(bundlePathOf('https://cdn.example/x.png')).toBeNull();
    expect(bundlePathOf('data:image/png;base64,AAAA')).toBeNull();
  });

  it('a link between a site’s pages finds the page, from where it stands', () => {
    const pages = files({ 'index.html': '<p>1</p>', 'pages/two.html': '<p>2</p>', 'styles.css': 'p {}' });
    expect(mainPage(pages)).toBe('index.html');
    expect(bundlePageAt(pages, 'index.html', 'pages/two.html')).toBe('pages/two.html');
    expect(bundlePageAt(pages, 'pages/two.html', '../index.html')).toBe('index.html');
    expect(bundlePageAt(pages, 'pages/two.html', '/index.html?x=1#top')).toBe('index.html');
    expect(bundlePageAt(pages, 'index.html', 'styles.css')).toBeNull();
    expect(bundlePageAt(pages, 'index.html', 'https://example.com/index.html')).toBeNull();
  });
});

describe('a handler written for a browser', () => {
  it.each([
    ['onclick="alert(\'Saved\')"'],
    ['onclick="document.getElementById(\'m\').hidden = true"'],
    ['onsubmit="event.preventDefault(); document.title = \'sent\'"'],
    ['onclick="location.href = \'about.html\'"'],
  ])('%s stays the attribute, so the page is given its document for it', (attribute) => {
    const page = parse(`<button ${attribute}>x</button>`);
    expect(element(`<button ${attribute}>x</button>`).events).toEqual([]);
    expect(hasPageHandlers(page.template)).toBe(true);
    expect(page.diagnostics ?? [], 'and nothing warns of it').toEqual([]);
  });

  it('one that calls the page’s own logic is still read as SoftN reads it', () => {
    expect(element('<button onclick="save()">x</button>').events.map((e) => e.name)).toEqual(['click']);
    expect(element('<input onchange="total = 1">').events.map((e) => e.name)).toEqual(['change']);
  });

  it.each([
    ['onclick="status = \'Moved to history.\'"'],
    ['onclick="note = \'Check the URL.\' /* not location.href */"'],
    ['onclick="msg = `Open the document. ${count}`"'],
  ])('%s, naming the browser only in its text, is still SoftN’s, as before parser 15', (attribute) => {
    expect(element(`<button ${attribute}>x</button>`).events.map((e) => e.name)).toEqual(['click']);
  });

  it('a template’s code is read: `${document.title}` is the browser’s', () => {
    expect(element('<button onclick="msg = `Now: ${document.title}`">x</button>').events).toEqual([]);
  });

  it('a quote inside a regular expression hides nothing after it, and a division is no regular expression', () => {
    expect(element('<button onclick="ok = /\'/.test(s); alert(1)">x</button>').events).toEqual([]);
    expect(element('<button onclick="half = total / 2; note = \'See history.\'">x</button>').events.map((e) => e.name)).toEqual(['click']);
    expect(codeWithoutText("a = /[/']x/; b = c / d / e; f('history.')")).toBe("a = /[/']x/; b = c / d / e; f('')");
  });

  it('code given as text, and a quote never closed, are still read as code', () => {
    expect(element('<button onclick="setTimeout(\'history.back()\', 500)">x</button>').events).toEqual([]);
    expect(element('<button onclick="eval(\'location.reload()\')">x</button>').events).toEqual([]);
    const page = parse('<button onclick="t = it\'s; document.title = t">x</button>');
    expect((page.template[0] as unknown as { events: unknown[] }).events).toEqual([]);
    expect(page.diagnostics ?? [], 'and nothing warns of it').toEqual([]);
  });

  it('a long handler is read in time, slashes and all', () => {
    const started = performance.now();
    codeWithoutText('a' + '/b'.repeat(64 * 1024));
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it('codeWithoutText keeps the code and leaves out what strings and comments say', () => {
    expect(codeWithoutText(`alert('a.b'); x = "it's" // history.back()`)).toBe(`alert(''); x = "" `);
    expect(codeWithoutText('a /* location.href */ + `t ${ {k: 1}.k } u` + \'\\\'q\'')).toBe("a   + `  {k: 1}.k  ` + ''");
  });

  it('<body onload> is held for the page’s document, which fires it once the page is drawn', () => {
    const page = parse('<body onload="init()"><p>Hi</p></body>');
    const body = page.template[0] as unknown as { tag: string; events: unknown[]; props: { name: string }[] };
    expect(body.tag).toBe('div');
    expect(body.events).toEqual([]);
    expect(body.props.map((p) => p.name).sort()).toEqual(['data-softn-body', 'onload']);
    expect(hasPageHandlers(page.template)).toBe(true);
  });
});

describe('a form', () => {
  const submitted = (props: Record<string, unknown>) => {
    let stopped = false;
    keepFormOnPage(props as never);
    (props.onSubmit as ((event: unknown) => void) | undefined)?.({ preventDefault: () => { stopped = true; } });
    return stopped;
  };

  it('with no action keeps its page', () => {
    expect(submitted({})).toBe(true);
  });

  it('with an action goes there', () => {
    expect(submitted({ action: 'contact.php' })).toBe(false);
  });

  it('whose handler for a browser cancels stays, as that handler runs too late to', () => {
    expect(submitted({ action: 'contact.php', onsubmit: 'event.preventDefault(); send()' })).toBe(true);
    expect(submitted({ action: 'contact.php', onsubmit: 'send(); return false' })).toBe(true);
    expect(submitted({ action: 'contact.php', onsubmit: 'check()' })).toBe(false);
  });
});

describe('an import as a formatter leaves it', () => {
  it('over several lines is read as one, and leaves those lines behind so an error’s line is the author’s', () => {
    const code = 'import {\n  a,\n  b\n} from "./lib.js";\nboom();';
    const read = moduleSyntaxAsScript(code);
    expect(read.split('\n')[0]).toBe('import "./lib.js"');
    expect(read.split('\n')).toHaveLength(code.split('\n').length);
    expect(read.split('\n')[4]).toBe('boom();');
  });

  it('as does an export of names', () => {
    const code = 'let a = 1;\nexport {\n  a\n};\nboom();';
    const read = moduleSyntaxAsScript(code);
    expect(read).not.toContain('export');
    expect(read.split('\n')).toHaveLength(code.split('\n').length);
  });

  it('a rename stays as written, and fails as it did', () => {
    const code = 'import {\n  a as b\n} from "./lib.js";';
    expect(moduleSyntaxAsScript(code)).toBe(code);
  });
});

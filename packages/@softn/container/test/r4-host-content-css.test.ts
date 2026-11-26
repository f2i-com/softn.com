/**
 * Round 4 (container host, the page as the archive wrote it): stylesheets and what the
 * first page's elements are given.
 */
import { describe, expect, it } from 'vitest';
import { ContainerArchive } from '../src/archive';
import { prepareHtmlDocument, sanitizeContainerCss } from '../src/sanitize';
import { rewriteCss } from '../src/css-policy';

const PERMS = { permissions: {} };

async function prepare(files: Record<string, string>, page = 'index.html') {
  const archive = await ContainerArchive.open(files);
  const prepared = prepareHtmlDocument(archive.readText(page)!, page, archive, PERMS, false);
  const viewport = document.createElement('div');
  const docRoot = document.createElement('div');
  prepared.mountInitialDom(viewport, new Map(), docRoot);
  return { archive, prepared, viewport, docRoot };
}

/** The rules the page's one `<style>` holds, as a browser reads it (softn-app joins the sheets with a line between). */
function rulesOf(styles: string[]): string[] {
  const el = document.createElement('style');
  el.textContent = styles.join('\n');
  document.head.appendChild(el);
  const rules = [...el.sheet!.cssRules].map((rule) => rule.cssText.replace(/\s+/g, ' '));
  el.remove();
  return rules;
}

describe("a stylesheet's media", () => {
  it('applies a print or a small-screen sheet to those media only', async () => {
    const { prepared } = await prepare({
      'index.html':
        '<!doctype html><head>' +
        '<link rel="stylesheet" href="print.css" media="print">' +
        '<link rel="stylesheet" href="all.css" media="all">' +
        '<style media="screen and (max-width: 600px)">.menu{display:none}</style>' +
        '</head><body><p>x</p></body>',
      'print.css': 'body{visibility:hidden}.article{visibility:visible}',
      'all.css': '.a{color:blue}',
    });
    expect(prepared.styles[0]).toMatch(/^@media print\{/);
    expect(prepared.styles[1]).toBe('.a{color:blue}');
    expect(prepared.styles[2]).toMatch(/^@media screen and \(max-width: 600px\)\{/);
    // What a browser makes of it: rules inside the media rules, not on every screen.
    const rules = rulesOf(prepared.styles);
    expect(rules).toHaveLength(3);
    expect(rules[0]).toMatch(/^@media print \{/);
    expect(rules[2]).toMatch(/^@media screen and \(max-width: 600px\)/);
  });

  it('keeps for all media a sheet the page turns on itself, and a list no query is written with', async () => {
    const { prepared } = await prepare({
      'index.html':
        '<!doctype html><head>' +
        `<link rel="stylesheet" href="app.css" media="print" onload="this.media='all'">` +
        '<link rel="stylesheet" href="b.css" media="print{} *{color:red}">' +
        '</head><body></body>',
      'app.css': '.app{color:green}',
      'b.css': '.b{color:blue}',
    });
    expect(prepared.styles).toEqual(['.app{color:green}', '.b{color:blue}']);
  });

  it('reads rel as a list of words, and leaves an alternate sheet off', async () => {
    const { prepared } = await prepare({
      'index.html':
        '<!doctype html><head>' +
        '<link rel="stylesheet " href="a.css"><link rel="Stylesheet\tpreload" href="b.css">' +
        '<link rel="alternate stylesheet" title="Contrast" href="c.css">' +
        '</head><body></body>',
      'a.css': '.a{color:red}',
      'b.css': '.b{color:red}',
      'c.css': '.c{color:red}',
    });
    expect(prepared.styles).toEqual(['.a{color:red}', '.b{color:red}']);
  });
});

describe('a sheet that ends with something open', () => {
  it('does not take the sheets after it into its last rule', async () => {
    const { prepared } = await prepare({
      'index.html':
        '<!doctype html><head><link rel="stylesheet" href="a.css"><link rel="stylesheet" href="b.css">' +
        '<style>.c{color:green}</style></head><body></body>',
      // A last `}` left out, as browsers forgive, and a function and a prelude left open.
      'a.css': '.a{color:red}\n.a2{margin:0',
      'b.css': '.b{color:rgb(0,0,255)}\n.b2{color:rgb(1,2',
    });
    const rules = rulesOf(prepared.styles);
    expect(rules.map((rule) => rule.split(' {')[0])).toEqual(['.a', '.a2', '.b', '.b2', '.c']);
  });

  it('is closed as the end of a sheet closes it', async () => {
    const archive = await ContainerArchive.open({ 'index.html': '<!doctype html>' });
    const css = (text: string) => sanitizeContainerCss(text, 'index.html', archive, PERMS, false);
    expect(css('.a{color:red')).toBe('.a{color:red}');
    expect(css('@media (min-width: 1px){.a{color:red}')).toBe('@media (min-width: 1px){.a{color:red}}');
    expect(css('.a{x:y}.b')).toBe('.a{x:y}.b{}');
    expect(css('.a{x:y}@layer one, two')).toBe('.a{x:y}@layer one, two;');
    expect(css('.a{x:y}@media (min-width: 1px')).toBe('.a{x:y}@media (min-width: 1px);');
    expect(css('a[href="}"]{content:"{"}')).toBe('a[href="}"]{content:"{"}');
    // A whole sheet, and an inline style, are as they were.
    expect(css('.a{color:red}')).toBe('.a{color:red}');
    expect(sanitizeContainerCss('color: rgb(1,2', 'index.html', archive, PERMS, false, 'inline')).toBe('color: rgb(1,2');
  });
});

describe('a font or a picture written into a stylesheet', () => {
  it('is kept under the types the tools that write them use', async () => {
    const archive = await ContainerArchive.open({ 'index.html': '<!doctype html>' });
    const css = (text: string) => sanitizeContainerCss(text, 'index.html', archive, PERMS, false);
    for (const type of ['application/x-font-ttf', 'application/x-font-woff', 'application/font-woff2', 'application/octet-stream', 'font/woff2']) {
      const out = css(`@font-face{font-family:icons;src:url(data:${type};charset=utf-8;base64,AAEAAA) format("woff")}`);
      expect(out, type).toContain(`url("data:${type};charset=utf-8;base64,AAEAAA")`);
    }
    expect(css('.b{background:url(data:image/jpg;base64,/9j/4AAQ)}')).toContain('url("data:image/jpg;base64,/9j/4AAQ")');
    // What can be more than a picture or a font is not.
    expect(css('.c{background:url(data:text/html;base64,PHA+)}')).toContain('url("about:blank")');
    expect(css('.d{background:url(data:application/xhtml+xml;base64,PHA+)}')).toContain('url("about:blank")');
  });

  it('is kept on an img the page draws as a JPEG', async () => {
    const { viewport } = await prepare({ 'index.html': '<!doctype html><img src="data:image/jpg;base64,/9j/4AAQ">' });
    expect(viewport.querySelector('img')!.getAttribute('src')).toBe('data:image/jpg;base64,/9j/4AAQ');
  });
});

describe("the fragment of an address of the app's own file", () => {
  it('stays on the address the page is handed for it', async () => {
    const realCreate = URL.createObjectURL;
    URL.createObjectURL = (() => 'blob:https://embedder.example/1') as typeof URL.createObjectURL;
    try {
      const { archive, viewport } = await prepare({
        'index.html':
          '<!doctype html><video id="v" src="media/clip.mp4#t=0.5" preload="metadata"></video>' +
          '<img id="s" src="sprite.svg#icon-home"><img id="p" srcset="sprite.svg#icon-home 1x, sprite.svg#icon-away 2x"><img id="n" src="sprite.svg">',
        'media/clip.mp4': '\u0000\u0000\u0000\u0018ftypmp42',
        'sprite.svg': '<svg xmlns="http://www.w3.org/2000/svg"><view id="icon-home" viewBox="0 0 16 16"/></svg>',
      });
      expect(viewport.querySelector('#v')!.getAttribute('src')).toBe('blob:https://embedder.example/1#t=0.5');
      expect(viewport.querySelector('#s')!.getAttribute('src')).toMatch(/^data:image\/svg\+xml;base64,[A-Za-z0-9+/=]+#icon-home$/);
      expect(viewport.querySelector('#p')!.getAttribute('srcset')).toMatch(/#icon-home 1x, data:image\/svg\+xml;base64,[A-Za-z0-9+/=]+#icon-away 2x$/);
      expect(viewport.querySelector('#n')!.getAttribute('src')).toMatch(/^data:image\/svg\+xml;base64,[A-Za-z0-9+/=]+$/);
      const css = sanitizeContainerCss('.i{background:url(sprite.svg#icon-home)}', 'index.html', archive, PERMS, false);
      expect(css).toMatch(/^\.i\{background:url\("data:image\/svg\+xml;base64,[A-Za-z0-9+/=]+#icon-home"\)\}$/);
    } finally {
      URL.createObjectURL = realCreate;
    }
  });
});

describe('@namespace', () => {
  it('keeps the namespace a sheet names, which is never fetched', () => {
    expect(rewriteCss('@namespace url(http://www.w3.org/1999/xhtml);\np{color:red}', () => null)).toBe(
      '@namespace url("http://www.w3.org/1999/xhtml");\np{color:red}'
    );
    expect(rewriteCss("@namespace svg 'http://www.w3.org/2000/svg';svg|a{fill:red}", () => null)).toBe(
      '@namespace svg url("http://www.w3.org/2000/svg");svg|a{fill:red}'
    );
  });

  it('reads anything but its plain form as before', () => {
    // An address after an unquoted `url(` with a quote in it is read by a browser up to the
    // first `)`: what follows is not the namespace's, and is not passed on as written.
    const out = rewriteCss('@namespace x url(a"b);@import url(https://evil.example/x.css)"c);', () => null);
    expect(out).not.toContain('evil.example');
    expect(rewriteCss('@namespace x url(https://evil.example/a\\29 b);', () => null)).not.toContain('evil.example');
  });
});

describe("the page's own html and body", () => {
  it('are given what the patcher gives them: dir and lang on the body too', async () => {
    const { viewport, docRoot } = await prepare({
      'index.html':
        '<!doctype html><html lang="ar" dir="rtl" title="t" data-theme="dark"><body dir="rtl" lang="ar" class="home" role="main" title="Home" data-page="1" aria-busy="false" id="home" style="color:red">x</body></html>',
    });
    expect(viewport.getAttribute('dir')).toBe('rtl');
    expect(viewport.getAttribute('lang')).toBe('ar');
    expect(viewport.getAttribute('title')).toBe('Home');
    expect(viewport.getAttribute('class')).toBe('home');
    expect(viewport.getAttribute('role')).toBe('main');
    expect(viewport.getAttribute('data-page')).toBe('1');
    expect(viewport.getAttribute('aria-busy')).toBe('false');
    expect(viewport.getAttribute('style')).toBe('color:red');
    // Not one the patcher refuses for it.
    expect(viewport.hasAttribute('id')).toBe(false);
    expect(docRoot.getAttribute('dir')).toBe('rtl');
    expect(docRoot.getAttribute('lang')).toBe('ar');
    expect(docRoot.getAttribute('data-theme')).toBe('dark');
  });

  it('give a muted video of the page its muted state, which it plays by itself with', async () => {
    const { viewport } = await prepare({
      'index.html': '<!doctype html><video id="v" autoplay muted loop playsinline></video><audio id="a" muted></audio><video id="loud"></video>',
    });
    expect((viewport.querySelector('#v') as HTMLVideoElement).muted).toBe(true);
    expect((viewport.querySelector('#a') as HTMLAudioElement).muted).toBe(true);
    expect((viewport.querySelector('#loud') as HTMLVideoElement).muted).toBe(false);
  });
});

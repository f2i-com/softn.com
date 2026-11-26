/**
 * A container app runs with scripting on, so what its page holds in `<noscript>` is not the
 * app's: a browser that runs scripts neither runs nor applies it.
 */
import { describe, expect, it } from 'vitest';
import { ContainerArchive } from '../src/archive';
import { prepareHtmlDocument } from '../src/sanitize';
import { findInlineScriptStartLines } from '../src/source-map';

const PERMS = { permissions: {} };

describe('a page with <noscript>', () => {
  it('runs no script and applies no style that is inside it', async () => {
    const archive = await ContainerArchive.open({
      'index.html':
        '<!doctype html><html><head>' +
        '<noscript><style>body{display:none}</style><link rel="stylesheet" href="fallback.css"></noscript>' +
        '</head><body>' +
        '<noscript><script>window.fallbackRan = true;</script><p id="nojs">Please turn on JavaScript</p></noscript>' +
        '<p id="app">app</p>\n' +
        '<script>\nwindow.appRan = true;\n</script>' +
        '</body></html>',
      'fallback.css': 'p{color:red}',
    });
    const prepared = prepareHtmlDocument(archive.readText('index.html')!, 'index.html', archive, PERMS, false);
    expect(prepared.scripts.map((s) => s.code.trim())).toEqual(['window.appRan = true;']);
    expect(prepared.styles.join('\n')).not.toContain('display:none');
    expect(prepared.styles.join('\n')).not.toContain('color:red');

    const viewport = document.createElement('div');
    prepared.mountInitialDom(viewport, new Map(), document.createElement('div'));
    expect(viewport.querySelector('#app')).not.toBeNull();
    expect(viewport.querySelector('#nojs')).toBeNull();
  });

  it('gives the scripts after it their own start lines', async () => {
    const html = [
      '<!doctype html><html><body>',
      '<noscript>',
      '<script>console.log("never");</script>',
      '</noscript>',
      '<script>',
      'first();',
      '</script>',
      '<script>',
      'second();',
      '</script>',
      '</body></html>',
    ].join('\n');
    const archive = await ContainerArchive.open({ 'index.html': html });
    const prepared = prepareHtmlDocument(html, 'index.html', archive, PERMS, false);
    expect(prepared.scripts.map((s) => s.code.trim())).toEqual(['first();', 'second();']);
    // The page's own reading of where its scripts start passes the <noscript> over, as a
    // browser that runs scripts does; each script must get its own entry of it.
    const starts = findInlineScriptStartLines(html);
    expect(starts).toHaveLength(2);
    expect(prepared.scripts.map((s) => s.startLine)).toEqual(starts);
    const lines = html.split('\n');
    expect(lines[starts[0] - 1] + lines[starts[0]]).toContain('first();');
  });
});

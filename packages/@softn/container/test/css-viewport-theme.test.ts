import { describe, it, expect, beforeEach } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mountSoftNContainer } from '../src/index';
import {
  extractFontFaces,
  rewritePageSelectorList,
  rewriteViewportUnitsInValue,
  transformContainerCss,
} from '../src/css-policy';

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LITE_WASM = path.join(PKG_ROOT, 'dist', 'runtime', 'engines', 'zipp-javascript-lite.wasm');

function settle(ms = 60): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('container CSS scoping, viewport units, bundled fonts, and offset geometry', () => {
  beforeEach(() => {
    localStorage.clear();
    document.body.innerHTML = '';
    for (const el of Array.from(document.head.querySelectorAll('style[data-softn-fonts]'))) el.remove();
  });

  it('scopes :root and html to [data-softn-docroot] and body to [data-softn-viewport] across @layer/@media/selectors', () => {
    expect(rewritePageSelectorList(':root')).toBe('[data-softn-docroot]');
    expect(rewritePageSelectorList('html[data-theme="light"]')).toBe('[data-softn-docroot][data-theme="light"]');
    expect(rewritePageSelectorList('html[data-density=compact] body')).toBe(
      '[data-softn-docroot][data-density=compact] [data-softn-viewport]'
    );
    expect(rewritePageSelectorList('html.dark > body .card')).toBe(
      '[data-softn-docroot].dark > [data-softn-viewport] .card'
    );
    expect(rewritePageSelectorList(':where(html, body)')).toBe(
      ':where([data-softn-docroot], [data-softn-viewport])'
    );
    // Must not touch class names, ids, attribute values, or longer identifiers
    expect(rewritePageSelectorList('.body #html [data-body="html"] x-body html5')).toBe(
      '.body #html [data-body="html"] x-body html5'
    );

    const layered = transformContainerCss(
      `@layer base { :root { --bg: #0a0d12; } html[data-theme=light] { --bg: #f5f3ee; } body { background: var(--bg); height: 100dvh; } }`,
      { scopeSelectors: true, rewriteViewportUnits: true }
    );
    expect(layered).toContain('[data-softn-docroot] { --bg: #0a0d12; }');
    expect(layered).toContain('[data-softn-docroot][data-theme=light] { --bg: #f5f3ee; }');
    expect(layered).toContain('[data-softn-viewport] { background: var(--bg); height: calc(100 * var(--softn-vh, 1vh)); }');
  });

  it('rewrites viewport length units cleanly without touching property names, strings, or url()', () => {
    expect(rewriteViewportUnitsInValue('100dvh')).toBe('calc(100 * var(--softn-vh, 1vh))');
    expect(rewriteViewportUnitsInValue('100vw')).toBe('calc(100 * var(--softn-vw, 1vw))');
    expect(rewriteViewportUnitsInValue('-50svh')).toBe('calc(-50 * var(--softn-vh, 1vh))');
    expect(rewriteViewportUnitsInValue('calc(100vh - 48px)')).toBe(
      'calc(calc(100 * var(--softn-vh, 1vh)) - 48px)'
    );
    expect(rewriteViewportUnitsInValue('translateY(-25lvh)')).toBe(
      'translateY(calc(-25 * var(--softn-vh, 1vh)))'
    );
    expect(rewriteViewportUnitsInValue('var(--h-100vh) "100dvh" url("/img/100vh.png") 16px')).toBe(
      'var(--h-100vh) "100dvh" url("/img/100vh.png") 16px'
    );

    // Inline style attribute: keep custom property name intact while rewriting its value
    const inlineStyle = transformContainerCss('--h-100vh: 100dvh; width: 100vw;', {
      scopeSelectors: false,
      rewriteViewportUnits: true,
      inline: true,
    });
    expect(inlineStyle).toBe('--h-100vh: calc(100 * var(--softn-vh, 1vh)); width: calc(100 * var(--softn-vw, 1vw));');
  });

  it('extracts flat @font-face rules (including inside @layer) and rejects nested blocks', () => {
    const css = `
      @layer base {
        @font-face { font-family: "Fraunces"; src: url("blob:font1") format("woff2"); }
      }
      @font-face { font-family: "Evil"; .x { color: red; } }
      body { font-family: "Fraunces"; }
    `;
    const extracted = extractFontFaces(css);
    expect(extracted).toContain('font-family: "Fraunces"');
    expect(extracted).toContain('blob:font1');
    expect(extracted).not.toContain('Evil');
    expect(extracted).not.toContain('color: red');
  });

  it('supports toggling html[data-theme] on document.documentElement and resolves frontendRoot CSS font assets', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const fakeWoff2 = new Uint8Array([0x77, 0x4f, 0x46, 0x32, 0x00, 0x01, 0x00, 0x00]);
    const handle = await mountSoftNContainer(host, {
      isolation: 'inline',
      engineWasm: { lite: LITE_WASM },
      permissionMode: 'deny',
      theme: 'dark',
      source: {
        'manifest.json': JSON.stringify({
          name: 'ThemeFontApp',
          version: '1.0.0',
          engine: 2,
          main: 'app/dist/index.html',
          frontendRoot: 'app/dist',
        }),
        'app/dist/assets/custom.woff2': fakeWoff2,
        'app/dist/assets/app.css': `
          @font-face {
            font-family: "CustomAppFont";
            src: url("/assets/custom.woff2") format("woff2");
          }
          :root { --bg: #0a0d12; }
          html[data-theme="light"] { --bg: #f5f3ee; }
          .shell { height: 100dvh; width: 100vw; background: var(--bg); }
        `,
        'app/dist/index.html': `<!doctype html>
          <html lang="en" data-theme="dark">
            <head><link rel="stylesheet" href="/assets/app.css"></head>
            <body>
              <div class="shell"><button id="toggle">Switch</button></div>
              <script>
                document.getElementById('toggle').addEventListener('click', function () {
                  var next = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
                  document.documentElement.setAttribute('data-theme', next);
                });
              </script>
            </body>
          </html>`,
      },
    });
    await settle(100);

    const docRoot = handle.shadowRoot.querySelector('[data-softn-docroot]') as HTMLElement;
    const viewport = handle.shadowRoot.querySelector('[data-softn-viewport]') as HTMLElement;
    expect(docRoot.getAttribute('data-theme')).toBe('dark');
    // Unmodified web apps (not using softn:ui.css) must not have a hard-coded data-theme forced on viewport
    expect(viewport.hasAttribute('data-theme')).toBe(false);

    // Stylesheet resolved `/assets/custom.woff2` through `frontendRoot` (never `about:blank`)
    const sheetText = [...handle.shadowRoot.querySelectorAll('style')].map((s) => s.textContent ?? '').join('\n');
    expect(sheetText).toContain('[data-softn-docroot][data-theme="light"]');
    expect(sheetText).toContain('calc(100 * var(--softn-vh, 1vh))');
    expect(sheetText).not.toContain('about:blank');

    // `@font-face` mirrored into document.head so ShadowRoot typography works in Chromium
    const headFontStyle = document.head.querySelector(`style[data-softn-fonts="${handle.appId}"]`);
    expect(headFontStyle?.textContent).toContain('CustomAppFont');
    expect(headFontStyle?.textContent).toMatch(/blob:|data:/);

    // Clicking toggle updates `[data-softn-docroot][data-theme]` cleanly between dark and light
    const toggleBtn = handle.shadowRoot.querySelector('#toggle') as HTMLButtonElement;
    toggleBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, composed: true }));
    await expect.poll(() => docRoot.getAttribute('data-theme')).toBe('light');
    toggleBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, composed: true }));
    await expect.poll(() => docRoot.getAttribute('data-theme')).toBe('dark');

    // Disposing removes mirrored host `@font-face` style cleanly
    handle.dispose();
    expect(document.head.querySelector(`style[data-softn-fonts="${handle.appId}"]`)).toBeNull();
  });

  it('reports host offsetLeft and offsetTop separately from viewport rect x/y', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const handle = await mountSoftNContainer(host, {
      isolation: 'inline',
      engineWasm: { lite: LITE_WASM },
      permissionMode: 'deny',
      source: {
        'index.html': `<!doctype html><html><body>
          <div id="parent"><button id="btn">SIM</button></div>
          <pre id="out"></pre>
          <script>
            var btn = document.getElementById('btn');
            // Ask host to measure btn
            btn.getBoundingClientRect();
            document.getElementById('btn').addEventListener('click', function () {
              document.getElementById('out').textContent = btn.offsetLeft + ',' + btn.offsetTop + ',' + Math.round(btn.getBoundingClientRect().left);
            });
          </script>
        </body></html>`,
      },
    });
    await settle(100);

    const btn = handle.shadowRoot.querySelector('#btn') as HTMLElement;
    const docRoot = handle.shadowRoot.querySelector('[data-softn-docroot]') as HTMLElement;
    docRoot.getBoundingClientRect = () =>
      ({ left: 0, top: 48, right: 1200, bottom: 900, width: 1200, height: 852, x: 0, y: 48, toJSON: () => ({}) });
    btn.getBoundingClientRect = () =>
      ({ left: 420, top: 160, right: 480, bottom: 184, width: 60, height: 24, x: 420, y: 160, toJSON: () => ({}) });
    Object.defineProperty(btn, 'offsetLeft', { configurable: true, value: 48 });
    Object.defineProperty(btn, 'offsetTop', { configurable: true, value: 2 });

    // Trigger a re-measure via a synthetic DOM change / second getBoundingClientRect cycle
    await settle(60);
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, composed: true }));
    await settle(80);
    // Re-click after ResizeObserver / rAF measurement flushed
    const out = handle.shadowRoot.querySelector('#out')!;
    // Trigger another measurement pass by appending an attribute and clicking again
    await expect.poll(async () => {
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, composed: true }));
      await settle(40);
      return out.textContent;
    }).toBe('48,2,420');

    handle.dispose();
  });
});

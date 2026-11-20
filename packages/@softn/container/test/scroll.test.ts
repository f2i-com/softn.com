/**
 * Where the person has scrolled an app's page and its elements to.
 *
 * The page told the app nothing of it: an element's `scrollTop` read what the app had last
 * written, `window.scrollY` stayed 0, and a `scroll` listener on the window was never called.
 * A list that draws only the rows in view (react-window, TanStack Virtual) drew the first
 * rows wherever the person scrolled; a "back to the top" button never showed.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mountSoftNContainer } from '../src/index';

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENGINES = path.join(PKG_ROOT, 'dist', 'runtime', 'engines');
const ENGINE_FILES = {
  lite: path.join(ENGINES, 'zipp-javascript-lite.wasm'),
  typescript: path.join(ENGINES, 'zipp-typescript.wasm'),
};

async function open(html: string) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const said: string[] = [];
  const handle = await mountSoftNContainer(host, {
    isolation: 'inline',
    engineWasm: ENGINE_FILES,
    permissionMode: 'deny',
    onConsole: (level, text) => said.push(`${level}: ${text}`),
    onError: (error) => said.push(`failed: ${error.message}`),
    source: { 'index.html': html },
  });
  const find = (selector: string) => handle.shadowRoot.querySelector(selector) as HTMLElement;
  const text = (selector: string) => find(selector)?.textContent ?? '';
  // jsdom lays nothing out and scrolls nothing: the person's scroll is a position and the event a browser sends with it.
  const scroll = (el: HTMLElement, top: number, left = 0) => {
    Object.defineProperty(el, 'scrollTop', { configurable: true, get: () => top, set: () => undefined });
    Object.defineProperty(el, 'scrollLeft', { configurable: true, get: () => left, set: () => undefined });
    el.dispatchEvent(new Event('scroll'));
  };
  return { handle, said, find, text, scroll };
}

describe('where the person has scrolled', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('is what an element’s scrollTop reads in its scroll listener', async () => {
    const { handle, said, find, text, scroll } = await open(`<!doctype html><html><body>
      <div id="list" style="height: 100px; overflow: auto"><div style="height: 5000px"></div></div>
      <p id="out">waiting</p>
      <script>
        var list = document.getElementById('list');
        list.addEventListener('scroll', function () { document.getElementById('out').textContent = 'at ' + list.scrollTop + ',' + list.scrollLeft; });
        document.getElementById('out').textContent = 'ready';
      </script></body></html>`);
    await expect.poll(() => text('#out'), { timeout: 10_000 }).toBe('ready');
    scroll(find('#list'), 600, 20);
    await expect.poll(() => text('#out'), { timeout: 5_000 }).toBe('at 600,20');
    // Scrolled on: the new place, and a side not scrolled reads 0.
    scroll(find('#list'), 640);
    await expect.poll(() => text('#out'), { timeout: 5_000 }).toBe('at 640,0');
    expect(said.filter((line) => !line.startsWith('log'))).toEqual([]);
    handle.dispose();
  });

  it('is the app’s page’s for window.scrollY, and a scroll listener on the window hears it', async () => {
    const { handle, find, text, scroll } = await open(`<!doctype html><html><body>
      <div style="height: 4000px">tall</div>
      <p id="out">waiting</p>
      <script>
        window.addEventListener('scroll', function (e) { document.getElementById('out').textContent = 'window at ' + window.scrollY + ' ' + (e.target === document); });
        document.getElementById('out').textContent = 'ready';
      </script></body></html>`);
    await expect.poll(() => text('#out'), { timeout: 10_000 }).toBe('ready');
    scroll(find('[data-softn-docroot]'), 250);
    await expect.poll(() => text('#out'), { timeout: 5_000 }).toBe('window at 250 true');
    handle.dispose();
  });

  it('is told once the scrolling stops, to an app that does not listen for it, and with the next event it hears', async () => {
    const { handle, find, text, scroll } = await open(`<!doctype html><html><body>
      <div id="list" style="height: 100px; overflow: auto"><div style="height: 5000px"></div></div>
      <button id="where">where</button>
      <p id="out">waiting</p><p id="polled">waiting</p>
      <script>
        var list = document.getElementById('list');
        document.getElementById('where').addEventListener('click', function () { document.getElementById('out').textContent = 'clicked at ' + list.scrollTop; });
        setInterval(function () { document.getElementById('polled').textContent = 'polled ' + list.scrollTop; }, 20);
        document.getElementById('out').textContent = 'ready';
      </script></body></html>`);
    await expect.poll(() => text('#out'), { timeout: 10_000 }).toBe('ready');
    scroll(find('#list'), 300);
    await expect.poll(() => text('#polled'), { timeout: 5_000 }).toBe('polled 300');
    // Scrolled and clicked at once: the click is heard with where the list is.
    scroll(find('#list'), 900);
    find('#where').click();
    await expect.poll(() => text('#out'), { timeout: 5_000 }).toBe('clicked at 900');
    handle.dispose();
  });
});

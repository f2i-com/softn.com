/**
 * The fonts an app's script declares in stylesheets it makes, which the container keeps in the
 * embedding page's head (a shadow root's @font-face rules load nowhere), to a budget.
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { mountSoftNContainer, type SoftNContainerHandle } from '../src/index';

const PKG_ROOT = path.resolve(__dirname, '..');
const LITE_WASM = new Uint8Array(fs.readFileSync(path.join(PKG_ROOT, 'dist', 'runtime', 'engines', 'zipp-javascript-lite.wasm')));

const APP = `<!doctype html><html><head></head><body><p id="out">-</p><button id="grow">grow</button><script>
  function face(family, size) {
    return '@font-face { font-family: "' + family + '"; src: url(data:font/woff2;base64,' + 'A'.repeat(size) + ') format("woff2"); }';
  }
  var one = document.createElement('style'); one.textContent = face('FaceOne', 200000); document.head.appendChild(one);
  var two = document.createElement('style'); two.textContent = face('FaceTwo', 200000); document.head.appendChild(two);
  var three = document.createElement('style'); three.textContent = face('FaceThree', 100000); document.head.appendChild(three);
  document.getElementById('grow').addEventListener('click', function () {
    one.textContent = face('FaceOneBigger', 250000);
    document.getElementById('out').textContent = 'grown';
  });
  document.getElementById('out').textContent = 'ready';
</script></body></html>`;

let handle: SoftNContainerHandle | null = null;

afterEach(() => {
  handle?.dispose();
  handle = null;
  document.body.innerHTML = '';
});

describe("the fonts of an app's own stylesheets", () => {
  it('uses the rules a stylesheet has now when it is rewritten past the budget, letting go of the oldest others', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    handle = await mountSoftNContainer(host, {
      isolation: 'inline',
      persistStorage: false,
      permissionMode: 'deny',
      engineWasm: { lite: LITE_WASM },
      source: { 'index.html': APP },
    });
    const text = (id: string) => handle!.shadowRoot.getElementById(id)?.textContent ?? '';
    const fonts = () => document.head.querySelector('style[data-softn-fonts]')?.textContent ?? '';
    await expect.poll(() => text('out'), { timeout: 10_000 }).toBe('ready');
    await expect.poll(() => fonts().includes('FaceThree'), { timeout: 5_000 }).toBe(true);
    (handle.shadowRoot.getElementById('grow') as HTMLElement).click();
    await expect.poll(() => text('out'), { timeout: 10_000 }).toBe('grown');
    // The rewritten sheet's fonts are its new ones; its old ones are not left in its place.
    await expect.poll(() => fonts().includes('FaceOneBigger'), { timeout: 5_000 }).toBe(true);
    expect(fonts()).not.toMatch(/FaceOne"/);
    expect(fonts().length).toBeLessThanOrEqual(512 * 1024);
  });
});

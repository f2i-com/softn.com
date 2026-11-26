/**
 * What an app keeps where the mount keeps nothing between visits (`persistStorage: false`: an
 * editor's preview, an app nested in another): it lasts as long as the mount does, across the
 * pages of the app, as it does in a browser's private window. Each page started from nothing.
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { mountSoftNContainer, type SoftNContainerHandle } from '../src/index';

const PKG_ROOT = path.resolve(__dirname, '..');
const LITE_WASM = new Uint8Array(fs.readFileSync(path.join(PKG_ROOT, 'dist', 'runtime', 'engines', 'zipp-javascript-lite.wasm')));

const ONE = `<!doctype html><html><body><p id="out">one</p><script type="module">
  import { db } from 'softn:db';
  db.create('notes', { text: 'remember the milk' });
  localStorage.setItem('token', 'abc123');
  sessionStorage.setItem('step', '2');
  var open = indexedDB.open('cart', 1);
  open.onupgradeneeded = function () { open.result.createObjectStore('items', { keyPath: 'id' }); };
  open.onsuccess = function () {
    var tx = open.result.transaction('items', 'readwrite');
    tx.objectStore('items').put({ id: 1, name: 'hat' });
    tx.oncomplete = function () { document.getElementById('out').textContent = 'kept'; };
  };
</script></body></html>`;

const TWO = `<!doctype html><html><body><p id="out">two</p><p id="cart">?</p><p id="notes">?</p><script type="module">
  import { db } from 'softn:db';
  document.getElementById('notes').textContent = 'notes=' + db.query('notes').map(function (n) { return n.text; }).join(',');
  document.getElementById('out').textContent = 'token=' + localStorage.getItem('token') + ' step=' + sessionStorage.getItem('step');
  var open = indexedDB.open('cart', 1);
  open.onupgradeneeded = function () { open.result.createObjectStore('items', { keyPath: 'id' }); };
  open.onsuccess = function () {
    var req = open.result.transaction('items').objectStore('items').getAll();
    req.onsuccess = function () { document.getElementById('cart').textContent = 'cart=' + req.result.map(function (r) { return r.name; }).join(','); };
  };
</script></body></html>`;

let handle: SoftNContainerHandle | null = null;

afterEach(() => {
  handle?.dispose();
  handle = null;
  document.body.innerHTML = '';
  localStorage.clear();
});

describe('a mount that keeps nothing between visits', () => {
  it("keeps the app's localStorage, sessionStorage and IndexedDB from one of its pages to the next", async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const said: string[] = [];
    handle = await mountSoftNContainer(host, {
      isolation: 'inline',
      persistStorage: false,
      permissionMode: 'deny',
      engineWasm: { lite: LITE_WASM },
      onError: (error) => said.push(error.message),
      source: { 'index.html': ONE, 'two.html': TWO },
    });
    const text = (id: string) => handle!.shadowRoot.getElementById(id)?.textContent ?? '';
    await expect.poll(() => text('out'), { timeout: 10_000 }).toBe('kept');
    await handle.navigate('/two.html');
    await expect.poll(() => text('out'), { timeout: 10_000 }).toBe('token=abc123 step=2');
    await expect.poll(() => text('cart'), { timeout: 10_000 }).toBe('cart=hat');
    expect(text('notes')).toBe('notes=remember the milk');
    // Nothing of it reached the page's storage, and nothing was said to be lost.
    expect(Object.keys(localStorage)).toEqual([]);
    expect(said).toEqual([]);
  });
});

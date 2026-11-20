/**
 * The same app mounted twice in one page, and what it keeps.
 *
 * The browser tells a write to the page's storage to the site's other pages, never to the
 * page that made it. Two of the same app in one page (a dashboard with the same widget
 * twice, an app and its preview) did not hear each other: each kept what it had read when it
 * started, and wrote the other's records away. And an app never heard a `storage` event at
 * all, from another tab or from anywhere.
 */
import { afterEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mountSoftNContainer } from '../src/index';

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENGINES = path.join(PKG_ROOT, 'dist', 'runtime', 'engines');
const ENGINE_FILES = {
  lite: path.join(ENGINES, 'zipp-javascript-lite.wasm'),
  typescript: path.join(ENGINES, 'zipp-typescript.wasm'),
};

const APP = `<!doctype html><html><body>
  <p id="out">waiting</p><p id="notes">waiting</p>
  <button id="write">write</button><button id="note">note</button>
  <script>
    var out = document.getElementById('out');
    window.addEventListener('storage', function (e) {
      out.textContent = 'heard ' + e.key + '=' + e.newValue + ' was ' + e.oldValue + ' ' + (e.storageArea === localStorage) + ' ' + localStorage.getItem('colour');
    });
    document.getElementById('write').addEventListener('click', function () { localStorage.setItem('colour', 'blue'); });
    var opening = indexedDB.open('notes', 1);
    opening.onupgradeneeded = function () { opening.result.createObjectStore('notes', { autoIncrement: true }); };
    opening.onsuccess = function () {
      var db = opening.result;
      document.getElementById('note').addEventListener('click', function () { db.transaction('notes', 'readwrite').objectStore('notes').add('a note'); });
      setInterval(function () {
        var count = db.transaction('notes').objectStore('notes').count();
        count.onsuccess = function () { document.getElementById('notes').textContent = 'notes ' + count.result; };
      }, 30);
      out.textContent = 'ready';
    };
  </script></body></html>`;

async function mount(storagePrefix: string) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const said: string[] = [];
  const handle = await mountSoftNContainer(host, {
    isolation: 'inline',
    engineWasm: ENGINE_FILES,
    permissionMode: 'deny',
    storagePrefix,
    onConsole: (level, text) => said.push(`${level}: ${text}`),
    onError: (error) => said.push(`failed: ${error.message}`),
    source: { 'index.html': APP },
  });
  const find = (selector: string) => handle.shadowRoot.querySelector(selector) as HTMLElement;
  const text = (selector: string) => find(selector)?.textContent ?? '';
  await expect.poll(() => text('#out'), { timeout: 10_000 }).toBe('ready');
  return { handle, said, find, text };
}

describe('the same app twice in one page', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    localStorage.clear();
  });

  it('each hears what the other keeps in localStorage, as a storage event, and never its own', async () => {
    const one = await mount('softn-test-neighbours:');
    const two = await mount('softn-test-neighbours:');
    one.find('#write').click();
    await expect.poll(() => two.text('#out'), { timeout: 5_000 }).toBe('heard colour=blue was null true blue');
    expect(one.text('#out')).toBe('ready');
    // Another app (kept somewhere else) hears nothing of it.
    const other = await mount('softn-test-someone-else:');
    two.find('#write').click();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(other.text('#out')).toBe('ready');
    expect([...one.said, ...two.said, ...other.said].filter((line) => !line.startsWith('log'))).toEqual([]);
    for (const app of [one, two, other]) app.handle.dispose();
  });

  it('each reads the records the other adds to its IndexedDB', async () => {
    const one = await mount('softn-test-neighbours-idb:');
    const two = await mount('softn-test-neighbours-idb:');
    await expect.poll(() => two.text('#notes'), { timeout: 5_000 }).toBe('notes 0');
    one.find('#note').click();
    await expect.poll(() => two.text('#notes'), { timeout: 5_000 }).toBe('notes 1');
    two.find('#note').click();
    await expect.poll(() => one.text('#notes'), { timeout: 5_000 }).toBe('notes 2');
    await expect.poll(() => two.text('#notes'), { timeout: 5_000 }).toBe('notes 2');
    one.handle.dispose();
    two.handle.dispose();
  });
});

/**
 * What a mount saves of an app's session (session-store.ts) as the app keeps things.
 *
 * With the page's localStorage, that is where the app's localStorage is kept and read back
 * from; the session keeps its route and its sessionStorage. A copy of the whole localStorage
 * was saved again after every key the app kept, and never read.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const saved: Array<{ base: string; localStorage: Record<string, string>; sessionStorage: Record<string, string>; urlPath?: string }> = [];

vi.mock('../src/session-store', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/session-store')>();
  return {
    ...real,
    saveContainerSession: (base: string, session: { localStorage: Record<string, string>; sessionStorage: Record<string, string>; urlPath?: string }) => {
      saved.push({ base, localStorage: { ...session.localStorage }, sessionStorage: { ...session.sessionStorage }, urlPath: session.urlPath });
      return Promise.resolve(true);
    },
  };
});

const { mountSoftNContainer } = await import('../src/index');

const PKG_ROOT = path.resolve(__dirname, '..');
const LITE_WASM = new Uint8Array(fs.readFileSync(path.join(PKG_ROOT, 'dist', 'runtime', 'engines', 'zipp-javascript-lite.wasm')));

const APP = `<!doctype html><html><body><p id="out">-</p><button id="keep">keep</button><button id="tab">tab</button>
<script>
  var n = 0;
  document.getElementById('out').textContent = 'had ' + (localStorage.getItem('draft') || 'nothing');
  document.getElementById('keep').addEventListener('click', function () {
    n++;
    localStorage.setItem('draft', 'version ' + n + ' ' + 'x'.repeat(2000));
    localStorage.setItem('n', String(n));
  });
  document.getElementById('tab').addEventListener('click', function () { sessionStorage.setItem('tab', 'two'); });
</script></body></html>`;

afterEach(() => {
  document.body.innerHTML = '';
  localStorage.clear();
  saved.length = 0;
});

async function mount() {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const handle = await mountSoftNContainer(host, {
    isolation: 'inline',
    engineWasm: { lite: LITE_WASM },
    permissionMode: 'deny',
    storagePrefix: 'r4-session:',
    source: { 'index.html': APP },
  });
  const find = (id: string) => handle.shadowRoot.getElementById(id) as HTMLElement;
  return { handle, find };
}

describe("an app's session", () => {
  it('saves no copy of localStorage the page already keeps, and the app still finds what it kept', async () => {
    const first = await mount();
    await expect.poll(() => first.find('out').textContent).toBe('had nothing');
    await new Promise((resolve) => setTimeout(resolve, 120));
    const before = saved.length;
    for (let i = 0; i < 5; i++) {
      first.find('keep').click();
      await new Promise((resolve) => setTimeout(resolve, 80));
    }
    expect(localStorage.getItem('r4-session:ls:n')).toBe('5');
    // A key kept in the page's storage is no session to save.
    expect(saved.length - before).toBe(0);
    expect(saved.every((s) => Object.keys(s.localStorage).length === 0)).toBe(true);
    // What the session does keep is still saved.
    first.find('tab').click();
    await expect.poll(() => saved.some((s) => s.sessionStorage.tab === 'two'), { timeout: 2_000 }).toBe(true);
    first.handle.dispose();

    const again = await mount();
    await expect.poll(() => again.find('out').textContent).toMatch(/^had version 5 x+$/);
    again.handle.dispose();
  });
});

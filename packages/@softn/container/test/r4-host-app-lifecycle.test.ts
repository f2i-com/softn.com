/**
 * What a mount holds of the embedding page (its listeners) and lets go of when it ends,
 * including a mount another took the place of while it was still starting.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mountSoftNContainer, type BackendTransport } from '../src/index';

/** Listeners of these kinds on the window and the document, as they are added and removed. */
function trackListeners(types: readonly string[]) {
  const live = new Map<string, Set<unknown>>();
  for (const type of types) live.set(type, new Set());
  for (const target of [window, document] as EventTarget[]) {
    const add = target.addEventListener.bind(target);
    const remove = target.removeEventListener.bind(target);
    vi.spyOn(target, 'addEventListener').mockImplementation((type: string, fn: EventListenerOrEventListenerObject | null, opts?: boolean | AddEventListenerOptions) => {
      live.get(type)?.add(fn);
      add(type, fn, opts);
    });
    vi.spyOn(target, 'removeEventListener').mockImplementation((type: string, fn: EventListenerOrEventListenerObject | null, opts?: boolean | EventListenerOptions) => {
      live.get(type)?.delete(fn);
      remove(type, fn, opts);
    });
  }
  return (type: string) => live.get(type)?.size ?? 0;
}

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
  localStorage.clear();
});

describe('what another tab does to the page storage', () => {
  it("hears another tab clear the site's whole localStorage: the app's keys are gone for it too", async () => {
    const LITE_WASM = new Uint8Array(
      (await import('node:fs')).readFileSync(
        (await import('node:path')).join(__dirname, '..', 'dist', 'runtime', 'engines', 'zipp-javascript-lite.wasm')
      )
    );
    const host = document.createElement('div');
    document.body.appendChild(host);
    const handle = await mountSoftNContainer(host, {
      isolation: 'inline',
      permissionMode: 'deny',
      engineWasm: { lite: LITE_WASM },
      storagePrefix: 'r4-cleared:',
      source: {
        'index.html': `<!doctype html><html><body><p id="out">-</p><button id="read">read</button><script>
          localStorage.setItem('theme', 'dark');
          document.getElementById('read').addEventListener('click', function () {
            document.getElementById('out').textContent = 'theme=' + localStorage.getItem('theme');
          });
          document.getElementById('out').textContent = 'ready';
        </script></body></html>`,
      },
    });
    const text = () => handle.shadowRoot.getElementById('out')?.textContent ?? '';
    await expect.poll(text, { timeout: 10_000 }).toBe('ready');
    expect(localStorage.getItem('r4-cleared:ls:theme')).toBe('dark');
    // Another tab clears the site's storage (a "clear all data" of the embedding site's own).
    localStorage.clear();
    window.dispatchEvent(new StorageEvent('storage', { key: null, oldValue: null, newValue: null, storageArea: localStorage }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    (handle.shadowRoot.getElementById('read') as HTMLElement).click();
    await expect.poll(text, { timeout: 5_000 }).toBe('theme=null');
    handle.dispose();
  });
});

describe('a mount and the page it is in', () => {
  it('leaves no listener on the page when another mount takes its element while its backend connects', async () => {
    const listening = trackListeners(['pagehide', 'visibilitychange', 'storage']);
    let connect!: () => void;
    const transport: BackendTransport = {
      kind: 'remote',
      ready: new Promise<void>((resolve) => {
        connect = resolve;
      }),
      fetch: async () => ({ status: 200, statusText: 'OK', headers: [], body: new Uint8Array() }),
      dispose: () => undefined,
    };
    const host = document.createElement('div');
    document.body.appendChild(host);
    const first = mountSoftNContainer(host, {
      isolation: 'inline',
      permissionMode: 'deny',
      backendTransport: transport,
      storagePrefix: 'r4-first:',
      source: { 'index.html': '<!doctype html><p>first</p>' },
    });
    // The host draws again (a preview on a keystroke) before the first has connected.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const second = await mountSoftNContainer(host, {
      isolation: 'inline',
      permissionMode: 'deny',
      storagePrefix: 'r4-second:',
      source: { 'index.html': '<!doctype html><p>second</p>' },
    });
    connect();
    const firstHandle = await first;
    firstHandle.dispose();
    second.dispose();
    expect(listening('pagehide')).toBe(0);
    expect(listening('visibilitychange')).toBe(0);
    expect(listening('storage')).toBe(0);
  });
});

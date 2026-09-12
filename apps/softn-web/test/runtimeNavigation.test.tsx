/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import type { CachedApp } from '../src/lib/appCache';

const cache = vi.hoisted(() => ({ apps: [] as CachedApp[] }));
vi.mock('../src/lib/appCache', async (original) => ({
  ...await original<typeof import('../src/lib/appCache')>(),
  getCachedApps: vi.fn(async () => cache.apps),
  getCachedAppByName: vi.fn(async (name: string) => cache.apps.find((app) => app.name === name) ?? null),
  getCachedAppByOrigin: vi.fn(async (origin: string) => cache.apps.find((app) => app.origin === origin) ?? null),
  // Simulate a browser that can run apps but cannot persist a bundle cache.
  cacheApp: vi.fn(async () => null),
  updateLastOpened: vi.fn(async () => {}),
}));

import App from '../src/App';
import { getCachedAppByName } from '../src/lib/appCache';

let root: Root;
let container: HTMLDivElement;
const bundle = (name: string) => zipSync({
  'manifest.json': strToU8(JSON.stringify({ name, version: '1.0.0', main: 'ui/main.ui', files: { ui: ['ui/main.ui'] } }), true),
  'ui/main.ui': strToU8(`<App><Text>${name}</Text></App>`, true),
});
const response = (bytes: Uint8Array) => new Response(bytes as BodyInit, { headers: { 'content-type': 'application/octet-stream' } });
const emptyDirectory = () => new Response(JSON.stringify({ ok: true, apps: [], page: 1, pages: 1, total: 0 }));
async function settle() {
  for (let i = 0; i < 4; i++) await act(async () => { await new Promise((done) => setTimeout(done, 0)); });
}
async function mount(url: string) {
  window.history.replaceState({}, '', url);
  act(() => root.render(<App />));
  await settle();
}
async function click(selector: string) {
  const button = container.querySelector<HTMLElement>(selector);
  expect(button, selector).toBeTruthy();
  act(() => button!.click());
  await settle();
}

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
  localStorage.clear();
  cache.apps = [];
  vi.mocked(getCachedAppByName).mockReset().mockImplementation(async (name: string) => cache.apps.find((app) => app.name === name) ?? null);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  act(() => root.unmount());
  await settle();
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
  window.history.replaceState({}, '', '/');
});

describe('runtime entry and navigation ownership', () => {
  it('refreshes a cached directory app by its stored slug, even when the display name differs', async () => {
    const bytes = bundle('A Friendly Name');
    cache.apps = [{ id: 'cached', name: 'A Friendly Name', version: '1.0.0', directorySlug: 'real-directory-key', bundleData: bytes, cachedAt: 1, lastOpened: 1 }];
    const fetcher = vi.fn(async (input: string | URL) => String(input).endsWith('/api/apps/real-directory-key/bundle.softn') ? response(bytes) : emptyDirectory());
    vi.stubGlobal('fetch', fetcher);
    await mount('/app/A%20Friendly%20Name');
    expect(fetcher.mock.calls.some(([url]) => String(url).endsWith('/api/apps/real-directory-key/bundle.softn'))).toBe(true);
    expect(fetcher.mock.calls.some(([url]) => String(url).includes('/api/apps/A%20Friendly%20Name/'))).toBe(false);
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it('keeps the validated return path through canonical URLs and Home navigation', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => String(input).endsWith('/Example.softn') ? response(bundle('Example')) : emptyDirectory()));
    await mount('/?open=/Example.softn&back=%2Fapp%2Fexample%3Ffrom%3Ddirectory%23details');
    expect(window.location.pathname).toBe('/app/Example');
    expect(new URLSearchParams(window.location.search).get('back')).toBe('/app/example?from=directory#details');
    expect(new URLSearchParams(window.location.search).has('open')).toBe(false);
    expect(container.querySelector('.softn-frame-close')?.getAttribute('aria-label')).toBe('Stop the app and return to the page that opened it');
    await click('.softn-frame-home');
    expect(new URLSearchParams(window.location.search).get('back')).toBe('/app/example?from=directory#details');
  });

  it('leaves Home selected when an initial download completes in the background', async () => {
    let deliver!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => { deliver = resolve; });
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => String(input).endsWith('/Slow.softn') ? pending : emptyDirectory()));
    await mount('/?open=/Slow.softn');
    await click('.softn-frame-home');
    await act(async () => deliver(response(bundle('Slow app'))));
    await settle();
    expect(container.querySelector('[aria-label="Stop Slow app"]')).toBeTruthy();
    expect(container.querySelector('.softn-frame-home')).toBeNull();
    expect(window.location.pathname).toBe('/');
    expect(window.location.search).toBe('');
  });

  it('keeps a newer app selected when an older download finishes', async () => {
    const local = bundle('Newer selection');
    cache.apps = [{ id: 'newer', name: 'Newer selection', version: '1.0.0', bundleData: local, cachedAt: 1, lastOpened: 1 }];
    let deliver!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => { deliver = resolve; });
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => String(input).endsWith('/Slow.softn') ? pending : emptyDirectory()));
    await mount('/?open=/Slow.softn');
    await click('.softn-frame-home');
    await click('[aria-label="Open Newer selection"]');
    await act(async () => deliver(response(bundle('Older download'))));
    await settle();
    expect(container.querySelectorAll('.softn-launcher-run')).toHaveLength(2);
    expect(window.location.pathname).toBe('/app/Newer%20selection');
    expect(document.title).toBe('Newer selection');
  });

  it('retains embed mode while rejecting an external return destination', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => String(input).endsWith('/Example.softn') ? response(bundle('Example')) : emptyDirectory()));
    await mount('/?open=/Example.softn&embed=1&back=%2F%2Fevil.example%2Fapp');
    expect(window.location.pathname).toBe('/app/Example');
    expect(window.location.search).toBe('?embed=1');
    expect(container.querySelector('.softn-frame-home')).toBeNull();
  });

  it('keeps a cached local app’s initial page in its canonical URL', async () => {
    const bytes = bundle('Local notes');
    cache.apps = [{ id: 'local', name: 'Local notes', version: '1.0.0', bundleData: bytes, cachedAt: 1, lastOpened: 1 }];
    vi.stubGlobal('fetch', vi.fn(async () => emptyDirectory()));
    await mount('/app/Local%20notes/Archive');
    expect(window.location.pathname).toBe('/app/Local%20notes/Archive');
  });

  it('keeps a newer selection when the initial by-name cache lookup finishes late', async () => {
    const older: CachedApp = { id: 'older', name: 'Older cached app', version: '1.0.0', bundleData: bundle('Older cached app'), cachedAt: 1, lastOpened: 1 };
    const newer: CachedApp = { id: 'newer', name: 'Newer selection', version: '1.0.0', bundleData: bundle('Newer selection'), cachedAt: 1, lastOpened: 1 };
    cache.apps = [older, newer];
    let deliver!: (app: CachedApp) => void;
    vi.mocked(getCachedAppByName).mockImplementationOnce(() => new Promise((resolve) => { deliver = resolve; }));
    vi.stubGlobal('fetch', vi.fn(async () => emptyDirectory()));
    await mount('/app/Older%20cached%20app');
    await click('[aria-label="Open Newer selection"]');
    await act(async () => deliver(older));
    await settle();
    expect(container.querySelectorAll('.softn-launcher-run')).toHaveLength(2);
    expect(document.title).toBe('Newer selection');
    expect(window.location.pathname).toBe('/app/Newer%20selection');
  });

  it.each(['Home', 'newer app'])('keeps %s selected when an initial directory load falls back to its cached bytes', async (destination) => {
    const older: CachedApp = { id: 'older', name: 'Older published app', directorySlug: 'older-published', version: '1.0.0', bundleData: bundle('Older published app'), cachedAt: 1, lastOpened: 1 };
    const newer: CachedApp = { id: 'newer', name: 'Newer selection', version: '1.0.0', bundleData: bundle('Newer selection'), cachedAt: 1, lastOpened: 1 };
    cache.apps = [older, newer];
    let deliver!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => { deliver = resolve; });
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => String(input).endsWith('/api/apps/older-published/bundle.softn') ? pending : emptyDirectory()));
    await mount('/app/Older%20published%20app');
    await click('.softn-frame-home');
    if (destination === 'newer app') await click('[aria-label="Open Newer selection"]');
    await act(async () => deliver(new Response('offline', { status: 503 })));
    await settle();
    expect(container.querySelector('[aria-label="Stop Older published app"]')).toBeTruthy();
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(document.title).toBe(destination === 'Home' ? 'SoftN Web' : 'Newer selection');
    expect(window.location.pathname).toBe(destination === 'Home' ? '/' : '/app/Newer%20selection');
  });

  it('downloads the running bytes even when IndexedDB could not save their cache record', async () => {
    const bytes = bundle('Uncached app');
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => String(input).endsWith('/Uncached.softn') ? response(bytes) : emptyDirectory()));
    const NativeURL = URL;
    const createObjectURL = vi.fn((_blob: Blob) => 'blob:download');
    vi.stubGlobal('URL', class extends NativeURL { static createObjectURL = createObjectURL; static revokeObjectURL = vi.fn(); });
    const download = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    await mount('/?open=/Uncached.softn');
    await click('[aria-haspopup="menu"]');
    const menu = [...container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((item) => item.textContent?.includes('Download Uncached app.softn'))!;
    expect(menu).toBeTruthy();
    act(() => menu.click());
    await settle();
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(createObjectURL.mock.calls[0]?.[0]).toMatchObject({ size: bytes.byteLength, type: 'application/octet-stream' });
    expect(download).toHaveBeenCalledTimes(1);
  });
});

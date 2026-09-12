/** @vitest-environment jsdom */
/** Mount the actual runtime and launcher; only the IndexedDB bundle cache is
 * substituted. App-data reads, import/copy/delete and localStorage stay real. */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import type { CachedApp } from '../src/lib/appCache';

const cache = vi.hoisted(() => ({ apps: [] as CachedApp[] }));
vi.mock('../src/lib/appCache', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/appCache')>();
  return {
    ...actual,
    getCachedApps: vi.fn(async () => [...cache.apps]),
    getCachedApp: vi.fn(async (id: string) => cache.apps.find((app) => app.id === id) ?? null),
    getCachedAppByOrigin: vi.fn(async (origin: string) => cache.apps.find((app) => app.origin === origin) ?? null),
    getCachedAppByName: vi.fn(async (name: string) => cache.apps.find((app) => app.name === name) ?? null),
    cacheApp: vi.fn(async (_bytes: Uint8Array, manifest: { version: string }) => cache.apps.find((app) => app.version === manifest.version) ?? null),
    updateLastOpened: vi.fn(async () => {}),
    setOfflineState: vi.fn(async () => {}),
    removeCachedApp: vi.fn(async (id: string) => { cache.apps = cache.apps.filter((app) => app.id !== id); }),
  };
});

import App from '../src/App';
import { computeAppOrigin, exportAppData, removeCachedApp } from '../src/lib/appCache';

let root: Root;
let container: HTMLDivElement;
let current: CachedApp;
let older: CachedApp;
let confirm: ReturnType<typeof vi.spyOn>;
const dataKey = (app: CachedApp) => `softn:${app.origin}:saved-note`;

async function makeApp(version: string, lastOpened: number): Promise<CachedApp> {
  const manifest = { name: 'Data guard test', version, main: 'ui/main.ui', files: { ui: ['ui/main.ui'] } };
  const bundleData = zipSync({
    'manifest.json': strToU8(JSON.stringify(manifest), true),
    'ui/main.ui': strToU8('<App><Text>Data guard test</Text></App>', true),
  });
  return { id: version, name: manifest.name, version, bundleData, origin: await computeAppOrigin(bundleData), cachedAt: 1, lastOpened };
}

async function settle() {
  for (let i = 0; i < 4; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}
async function mount() {
  act(() => root.render(<App />));
  await settle();
}
async function click(selector: string) {
  const button = container.querySelector<HTMLElement>(selector);
  expect(button, selector).toBeTruthy();
  act(() => button!.click());
  await settle();
}
async function startAndReturnHome() {
  await click('[aria-label="Open Data guard test"]');
  expect(container.querySelector('[aria-label="Stop Data guard test"]')).toBeTruthy();
  await click('.softn-frame-home');
}
function dataFile(app: CachedApp, text?: () => Promise<string>): File {
  const snapshot = exportAppData(app)!;
  snapshot.stores.local['saved-note'] = 'imported note';
  const file = new File([], 'data-backup.json', { type: 'application/json' });
  Object.defineProperty(file, 'text', { value: text ?? (async () => JSON.stringify(snapshot)) });
  return file;
}
async function chooseImport(file: File) {
  const button = [...container.querySelectorAll('button')].find((item) => item.textContent?.trim() === 'Import data…')!;
  expect(button).toBeTruthy();
  act(() => button.click());
  const input = container.querySelector<HTMLInputElement>('input[accept=".json,application/json"]')!;
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  act(() => input.dispatchEvent(new Event('change', { bubbles: true })));
  await settle();
}

beforeEach(async () => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => [] })));
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
  confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
  vi.mocked(removeCachedApp).mockClear();
  window.history.replaceState({}, '', '/');
  localStorage.clear();
  current = await makeApp('2.0.0', 200);
  older = await makeApp('1.0.0', 100);
  cache.apps = [current, older];
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.history.replaceState({}, '', '/');
});

describe('runtime app-data actions', () => {
  it('opens a directory app in the same runtime and preserves the app already running', async () => {
    const requests: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
      const url = String(input);
      requests.push(url);
      if (url.endsWith('/api/apps/older-build/bundle.softn')) return new Response(older.bundleData as BodyInit);
      if (url.startsWith('/api/apps?')) return new Response(JSON.stringify({ ok: true, apps: [{ slug: 'older-build', name: 'Earlier build', description: '', urls: { bundle: '/api/apps/older-build/bundle.softn' } }], page: 1, pages: 1, total: 1, perPage: 6 }));
      return new Response(JSON.stringify({ ok: true }));
    }));
    await mount();
    await startAndReturnHome();
    await click('[aria-label="Run Earlier build"]');
    expect(container.querySelector('[role="alert"]')).toBeNull();
    await click('.softn-frame-home');
    expect(container.querySelectorAll('.softn-launcher-run')).toHaveLength(2);
    const requestCount = requests.filter((url) => url.endsWith('/api/apps/older-build/bundle.softn')).length;
    expect(requestCount).toBe(1);
    await click('[aria-label="Run Earlier build"]');
    await click('.softn-frame-home');
    expect(container.querySelectorAll('.softn-launcher-run')).toHaveLength(2);
    expect(requests.filter((url) => url.endsWith('/api/apps/older-build/bundle.softn'))).toHaveLength(1);
  });

  it('keeps running app data and bundle when Remove is pressed from Home', async () => {
    localStorage.setItem(dataKey(current), 'original note');
    await mount();
    await startAndReturnHome();
    await click('[aria-label="Remove Data guard test"]');
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Stop “Data guard test”');
    expect(localStorage.getItem(dataKey(current))).toBe('original note');
    expect(removeCachedApp).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
  });

  it('rejects importing into a running app before even reading the file', async () => {
    localStorage.setItem(dataKey(current), 'original note');
    await mount();
    await startAndReturnHome();
    const read = vi.fn(async () => 'unused');
    await chooseImport(dataFile(current, read));
    expect(read).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Returning Home keeps the app running');
    expect(localStorage.getItem(dataKey(current))).toBe('original note');
  });

  it('rejects bringing data forward into a running target, preserving the old build', async () => {
    localStorage.setItem(dataKey(older), 'older saved note');
    await mount();
    await startAndReturnHome();
    await click('.softn-launcher-adopt');
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Stop “Data guard test”');
    expect(localStorage.getItem(dataKey(current))).toBeNull();
    expect(localStorage.getItem(dataKey(older))).toBe('older saved note');
  });

  it('checks again when the app starts while the backup is being read', async () => {
    localStorage.setItem(dataKey(current), 'original note');
    const snapshot = exportAppData(current)!;
    snapshot.stores.local['saved-note'] = 'replacement';
    let finish!: (text: string) => void;
    const pending = new Promise<string>((resolve) => { finish = resolve; });
    await mount();
    await chooseImport(dataFile(current, () => pending));
    await startAndReturnHome();
    await act(async () => finish(JSON.stringify(snapshot)));
    await settle();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Stop “Data guard test”');
    expect(localStorage.getItem(dataKey(current))).toBe('original note');
  });

  it('asks before removing a stopped app; Cancel retains its bundle and data', async () => {
    localStorage.setItem(dataKey(current), 'original note');
    await mount();
    await startAndReturnHome();
    await click('[aria-label="Stop Data guard test"]');
    await click('[aria-label="Remove Data guard test"]');
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('and its saved data from this browser'));
    expect(localStorage.getItem(dataKey(current))).toBe('original note');
    expect(removeCachedApp).not.toHaveBeenCalled();
    confirm.mockReturnValue(true);
    await click('[aria-label="Remove Data guard test"]');
    expect(localStorage.getItem(dataKey(current))).toBeNull();
    expect(removeCachedApp).toHaveBeenCalledWith(current.id);
  });

  it('cancelled backup replacement keeps data; a confirmed stopped-app import replaces it', async () => {
    localStorage.setItem(dataKey(current), 'original note');
    await mount();
    await chooseImport(dataFile(current));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('Replace the data'));
    expect(localStorage.getItem(dataKey(current))).toBe('original note');
    confirm.mockReturnValue(true);
    await chooseImport(dataFile(current));
    expect(localStorage.getItem(dataKey(current))).toBe('imported note');
    expect(container.textContent).toContain('Imported 1 stored record');
  });
});

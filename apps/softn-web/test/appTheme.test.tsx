/** @vitest-environment jsdom */
/**
 * The side a project declares reaches the app it is declared for.
 *
 * A manifest says `config.theme.mode`: light, dark or system. The runtime
 * read `config.execution` and `config.server` from the same place and never
 * this, so a project declared dark was drawn in whatever softn.com's own page
 * happened to be for the visitor. The rule itself is @softn/components'
 * (theme/app-theme.ts, held by its own tests); what is held here is that the
 * runtime hands it the manifest's word, for the right tab, and names the box
 * that tab is drawn in: every open app stays mounted in one document, and a
 * side written on the document would be every tab's.
 */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { strToU8, zipSync } from 'fflate';

const seen = vi.hoisted(() => ({ providers: [] as Array<Record<string, unknown>> }));
vi.mock('@softn/components/theme', () => ({
  ThemeProvider: (props: Record<string, unknown> & { children: ReactNode }) => {
    seen.providers.push(props);
    return props.children;
  },
}));
vi.mock('../src/lib/appCache', async (original) => ({
  ...await original<typeof import('../src/lib/appCache')>(),
  getCachedApps: vi.fn(async () => []),
  getCachedAppByName: vi.fn(async () => null),
  getCachedAppByOrigin: vi.fn(async () => null),
  cacheApp: vi.fn(async () => null),
  updateLastOpened: vi.fn(async () => {}),
}));

import App from '../src/App';

let root: Root;
let container: HTMLDivElement;
const bundle = (name: string, config?: unknown) => zipSync({
  'manifest.json': strToU8(JSON.stringify({ name, version: '1.0.0', main: 'ui/main.ui', files: { ui: ['ui/main.ui'] }, ...(config === undefined ? {} : { config }) }), true),
  // A plain tag: no component is registered here, and none is needed.
  'ui/main.ui': strToU8(`<div>${name}</div>`, true),
});
const response = (bytes: Uint8Array) => new Response(bytes as BodyInit, { headers: { 'content-type': 'application/octet-stream' } });
const emptyDirectory = () => new Response(JSON.stringify({ ok: true, apps: [], page: 1, pages: 1, total: 0 }));
async function settle() {
  for (let i = 0; i < 4; i++) await act(async () => { await new Promise((done) => setTimeout(done, 0)); });
}
async function open(file: string, bytes: Uint8Array) {
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => String(input).endsWith(`/${file}`) ? response(bytes) : emptyDirectory()));
  window.history.replaceState({}, '', `/?open=/${file}`);
  act(() => root.render(<App />));
  await settle();
}
/** The provider around a running app: the one given a box to write on. */
const running = () => seen.providers.filter((props) => typeof props.box === 'string');

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
  localStorage.clear();
  seen.providers.length = 0;
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

describe("a project's declared theme in the web runtime", () => {
  it('hands the manifest’s mode to the provider around that app, with the box the app is drawn in', async () => {
    await open('Dark.softn', bundle('Dark app', { theme: { primary: '#22d3ee', mode: 'dark' } }));
    const provider = running().at(-1);
    expect(provider, 'the running app has a provider that names its box').toBeDefined();
    expect(provider!.declaredMode).toBe('dark');
    // The host is still followed: it is what a project declared system, or
    // nothing, goes on being drawn by.
    expect(provider!.followHost).toBe(true);
    expect(provider!.followSystem).toBe(true);
    // The box is the one the app renders into, and nothing else carries the name.
    const boxes = [...container.querySelectorAll('[data-softn-theme-box]')];
    expect(boxes).toHaveLength(1);
    expect(boxes[0].classList.contains('softn-runner-app')).toBe(true);
    expect(boxes[0].getAttribute('data-softn-theme-box')).toBe(provider!.box);
    expect(boxes[0].textContent).toContain('Dark app');
  });

  it('hands over whatever the manifest says and leaves the judging to the rule', async () => {
    await open('Light.softn', bundle('Light app', { theme: { mode: 'light' } }));
    expect(running().at(-1)!.declaredMode).toBe('light');
  });

  it('declares nothing for a project that declares nothing', async () => {
    await open('Plain.softn', bundle('Plain app'));
    const provider = running().at(-1);
    expect(provider).toBeDefined();
    expect(provider!.declaredMode).toBeUndefined();
  });

  it('gives the loading screens no project to listen to', async () => {
    await open('Dark.softn', bundle('Dark app', { theme: { mode: 'dark' } }));
    // Any provider that is not around a running app is the runtime's own
    // (the spinner before an app is known): it follows the host, as it did.
    for (const provider of seen.providers.filter((props) => typeof props.box !== 'string')) {
      expect(provider.declaredMode).toBeUndefined();
    }
  });
});

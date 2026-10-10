// @vitest-environment jsdom
/**
 * A single-app page draws its app on the side the project declares.
 *
 * The shell had one say on the theme, the deployment's own `theme` (dark
 * unless the configuration says light; a directory's play page is always
 * configured dark), and never read the bundle's `config.theme.mode`. The
 * rule that weighs the two is @softn/components' (theme/app-theme.ts); here
 * the shell is held to reading the manifest's word in the step both
 * single-app hosts share, and to handing it over with the deployment's
 * `theme` as the default it always was.
 */
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { zipSync, strToU8 } from 'fflate';

const seen = vi.hoisted(() => ({ providers: [] as Array<Record<string, unknown>> }));
vi.mock('@softn/components/theme', () => ({
  ThemeProvider: (props: Record<string, unknown> & { children: React.ReactNode }) => {
    seen.providers.push(props);
    return props.children;
  },
}));
vi.mock('@softn/core', async (original) => ({
  ...(await original<object>()),
  SoftNWithXDB: () => <p data-app="true">The app</p>,
}));
vi.mock('@softn/runtime-shell/bundleProcessor', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  loadXDBData: vi.fn(async () => {}),
}));
vi.mock('@softn/brand', () => ({ Mark: () => null }));
import { Application } from '../src/SingleApp';
import { loadApplication, type LoadedApplication } from '../src/load';

const base = 'https://example.test/nested/runtime.config.json';
const element = document.createElement('div');
document.body.append(element);
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  seen.providers.length = 0;
  localStorage.clear();
  vi.unstubAllGlobals();
});

function serve(config: unknown, deployment: Record<string, unknown> = {}) {
  const bytes = zipSync({
    'manifest.json': strToU8(JSON.stringify({ name: 'Example', main: 'main.ui', files: { ui: ['main.ui'] }, config })),
    'main.ui': strToU8('<div>Hello</div>'),
    'permission.json': strToU8('{"permissions":{}}'),
  });
  vi.stubGlobal(
    'fetch',
    async (url: string) =>
      new Response(url === base ? JSON.stringify({ version: 1, id: 'sample', title: 'Example', bundle: 'app.softn', ...deployment }) : bytes)
  );
}

function mount(app: LoadedApplication) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  root = createRoot(element);
  act(() => root!.render(<Application app={app} />));
}

it('reads the side the project declares from its manifest, beside where it runs its script', async () => {
  serve({ execution: 'worker', theme: { primary: '#22d3ee', mode: 'dark' } });
  const dark = await loadApplication(base, new AbortController().signal);
  expect(dark.themeMode).toBe('dark');
  expect(dark.execution).toBe('worker');
  dark.assets.dispose();

  serve({ theme: { mode: 'light' } });
  const light = await loadApplication(base, new AbortController().signal);
  expect(light.themeMode).toBe('light');
  light.assets.dispose();

  // A manifest with no config at all is a project that declares nothing.
  serve(undefined);
  const silent = await loadApplication(base, new AbortController().signal);
  expect(silent.themeMode).toBeUndefined();
  silent.assets.dispose();
});

it('hands the declared side to the provider over the deployment’s own theme, and names the box the app is drawn in', async () => {
  // A directory's play page: the configuration says dark for every app.
  serve({ theme: { mode: 'light' } }, { theme: 'dark' });
  const app = await loadApplication(base, new AbortController().signal);
  mount(app);
  const provider = seen.providers.at(-1)!;
  expect(provider.declaredMode).toBe('light');
  // The deployment's theme is still the default: it is what a project
  // declared system, or nothing, goes on being drawn in.
  expect(provider.defaultDarkMode).toBe(true);
  const box = element.querySelector('[data-softn-theme-box]');
  expect(box?.classList.contains('application-content')).toBe(true);
  expect(box?.getAttribute('data-softn-theme-box')).toBe(provider.box);
  expect(box?.querySelector('[data-app]')).not.toBeNull();
  app.assets.dispose();
});

it('declares nothing to the provider for a project that declares nothing', async () => {
  serve(undefined, { theme: 'light' });
  const app = await loadApplication(base, new AbortController().signal);
  mount(app);
  const provider = seen.providers.at(-1)!;
  expect(provider.declaredMode).toBeUndefined();
  expect(provider.defaultDarkMode).toBe(false);
  app.assets.dispose();
});

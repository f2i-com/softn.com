// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const bridge = vi.hoisted(() => ({ invoke: vi.fn(), open: vi.fn(), listen: vi.fn(), drag: vi.fn(), title: vi.fn(), runner: vi.fn(), files: new Map<string, string>() }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: bridge.open }));
vi.mock('@tauri-apps/api/webview', () => ({ getCurrentWebview: () => ({ onDragDropEvent: bridge.drag }) }));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ setTitle: bridge.title }) }));
vi.mock('@softn/components', () => ({ registerAllBuiltins() {}, ThemeProvider: ({ children }: { children: React.ReactNode }) => children, Spinner: () => <span>Loading</span> }));
vi.mock('@softn/core', async (importOriginal) => ({
  // The manifest and permission reads are core's real ones: the loader is
  // what this test exercises, and those are what it reads through. So is
  // `debug`, which is silent here and would otherwise be missing from the mock.
  // So are the consent and egress rules the loader applies on top of them.
  ...(({ readManifest, extractPermissions, debug, inspectDeclaration, describeNetDestination }) => ({ readManifest, extractPermissions, debug, inspectDeclaration, describeNetDestination }))(await importOriginal<typeof import('@softn/core')>()),
  SoftNWithXDB: (props: Record<string, unknown>) => { bridge.runner(props); return <p>Running the selected app</p>; },
  XDBStorageNotice: () => null,
  classifyAsset: () => ({ binary: false, mime: 'text/plain' }),
  readBundleEntries: () => new Map([...bridge.files].map(([name, text]) => [name, new TextEncoder().encode(text)])),
}));
vi.mock('../src/bundleRuntime', () => ({ computeBundleAppId: async () => 'bundle-test', loadBundleXDBData: async () => 0, processBundleSource: () => ({ source: '<Text>App</Text>', preIncludedLogicPaths: [] }) }));

let host: HTMLDivElement;
let root: Root;
beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('__ANDROID__', false);
  localStorage.clear();
  bridge.files.clear();
  bridge.files.set('manifest.json', JSON.stringify({ name: 'Fieldnotes', main: 'main.ui', files: {} }));
  bridge.files.set('main.ui', '<Text>App</Text>');
  Object.defineProperty(window, '__TAURI__', { value: { core: { invoke: bridge.invoke }, event: { listen: bridge.listen } }, configurable: true });
  bridge.invoke.mockImplementation(async (command: string) => command === 'get_opened_file' ? null : command === 'pick_softn_bundle' ? bridge.open() : [1]);
  bridge.open.mockResolvedValue('C:\\Apps\\Fieldnotes.SOFTN');
  bridge.listen.mockResolvedValue(() => {});
  bridge.drag.mockResolvedValue(() => {});
  bridge.title.mockResolvedValue(undefined);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  delete (window as unknown as Record<string, unknown>).__TAURI__;
  vi.unstubAllGlobals();
});
async function mount() {
  const { default: App } = await import('../src/App');
  await act(async () => root.render(<App />));
}
async function click(label: string) {
  const button = [...host.querySelectorAll('button')].find((node) => node.textContent === label || node.getAttribute('aria-label') === label);
  expect(button).toBeDefined();
  await act(async () => button!.click());
}

it('opens and reopens the same native file, passes scoped assets, and returns home', async () => {
  await mount();
  await click('Open app');
  expect(host.textContent).toContain('Running the selected app');
  expect(bridge.runner.mock.lastCall?.[0].assetResolver.pathOf).toBeTypeOf('function');
  await click('Open app');
  expect(bridge.invoke.mock.calls.filter(([command]) => command === 'read_softn_bundle')).toHaveLength(2);
  await click('Runtime home');
  expect(host.textContent).toContain('Start with a .softn app');
  expect(host.textContent).not.toContain('Running the selected app');
});

it('reports a failed native picker without leaving a dead welcome screen', async () => {
  await mount();
  bridge.open.mockRejectedValueOnce(new Error('Dialog unavailable'));
  await click('Open a .softn file');
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('Dialog unavailable');
});

it('does not replace a user selection with a late startup file', async () => {
  let finish!: (value: string) => void;
  bridge.invoke.mockImplementation((command: string) => command === 'get_opened_file' ? new Promise(resolve => { finish = resolve; }) : command === 'pick_softn_bundle' ? bridge.open() : Promise.resolve([1]));
  await mount();
  await click('Open app');
  await act(async () => finish('C:\\Apps\\Old.softn'));
  expect(bridge.invoke.mock.calls.filter(([command]) => command === 'read_softn_bundle')).toEqual([['read_softn_bundle', { path: 'C:\\Apps\\Fieldnotes.SOFTN' }]]);
});

it('uses current Tauri drag events and removes a listener installed after unmount', async () => {
  let finish!: (value: () => void) => void;
  const unlisten = vi.fn();
  bridge.drag.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  await mount();
  const handle = bridge.drag.mock.calls[0][0];
  await act(async () => handle({ payload: { type: 'enter' } }));
  expect(host.querySelector('[data-dragging="true"]')).not.toBeNull();
  await act(async () => handle({ payload: { type: 'leave' } }));
  expect(host.querySelector('[data-dragging="true"]')).toBeNull();
  await act(async () => root.render(null));
  await act(async () => finish(unlisten));
  expect(unlisten).toHaveBeenCalledOnce();
});

function lastRun(): Record<string, unknown> & { permissionConfig?: { permissions: Record<string, { enabled?: boolean } | undefined>; consentPending?: boolean } } {
  return bridge.runner.mock.lastCall?.[0];
}

it('runs a bundle that declares nothing as an empty declaration, not as an unrestricted page', async () => {
  // extractPermissions yields null for a bundle with no permission.json and
  // no manifest.permissions. Passed through as undefined, the renderer read
  // "no host is enforcing" and the device components and remote images were
  // unrestricted.
  await mount();
  await click('Open app');
  expect(lastRun().permissionConfig).toEqual({ permissions: {} });
  expect(host.textContent).not.toContain('This app wants to use');
});

it('withholds what a bundle declared until Allow, and remembers the answer for that declaration', async () => {
  bridge.files.set('permission.json', JSON.stringify({ permissions: { net: { enabled: true, allowed_hosts: ['api.example.com'] } } }));
  await mount();
  await click('Open app');
  // On screen and running, with everything withheld.
  expect(host.textContent).toContain('Running the selected app');
  expect(host.textContent).toContain('This app wants to use the internet.');
  expect(lastRun().permissionConfig).toMatchObject({ permissions: {}, consentPending: true });
  const runsBeforeAllow = bridge.runner.mock.calls.length;

  await click('Allow');
  expect(host.textContent).not.toContain('This app wants to use');
  expect(lastRun().permissionConfig?.permissions.net?.enabled).toBe(true);
  expect(lastRun().permissionConfig?.consentPending).toBeUndefined();
  // Upgraded in place: the runner's identity key is unchanged, so no remount.
  expect(bridge.runner.mock.calls.length).toBeGreaterThan(runsBeforeAllow);

  // The same package with the same declaration opens granted.
  await click('Open app');
  expect(host.textContent).not.toContain('This app wants to use');
  expect(lastRun().permissionConfig?.permissions.net?.enabled).toBe(true);

  // One more host is a different request, and is asked again.
  bridge.files.set('permission.json', JSON.stringify({ permissions: { net: { enabled: true, allowed_hosts: ['api.example.com', 'collect.example.net'] } } }));
  await click('Open app');
  expect(host.textContent).toContain('This app wants to use the internet.');
  expect(lastRun().permissionConfig).toMatchObject({ permissions: {}, consentPending: true });
});

it('puts focus back into the app after Allow instead of dropping it on <body>', async () => {
  bridge.files.set('permission.json', JSON.stringify({ permissions: { net: { enabled: true, allowed_hosts: ['api.example.com'] } } }));
  await mount();
  await click('Open app');
  const allow = [...host.querySelectorAll('button')].find((node) => node.textContent === 'Allow')!;
  await act(async () => allow.focus());
  await click('Allow');
  expect(host.textContent).not.toContain('This app wants to use');
  expect(document.activeElement).not.toBe(document.body);
  expect(host.querySelector('main')?.contains(document.activeElement)).toBe(true);
});

it('keeps the bar out of the way on "Not now" without granting anything', async () => {
  bridge.files.set('permission.json', JSON.stringify({ permissions: { camera: { enabled: true } } }));
  await mount();
  await click('Open app');
  await click('Not now');
  // Folded to a strip that says what it is, rather than a bare shield icon.
  expect([...host.querySelectorAll('button')].some((button) => button.textContent === 'Review permissions')).toBe(true);
  expect(lastRun().permissionConfig).toMatchObject({ permissions: {}, consentPending: true });
  await click('Open app');
  expect(host.textContent).toContain('This app wants to use pictures from your camera.');
});

it('routes softn.net.fetch through the native side under the running config', async () => {
  bridge.files.set('permission.json', JSON.stringify({ permissions: { net: { enabled: true, allowed_hosts: ['api.example.com'] } } }));
  await mount();
  await click('Open app');
  const pending = lastRun().netFetchHandler as (url: string, options: Record<string, unknown>) => Promise<unknown>;
  expect(pending).toBeTypeOf('function');
  await expect(pending('https://api.example.com/v1', {})).rejects.toThrow('not permitted yet');

  await click('Allow');
  const granted = lastRun().netFetchHandler as typeof pending;
  expect(granted).not.toBe(pending);
  await expect(granted('https://evil.example.net/', {})).rejects.toThrow('Host not allowed: evil.example.net');
  expect(bridge.invoke.mock.calls.some(([command]) => command === 'net_fetch')).toBe(false);

  bridge.invoke.mockImplementation(async (command: string) => command === 'net_fetch' ? { ok: true, status: 200, statusText: 'OK', body: '{}', headers: {} } : [1]);
  await expect(granted('https://api.example.com/v1', { method: 'post', body: { q: 1 }, timeout: 500 })).resolves.toMatchObject({ ok: true, status: 200 });
  expect(bridge.invoke).toHaveBeenLastCalledWith('net_fetch', {
    request: {
      url: 'https://api.example.com/v1',
      method: 'post',
      headers: undefined,
      body: '{"q":1}',
      timeoutMs: 500,
      allowHttp: false,
      allowedHosts: ['api.example.com'],
    },
  });
});

it("honours the manifest's config.execution as the web runtime does", async () => {
  bridge.files.set('manifest.json', JSON.stringify({ name: 'Fieldnotes', main: 'main.ui', files: {}, config: { execution: 'worker' } }));
  await mount();
  await click('Open app');
  expect(lastRun().executionPreference).toBe('worker');
  // The renderer only reaches a worker in its default 'worker' mode.
  expect(lastRun().scriptExecutionMode).toBeUndefined();

  bridge.files.set('manifest.json', JSON.stringify({ name: 'Fieldnotes', main: 'main.ui', files: {}, config: { execution: 'Worker' } }));
  await click('Open app');
  expect(lastRun().executionPreference).toBe('main');
});

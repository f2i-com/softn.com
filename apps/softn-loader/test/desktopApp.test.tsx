// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

// `open` stands for the person's choice in the native picker, which the
// `pick_softn_bundle` command returns.
const bridge = vi.hoisted(() => ({ invoke: vi.fn(), open: vi.fn(), listen: vi.fn(), drag: vi.fn(), title: vi.fn(), runner: vi.fn(), theme: vi.fn(), files: new Map<string, string>(), id: { value: 'bundle-test' }, failCompose: { value: false } }));
vi.mock('@tauri-apps/api/webview', () => ({ getCurrentWebview: () => ({ onDragDropEvent: bridge.drag }) }));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ setTitle: bridge.title }) }));
vi.mock('@softn/components/lazy', () => ({ registerRuntimeComponents() {} }));
vi.mock('@softn/components/minimal', () => ({ Spinner: () => <span>Loading</span> }));
vi.mock('@softn/components/theme', () => ({ ThemeProvider: (props: Record<string, unknown> & { children: React.ReactNode }) => { bridge.theme(props); return props.children; } }));
vi.mock('@softn/core', async (importOriginal) => ({
  // Core's real reads and rules — the manifest, the permissions, consent and
  // egress — are what the loader reads through; only the renderer is a stand-in.
  ...(await importOriginal<typeof import('@softn/core')>()),
  SoftNWithXDB: (props: Record<string, unknown>) => { bridge.runner(props); return <p>Running the selected app</p>; },
  XDBStorageNotice: () => null,
}));
// The archive is this test's text files and the composer can be made to fail;
// the shared pipeline itself is tested in @softn/runtime-shell. Assets and
// imports are its real resolvers.
vi.mock('@softn/runtime-shell/bundleProcessor', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@softn/runtime-shell/bundleProcessor')>()),
  readZip: () => ({
    textFiles: new Map(bridge.files),
    binaryFiles: { get: () => undefined, has: () => false, declaredSize: () => undefined, isRead: () => false, release() {} },
  }),
  loadXDBData: async () => 0,
  processBundle: () => {
    if (bridge.failCompose.value) throw new Error('Main file not found: main.ui');
    return { source: '<Text>App</Text>', preIncludedLogicPaths: [] };
  },
}));
vi.mock('../src/bundleFile', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/bundleFile')>()),
  computeBundleAppId: async () => bridge.id.value,
}));

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
  bridge.id.value = 'bundle-test';
  bridge.failCompose.value = false;
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

it("honours the manifest's config.theme.mode as the web runtime does", async () => {
  // The loader read `config.execution`, `config.window` and `config.server`
  // from the manifest and never the side its project declares, so a project
  // declared dark was drawn in whatever the desktop shell's own theme was.
  // The rule is the provider's (@softn/components, theme/app-theme.ts); the
  // loader hands it the manifest's word and names the box the app is drawn in.
  bridge.files.set('manifest.json', JSON.stringify({ name: 'Fieldnotes', main: 'main.ui', files: {}, config: { theme: { primary: '#22d3ee', mode: 'dark' } } }));
  await mount();
  await click('Open app');
  const provider = bridge.theme.mock.lastCall?.[0] as Record<string, unknown>;
  expect(provider.declaredMode).toBe('dark');
  // The shell's own theme is still followed: it is what a project declared
  // system, or nothing, goes on being drawn by.
  expect(provider.followHost).toBe(true);
  expect(provider.followSystem).toBe(true);
  const box = host.querySelector('[data-softn-theme-box]');
  expect(box?.tagName).toBe('MAIN');
  expect(box?.getAttribute('data-softn-theme-box')).toBe(provider.box);
  expect(box?.textContent).toContain('Running the selected app');

  bridge.files.set('manifest.json', JSON.stringify({ name: 'Fieldnotes', main: 'main.ui', files: {} }));
  await click('Open app');
  expect((bridge.theme.mock.lastCall?.[0] as Record<string, unknown>).declaredMode).toBeUndefined();
});

it('opens an app whose manifest names its icon with something that is not text', async () => {
  // The web runtime and the single-app shell skip such an icon; the loader
  // called toLowerCase on it and refused to open the app.
  bridge.files.set('manifest.json', JSON.stringify({ name: 'Fieldnotes', main: 'main.ui', files: {}, icon: ['icon.png'] }));
  await mount();
  await click('Open app');
  expect(host.querySelector('[role="alert"]')).toBeNull();
  expect(host.textContent).toContain('Running the selected app');
});

it('puts the data back when an upgrade was staged and the package then fails to open', async () => {
  // A staged upgrade is finished only once the new package starts; a failure
  // before it starts restores the pre-upgrade backup and drops the staging.
  // A failure after the staging but before the app was handed to the runtime
  // (a main file that is missing) showed the plain error and left the
  // staging, the backup unused and the older package gated.
  bridge.invoke.mockImplementation(async (command: string) =>
    command === 'get_opened_file' ? null
      : command === 'pick_softn_bundle' ? bridge.open()
        : command === 'choose_data_identity' ? { kind: 'upgrade', dataId: 'bundle-a' }
          : command === 'backup_database' ? 'C:/data/backup-1.db'
            : command === 'restore_database' ? undefined
              : [1]);
  await mount();
  bridge.id.value = 'bundle-a';
  await click('Open app');
  expect(host.textContent).toContain('Running the selected app');

  bridge.id.value = 'bundle-b';
  bridge.failCompose.value = true;
  bridge.files.set('manifest.json', JSON.stringify({ name: 'Fieldnotes', version: '2', main: 'main.ui', files: {} }));
  await click('Open app');
  await act(async () => {
    for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  });
  const commands = bridge.invoke.mock.calls.map(([command, args]) => `${command} ${(args as { dataId?: string; appId?: string } | undefined)?.dataId ?? (args as { appId?: string } | undefined)?.appId ?? ''}`.trim());
  // The data is bound for the new package before it is backed up or put back.
  expect(commands.slice(commands.indexOf('choose_data_identity'))).toEqual(expect.arrayContaining(['bind_data_identity bundle-a', 'backup_database bundle-a', 'restore_database bundle-a']));
  expect(commands.indexOf('bind_data_identity bundle-a', commands.indexOf('choose_data_identity'))).toBeLessThan(commands.indexOf('backup_database bundle-a'));
  expect(bridge.invoke.mock.calls.some(([command]) => command === 'restore_database')).toBe(true);
  const registry = JSON.parse(localStorage.getItem('softn-loader:installations') ?? '{}');
  expect(registry.installations?.['bundle-a']?.pendingUpgrade).toBeUndefined();
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('Main file not found');
});

it('asks whether a package is a new version of an installed app in the native dialog, not in the page', async () => {
  // The answer lets the package read and change another app's records, so it
  // is put where nothing running in the page can give it.
  await mount();
  bridge.id.value = 'bundle-a';
  await click('Open app');
  bridge.invoke.mockClear();
  bridge.id.value = 'bundle-b';
  bridge.invoke.mockImplementation(async (command: string) =>
    command === 'pick_softn_bundle' ? bridge.open()
      : command === 'choose_data_identity' ? { kind: 'cancel' }
        : [1]);
  await click('Open app');
  expect(bridge.invoke.mock.calls).toContainEqual(['choose_data_identity', { bundleId: 'bundle-b', candidates: ['bundle-a'] }]);
  expect(host.querySelector('[role="dialog"]')).toBeNull();
  expect(bridge.invoke.mock.calls.some(([command]) => command === 'backup_database' || command === 'bind_data_identity')).toBe(false);
  expect(host.textContent).toContain('Start with a .softn app');

  // "Open as a new app" opens it on its own data.
  bridge.invoke.mockImplementation(async (command: string) =>
    command === 'pick_softn_bundle' ? bridge.open()
      : command === 'choose_data_identity' ? { kind: 'new' }
        : [1]);
  await click('Open app');
  expect(bridge.invoke.mock.calls).toContainEqual(['bind_data_identity', { bundleId: 'bundle-b', dataId: 'bundle-b', name: 'Fieldnotes', version: '', start: true }]);
  expect(lastRun().appId).toBe('bundle-b');
});

it('asks its own questions as a dialog: focus on Cancel, Tab kept inside, Escape cancels', async () => {
  localStorage.setItem('softn-loader:installations', '{ damaged');
  await mount();
  await click('Open app');
  const dialog = host.querySelector<HTMLElement>('[role="dialog"]')!;
  expect(dialog).not.toBeNull();
  // On the answer that changes nothing, not left on the button behind it.
  expect(document.activeElement?.textContent).toBe('Cancel');
  const buttons = [...dialog.querySelectorAll('button')];
  const tab = (shiftKey: boolean) => {
    const event = new KeyboardEvent('keydown', { key: 'Tab', shiftKey, bubbles: true, cancelable: true });
    act(() => {
      document.activeElement?.dispatchEvent(event);
    });
    return event;
  };
  // Cancel is the last answer: Tab wraps to the first, Shift+Tab back to it.
  expect(tab(false).defaultPrevented).toBe(true);
  expect(document.activeElement).toBe(buttons[0]);
  expect(tab(true).defaultPrevented).toBe(true);
  expect(document.activeElement).toBe(buttons[buttons.length - 1]);
  await act(async () => {
    document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  });
  expect(host.querySelector('[role="dialog"]')).toBeNull();
  expect(localStorage.getItem('softn-loader:installations')).toBe('{ damaged');
  expect(bridge.invoke.mock.calls.some(([command]) => command === 'bind_data_identity')).toBe(false);
});

it('says what became of the data after a failed upgrade under StrictMode too, as the desktop app runs in development', async () => {
  // StrictMode runs an effect, cleans it up and runs it again. The restore
  // was started by the first run, whose answer was then thrown away, and the
  // second found nothing left to do: "Restoring…" stayed up, with the way
  // back disabled.
  bridge.invoke.mockImplementation(async (command: string) =>
    command === 'get_opened_file' ? null
      : command === 'pick_softn_bundle' ? bridge.open()
        : command === 'choose_data_identity' ? { kind: 'upgrade', dataId: 'bundle-a' }
          : command === 'backup_database' ? 'C:/data/backup-1.db'
            : command === 'restore_database' ? undefined
              : [1]);
  const { default: App } = await import('../src/App');
  await act(async () => root.render(<React.StrictMode><App /></React.StrictMode>));
  bridge.id.value = 'bundle-a';
  await click('Open app');
  bridge.id.value = 'bundle-b';
  bridge.failCompose.value = true;
  bridge.files.set('manifest.json', JSON.stringify({ name: 'Fieldnotes', version: '2', main: 'main.ui', files: {} }));
  await click('Open app');
  await act(async () => {
    for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  });
  const home = [...host.querySelectorAll('button')].find((node) => node.textContent === 'Back to runtime home');
  expect(home?.disabled).toBe(false);
  expect(host.textContent).not.toContain('Restoring the data from the pre-upgrade backup');
  expect(bridge.invoke.mock.calls.filter(([command]) => command === 'restore_database')).toHaveLength(1);
});

function tamperedRegistry() {
  // What a script in the page can write: app A's installation, with another
  // bundle's digest added to the packages allowed to open its data.
  const at = '2026-09-14T00:00:00.000Z';
  localStorage.setItem('softn-loader:installations', JSON.stringify({ version: 1, installations: { 'bundle-a': {
    dataId: 'bundle-a', name: 'Fieldnotes', bundleIds: ['bundle-a', 'bundle-evil'], createdAt: at, updatedAt: at, ledger: [],
  } } }));
}

it('does not run a bundle on the data a registry entry written by the page maps it to, unless the native side binds it', async () => {
  tamperedRegistry();
  bridge.invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
    if (command === 'get_opened_file') return null;
    if (command === 'pick_softn_bundle') return bridge.open();
    if (command === 'bind_data_identity') {
      if (args?.dataId !== args?.bundleId) throw 'Not opened: you chose not to open this app with that data';
      return null;
    }
    return [1];
  });
  bridge.id.value = 'bundle-evil';
  bridge.files.set('manifest.json', JSON.stringify({ name: 'Funny cats', main: 'main.ui', files: {} }));
  await mount();
  await click('Open app');
  expect(bridge.runner.mock.calls.map(([props]) => props.appId)).not.toContain('bundle-a');
  expect(bridge.invoke.mock.calls).toContainEqual(['bind_data_identity', { bundleId: 'bundle-evil', dataId: 'bundle-a', name: 'Funny cats', version: '', start: true }]);
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('you chose not to open this app with that data');
});

it('picks and reads a bundle on Android through the native side, which the page has no file system plugin to do', async () => {
  vi.stubGlobal('__ANDROID__', true);
  const picked = 'content://com.android.providers.downloads.documents/document/42';
  bridge.invoke.mockImplementation(async (command: string) => command === 'get_opened_file' ? null : command === 'pick_softn_bundle' ? picked : [1]);
  await mount();
  await click('Open a .softn file');
  expect(bridge.invoke.mock.calls).toContainEqual(['read_softn_bundle', { path: picked }]);
  expect(bridge.invoke.mock.calls).toContainEqual(['bind_data_identity', { bundleId: 'bundle-test', dataId: 'bundle-test', name: 'Fieldnotes', version: '', start: true }]);
  expect(bridge.open).not.toHaveBeenCalled();
  expect(host.textContent).toContain('Running the selected app');
});

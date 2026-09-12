// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const bridge = vi.hoisted(() => ({ invoke: vi.fn(), open: vi.fn(), listen: vi.fn(), drag: vi.fn(), title: vi.fn(), runner: vi.fn() }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: bridge.open }));
vi.mock('@tauri-apps/api/webview', () => ({ getCurrentWebview: () => ({ onDragDropEvent: bridge.drag }) }));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ setTitle: bridge.title }) }));
vi.mock('@softn/components', () => ({ registerAllBuiltins() {}, ThemeProvider: ({ children }: { children: React.ReactNode }) => children, Spinner: () => <span>Loading</span> }));
vi.mock('@softn/core', () => ({
  SoftNWithXDB: (props: Record<string, unknown>) => { bridge.runner(props); return <p>Running the selected app</p>; },
  classifyAsset: () => ({ binary: false, mime: 'text/plain' }),
  readBundleEntries: () => new Map([['manifest.json', new TextEncoder().encode(JSON.stringify({ name: 'Fieldnotes', main: 'main.ui', files: {} }))], ['main.ui', new TextEncoder().encode('<Text>App</Text>')]]),
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
  Object.defineProperty(window, '__TAURI__', { value: { core: { invoke: bridge.invoke }, event: { listen: bridge.listen } }, configurable: true });
  bridge.invoke.mockImplementation(async (command: string) => command === 'get_opened_file' ? null : [1]);
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
  bridge.invoke.mockImplementation((command: string) => command === 'get_opened_file' ? new Promise(resolve => { finish = resolve; }) : Promise.resolve([1]));
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

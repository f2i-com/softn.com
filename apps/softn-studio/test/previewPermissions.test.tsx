/** @vitest-environment jsdom */
/**
 * Studio's preview runs a project under what its permission.json asks for,
 * withheld until the person allows it there.
 *
 * It was handed no declaration, which core reads as a host enforcing
 * nothing: the page's markup fetched any address it named, the app's state
 * in it if the page said so, and a device component opened its device, for
 * a project opened from a link (`?open=`) as for one's own. Calls from the
 * logic were refused, and nothing could allow them.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { registerAllBuiltins } from '@softn/components';
import { configureZippWasmSource } from '@softn/core';
import { VisualCanvas } from '../src/components/canvas/VisualCanvas';
import { useVFSStore, useWorkspaceStore } from '../src/stores';

beforeAll(() => {
  configureZippWasmSource(readFileSync(resolve(process.cwd(), '../../packages/@softn/core/wasm-zipp/zipp_wasm_bg.wasm')));
  registerAllBuiltins();
});

const PAGE = `<data>
  <collection name="tasks" as="tasks" />
</data>

<App theme="light">
  <Heading level={1}>Tasks</Heading>
  <img src="https://images.example/cover.png?from=preview" alt="cover" />
  #each (item in tasks) key={item.id}
    <Text>{item.data.title}</Text>
  #end
</App>
`;
const project = (permission?: unknown): Array<{ path: string; content: string }> => [
  { path: 'manifest.json', content: JSON.stringify({ name: 'Tasks', version: '1.0.0', description: 'Tasks.', main: 'ui/main.ui', files: { ui: ['ui/main.ui'], xdb: ['xdb/tasks.xdb'] } }) },
  { path: 'ui/main.ui', content: PAGE },
  { path: 'xdb/tasks.xdb', content: JSON.stringify({ collection: 'tasks', records: [{ id: '1', title: 'Buy milk' }] }) },
  ...(permission === undefined ? [] : [{ path: 'permission.json', content: JSON.stringify(permission) }]),
];

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  useWorkspaceStore.getState().reset();
  useVFSStore.getState().reset();
  useWorkspaceStore.setState({ projectId: `permissions-${Math.random().toString(36).slice(2)}`, projectName: 'Tasks' });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const settle = async (ms = 1500) => {
  for (let i = 0; i < ms / 20; i++) await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
};
const shown = () => container.querySelector('[data-softn-preview-content]')?.textContent ?? '';
const remoteImage = () => container.querySelector('[data-softn-preview-content] img[src^="https://images.example/"]');
const note = () => container.querySelector<HTMLElement>('[data-preview-capabilities]');

describe('the preview of a project that asks for the network', () => {
  it('fetches nothing from another site until the person allows it, then does, and stops when withheld again', async () => {
    useVFSStore.getState().hydrateFiles(project({ permissions: { net: { enabled: true, allowed_hosts: ['images.example'] } } }));
    await act(async () => { root.render(<VisualCanvas />); });
    await settle();
    // The app is drawn, its records with it; only what it reaches out for waits.
    expect(shown()).toContain('Buy milk');
    expect(remoteImage()).toBeNull();
    expect(note()?.dataset.previewCapabilities).toBe('withheld');
    expect(note()?.textContent).toContain('This project asks for net');

    const allow = [...note()!.querySelectorAll('button')].find((button) => button.textContent === 'Allow in preview')!;
    await act(async () => { allow.click(); });
    await settle();
    expect(note()?.dataset.previewCapabilities).toBe('allowed');
    expect(remoteImage()).not.toBeNull();
    expect(shown()).toContain('Buy milk');

    const withhold = [...note()!.querySelectorAll('button')].find((button) => button.textContent === 'Withhold again')!;
    await act(async () => { withhold.click(); });
    await settle();
    expect(remoteImage()).toBeNull();
  }, 60_000);

  it('asks again once permission.json asks for more than was allowed', async () => {
    useVFSStore.getState().hydrateFiles(project({ permissions: { net: { enabled: true, allowed_hosts: ['images.example'] } } }));
    await act(async () => { root.render(<VisualCanvas />); });
    await settle();
    const allow = [...note()!.querySelectorAll('button')].find((button) => button.textContent === 'Allow in preview')!;
    await act(async () => { allow.click(); });
    await settle();
    expect(remoteImage()).not.toBeNull();
    await act(async () => {
      useVFSStore.getState().updateFile('permission.json', JSON.stringify({ permissions: { net: { enabled: true } } }), 'user');
    });
    await settle();
    expect(note()?.dataset.previewCapabilities).toBe('withheld');
    expect(remoteImage()).toBeNull();
  }, 60_000);
});

describe('the preview of a project that declares nothing', () => {
  it('grants nothing, as a runtime would: the page is drawn, and nothing is fetched from another site', async () => {
    useVFSStore.getState().hydrateFiles(project());
    await act(async () => { root.render(<VisualCanvas />); });
    await settle();
    expect(shown()).toContain('Buy milk');
    expect(remoteImage()).toBeNull();
    expect(note()).toBeNull();
  }, 60_000);
});

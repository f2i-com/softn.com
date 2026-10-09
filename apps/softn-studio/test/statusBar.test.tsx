/** @vitest-environment jsdom */
/**
 * The status bar's file count and size are the bundle's: what Export bundle
 * will write.
 *
 * It counted and weighed every file the project holds, Studio's own notes
 * under builder/ among them, beside the word "Bundle": a new app read
 * "14 files, Bundle 6.3 KB" and exported seven files of 2.9 KB.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { StatusBar } from '../src/components/layout/StatusBar';
import { planBundle } from '../src/lib/exportBundle';
import { useAIStore, useVFSStore, useWorkspaceStore } from '../src/stores';

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  useWorkspaceStore.getState().reset();
  useAIStore.getState().resetSession();
  useVFSStore.getState().reset();
  useVFSStore.getState().hydrateFiles([
    { path: 'manifest.json', content: JSON.stringify({ name: 'Club', version: '1.0.0', main: 'ui/main.ui', files: { ui: ['ui/main.ui'] } }) },
    { path: 'ui/main.ui', content: '<App><Text>Club</Text></App>' },
    { path: 'builder/blueprint.json', content: JSON.stringify({ note: 'x'.repeat(5_000) }) },
    { path: 'builder/requirements.md', content: '# Club' },
  ]);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('the status bar', () => {
  it('counts and weighs what the export will hold, not Studio’s notes beside it', () => {
    act(() => root.render(<StatusBar />));
    const plan = planBundle(useVFSStore.getState().files);
    const bytes = [...plan.entries.values()].reduce((sum, entry) => sum + entry.length, 0);
    expect(plan.entries.size).toBe(2);
    expect(bytes).toBeLessThan(1024);
    const items = [...container.querySelectorAll('.st-status-item')].map((item) => item.textContent?.replace(/\s+/g, ' ').trim());
    expect(items).toContain('2 files');
    expect(items).toContain(`Bundle ${bytes} B`);
  });
});

/** @vitest-environment jsdom */
/**
 * The check asks the engine again when what it compiles has changed.
 *
 * Whether to ask was decided by the pages, the logic files and the manifest, and a web
 * container's `.vue` components are none of those, though the engine compiles them. A
 * component broken by the AI was caught when another file changed with it; fixed by hand, the
 * old error was published again after every change, and Run and Publish stayed held back
 * over an app that compiled. Broken by hand, it was never caught.
 */

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import type { VFSFile } from '../src/types/studio';

// The engine, as far as this needs it: App.vue does not compile while it says "broken".
vi.mock('../src/lib/logicCheck', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/logicCheck')>();
  return {
    ...actual,
    logicSyntaxProblems: async (files: Map<string, VFSFile>) =>
      String(files.get('App.vue')?.content ?? '').includes('broken')
        ? [{ file: 'App.vue', level: 'error' as const, type: 'logic-syntax', message: 'The logic does not compile: Unexpected token' }]
        : [],
  };
});

const { useProjectCheck } = await import('../src/lib/projectCheck');
const { useVFSStore, useWorkspaceStore } = await import('../src/stores');

function Check(): null {
  useProjectCheck(true);
  return null;
}

const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 400)); });
const compileErrors = () => useWorkspaceStore.getState().errors.filter((e) => e.type === 'logic-syntax').map((e) => e.file);

it('asks again after a .vue component changes, and lets a fixed one go', async () => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  useWorkspaceStore.getState().reset();
  useWorkspaceStore.setState({ projectId: 'p1' });
  useVFSStore.getState().reset();
  useVFSStore.getState().hydrateFiles([
    { path: 'manifest.json', content: JSON.stringify({ name: 'Vue app', version: '1.0.0', engine: 2, main: 'index.html' }) },
    { path: 'index.html', content: '<!doctype html><div id="app"></div><script type="module" src="app.js"></script>' },
    { path: 'app.js', content: "import App from './App.vue';\n" },
    { path: 'App.vue', content: '<template><p>Hi</p></template>\n<script>export default {}</script>\n' },
  ]);
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(<Check />));
  await settle();
  expect(compileErrors()).toEqual([]);

  // Broken by hand: caught.
  act(() => useVFSStore.getState().updateFile('App.vue', '<template><p>Hi</p></template>\n<script>export default { broken </script>\n'));
  await settle();
  expect(compileErrors()).toEqual(['App.vue']);

  // Fixed by hand: let go.
  act(() => useVFSStore.getState().updateFile('App.vue', '<template><p>Hello</p></template>\n<script>export default {}</script>\n'));
  await settle();
  expect(compileErrors()).toEqual([]);
  act(() => root.unmount());
  container.remove();
});

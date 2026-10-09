/** @vitest-environment jsdom */
/**
 * The Files panel shows the file the workspace has active, and choosing a
 * file is the only way it changes which that is.
 *
 * The panel kept a selection of its own, which began empty every time it was
 * opened; finding none, it selected the bundle's main file and made that the
 * workspace's active file. So opening the panel — or reloading a project saved
 * with it open, as the examples are — threw away the file the person was
 * looking at and put the entry page on the canvas. The active file is part of
 * the saved project, so opening the panel was also a change to save.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FilesPanel } from '../src/components/panels/FilesPanel';
import { useVFSStore, useWorkspaceStore } from '../src/stores';

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  useWorkspaceStore.getState().reset();
  useVFSStore.getState().reset();
  useVFSStore.getState().hydrateFiles([
    { path: 'manifest.json', content: JSON.stringify({ name: 'Club', version: '1.0.0', main: 'ui/main.ui' }) },
    { path: 'ui/main.ui', content: '<App />' },
    { path: 'ui/pages/settings.ui', content: '<Text>Settings</Text>' },
    { path: 'logic/main.logic', content: 'let count = 0' },
  ]);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

/** The file the tree marks as the one showing. */
const marked = () => container.querySelector('button[aria-current="true"]')?.getAttribute('title') ?? null;

describe('the files panel', () => {
  it('marks the file the workspace has active, inside its folder, and leaves it active when the panel opens', () => {
    useWorkspaceStore.getState().setActiveFilePath('ui/pages/settings.ui');
    act(() => root.render(<FilesPanel />));
    expect(useWorkspaceStore.getState().activeFilePath).toBe('ui/pages/settings.ui');
    expect(marked()).toBe('ui/pages/settings.ui');
  });

  it('with no file active, marks the page the canvas shows and changes nothing', () => {
    act(() => root.render(<FilesPanel />));
    expect(useWorkspaceStore.getState().activeFilePath).toBeNull();
    expect(marked()).toBe('ui/main.ui');
  });

  it('makes the file that is chosen the active one', () => {
    useWorkspaceStore.getState().setActiveFilePath('ui/pages/settings.ui');
    act(() => root.render(<FilesPanel />));
    const file = [...container.querySelectorAll('button')].find((b) => b.getAttribute('title') === 'logic/main.logic')!;
    act(() => file.click());
    expect(useWorkspaceStore.getState().activeFilePath).toBe('logic/main.logic');
    expect(marked()).toBe('logic/main.logic');
  });
});

/** @vitest-environment jsdom */
/**
 * Renaming a project.
 *
 * A project's name came from its brief and could not be changed afterwards
 * except by going back through the brief, which scaffolds the project again.
 * It is renamed now from the project's header and from the list of
 * projects. The name is one of the project's own fields: it is saved like any
 * change, merged with another tab's changes as a field (lib/projectMerge.ts),
 * and taken in by the other tab (test/liveTabs.test.ts).
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installFakeIndexedDB } from '@softn/test-utils/fake-indexeddb';
import { TopBar } from '../src/components/toolbar/TopBar';
import { Dashboard, type RecentEntry } from '../src/components/layout/Dashboard';
import { beginNewProjectSession, renameProject, renameSavedProject, startProjectAutosave } from '../src/lib/projectSession';
import { loadProjectRecord, loadRecentProjects, saveProjectRecord, saveRecentProject } from '../src/lib/persistence';
import { useVFSStore, useWorkspaceStore } from '../src/stores';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  installFakeIndexedDB();
  localStorage.clear();
  useWorkspaceStore.getState().reset();
  useVFSStore.getState().reset();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  delete (globalThis as unknown as { indexedDB?: unknown }).indexedDB;
});

const button = (name: string | RegExp) => [...container.querySelectorAll('button')].find((b) => (typeof name === 'string' ? b.getAttribute('aria-label') === name || b.textContent?.trim() === name : name.test(b.getAttribute('aria-label') ?? b.textContent ?? '')));
const type = (input: HTMLInputElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  act(() => { setter.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); });
};
const key = (input: HTMLInputElement, name: string) => act(() => { input.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true })); });
const flush = () => act(async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); });

/** A project saved under `id` with the name `name`, as another session left it. */
async function savedProject(name: string): Promise<string> {
  const id = beginNewProjectSession();
  useWorkspaceStore.getState().setProjectName(name);
  useVFSStore.getState().createFile('ui/main.ui', '<Text>Main</Text>');
  const autosave = startProjectAutosave({ debounceMs: 60_000 });
  expect(await autosave.flush()).toEqual({ ok: true });
  autosave.stop();
  return id;
}

describe('renaming, in the session', () => {
  it('renames the project open here, trimmed, and refuses an empty name', () => {
    beginNewProjectSession();
    useWorkspaceStore.getState().setProjectName('Notes');
    expect(renameProject('  Field   notes ')).toBeNull();
    expect(useWorkspaceStore.getState().projectName).toBe('Field notes');
    expect(renameProject('   ')).toBe('A project needs a name.');
    expect(renameProject('x'.repeat(81))).toMatch(/at most 80 characters/);
    expect(useWorkspaceStore.getState().projectName).toBe('Field notes');
  });

  it('renames a saved project that is not open here, in its record and in the list', async () => {
    const id = await savedProject('Old name');
    saveRecentProject({ id, name: 'Old name', target: 'web', lastModified: 'today' });
    const before = (await loadProjectRecord(id))!.revision;
    // Another project is open now.
    beginNewProjectSession();
    expect(await renameSavedProject(id, 'New name')).toEqual({ ok: true });
    const record = (await loadProjectRecord(id))!;
    expect(record.workspace.projectName).toBe('New name');
    expect(record.revision).toBeGreaterThan(before);
    expect(record.files[0].content).toBe('<Text>Main</Text>');
    expect(loadRecentProjects().find((entry) => entry.id === id)?.name).toBe('New name');
  });

  it('renames from the list the project open here, and its entry in the list at once', async () => {
    const id = await savedProject('Old name');
    saveRecentProject({ id, name: 'Old name', target: 'web', lastModified: 'today' });
    expect(await renameSavedProject(id, 'New name')).toEqual({ ok: true });
    expect(useWorkspaceStore.getState().projectName).toBe('New name');
    // The list is made again straight after: it is not to wait for the next save to say so.
    expect(loadRecentProjects().find((entry) => entry.id === id)?.name).toBe('New name');
  });

  it('will not rename a saved copy it cannot read whole, which a write would cut down', async () => {
    const id = await savedProject('Old name');
    const record = (await loadProjectRecord(id))!;
    await saveProjectRecord({ ...record, files: [...record.files, { path: 'ui/broken.ui' } as never] });
    beginNewProjectSession();
    expect(await renameSavedProject(id, 'New name')).toEqual({ ok: false, message: 'Its saved copy could not be read whole. Open it, then rename it.' });
  });
});

describe('renaming from the project header', () => {
  beforeEach(() => {
    beginNewProjectSession();
    useWorkspaceStore.getState().setProjectName('Notes');
    act(() => root.render(<TopBar onBackToDashboard={() => {}} />));
  });

  it('renames on Enter', async () => {
    act(() => button('Rename Notes')!.click());
    const input = container.querySelector<HTMLInputElement>('input[aria-label="Project name"]')!;
    expect(input.value).toBe('Notes');
    expect(document.activeElement).toBe(input);
    type(input, 'Field notes');
    key(input, 'Enter');
    await flush();
    expect(useWorkspaceStore.getState().projectName).toBe('Field notes');
    expect(container.querySelector('input[aria-label="Project name"]')).toBeNull();
    expect(container.querySelector('.st-project-name')?.textContent).toBe('Field notes');
  });

  it('keeps the name on Escape, and says why an empty one is not taken', async () => {
    act(() => button('Rename Notes')!.click());
    let input = container.querySelector<HTMLInputElement>('input[aria-label="Project name"]')!;
    type(input, 'Something else');
    key(input, 'Escape');
    expect(useWorkspaceStore.getState().projectName).toBe('Notes');
    act(() => button('Rename Notes')!.click());
    input = container.querySelector<HTMLInputElement>('input[aria-label="Project name"]')!;
    type(input, '  ');
    key(input, 'Enter');
    await flush();
    expect(useWorkspaceStore.getState().projectName).toBe('Notes');
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('A project needs a name.');
  });
});

describe('renaming from the list of projects', () => {
  const entries: RecentEntry[] = [{ id: 'a', name: 'Alpha', target: 'web', lastModified: 'today', saved: true, active: false }];

  it('asks the app to rename that project, and says when it could not', async () => {
    const onRenameProject = vi.fn(async (_id: string, name: string) => (name === 'Beta' ? { ok: true as const } : { ok: false as const, message: 'storage did not answer.' }));
    act(() => root.render(<Dashboard onNewProject={() => {}} recentProjects={entries} onRenameProject={onRenameProject} />));
    act(() => button('Rename Alpha')!.click());
    let input = container.querySelector<HTMLInputElement>('input[aria-label="New name for Alpha"]')!;
    expect(input.value).toBe('Alpha');
    type(input, 'Beta');
    key(input, 'Enter');
    await flush();
    expect(onRenameProject).toHaveBeenCalledWith('a', 'Beta');
    expect(container.querySelector('input[aria-label="New name for Alpha"]')).toBeNull();

    act(() => button('Rename Alpha')!.click());
    input = container.querySelector<HTMLInputElement>('input[aria-label="New name for Alpha"]')!;
    type(input, 'Gamma');
    act(() => button('Save name')!.click());
    await flush();
    expect(container.textContent).toContain('Could not rename Alpha: storage did not answer.');
  });
});

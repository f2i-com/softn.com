/** @vitest-environment jsdom */
/**
 * The save bar of a tab whose project another tab deleted.
 *
 * The tab went on saying "Saved", and its next change wrote the whole project
 * back: the deletion was undone and nobody was told (test/twoTabs.test.ts,
 * test/liveTabs.test.ts for the saving). The bar says so now and offers the
 * two ways out: keep it, which saves it here again, or close it, which lets it
 * go once the person has said so twice.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installFakeIndexedDB } from '@softn/test-utils/fake-indexeddb';
import { SaveStatusIndicator } from '../src/components/common/SaveStatus';
import { beginNewProjectSession, getSaveStatus, startProjectAutosave, subscribeProjectClosed, type AutosaveController } from '../src/lib/projectSession';
import { deleteProjectRecord, loadProjectRecord } from '../src/lib/persistence';
import { useVFSStore, useWorkspaceStore } from '../src/stores';

let container: HTMLDivElement;
let root: Root;
let autosave: AutosaveController | null = null;
let id: string;

beforeEach(async () => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  installFakeIndexedDB();
  localStorage.clear();
  useWorkspaceStore.getState().reset();
  useVFSStore.getState().reset();
  id = beginNewProjectSession();
  useWorkspaceStore.getState().setProjectName('Notes');
  useVFSStore.getState().createFile('ui/main.ui', '<Text>Main</Text>');
  autosave = startProjectAutosave({ debounceMs: 60_000, maxWaitMs: 60_000 });
  expect(await autosave.flush()).toEqual({ ok: true });
  // Deleted in another tab; this tab's next change is refused, and the bar says why.
  expect(await deleteProjectRecord(id)).toEqual({ ok: true });
  useVFSStore.getState().updateFile('ui/main.ui', '<Text>Main, changed here</Text>');
  expect(await autosave.flush()).toMatchObject({ ok: false, reason: 'deleted' });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(<SaveStatusIndicator />));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  autosave?.stop();
  autosave = null;
  vi.restoreAllMocks();
  delete (globalThis as unknown as { indexedDB?: unknown }).indexedDB;
});

const button = (name: string) => [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === name);
const settle = () => act(async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0)); });

describe('the save bar of a project deleted in another tab', () => {
  it('says so, and offers to keep it or close it in place of Export bundle', () => {
    expect(container.textContent).toMatch(/Not saved/);
    expect(container.textContent).toMatch(/deleted in another tab/i);
    expect(button('Keep it')).toBeDefined();
    expect(button('Close it')).toBeDefined();
    expect(button('Export bundle')).toBeUndefined();
  });

  it('keeps it: saved again, whole, as it is in this tab', async () => {
    act(() => button('Keep it')!.click());
    await settle();
    expect(getSaveStatus().state).toBe('saved');
    expect((await loadProjectRecord(id))?.files.find((f) => f.path === 'ui/main.ui')?.content).toBe('<Text>Main, changed here</Text>');
    expect(button('Keep it')).toBeUndefined();
  });

  it('closes it only when the person confirms, and then writes nothing', async () => {
    const closed = vi.fn();
    const stop = subscribeProjectClosed(closed);
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    act(() => button('Close it')!.click());
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(useWorkspaceStore.getState().projectId).toBe(id);
    expect(closed).not.toHaveBeenCalled();

    confirm.mockReturnValue(true);
    act(() => button('Close it')!.click());
    expect(closed).toHaveBeenCalledTimes(1);
    expect(useWorkspaceStore.getState().projectId).not.toBe(id);
    expect(useVFSStore.getState().files.size).toBe(0);
    await autosave!.flush();
    expect(await loadProjectRecord(id)).toBeNull();
    stop();
  });
  it('on a phone, says why on the bar and has the two ways on under it', () => {
    act(() => root.render(<SaveStatusIndicator compact />));
    expect(button('Keep it')).toBeUndefined();
    const toggle = button('Deleted in another tab')!;
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    act(() => toggle.click());
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelector('[role="group"]')?.textContent).toMatch(/deleted in another tab.*Keep it to save it here again/);
    expect(button('Keep it')).toBeDefined();
    expect(button('Close it')).toBeDefined();
    act(() => { toggle.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    expect(button('Keep it')).toBeUndefined();
  });
});

// @vitest-environment jsdom
/**
 * Unsaved work is kept as it is made, and offered back on the next open.
 *
 * Driven first: build a page, do not save, and look in the browser's
 * store. It was empty. The record a session is restored from was written
 * by Save and by Export alone, so a tab closed by mistake took everything
 * since the last of those with it; and two tabs each wrote the one record
 * at their own Save with nothing said to the other.
 *
 * What is held here: the copy is written a moment after a change and as
 * the page is left, and is the project as it stands; a project whose
 * assets do not fit is kept without them, and the offer says so; a store
 * that takes nothing is said once and thrown never; and a tab whose copy
 * another tab has just replaced is told.
 */

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RECOVERY_DELAY_MS, RECOVERY_FAILED, RECOVERY_TAKEN, useRecoveryCopy } from '../hooks/useRecoveryCopy';
import { useCanvasStore } from '../stores/canvasStore';
import { useFilesStore } from '../stores/filesStore';
import { useHistoryStore } from '../stores/historyStore';
import { useNotificationStore } from '../stores/notificationStore';
import { useProjectStore } from '../stores/projectStore';
import { useSchemaStore } from '../stores/schemaStore';
import { SESSION_STORAGE_KEY, captureSession, commitProjectSnapshot, prepareSessionSnapshot, startupAction } from './openProject';
import { RECOVERY_OWNER_KEY, TAB_ID, recoveryOf, restoreOffer, writeRecoveryCopy } from './recoveryCopy';
import { SESSION_ASSETS_KEY, joinStoredSession, resetRefusedAssets } from './storedAssets';
import { resetPersistedRevisions, saveProject } from './saveProject';
import { keepSavedPoint } from './savedPoint';
import { undoCanvas } from './canvasHistory';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

const canvas = () => useCanvasStore.getState();
const stored = () => window.localStorage.getItem(SESSION_STORAGE_KEY);
const said = () => useNotificationStore.getState().notifications.map((notification) => notification.message);

/** An edit on the canvas, as dropping a component makes one. */
function edit(words = 'Unsaved words'): void {
  const id = canvas().addElement('Text', canvas().rootId!, undefined, { starter: true });
  canvas().updateElementProps(id, { children: words });
}

function asset(name: string, bytes: number): void {
  const files = useFilesStore.getState();
  const id = `asset_${name}`;
  const nodes = new Map(files.nodes);
  const folder = [...nodes.values()].find((node) => node.type === 'folder' && node.path === 'assets')!;
  nodes.set(id, { id, name, path: `assets/${name}`, type: 'file', fileType: 'asset', parentId: folder.id, isDirty: false } as never);
  nodes.set(folder.id, { ...folder, children: [...(folder.children ?? []), id] });
  useFilesStore.setState({ nodes, assetFiles: new Map([...files.assetFiles, [id, { name, bundlePath: `assets/${name}`, type: 'image/png', data: new Uint8Array(bytes).fill(7) }]]) });
}

function everythingNew(): void {
  useProjectStore.getState().reset();
  useFilesStore.getState().reset();
  canvas().reset();
  useSchemaStore.getState().reset();
  useHistoryStore.getState().clear();
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  window.localStorage.clear();
  resetRefusedAssets();
  useNotificationStore.getState().clearAll();
  everythingNew();
  useProjectStore.getState().setName('Field Notes');
  useProjectStore.getState().markClean();
});

describe('the copy of unsaved work', () => {
  it('is the project as it stands, marked as unsaved and as this tab\'s, and comes back whole', () => {
    edit();
    const outcome = writeRecoveryCopy({ view: 'design' });
    expect(outcome).toMatchObject({ kind: 'written', assets: 'kept', revision: useProjectStore.getState().revision });
    expect(recoveryOf(stored()!)).toMatchObject({ tab: TAB_ID, unsaved: true, assets: 'kept', name: 'Field Notes' });
    expect(JSON.parse(window.localStorage.getItem(RECOVERY_OWNER_KEY)!).tab).toBe(TAB_ID);

    // The next open: the same question the page has always asked of what is stored, and the work is in it.
    expect(startupAction(new URL('http://localhost/') as never, { replaceState: () => undefined, state: null } as never, stored())).toEqual({ kind: 'restore-prompt', raw: stored() });
    everythingNew();
    commitProjectSnapshot(prepareSessionSnapshot(stored()!));
    expect([...canvas().elements.values()].some((element) => element.props.children === 'Unsaved words')).toBe(true);
    expect(useProjectStore.getState().name).toBe('Field Notes');
  });

  it('names the project\'s assets and holds none of them: they are a record of their own, put back when it is restored', () => {
    asset('small.png', 2000);
    edit();
    expect(writeRecoveryCopy({ view: 'design' })).toMatchObject({ kind: 'written', assets: 'kept' });
    const text = JSON.parse(stored()!) as { files: { assetFiles: unknown[]; assetRefs: Array<[string, { name: string; size: number }]> } };
    expect(text.files.assetFiles).toEqual([]);
    expect(text.files.assetRefs.map(([, ref]) => [ref.name, ref.size])).toEqual([['small.png', 2000]]);
    const joined = joinStoredSession(stored()!, window.localStorage.getItem(SESSION_ASSETS_KEY));
    expect(joined.assets).toEqual({ total: 1, missing: 0 });
    const copy = prepareSessionSnapshot(joined.raw);
    if (copy.files.kind !== 'state') throw new Error('a stored session comes back as the files it held');
    expect(copy.files.assetFiles.size).toBe(1);
    expect([...copy.canvas.elements.values()].some((element) => element.props.children === 'Unsaved words')).toBe(true);
  });

  it('is its text alone where the record of its assets is not there, with nothing left pointing at them', () => {
    asset('small.png', 2000);
    edit();
    writeRecoveryCopy({ view: 'design' });
    const joined = joinStoredSession(stored()!, null);
    expect(joined.assets).toEqual({ total: 1, missing: 1 });
    const copy = prepareSessionSnapshot(joined.raw);
    if (copy.files.kind !== 'state') throw new Error('a stored session comes back as the files it held');
    expect(copy.files.assetFiles.size).toBe(0);
    expect([...copy.files.nodes.values()].filter((node) => node.fileType === 'asset')).toEqual([]);
    expect([...copy.files.nodes.values()].find((node) => node.path === 'assets')!.children).toEqual([]);
    expect([...copy.canvas.elements.values()].some((element) => element.props.children === 'Unsaved words')).toBe(true);
  });

  it('is a failure handed back when the store will not take the text, and nothing is thrown', () => {
    asset('small.png', 4000);
    edit();
    const full = { setItem: () => { throw new DOMException('full', 'QuotaExceededError'); } };
    const outcome = writeRecoveryCopy({ view: 'design', storage: full });
    expect(outcome.kind).toBe('failed');
  });
});

describe('a save that is still writing its file while the work goes on', () => {
  it('does not put the revision it captured back over the copy of what was done since', async () => {
    // Save captures a revision and then waits for the file to be written. It
    // promises not to write the recovery record over a newer one, and knew
    // only of records other saves had written: the copy kept of unsaved work
    // a moment later was replaced by the older revision when the file was
    // done, and the page, having kept that revision already, wrote nothing
    // more on the way out.
    resetPersistedRevisions();
    edit('before the save');
    let fileWritten!: () => void;
    const saving = saveProject({
      view: 'design',
      existingHandle: null,
      build: async () => new Uint8Array([1]),
      writeFile: () => new Promise((resolve) => { fileWritten = () => resolve(null); }),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    edit('made while the file was being written');
    expect(writeRecoveryCopy({ view: 'design' }).kind).toBe('written');

    fileWritten();
    const outcome = await saving;
    expect(stored()).toContain('made while the file was being written');
    expect(recoveryOf(stored()!)?.unsaved).toBe(true);
    // Nothing failed, and the save says which it was: there is no "storage is full" to report.
    expect(outcome).toMatchObject({ kind: 'saved', stale: true, sessionStored: false, sessionSuperseded: true });
    expect('sessionError' in outcome && outcome.sessionError).toBeFalsy();
  });

  it('writes its own record as before when nothing newer is kept', async () => {
    resetPersistedRevisions();
    edit('saved as it is');
    writeRecoveryCopy({ view: 'design' });
    const outcome = await saveProject({ view: 'design', existingHandle: null, build: async () => new Uint8Array([1]), writeFile: async () => null });
    expect(outcome).toMatchObject({ kind: 'saved', stale: false, sessionStored: true });
    expect('sessionSuperseded' in outcome).toBe(false);
    // The record is the saved one now: not a copy of unsaved work.
    expect(recoveryOf(stored()!)).toBeNull();
  });
});

describe('the offer made on the next open', () => {
  it('says the work was not saved, whose it is and when, and what is not in it', () => {
    edit();
    writeRecoveryCopy({ view: 'design' });
    expect(restoreOffer(stored()!)).toMatch(/^Restore “Field Notes” with the changes that were not saved, as it was at .+ on .+\?$/);

    // What joining it with the record of its assets found is said, and a copy from before they were kept apart says it of itself.
    expect(restoreOffer(stored()!, { total: 3, missing: 3 })).toContain('Its pictures and other assets could not be kept in this browser and are not in it: add them again, or open the file you last saved.');
    expect(restoreOffer(stored()!, { total: 3, missing: 0 })).not.toContain('pictures');
    const before = JSON.stringify({ ...JSON.parse(stored()!), recovery: { tab: 'x', unsaved: true, assets: 'left-out' } });
    expect(restoreOffer(before)).toContain('Its pictures and other assets could not be kept in this browser and are not in it: add them again, or open the file you last saved.');
  });

  it('is the question it always was for a session that Save wrote, and for one that cannot be read', () => {
    expect(restoreOffer(JSON.stringify(captureSession('design')))).toBe('Restore the last locally saved builder session?');
    expect(restoreOffer('not json')).toBe('Restore the last locally saved builder session?');
    expect(recoveryOf(JSON.stringify(captureSession('design')))).toBeNull();
  });
});

describe('while a project is being edited', () => {
  let host: HTMLDivElement;
  let root: Root;
  function Editor({ enabled = true }: { enabled?: boolean }): null {
    useRecoveryCopy('design', enabled);
    return null;
  }
  const open = (enabled = true) => act(() => root.render(React.createElement(Editor, { enabled })));

  beforeEach(() => {
    vi.useFakeTimers();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('nothing is kept for a project with nothing unsaved', () => {
    open();
    act(() => void vi.advanceTimersByTime(RECOVERY_DELAY_MS * 3));
    expect(stored()).toBeNull();
  });

  it('the copy is written a moment after the last change, not at each one', () => {
    open();
    const write = vi.spyOn(Storage.prototype, 'setItem');
    act(() => edit('one'));
    act(() => void vi.advanceTimersByTime(RECOVERY_DELAY_MS - 100));
    act(() => edit('two'));
    act(() => void vi.advanceTimersByTime(RECOVERY_DELAY_MS - 100));
    expect(stored()).toBeNull();
    act(() => void vi.advanceTimersByTime(200));
    expect(stored()).toContain('two');
    // And once for that revision, however long nothing more is changed.
    const writes = write.mock.calls.filter(([key]) => key === SESSION_STORAGE_KEY).length;
    expect(writes).toBe(1);
    act(() => void vi.advanceTimersByTime(RECOVERY_DELAY_MS * 4));
    expect(write.mock.calls.filter(([key]) => key === SESSION_STORAGE_KEY).length).toBe(1);
  });

  it('is written at once as the page is left or hidden', () => {
    open();
    act(() => edit('closing'));
    expect(stored()).toBeNull();
    act(() => void window.dispatchEvent(new Event('pagehide')));
    expect(stored()).toContain('closing');
  });

  it('is not kept once the work has been saved, until there is more', () => {
    open();
    act(() => edit('saved'));
    act(() => useProjectStore.getState().markClean());
    act(() => void vi.advanceTimersByTime(RECOVERY_DELAY_MS * 2));
    expect(stored()).toBeNull();
    act(() => edit('more'));
    act(() => void vi.advanceTimersByTime(RECOVERY_DELAY_MS + 10));
    expect(stored()).toContain('more');
  });

  it('says once that it could not be kept, and throws nothing', () => {
    open();
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('full', 'QuotaExceededError'); });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    act(() => edit('one'));
    expect(() => act(() => void vi.advanceTimersByTime(RECOVERY_DELAY_MS + 10))).not.toThrow();
    act(() => edit('two'));
    act(() => void vi.advanceTimersByTime(RECOVERY_DELAY_MS + 10));
    expect(said().filter((message) => message === RECOVERY_FAILED)).toHaveLength(1);
  });

  it('tells a tab whose copy another tab has just replaced, once, and not a tab that had none', () => {
    open();
    const fromOther = () => act(() => void window.dispatchEvent(new StorageEvent('storage', { key: RECOVERY_OWNER_KEY, newValue: JSON.stringify({ tab: 'another-tab', savedAt: 'now' }) })));
    // Nothing unsaved here: nothing of this tab's was replaced.
    fromOther();
    expect(said()).toEqual([]);
    act(() => edit('mine'));
    act(() => void vi.advanceTimersByTime(RECOVERY_DELAY_MS + 10));
    // This tab's own write is not news to it.
    act(() => void window.dispatchEvent(new StorageEvent('storage', { key: RECOVERY_OWNER_KEY, newValue: JSON.stringify({ tab: TAB_ID, savedAt: 'now' }) })));
    expect(said()).toEqual([]);
    fromOther();
    fromOther();
    expect(said()).toEqual([RECOVERY_TAKEN]);
  });

  /** The entry page on the canvas, as the app has it once it is open, held as what was kept. */
  function kept(): void {
    const file = useFilesStore.getState().uiFiles.get('main_ui')!;
    canvas().loadState(file.elements, file.rootId, file.imports);
    keepSavedPoint();
  }
  /** An edit that Undo takes back whole. */
  function undoable(words: string): void {
    useHistoryStore.getState().push(canvas().elements, canvas().rootId);
    edit(words);
  }

  it('is written again as the project stands, and not as unsaved, once the work is undone to what was kept', () => {
    kept();
    open();
    act(() => undoable('undone later'));
    act(() => void vi.advanceTimersByTime(RECOVERY_DELAY_MS + 10));
    expect(recoveryOf(stored()!)?.unsaved).toBe(true);
    act(() => void undoCanvas());
    expect(useProjectStore.getState().isDirty).toBe(false);
    act(() => void vi.advanceTimersByTime(RECOVERY_DELAY_MS + 10));
    // The next open does not offer the undone words back as work that was not saved.
    expect(stored()).not.toContain('undone later');
    expect(recoveryOf(stored()!)).toBeNull();
    expect(useProjectStore.getState().name).toBe('Field Notes');
    expect(JSON.parse(stored()!).project.name).toBe('Field Notes');
  });

  it('is not written over another tab\'s copy once the work here is undone', () => {
    kept();
    open();
    act(() => undoable('mine, undone later'));
    act(() => void vi.advanceTimersByTime(RECOVERY_DELAY_MS + 10));
    const theirs = JSON.stringify({ ...JSON.parse(stored()!), recovery: { tab: 'another-tab', unsaved: true, assets: 'kept' } });
    window.localStorage.setItem(SESSION_STORAGE_KEY, theirs);
    act(() => void window.dispatchEvent(new StorageEvent('storage', { key: SESSION_STORAGE_KEY, newValue: theirs })));
    act(() => void undoCanvas());
    act(() => void vi.advanceTimersByTime(RECOVERY_DELAY_MS + 10));
    act(() => void window.dispatchEvent(new Event('pagehide')));
    expect(stored()).toBe(theirs);
  });

  it('is not kept for a draft that is edited inside another product, which keeps it', () => {
    open(false);
    act(() => edit('hosted'));
    act(() => void vi.advanceTimersByTime(RECOVERY_DELAY_MS * 2));
    act(() => void window.dispatchEvent(new Event('pagehide')));
    expect(stored()).toBeNull();
  });
});

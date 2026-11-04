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
import { RECOVERY_DELAY_MS, RECOVERY_FAILED, RECOVERY_TAKEN, recoveryHeld, useRecoveryCopy } from '../hooks/useRecoveryCopy';
import { useCanvasStore } from '../stores/canvasStore';
import { useFilesStore } from '../stores/filesStore';
import { useHistoryStore } from '../stores/historyStore';
import { useNotificationStore } from '../stores/notificationStore';
import { useProjectStore } from '../stores/projectStore';
import { useSchemaStore } from '../stores/schemaStore';
import { QUARANTINE_ASSETS_KEY, QUARANTINE_STORAGE_KEY, RECOVERY_UNREAD, SESSION_STORAGE_KEY, SET_ASIDE_NOT_RESTORED, captureSession, commitProjectSnapshot, discardQuarantinedSession, exportQuarantinedSession, noteOpenedFromLink, noteRestoreOffered, prepareSessionSnapshot, readQuarantinedSession, restoredFromStore, setAsideUnrestored, startupAction, takeOpenedFromLink } from './openProject';
import { RECOVERY_OWNER_KEY, TAB_ID, recoveryOf, restoreOffer, writeRecoveryCopy } from './recoveryCopy';
import { SESSION_ASSETS_KEY, joinStoredSession, resetRefusedAssets } from './storedAssets';
import { resetPersistedRevisions, saveProject, sessionNotes } from './saveProject';
import { keepSavedPoint } from './savedPoint';
import { redoCanvas, undoCanvas } from './canvasHistory';

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
  takeOpenedFromLink();
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

  it('sets aside unsaved work a link opened another project over, rather than writing over it', () => {
    edit('Only copy of this');
    writeRecoveryCopy({ view: 'design' });
    const first = stored()!;
    // The front page's starter, opened in the same browser: the first edit in it is the first write.
    noteOpenedFromLink();
    everythingNew();
    useProjectStore.getState().setName('Fieldnotes');
    edit('A change to the starter');
    expect(writeRecoveryCopy({ view: 'design' })).toMatchObject({ kind: 'written', setAside: 'Field Notes' });
    const kept = readQuarantinedSession()!;
    expect(kept.payload).toBe(first);
    expect(kept.error).toContain('link');
    expect(recoveryOf(stored()!)?.name).toBe('Fieldnotes');
    // Told once: the next write is this project's own.
    edit('Another change');
    expect(writeRecoveryCopy({ view: 'design' })).not.toHaveProperty('setAside');
  });

  it('writes nothing over unsaved work it could not set aside, and says so, until it can', () => {
    edit('Only copy of this');
    writeRecoveryCopy({ view: 'design' });
    const first = stored()!;
    // A store near its quota: the second copy of the work that setting it aside needs does not fit.
    const real = Storage.prototype.setItem;
    const full = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
      if (key === QUARANTINE_STORAGE_KEY) throw new DOMException('full', 'QuotaExceededError');
      return real.call(this, key, value);
    });
    try {
      noteOpenedFromLink();
      everythingNew();
      useProjectStore.getState().setName('Fieldnotes');
      edit('A change to the starter');
      expect(writeRecoveryCopy({ view: 'design' })).toEqual({ kind: 'held', keeping: 'Field Notes', reason: 'room' });
      expect(stored()).toBe(first);
      // Asked again at the next change, not only the first: the store still holds the only copy.
      edit('Another change');
      expect(writeRecoveryCopy({ view: 'design' })).toEqual({ kind: 'held', keeping: 'Field Notes', reason: 'room' });
      expect(stored()).toBe(first);
    } finally {
      full.mockRestore();
    }
    // With room again, it is set aside as it would have been.
    edit('And another');
    expect(writeRecoveryCopy({ view: 'design' })).toMatchObject({ kind: 'written', setAside: 'Field Notes' });
    expect(readQuarantinedSession()!.payload).toBe(first);
  });

  it('does not replace a session Recovery already keeps with the one a link would write over', () => {
    const earlier = JSON.stringify({ quarantinedAt: '2026-11-01T00:00:00.000Z', error: 'It would not restore', payload: '{"kept":"for them"}' });
    window.localStorage.setItem(QUARANTINE_STORAGE_KEY, earlier);
    edit('Only copy of this');
    writeRecoveryCopy({ view: 'design' });
    const first = stored()!;
    noteOpenedFromLink();
    everythingNew();
    edit('A change to the starter');
    expect(writeRecoveryCopy({ view: 'design' })).toEqual({ kind: 'held', keeping: 'Field Notes', reason: 'recovery' });
    expect(window.localStorage.getItem(QUARANTINE_STORAGE_KEY)).toBe(earlier);
    expect(stored()).toBe(first);
  });

  it('says once that this project is not kept while the other is', async () => {
    edit('Only copy of this');
    writeRecoveryCopy({ view: 'design' });
    window.localStorage.setItem(QUARANTINE_STORAGE_KEY, JSON.stringify({ quarantinedAt: '', error: 'x', payload: '{}' }));
    noteOpenedFromLink();
    everythingNew();
    vi.useFakeTimers();
    const host = document.createElement('div');
    const root = createRoot(host);
    try {
      act(() => root.render(React.createElement(() => (useRecoveryCopy('design'), null))));
      for (const words of ['one', 'two']) {
        act(() => edit(words));
        act(() => vi.advanceTimersByTime(RECOVERY_DELAY_MS + 10));
      }
      expect(said()).toEqual([recoveryHeld('Field Notes', 'recovery')]);
    } finally {
      act(() => root.unmount());
      vi.useRealTimers();
    }
  });

  it('keeps a session that would not restore in Recovery when it has room, and says so', () => {
    window.localStorage.setItem(SESSION_STORAGE_KEY, '{"project":{"name":"Broken"},"files":');
    const raw = stored()!;
    expect(setAsideUnrestored(raw, new Error('Unexpected end of JSON input'), null)).toBe('It was kept; download it from Export → Recovery.');
    expect(readQuarantinedSession()).toMatchObject({ payload: raw, error: 'Unexpected end of JSON input' });
    expect(stored()).toBeNull();
  });

  it('does not replace what Recovery keeps with a session that would not restore, or write over that session after', () => {
    const earlier = JSON.stringify({ quarantinedAt: '2026-11-01T00:00:00.000Z', error: 'It would not restore', payload: '{"kept":"for them"}' });
    window.localStorage.setItem(QUARANTINE_STORAGE_KEY, earlier);
    // Not a copy of unsaved work as far as can be read: it would not restore, so it is held all the same.
    window.localStorage.setItem(SESSION_STORAGE_KEY, '{"project":{"name":"Broken"},"files":null}');
    const raw = stored()!;
    const told = setAsideUnrestored(raw, new Error('Unexpected end of JSON input'), null);
    expect(told).toMatch(/^It is left where it is, and nothing is written over it: Recovery already keeps another\./);
    expect(told).not.toMatch(/It was kept/);
    expect(window.localStorage.getItem(QUARANTINE_STORAGE_KEY)).toBe(earlier);
    expect(stored()).toBe(raw);

    // The project the page goes on with: its first changes are not written over it.
    edit('A change');
    expect(writeRecoveryCopy({ view: 'design' })).toEqual({ kind: 'held', keeping: 'Broken', reason: 'recovery' });
    edit('Another change');
    expect(writeRecoveryCopy({ view: 'design' })).toEqual({ kind: 'held', keeping: 'Broken', reason: 'recovery' });
    expect(stored()).toBe(raw);

    // Recovery emptied: it is set aside with the reason it would not restore, and this project's copy is kept.
    window.localStorage.removeItem(QUARANTINE_STORAGE_KEY);
    edit('And another');
    expect(writeRecoveryCopy({ view: 'design' })).toMatchObject({ kind: 'written', setAside: 'Broken' });
    expect(readQuarantinedSession()).toMatchObject({ payload: raw, error: 'Unexpected end of JSON input' });
    expect(recoveryOf(stored()!)?.name).toBe('Field Notes');
  });

  it('discards or downloads only the session Recovery was showing, not one another tab set aside since', async () => {
    const shown = { quarantinedAt: '2026-11-04T01:00:00.000Z', error: 'x', payload: '{"project":{"name":"Shown"}}' };
    window.localStorage.setItem(QUARANTINE_STORAGE_KEY, JSON.stringify(shown));
    // Another tab discards it, and the unsaved work it was holding moves into Recovery.
    const since = { quarantinedAt: '2026-11-04T02:00:00.000Z', error: 'x', payload: '{"project":{"name":"Only copy"}}' };
    window.localStorage.setItem(QUARANTINE_STORAGE_KEY, JSON.stringify(since));
    window.localStorage.setItem(QUARANTINE_ASSETS_KEY, '{"assets":{}}');
    expect(discardQuarantinedSession(shown)).toBe(false);
    expect(await exportQuarantinedSession(shown)).toBe(false);
    expect(readQuarantinedSession()).toMatchObject({ payload: since.payload });
    expect(window.localStorage.getItem(QUARANTINE_ASSETS_KEY)).toBe('{"assets":{}}');
    // The one shown now goes when asked.
    expect(discardQuarantinedSession(since)).toBe(true);
    expect(readQuarantinedSession()).toBeNull();
    expect(window.localStorage.getItem(QUARANTINE_ASSETS_KEY)).toBeNull();
    // Already gone: nothing more to do, and that is not a refusal.
    expect(discardQuarantinedSession(since)).toBe(true);
  });

  it('says a session that would not restore is left where it is when the store has no room to set it aside', () => {
    window.localStorage.setItem(SESSION_STORAGE_KEY, 'not a session at all');
    const real = Storage.prototype.setItem;
    const full = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
      if (key === QUARANTINE_STORAGE_KEY) throw new DOMException('full', 'QuotaExceededError');
      return real.call(this, key, value);
    });
    try {
      expect(setAsideUnrestored('not a session at all', new Error('Unexpected token'), null)).toMatch(/^It is left where it is, and nothing is written over it: this browser’s storage has no room to set it aside\./);
      edit('A change');
      expect(writeRecoveryCopy({ view: 'design' })).toEqual({ kind: 'held', keeping: 'the session that would not restore', reason: 'room' });
      expect(stored()).toBe('not a session at all');
    } finally {
      full.mockRestore();
    }
  });

  it('sets aside work the Builder offered to restore and was told "Not now", before the first change is written', () => {
    edit('Only copy of this');
    writeRecoveryCopy({ view: 'design' });
    const first = stored()!;
    // The next page load: the offer is made, declined, and the empty project is changed.
    noteRestoreOffered();
    everythingNew();
    edit('A new start');
    expect(writeRecoveryCopy({ view: 'design' })).toMatchObject({ kind: 'written', setAside: 'Field Notes' });
    expect(readQuarantinedSession()).toMatchObject({ payload: first, error: SET_ASIDE_NOT_RESTORED });
  });

  it('writes restored work as this tab\'s own once it is restored', () => {
    edit('Only copy of this');
    writeRecoveryCopy({ view: 'design' });
    noteRestoreOffered();
    everythingNew();
    commitProjectSnapshot(prepareSessionSnapshot(stored()!));
    restoredFromStore(stored()!);
    edit('More of it');
    expect(writeRecoveryCopy({ view: 'design' })).not.toHaveProperty('setAside');
    expect(readQuarantinedSession()).toBeNull();
  });

  it('sets aside the work another tab kept while the offer waited, once the copy offered is restored here', () => {
    edit('Only copy of this');
    writeRecoveryCopy({ view: 'design' });
    const offered = stored()!;
    noteRestoreOffered();
    // While the question waits, another tab goes on with its work and keeps a newer copy, then closes.
    const session = JSON.parse(offered) as { recovery: object; project: object };
    const theirs = JSON.stringify({ ...session, recovery: { ...session.recovery, tab: 'another-tab' }, project: { ...session.project, name: 'Their Work' } });
    window.localStorage.setItem(SESSION_STORAGE_KEY, theirs);
    // The person answers Restore: the copy offered is put back, as it was offered.
    everythingNew();
    commitProjectSnapshot(prepareSessionSnapshot(offered));
    restoredFromStore(offered);
    edit('More of it');
    expect(writeRecoveryCopy({ view: 'design' })).toMatchObject({ kind: 'written', setAside: 'Their Work' });
    expect(readQuarantinedSession()!.payload).toBe(theirs);
  });

  it('leaves where it is a session another tab kept since, when the one read as the page opened is set aside', () => {
    window.localStorage.setItem(SESSION_STORAGE_KEY, '{"theirs":true}');
    window.localStorage.setItem(SESSION_ASSETS_KEY, '{"files":[]}');
    expect(setAsideUnrestored('{"read as the page opened":true}', new Error('It would not restore'), '{"files":[["a",{}]]}')).toMatch(/^It was kept/);
    expect(stored()).toBe('{"theirs":true}');
    expect(window.localStorage.getItem(SESSION_ASSETS_KEY)).toBe('{"files":[]}');
    expect(readQuarantinedSession()!.payload).toBe('{"read as the page opened":true}');
    expect(window.localStorage.getItem(QUARANTINE_ASSETS_KEY)).toBe('{"files":[["a",{}]]}');
  });

  it('lets go of a session it held for not restoring once another tab has written its own over it', () => {
    const earlier = JSON.stringify({ quarantinedAt: '2026-11-01T00:00:00.000Z', error: 'It would not restore', payload: '{"kept":"for them"}' });
    window.localStorage.setItem(QUARANTINE_STORAGE_KEY, earlier);
    window.localStorage.setItem(SESSION_STORAGE_KEY, 'not a session at all');
    expect(setAsideUnrestored('not a session at all', new Error('Unexpected token'), null)).toMatch(/Recovery already keeps another/);
    // Another tab saves its project: what is stored now is a session Save wrote, which has its file.
    const saved = JSON.stringify(captureSession('design'));
    window.localStorage.setItem(SESSION_STORAGE_KEY, saved);
    edit('This tab goes on');
    const outcome = writeRecoveryCopy({ view: 'design' });
    expect(outcome).toMatchObject({ kind: 'written' });
    expect(outcome).not.toHaveProperty('setAside');
    expect(window.localStorage.getItem(QUARANTINE_STORAGE_KEY)).toBe(earlier);
  });

  it('keeps another tab\'s work from being written over when the session that would not restore is no longer stored here', () => {
    edit('Their work');
    writeRecoveryCopy({ view: 'design' });
    const session = JSON.parse(stored()!) as { recovery: object };
    const theirs = JSON.stringify({ ...session, recovery: { ...session.recovery, tab: 'another-tab' } });
    window.localStorage.setItem(SESSION_STORAGE_KEY, theirs);
    window.localStorage.setItem(QUARANTINE_STORAGE_KEY, JSON.stringify({ quarantinedAt: '2026-11-01T00:00:00.000Z', error: 'It would not restore', payload: '{"kept":"for them"}' }));
    // This tab offered the session it read as it opened; Restore failed after the other tab wrote over it.
    noteRestoreOffered();
    expect(setAsideUnrestored('the session read as the page opened', new Error('Unexpected token'), null)).toMatch(/could not be set aside/);
    everythingNew();
    edit('This tab');
    expect(writeRecoveryCopy({ view: 'design' })).toMatchObject({ kind: 'held' });
    expect(stored()).toBe(theirs);
  });

  it('says a session set aside without its pictures was kept without them', () => {
    window.localStorage.setItem(SESSION_STORAGE_KEY, '{"theirs":true}');
    const setItem = Storage.prototype.setItem;
    const full = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
      if (key === QUARANTINE_ASSETS_KEY) throw new DOMException('full', 'QuotaExceededError');
      setItem.call(this, key, value);
    });
    try {
      expect(setAsideUnrestored('{"read as the page opened":true}', new Error('It would not restore'), '{"files":[["a",{}]]}')).toMatch(/^It was kept without its pictures/);
    } finally {
      full.mockRestore();
    }
    expect(readQuarantinedSession()!.payload).toBe('{"read as the page opened":true}');
  });

  it('shows a Recovery record it cannot read as it is, so it can be downloaded or discarded and Recovery made free', () => {
    window.localStorage.setItem(QUARANTINE_STORAGE_KEY, 'not a record this Builder writes');
    const shown = readQuarantinedSession()!;
    expect(shown).toEqual({ quarantinedAt: '', error: RECOVERY_UNREAD, payload: 'not a record this Builder writes' });
    window.localStorage.setItem(SESSION_STORAGE_KEY, '{"another":true}');
    expect(setAsideUnrestored('{"another":true}', new Error('It would not restore'), null)).toMatch(/Recovery already keeps another/);
    expect(discardQuarantinedSession(shown)).toBe(true);
    expect(window.localStorage.getItem(QUARANTINE_STORAGE_KEY)).toBeNull();
    // An empty record keeps nothing, and is no reason to refuse the next.
    window.localStorage.setItem(QUARANTINE_STORAGE_KEY, '');
    expect(readQuarantinedSession()).toBeNull();
    window.localStorage.setItem(SESSION_STORAGE_KEY, '{"another":true}');
    expect(setAsideUnrestored('{"another":true}', new Error('It would not restore'), null)).toMatch(/^It was kept/);
  });

  it('sets aside a session that would not restore when a link opens over it, with the reason it would not', () => {
    // Not a copy of unsaved work as far as it says, and in no form the Builder opens: nothing else has it.
    window.localStorage.setItem(SESSION_STORAGE_KEY, '{"project":{"name":"Broken"},"files":null}');
    const raw = stored()!;
    noteOpenedFromLink();
    edit('A change to the starter');
    expect(writeRecoveryCopy({ view: 'design' })).toMatchObject({ kind: 'written', setAside: 'Broken' });
    expect(readQuarantinedSession()!.payload).toBe(raw);
    expect(readQuarantinedSession()!.error).toMatch(/missing its project, canvas, schema or files/);
  });

  it('holds a session that will not even parse when a link opens over it and Recovery is full', () => {
    const earlier = JSON.stringify({ quarantinedAt: '2026-11-01T00:00:00.000Z', error: 'It would not restore', payload: '{"kept":"for them"}' });
    window.localStorage.setItem(QUARANTINE_STORAGE_KEY, earlier);
    window.localStorage.setItem(SESSION_STORAGE_KEY, 'not a session at all');
    noteOpenedFromLink();
    edit('A change to the starter');
    expect(writeRecoveryCopy({ view: 'design' })).toEqual({ kind: 'held', keeping: 'the session that would not restore', reason: 'recovery' });
    expect(stored()).toBe('not a session at all');
    expect(window.localStorage.getItem(QUARANTINE_STORAGE_KEY)).toBe(earlier);
    // What the person is told says how to make room, and Download alone does not.
    expect(recoveryHeld('x', 'recovery')).toMatch(/download the one in Export → Recovery if you want it, then discard it\.$/);
  });

  it('leaves a session Save wrote alone when a link opens over it: that work has a file', () => {
    window.localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(captureSession('design')));
    noteOpenedFromLink();
    edit();
    expect(writeRecoveryCopy({ view: 'design' })).not.toHaveProperty('setAside');
    expect(readQuarantinedSession()).toBeNull();
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

describe('a save straight after a link opens a project over unsaved work', () => {
  const save = (as?: 'export') => saveProject({ ...(as ? { as } : {}), view: 'design', existingHandle: null, build: async () => new Uint8Array([1]), writeFile: async () => null, writeExport: async () => null });

  it('leaves the work where it is when it cannot be set aside, and says so; the file is still written', async () => {
    edit('Only copy of this');
    writeRecoveryCopy({ view: 'design' });
    const first = stored()!;
    window.localStorage.setItem(QUARANTINE_STORAGE_KEY, JSON.stringify({ quarantinedAt: '', error: 'x', payload: '{}' }));
    // The starter opened, and saved or exported at once, before any edit in it.
    noteOpenedFromLink();
    everythingNew();
    useProjectStore.getState().setName('Fieldnotes');
    for (const as of [undefined, 'export'] as const) {
      const written: string[] = [];
      const outcome = await saveProject({ ...(as ? { as } : {}), view: 'design', existingHandle: null, build: async () => new Uint8Array([1]),
        writeFile: async () => (written.push('file'), null), writeExport: async () => (written.push('export'), null) });
      expect(written).toHaveLength(1);
      expect(outcome).toMatchObject({ kind: 'saved', sessionStored: false, sessionHeld: { keeping: 'Field Notes', reason: 'recovery' } });
      expect('sessionError' in outcome && outcome.sessionError).toBeFalsy();
      expect(stored()).toBe(first);
      expect(sessionNotes(outcome as never)).toEqual(['Your unsaved work on Field Notes is still kept for recovery, and was not replaced: the file is this project’s copy.']);
    }
  });

  it('sets the work aside first when it can, and says where it went', async () => {
    edit('Only copy of this');
    writeRecoveryCopy({ view: 'design' });
    const first = stored()!;
    noteOpenedFromLink();
    everythingNew();
    useProjectStore.getState().setName('Fieldnotes');
    const outcome = await save();
    expect(outcome).toMatchObject({ kind: 'saved', sessionStored: true, setAside: 'Field Notes' });
    expect(readQuarantinedSession()!.payload).toBe(first);
    expect(recoveryOf(stored()!)).toBeNull();
    // Asked once: the next save is this project's own.
    expect(await save()).not.toHaveProperty('setAside');
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

  it('is not written over another tab\'s copy that this tab has not heard of yet', () => {
    // The store is heard changing a moment after it has changed. Whose copy
    // it holds is read from it before a copy with no mark is written over it.
    kept();
    open();
    act(() => undoable('mine, undone later'));
    act(() => void vi.advanceTimersByTime(RECOVERY_DELAY_MS + 10));
    const theirs = JSON.stringify({ ...JSON.parse(stored()!), recovery: { tab: 'another-tab', unsaved: true, assets: 'kept' } });
    window.localStorage.setItem(SESSION_STORAGE_KEY, theirs);
    act(() => void undoCanvas());
    act(() => void vi.advanceTimersByTime(RECOVERY_DELAY_MS + 10));
    act(() => void window.dispatchEvent(new Event('pagehide')));
    expect(stored()).toBe(theirs);
  });

  it('is not marked as unsaved where putting the canvas into its file shows the project to be what was saved', async () => {
    // Driven first: an edit, a save, Undo, and Redo back to the save. The
    // toolbar said "Unsaved" until the canvas went into its file, which is
    // where the copy is taken from; the copy had been decided on before
    // that, and was written as unsaved work for a project with none. The
    // next open offered "the changes that were not saved".
    resetPersistedRevisions();
    const page = '<App>\n  <Text>First</Text>\n</App>';
    useFilesStore.getState().updateUIFileSource('main_ui', page);
    useProjectStore.getState().markClean();
    kept();
    open();
    const text = [...canvas().elements.values()].find((element) => element.componentType === 'Text')!;
    act(() => {
      useHistoryStore.getState().push(canvas().elements, canvas().rootId);
      canvas().updateElementProps(text.id, { children: 'Saved words' });
    });
    await act(async () => {
      await saveProject({ view: 'design', existingHandle: null, writeFile: async () => null });
    });
    expect(useProjectStore.getState().isDirty).toBe(false);

    act(() => void undoCanvas());
    act(() => void vi.advanceTimersByTime(RECOVERY_DELAY_MS + 10));
    // Undone past the save: that is unsaved, and kept as such.
    expect(recoveryOf(stored()!)?.unsaved).toBe(true);
    expect(stored()).not.toContain('Saved words');

    act(() => void redoCanvas());
    act(() => void vi.advanceTimersByTime(RECOVERY_DELAY_MS + 10));
    expect(useProjectStore.getState().isDirty).toBe(false);
    expect(stored()).toContain('Saved words');
    expect(recoveryOf(stored()!)).toBeNull();
  });

  it('is not kept for a draft that is edited inside another product, which keeps it', () => {
    open(false);
    act(() => edit('hosted'));
    act(() => void vi.advanceTimersByTime(RECOVERY_DELAY_MS * 2));
    act(() => void window.dispatchEvent(new Event('pagehide')));
    expect(stored()).toBeNull();
  });
});

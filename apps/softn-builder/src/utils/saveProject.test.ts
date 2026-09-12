// @vitest-environment jsdom
/**
 * A save marks clean only the revision it saved.
 *
 * handleSave awaited the file write and then called markClean, whatever had
 * happened during the wait: an edit made while the picker was open was
 * marked clean without reaching a file, and a save begun on one project
 * marked clean the project opened while it was pending — and wrote that
 * first project's session over the second's recovery record. Its session
 * payload mixed snapshots taken before the write with `toJSON()` read after
 * it, so the recovery record was of no revision at all.
 *
 * Pinned with a paused mocked file write: edits during the pending save
 * stay dirty; a save from project A cannot clean project B or replace its
 * recovery record; the bytes written and the recovery record are the same
 * revision; cancel, I/O failure and success-then-storage-failure are three
 * distinct outcomes.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readBundleEntries } from '@softn/core';
import { saveProject, resetPersistedRevisions, type SaveOutcome } from './saveProject';
import { SESSION_STORAGE_KEY, commitProjectSnapshot, prepareProjectSnapshot } from './openProject';
import { loadBundle } from './bundleLoader';
import { useProjectStore } from '../stores/projectStore';
import { useCanvasStore } from '../stores/canvasStore';
import { useSchemaStore } from '../stores/schemaStore';
import { useFilesStore } from '../stores/filesStore';
import { strToU8, zipSync } from 'fflate';

interface Deferred {
  resolve: (handle: FileSystemFileHandle | null) => void;
  reject: (e: unknown) => void;
  written: Uint8Array | null;
  calls: number;
}

/** A file write that waits until the test lets it finish. */
function pausedWrite(): { deferred: Deferred; writeFile: (bytes: Uint8Array) => Promise<FileSystemFileHandle | null> } {
  const deferred: Deferred = { resolve: () => {}, reject: () => {}, written: null, calls: 0 };
  const writeFile = (bytes: Uint8Array) => {
    deferred.written = bytes;
    deferred.calls += 1;
    return new Promise<FileSystemFileHandle | null>((resolve, reject) => {
      deferred.resolve = resolve;
      deferred.reject = reject;
    });
  };
  return { deferred, writeFile };
}

function memoryStorage(): Pick<Storage, 'setItem'> & { items: Map<string, string> } {
  const items = new Map<string, string>();
  return { items, setItem: (k: string, v: string) => void items.set(k, v) };
}

const manifestName = (bytes: Uint8Array) => JSON.parse(new TextDecoder().decode(readBundleEntries(bytes).get('manifest.json')!)).name as string;

function bundleNamed(name: string): Uint8Array {
  return zipSync({
    'manifest.json': strToU8(
      JSON.stringify({ name, version: '1.0.0', description: '', main: 'ui/main.ui', files: { ui: ['ui/main.ui'], logic: [], xdb: [], assets: [] } })
    ),
    'ui/main.ui': strToU8('<App><Text>b</Text></App>\n'),
  });
}

async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

beforeEach(() => {
  resetPersistedRevisions();
  useCanvasStore.getState().reset();
  useProjectStore.getState().reset();
  useSchemaStore.getState().reset();
  useFilesStore.getState().reset();
  const file = useFilesStore.getState().uiFiles.get('main_ui')!;
  useCanvasStore.getState().loadState(file.elements, file.rootId);
  useProjectStore.getState().setName('Project A');
  useProjectStore.getState().markClean();
});

describe('a save with a paused file write', () => {
  it.each(['source', 'secondary logic', 'canvas'] as const)('keeps %s edits made during a pending save unsaved', async (kind) => {
    const { deferred, writeFile } = pausedWrite();
    const file = kind === 'secondary logic' ? useFilesStore.getState().createFile('logic', 'extra.logic', 'logic') : 'main_ui';
    useProjectStore.getState().markClean();
    const saving = saveProject({ view: 'design', existingHandle: null, writeFile, storage: memoryStorage() });
    await settle();
    if (kind === 'source') useFilesStore.getState().updateUIFileSource(file, '<App><Text>Later</Text></App>');
    else if (kind === 'secondary logic') useFilesStore.getState().updateLogicFile(file, 'let later = true;');
    else useCanvasStore.getState().addElement('Text', useCanvasStore.getState().rootId);
    deferred.resolve(null);
    const outcome = await saving;
    expect(outcome).toMatchObject({ kind: 'saved', stale: true, projectChanged: false });
    expect(useProjectStore.getState().isDirty).toBe(true);
  });
  it.each(['capture', 'build'] as const)('reports a synchronous %s failure and preserves unsaved work', async (step) => {
    useProjectStore.getState().setDescription('must not disappear');
    const writeFile = vi.fn(async () => null);
    const error = new Error(`Invalid ${step} state`);
    const outcome = await saveProject({ view: 'code', existingHandle: null, writeFile,
      [step]: () => { throw error; },
    });
    expect(outcome).toEqual({ kind: 'failed', error });
    expect(writeFile).not.toHaveBeenCalled();
    expect(useProjectStore.getState().isDirty).toBe(true);
    expect(useProjectStore.getState().description).toBe('must not disappear');
  });
  it('leaves edits made during the write dirty, and says so', async () => {
    const project = useProjectStore.getState();
    project.setDescription('first');
    expect(useProjectStore.getState().isDirty).toBe(true);
    const revisionAtSave = useProjectStore.getState().revision;

    const { deferred, writeFile } = pausedWrite();
    const storage = memoryStorage();
    const pending = saveProject({ view: 'design', existingHandle: null, writeFile, storage });
    await settle();
    expect(deferred.calls).toBe(1);

    // An edit while the picker is open.
    useProjectStore.getState().setDescription('second');
    deferred.resolve(null);
    const outcome = await pending;

    expect(outcome.kind).toBe('saved');
    const saved = outcome as Extract<SaveOutcome, { kind: 'saved' }>;
    expect(saved.stale).toBe(true);
    expect(saved.revision).toBe(revisionAtSave);
    expect(useProjectStore.getState().isDirty).toBe(true);
    expect(useProjectStore.getState().description).toBe('second');
  });

  it('marks clean when nothing moved, and the file and recovery record are one revision', async () => {
    useProjectStore.getState().setDescription('once');
    const { deferred, writeFile } = pausedWrite();
    const storage = memoryStorage();
    const pending = saveProject({ view: 'data', existingHandle: null, writeFile, storage });
    await settle();
    deferred.resolve(null);
    const outcome = (await pending) as Extract<SaveOutcome, { kind: 'saved' }>;

    expect(outcome.kind).toBe('saved');
    expect(outcome.stale).toBe(false);
    expect(outcome.sessionStored).toBe(true);
    expect(useProjectStore.getState().isDirty).toBe(false);
    const session = JSON.parse(storage.items.get(SESSION_STORAGE_KEY)!);
    expect(session.projectId).toBe(outcome.projectId);
    expect(session.revision).toBe(outcome.revision);
    expect(session.project.description).toBe('once');
    expect(session.view).toBe('data');
    expect(manifestName(deferred.written!)).toBe('Project A');
  });

  it('writes the revision it captured even when the name changes during the write', async () => {
    const { deferred, writeFile } = pausedWrite();
    const storage = memoryStorage();
    const pending = saveProject({ view: 'design', existingHandle: null, writeFile, storage });
    await settle();
    useProjectStore.getState().setName('Renamed during save');
    deferred.resolve(null);
    const outcome = (await pending) as Extract<SaveOutcome, { kind: 'saved' }>;
    expect(manifestName(deferred.written!)).toBe('Project A');
    expect(JSON.parse(storage.items.get(SESSION_STORAGE_KEY)!).project.name).toBe('Project A');
    expect(outcome.stale).toBe(true);
  });
});

describe('a save begun on project A while project B is opened', () => {
  it('neither cleans B nor replaces B\'s recovery record', async () => {
    useProjectStore.getState().setDescription('A, unsaved');
    const { deferred, writeFile } = pausedWrite();
    const storage = memoryStorage();
    const pending = saveProject({ view: 'design', existingHandle: null, writeFile, storage });
    await settle();

    // Open B while A's write is pending, then edit B.
    commitProjectSnapshot(prepareProjectSnapshot(await loadBundle(bundleNamed('Project B'))));
    useProjectStore.getState().setDescription('B, unsaved');
    const bId = useProjectStore.getState().projectId;
    const bRevision = useProjectStore.getState().revision;
    storage.items.set(SESSION_STORAGE_KEY, 'B recovery record');

    deferred.resolve(null);
    const outcome = (await pending) as Extract<SaveOutcome, { kind: 'saved' }>;

    expect(outcome.kind).toBe('saved');
    expect(outcome.projectChanged).toBe(true);
    expect(outcome.projectId).not.toBe(bId);
    expect(manifestName(deferred.written!)).toBe('Project A');
    // B is untouched: still dirty, at its own revision, its record intact.
    expect(useProjectStore.getState().isDirty).toBe(true);
    expect(useProjectStore.getState().projectId).toBe(bId);
    expect(useProjectStore.getState().revision).toBe(bRevision);
    expect(storage.items.get(SESSION_STORAGE_KEY)).toBe('B recovery record');
    expect(outcome.sessionStored).toBe(false);
  });
});

describe('the three ways a save can end short of clean', () => {
  it('cancel: quiet, still dirty, nothing stored', async () => {
    useProjectStore.getState().setDescription('x');
    const { deferred, writeFile } = pausedWrite();
    const storage = memoryStorage();
    const pending = saveProject({ view: 'design', existingHandle: null, writeFile, storage });
    await settle();
    deferred.reject(new DOMException('The user aborted a request.', 'AbortError'));
    expect(await pending).toEqual({ kind: 'cancelled' });
    expect(useProjectStore.getState().isDirty).toBe(true);
    expect(storage.items.size).toBe(0);
  });

  it('I/O failure: reported, still dirty, nothing stored', async () => {
    useProjectStore.getState().setDescription('x');
    const { deferred, writeFile } = pausedWrite();
    const storage = memoryStorage();
    const pending = saveProject({ view: 'design', existingHandle: null, writeFile, storage });
    await settle();
    deferred.reject(new Error('disk full'));
    const outcome = await pending;
    expect(outcome.kind).toBe('failed');
    expect((outcome as { error: Error }).error.message).toBe('disk full');
    expect(useProjectStore.getState().isDirty).toBe(true);
    expect(storage.items.size).toBe(0);
  });

  it('file saved, recovery record not stored: a successful save that says the record is missing', async () => {
    useProjectStore.getState().setDescription('x');
    const { deferred, writeFile } = pausedWrite();
    const storage: Pick<Storage, 'setItem'> = {
      setItem: () => {
        throw new DOMException('quota', 'QuotaExceededError');
      },
    };
    const pending = saveProject({ view: 'design', existingHandle: null, writeFile, storage });
    await settle();
    deferred.resolve(null);
    const outcome = (await pending) as Extract<SaveOutcome, { kind: 'saved' }>;
    expect(outcome.kind).toBe('saved');
    expect(outcome.stale).toBe(false);
    expect(outcome.sessionStored).toBe(false);
    expect(outcome.sessionError).toBeInstanceOf(DOMException);
    // The file is on disk: the project is clean.
    expect(useProjectStore.getState().isDirty).toBe(false);
  });
});

describe('the recovery record', () => {
  it('is never overwritten by an older revision that finishes later', async () => {
    const storage = memoryStorage();
    const first = pausedWrite();
    useProjectStore.getState().setDescription('one');
    const older = saveProject({ view: 'design', existingHandle: null, writeFile: first.writeFile, storage });
    await settle();
    useProjectStore.getState().setDescription('two');
    const second = pausedWrite();
    const newer = saveProject({ view: 'design', existingHandle: null, writeFile: second.writeFile, storage });
    await settle();
    second.deferred.resolve(null);
    await newer;
    first.deferred.resolve(null);
    const outcome = (await older) as Extract<SaveOutcome, { kind: 'saved' }>;
    expect(outcome.stale).toBe(true);
    expect(outcome.sessionStored).toBe(false);
    expect(JSON.parse(storage.items.get(SESSION_STORAGE_KEY)!).project.description).toBe('two');
    expect(useProjectStore.getState().isDirty).toBe(false);
  });
});

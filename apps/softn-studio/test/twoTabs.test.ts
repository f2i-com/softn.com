/**
 * One project open in two tabs.
 *
 * The project is saved as one record, and a tab whose copy was older than
 * the stored one used to be refused every save: one change in the other tab
 * (a hand edit, a run's step, a panel opened) and this tab said "Not saved"
 * for good, however unrelated its own work was. A save is now merged with
 * the stored copy, part by part, against what this tab last had from
 * storage: what only one tab changed is kept and brought into the other, and
 * what both changed is never written over. Here "the other tab" is a write
 * to the store as another tab's autosave makes it.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installFakeIndexedDB } from '@softn/test-utils/fake-indexeddb';
import { beginNewProjectSession, getSaveStatus, keepThisTabsVersion, startProjectAutosave, type AutosaveController } from '../src/lib/projectSession';
import { loadProjectRecord, saveProjectRecord, type PersistedFile, type ProjectRecord } from '../src/lib/persistence';
import { useAIStore, useEditStore, useVFSStore, useWorkspaceStore } from '../src/stores';
import { beginHandEdit, saveHandEdit } from '../src/lib/handEdit';

function memoryStorage() {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
    removeItem: (key: string) => { data.delete(key); },
  };
}

let autosave: AutosaveController | null = null;

beforeEach(() => {
  installFakeIndexedDB();
  (globalThis as unknown as { window: unknown }).window = { localStorage: memoryStorage() };
  useWorkspaceStore.getState().reset();
  useVFSStore.getState().reset();
  useAIStore.setState({ providers: [], activeProviderId: null, messages: [], agentState: 'idle', currentStep: '', iterationsUsed: 0, tokensUsed: 0, filesChanged: 0 });
});

afterEach(() => {
  autosave?.stop();
  autosave = null;
  delete (globalThis as unknown as { indexedDB?: unknown }).indexedDB;
  delete (globalThis as unknown as { window?: unknown }).window;
});

/** A project saved once from this tab, with two pages. */
async function savedProject(): Promise<string> {
  const id = beginNewProjectSession();
  useWorkspaceStore.getState().setProjectName('Notes');
  useVFSStore.getState().createFile('ui/main.ui', '<Text>Main</Text>');
  useVFSStore.getState().createFile('ui/about.ui', '<Text>About</Text>');
  autosave = startProjectAutosave({ debounceMs: 10 });
  expect(await autosave.flush()).toEqual({ ok: true });
  return id;
}

/** The other tab, which opened the stored copy, changes it and saves. */
async function otherTabSaves(id: string, change: (record: ProjectRecord) => ProjectRecord): Promise<void> {
  const stored = (await loadProjectRecord(id))!;
  expect(await saveProjectRecord(change({ ...stored, revision: stored.revision + 7 }), stored.revision)).toEqual({ ok: true });
}

const withFile = (path: string, content: string) => (record: ProjectRecord): ProjectRecord => {
  const file: PersistedFile = { path, content, mimeType: 'text/plain', lastModified: 2, lastModifiedBy: 'ai', version: 9 };
  return { ...record, files: [...record.files.filter((f) => f.path !== path), file] };
};

const storedFile = async (id: string, path: string) => (await loadProjectRecord(id))?.files.find((f) => f.path === path)?.content;
const here = (path: string) => useVFSStore.getState().files.get(path)?.content;

describe('two tabs on one project', () => {
  it('saves what this tab changed and keeps what the other tab saved, when they changed different files', async () => {
    const id = await savedProject();
    await otherTabSaves(id, withFile('ui/about.ui', '<Text>About, from the other tab</Text>'));

    useVFSStore.getState().updateFile('ui/main.ui', '<Text>Main, from this tab</Text>');
    expect(await autosave!.flush()).toEqual({ ok: true });
    expect(getSaveStatus().state).toBe('saved');
    expect(await storedFile(id, 'ui/main.ui')).toBe('<Text>Main, from this tab</Text>');
    expect(await storedFile(id, 'ui/about.ui')).toBe('<Text>About, from the other tab</Text>');
    // And this tab now has the other tab's change, so its next save does not take it back.
    expect(here('ui/about.ui')).toBe('<Text>About, from the other tab</Text>');
    useVFSStore.getState().updateFile('ui/main.ui', '<Text>Main, again</Text>');
    expect(await autosave!.flush()).toEqual({ ok: true });
    expect(await storedFile(id, 'ui/about.ui')).toBe('<Text>About, from the other tab</Text>');
    expect(useWorkspaceStore.getState().consoleOutput.join('\n')).toMatch(/Brought in what another tab saved: ui\/about\.ui\./);
  });

  it('is not blocked by a panel opened here after the other tab saved', async () => {
    const id = await savedProject();
    await otherTabSaves(id, withFile('ui/main.ui', '<Text>From the other tab</Text>'));
    useWorkspaceStore.getState().setLeftPanel('files');
    expect(await autosave!.flush()).toEqual({ ok: true });
    expect(await storedFile(id, 'ui/main.ui')).toBe('<Text>From the other tab</Text>');
    expect(here('ui/main.ui')).toBe('<Text>From the other tab</Text>');
    expect((await loadProjectRecord(id))?.workspace.leftPanel).toBe('files');
  });

  it('keeps a file and its deletion where only the other tab made them', async () => {
    const id = await savedProject();
    await otherTabSaves(id, (record) => withFile('ui/new.ui', '<Text>New</Text>')({ ...record, files: record.files.filter((f) => f.path !== 'ui/about.ui') }));
    useWorkspaceStore.getState().setProjectName('Notes, renamed here');
    expect(await autosave!.flush()).toEqual({ ok: true });
    const stored = await loadProjectRecord(id);
    expect(stored?.files.map((f) => f.path).sort()).toEqual(['ui/main.ui', 'ui/new.ui']);
    expect(stored?.workspace.projectName).toBe('Notes, renamed here');
    expect([...useVFSStore.getState().files.keys()].sort()).toEqual(['ui/main.ui', 'ui/new.ui']);
  });

  it('does not write over a file both tabs changed, says which, and saves the rest', async () => {
    const id = await savedProject();
    await otherTabSaves(id, withFile('ui/main.ui', '<Text>Main, from the other tab</Text>'));

    useVFSStore.getState().updateFile('ui/main.ui', '<Text>Main, from this tab</Text>');
    useVFSStore.getState().updateFile('ui/about.ui', '<Text>About, from this tab</Text>');
    expect(await autosave!.flush()).toEqual({ ok: true });
    const status = getSaveStatus();
    expect(status).toMatchObject({ state: 'failed', reason: 'conflict', parts: 'ui/main.ui' });
    expect(status.state === 'failed' ? status.message : '').toMatch(/^ui\/main\.ui changed in another tab as well as in this one/);
    expect(await storedFile(id, 'ui/main.ui')).toBe('<Text>Main, from the other tab</Text>');
    expect(await storedFile(id, 'ui/about.ui')).toBe('<Text>About, from this tab</Text>');
    // This tab's version is still here, to keep or to export.
    expect(here('ui/main.ui')).toBe('<Text>Main, from this tab</Text>');

    // A later, unrelated change saves, and still does not put this tab's main.ui over the other's.
    useWorkspaceStore.getState().setProjectName('Notes 2');
    expect(await autosave!.flush()).toEqual({ ok: true });
    expect(await storedFile(id, 'ui/main.ui')).toBe('<Text>Main, from the other tab</Text>');
    expect((await loadProjectRecord(id))?.workspace.projectName).toBe('Notes 2');
    expect(getSaveStatus()).toMatchObject({ state: 'failed', reason: 'conflict', parts: 'ui/main.ui' });
  });

  it('keeps this tab’s version when asked to, and only then', async () => {
    const id = await savedProject();
    await otherTabSaves(id, withFile('ui/main.ui', '<Text>Main, from the other tab</Text>'));
    useVFSStore.getState().updateFile('ui/main.ui', '<Text>Main, from this tab</Text>');
    await autosave!.flush();
    expect(getSaveStatus()).toMatchObject({ reason: 'conflict' });

    expect(await keepThisTabsVersion()).toEqual({ ok: true });
    expect(getSaveStatus().state).toBe('saved');
    expect(await storedFile(id, 'ui/main.ui')).toBe('<Text>Main, from this tab</Text>');
  });

  it('keeps this tab’s version over the other tab’s that was reported, not over a newer one', async () => {
    const id = await savedProject();
    await otherTabSaves(id, withFile('ui/main.ui', '<Text>Main, from the other tab</Text>'));
    useVFSStore.getState().updateFile('ui/main.ui', '<Text>Main, from this tab</Text>');
    await autosave!.flush();
    // The other tab changes it again before the person here decides.
    await otherTabSaves(id, withFile('ui/main.ui', '<Text>Main, from the other tab, again</Text>'));
    await keepThisTabsVersion();
    expect(await storedFile(id, 'ui/main.ui')).toBe('<Text>Main, from the other tab, again</Text>');
    expect(getSaveStatus()).toMatchObject({ state: 'failed', reason: 'conflict', parts: 'ui/main.ui' });
  });

  it('a file the person changes while the save is in flight is not replaced by the other tab’s', async () => {
    const id = await savedProject();
    await otherTabSaves(id, withFile('ui/main.ui', '<Text>Main, from the other tab</Text>'));
    autosave!.stop();
    autosave = startProjectAutosave({
      debounceMs: 10,
      save: async (record, lastSeen, reconcile) => {
        const result = await saveProjectRecord(record, lastSeen, reconcile);
        // Typed after the record was collected, before the other tab's main.ui is brought in.
        useVFSStore.getState().updateFile('ui/main.ui', '<Text>Typed during the save</Text>');
        return result;
      },
    });
    useVFSStore.getState().updateFile('ui/about.ui', '<Text>About, from this tab</Text>');
    expect(await autosave.flush()).toEqual({ ok: true });
    expect(here('ui/main.ui')).toBe('<Text>Typed during the save</Text>');
    expect(await storedFile(id, 'ui/main.ui')).toBe('<Text>Main, from the other tab</Text>');
    // The next save meets both changes to main.ui: a conflict, not this tab's copy over the other's.
    autosave.stop();
    autosave = startProjectAutosave({ debounceMs: 10 });
    useVFSStore.getState().updateFile('ui/about.ui', '<Text>About, again</Text>');
    await autosave.flush();
    expect(await storedFile(id, 'ui/main.ui')).toBe('<Text>Main, from the other tab</Text>');
    expect(getSaveStatus()).toMatchObject({ reason: 'conflict', parts: 'ui/main.ui' });
  });

  it('an Undo here cannot put this tab’s older copy over a file brought in from the other tab', async () => {
    const id = await savedProject();
    useVFSStore.getState().updateFile('ui/about.ui', '<Text>About, edited here</Text>');
    await autosave!.flush();
    await otherTabSaves(id, withFile('ui/about.ui', '<Text>About, from the other tab</Text>'));
    const before = useVFSStore.getState().files.get('ui/about.ui')!.version;
    useVFSStore.getState().updateFile('ui/main.ui', '<Text>Main, from this tab</Text>');
    await autosave!.flush();
    expect(here('ui/about.ui')).toBe('<Text>About, from the other tab</Text>');
    // Its version went up: a reply or a draft made from the older copy is refused.
    expect(useVFSStore.getState().files.get('ui/about.ui')!.version).toBeGreaterThan(before);
    expect(useVFSStore.getState().history.some((event) => event.path === 'ui/about.ui')).toBe(false);
    useVFSStore.getState().undoLast();
    expect(here('ui/main.ui')).toBe('<Text>Main</Text>');
    for (let i = 0; i < 5; i++) useVFSStore.getState().undoLast();
    expect(here('ui/about.ui')).toBe('<Text>About, from the other tab</Text>');
  });

  it('a draft open on a file brought in from the other tab is not saved over it, and says why', async () => {
    const id = await savedProject();
    expect(beginHandEdit('ui/about.ui')).toBeNull();
    useEditStore.getState().change('<Text>About, typed here</Text>');
    await otherTabSaves(id, withFile('ui/about.ui', '<Text>About, from the other tab</Text>'));
    useVFSStore.getState().updateFile('ui/main.ui', '<Text>Main, from this tab</Text>');
    await autosave!.flush();
    const saved = saveHandEdit();
    expect(saved).toMatchObject({ ok: false, kind: 'changed' });
    expect(saved.ok ? '' : saved.message).toMatch(/in another tab/);
    expect(here('ui/about.ui')).toBe('<Text>About, from the other tab</Text>');
    useEditStore.getState().close();
  });

  it('keeps both tabs’ chat messages, in the order they were said, and adds up what each spent', async () => {
    const id = await savedProject();
    await otherTabSaves(id, (record) => ({
      ...record,
      session: { ...record.session, messages: [...record.session.messages, { id: 'theirs', role: 'user', content: 'From the other tab', timestamp: 2000 }], tokensUsed: record.session.tokensUsed + 500 },
    }));
    useAIStore.getState().addMessage({ id: 'mine', role: 'user', content: 'From this tab', timestamp: 3000 });
    useAIStore.setState({ tokensUsed: useAIStore.getState().tokensUsed + 300 });
    expect(await autosave!.flush()).toEqual({ ok: true });
    const stored = await loadProjectRecord(id);
    expect(stored?.session.messages.map((m) => m.id)).toEqual(['theirs', 'mine']);
    expect(stored?.session.tokensUsed).toBe(800);
    expect(useAIStore.getState().messages.map((m) => m.id)).toEqual(['theirs', 'mine']);
    expect(useAIStore.getState().tokensUsed).toBe(800);
  });

  it('does not hold one file twice when both tabs created it with different capitals', async () => {
    const id = await savedProject();
    await otherTabSaves(id, withFile('ui/Notes.ui', '<Text>From the other tab</Text>'));
    useVFSStore.getState().createFile('ui/notes.ui', '<Text>From this tab</Text>');
    await autosave!.flush();
    expect(getSaveStatus()).toMatchObject({ reason: 'conflict', parts: 'ui/notes.ui' });
    expect((await loadProjectRecord(id))?.files.map((f) => f.path).filter((p) => /notes/i.test(p))).toEqual(['ui/Notes.ui']);
    expect([...useVFSStore.getState().files.keys()].filter((p) => /notes/i.test(p))).toEqual(['ui/notes.ui']);
  });

  it('does not save over a stored copy it cannot read whole', async () => {
    const id = await savedProject();
    await otherTabSaves(id, (record) => ({ ...record, files: [...record.files, { path: 'ui/broken.ui' } as unknown as PersistedFile] }));
    useVFSStore.getState().updateFile('ui/main.ui', '<Text>Main, from this tab</Text>');
    const result = await autosave!.flush();
    expect(result).toMatchObject({ ok: false, reason: 'conflict' });
    expect(await storedFile(id, 'ui/main.ui')).toBe('<Text>Main</Text>');
  });
});

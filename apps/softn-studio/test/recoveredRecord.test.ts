/**
 * A saved project whose record is not readable whole still opens with its files.
 *
 * The reader of a project record was all or nothing: one chat message
 * without a timestamp, one field of the workspace an older Studio wrote
 * differently, and the whole record was "not a record". The project then
 * appeared on the dashboard as "No saved copy", with only a cross to remove
 * it from the list, while every one of its files sat in the store where
 * nothing could reach them. Nothing said why, and nothing was offered.
 *
 * A record is read part by part now. Files that are files are kept; the
 * workspace is kept when it reads and rebuilt from its name when it does
 * not; chat messages that read are kept. What was left out is said, in the
 * log and in the chat, when the project opens. A record a newer Studio
 * wrote, and one with no file that reads, are still not opened: guessing
 * at those could write a worse copy over them.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installFakeIndexedDB, type FakeIndexedDB } from '@softn/test-utils/fake-indexeddb';
import {
  listProjectSummaries,
  loadProjectRecord,
  PROJECTS_STORE,
  readProjectRecord,
  saveActiveProjectId,
  saveProjectRecord,
  STUDIO_DB,
  type PersistedWorkspace,
  type ProjectRecord,
} from '../src/lib/persistence';
import { openProjectById, restoreSession } from '../src/lib/projectSession';
import { useAIStore, useVFSStore, useWorkspaceStore } from '../src/stores';

function memoryStorage() {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
    removeItem: (key: string) => { data.delete(key); },
  };
}

const workspace = (name: string, projectId: string): PersistedWorkspace => ({
  projectName: name, projectId, brief: null, blueprint: null, taskGraph: [], blueprintApproved: true, mode: 'design',
  leftPanel: 'ai', leftPanelExpanded: true, rightSidebarOpen: true, bottomDrawerOpen: false, bottomTab: 'log', advancedMode: false,
  activePageId: null, activeFilePath: null, selectedComponentId: null, devicePreset: 'desktop', zoom: 100, themePreview: 'dark', consoleOutput: [],
});

const record = (projectId: string, name: string): ProjectRecord => ({
  projectId,
  schemaVersion: 1,
  revision: 7,
  savedAt: 1_000,
  workspace: workspace(name, projectId),
  files: [
    { path: 'manifest.json', mimeType: 'application/json', lastModified: 1, lastModifiedBy: 'user', version: 1, content: '{"name":"Notes","version":"1.0.0","main":"ui/main.ui"}' },
    { path: 'ui/main.ui', mimeType: 'text/x-softn-ui', lastModified: 1, lastModifiedBy: 'ai', version: 3, content: '<App><Text>Work worth keeping</Text></App>' },
    { path: 'assets/dot.png', mimeType: 'image/png', lastModified: 1, lastModifiedBy: 'user', version: 1, content: new Uint8Array([137, 80, 78, 71]) },
  ],
  session: {
    messages: [
      { id: 'm1', role: 'user', content: 'Build the notes app', timestamp: 10 },
      { id: 'm2', role: 'assistant', content: 'Built it.', timestamp: 11 },
    ],
    iterationsUsed: 1, tokensUsed: 4_000, filesChanged: 2,
  },
});

/** Put `value` in the store as it is, past the writer's own checks: what an older Studio, or a fault, left there. */
async function putRaw(projectId: string, value: unknown): Promise<void> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(STUDIO_DB, 1);
    req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains(PROJECTS_STORE)) req.result.createObjectStore(PROJECTS_STORE); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  const tx = db.transaction(PROJECTS_STORE, 'readwrite');
  tx.objectStore(PROJECTS_STORE).put(value, projectId);
  await new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); });
  db.close();
}

let idb: FakeIndexedDB;

beforeEach(() => {
  idb = installFakeIndexedDB();
  (globalThis as unknown as { window: unknown }).window = { localStorage: memoryStorage() };
  useWorkspaceStore.getState().reset();
  useVFSStore.getState().reset();
  useAIStore.setState({ providers: [], activeProviderId: null, messages: [], agentState: 'idle', currentStep: '', iterationsUsed: 0, tokensUsed: 0, filesChanged: 0 });
});

afterEach(() => {
  void idb;
  delete (globalThis as unknown as { indexedDB?: unknown }).indexedDB;
  delete (globalThis as unknown as { window?: unknown }).window;
});

describe('a saved project that is not readable whole', () => {
  it('opens with its files and the chat that reads when one chat message does not', async () => {
    const saved = record('p1', 'Notes');
    // One message as an older Studio might have left it: no timestamp.
    await putRaw('p1', { ...saved, session: { ...saved.session, messages: [...saved.session.messages, { id: 'm3', role: 'assistant', content: 'From before' }] } });

    const read = await readProjectRecord('p1');
    expect(read).not.toBeNull();
    expect(read!.record.files.map((f) => f.path)).toEqual(['manifest.json', 'ui/main.ui', 'assets/dot.png']);
    expect(read!.record.files[1].content).toBe('<App><Text>Work worth keeping</Text></App>');
    expect(read!.record.session.messages.map((m) => m.id)).toEqual(['m1', 'm2']);
    expect(read!.leftOut).toEqual(['1 chat message']);
    // Every reader of a record gets the same answer: the export from the dashboard, the delete, the summaries.
    expect((await loadProjectRecord('p1'))?.files).toHaveLength(3);
    expect(await listProjectSummaries()).toEqual([expect.objectContaining({ projectId: 'p1', name: 'Notes', fileCount: 3 })]);
  });

  it('opens with its files when its workspace does not read, under the name it had', async () => {
    const saved = record('p2', 'Field Notes');
    await putRaw('p2', { ...saved, workspace: { ...saved.workspace, bottomTab: 'problems', zoom: 'fit' }, session: { messages: 'none', iterationsUsed: -1 } });

    const read = await readProjectRecord('p2');
    expect(read!.record.workspace.projectName).toBe('Field Notes');
    expect(read!.record.workspace.projectId).toBe('p2');
    expect(read!.record.files).toHaveLength(3);
    expect(read!.record.session).toEqual({ messages: [], iterationsUsed: 0, tokensUsed: 0, filesChanged: 0 });
    expect(read!.leftOut).toEqual(['the editor’s layout and the plan', 'the chat']);
  });

  it('leaves out a file that does not read and keeps the rest', async () => {
    const saved = record('p3', 'Notes');
    await putRaw('p3', { ...saved, files: [...saved.files, { path: 'ui/broken.ui', content: 42 }, null] });
    const read = await readProjectRecord('p3');
    expect(read!.record.files.map((f) => f.path)).toEqual(['manifest.json', 'ui/main.ui', 'assets/dot.png']);
    expect(read!.leftOut).toEqual(['2 files that could not be read']);
  });

  it('reads a whole record as it always did, with nothing left out', async () => {
    await saveProjectRecord(record('p4', 'Notes'));
    const read = await readProjectRecord('p4');
    expect(read!.leftOut).toEqual([]);
    expect(read!.record).toEqual(record('p4', 'Notes'));
  });

  it('does not open a record a newer Studio wrote, one with no file that reads, or one filed under another id', async () => {
    const saved = record('p5', 'Notes');
    await putRaw('p5', { ...saved, schemaVersion: 2 });
    await putRaw('p6', { ...record('p6', 'Notes'), files: [{ path: 'ui/main.ui' }] });
    await putRaw('p7', { ...record('other', 'Notes') });
    await putRaw('p8', 'not a record');
    for (const id of ['p5', 'p6', 'p7', 'p8']) expect(await readProjectRecord(id), id).toBeNull();
    expect(await listProjectSummaries()).toEqual([]);
  });

  it('says what was left out when the project is restored at start, in the log and in the chat', async () => {
    const saved = record('p1', 'Notes');
    await putRaw('p1', { ...saved, session: { ...saved.session, messages: [{ id: 'm0', role: 'assistant', content: 'From before' }, ...saved.session.messages] } });
    saveActiveProjectId('p1');

    const outcome = await restoreSession();

    expect(outcome.restored).toBe(true);
    expect(outcome.notice).toBe('Notes was opened from a save that could not be read whole. Its 3 files are here; left out: 1 chat message. Export a bundle to keep a copy.');
    expect(useVFSStore.getState().files.get('ui/main.ui')?.content).toBe('<App><Text>Work worth keeping</Text></App>');
    const chat = useAIStore.getState().messages;
    expect(chat.map((m) => m.id).slice(0, 2)).toEqual(['m1', 'm2']);
    expect(chat.at(-1)).toMatchObject({ role: 'assistant', content: outcome.notice });
  });

  it('says the same when the project is opened from the list', async () => {
    const saved = record('p2', 'Field Notes');
    await putRaw('p2', { ...saved, workspace: { ...saved.workspace, mode: 'an older mode' } });
    const outcome = await openProjectById('p2');
    expect(outcome).toEqual({ ok: true });
    expect(useWorkspaceStore.getState().projectName).toBe('Field Notes');
    expect(useVFSStore.getState().files.size).toBe(3);
    expect(useWorkspaceStore.getState().consoleOutput.at(-1)).toMatch(/^Field Notes was opened from a save that could not be read whole\. Its 3 files are here; left out: the editor’s layout and the plan\./);
    expect(useAIStore.getState().messages.at(-1)?.content).toMatch(/could not be read whole/);
  });
});

/**
 * A browser whose IndexedDB never answers does not hold Studio at its door.
 *
 * Every read and write of a project begins by opening the database, and the
 * open was waited for without limit. A request that neither succeeds nor
 * fails (a store left wedged by a crash, a profile whose storage is being
 * moved) left the start on "Opening your project…" for good, with no way to
 * begin a new app or import one; in the editor the save sat at "Saving…"
 * and never said it had failed, and leaving for another project waited on
 * that save for ever. The open has a deadline now. Past it the store is
 * treated as out of reach: a read finds nothing, a save says so and offers
 * the export, and for a while later opens are not waited for again.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installFakeIndexedDB } from '@softn/test-utils/fake-indexeddb';
import {
  DB_OPEN_DEADLINE_MS,
  askStoreAgain,
  listProjectSummaries,
  loadProjectRecord,
  saveActiveProjectId,
  saveProjectRecord,
  type PersistedWorkspace,
  type ProjectRecord,
} from '../src/lib/persistence';
import { beginNewProjectSession, claimWorkspace, reopenUnansweredProject, restoreSession } from '../src/lib/projectSession';
import { useAIStore, useVFSStore, useWorkspaceStore } from '../src/stores';

function memoryStorage() {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
    removeItem: (key: string) => { data.delete(key); },
  };
}

const workspace = (projectId: string): PersistedWorkspace => ({
  projectName: 'Notes', projectId, brief: null, blueprint: null, taskGraph: [], blueprintApproved: true, mode: 'design',
  leftPanel: 'ai', leftPanelExpanded: true, bottomDrawerOpen: false, bottomTab: 'log',
  activePageId: null, activeFilePath: null, devicePreset: 'desktop', zoom: 100, themePreview: 'dark', consoleOutput: [],
});
const record = (projectId: string): ProjectRecord => ({
  projectId, schemaVersion: 1, revision: 1, savedAt: 1, workspace: workspace(projectId),
  files: [{ path: 'ui/main.ui', mimeType: 'text/x-softn-ui', lastModified: 1, lastModifiedBy: 'user', version: 1, content: '<App />' }],
  session: { messages: [], iterationsUsed: 0, tokensUsed: 0, filesChanged: 0 },
});

let opens = 0;

beforeEach(() => {
  vi.useFakeTimers();
  opens = 0;
  // An open on which nothing ever fires.
  (globalThis as unknown as { indexedDB: unknown }).indexedDB = { open: () => { opens++; return {}; } };
  (globalThis as unknown as { window: unknown }).window = { localStorage: memoryStorage() };
  useWorkspaceStore.getState().reset();
  useVFSStore.getState().reset();
  useAIStore.setState({ providers: [], activeProviderId: null, messages: [], agentState: 'idle', currentStep: '', iterationsUsed: 0, tokensUsed: 0, filesChanged: 0 });
});

afterEach(() => {
  // Past the time for which a silent store is not asked again, so the next test starts clean.
  vi.advanceTimersByTime(10 * 60_000);
  vi.useRealTimers();
  delete (globalThis as unknown as { indexedDB?: unknown }).indexedDB;
  delete (globalThis as unknown as { window?: unknown }).window;
});

/** Whether `promise` has settled once `ms` have passed. */
async function settledAfter<T>(promise: Promise<T>, ms: number): Promise<{ settled: boolean; value?: T }> {
  let outcome: { settled: boolean; value?: T } = { settled: false };
  void promise.then((value) => { outcome = { settled: true, value }; });
  await vi.advanceTimersByTimeAsync(ms);
  return outcome;
}

describe('a store that never answers', () => {
  it('ends a save at the deadline, as a failure that says so and names the export', async () => {
    const save = saveProjectRecord(record('p1'));
    expect((await settledAfter(save, DB_OPEN_DEADLINE_MS - 1)).settled).toBe(false);
    const { settled, value } = await settledAfter(save, 2);
    expect(settled).toBe(true);
    expect(value).toEqual({ ok: false, reason: 'unavailable', message: 'This browser’s storage did not answer. Export the bundle to keep your work.' });
  });

  it('ends a read at the deadline with nothing found, and a list with nothing listed', async () => {
    expect((await settledAfter(loadProjectRecord('p1'), DB_OPEN_DEADLINE_MS + 1)).value).toBeNull();
    // Asked again straight away: not waited for a second time.
    const before = opens;
    expect((await settledAfter(listProjectSummaries(), 1)).value).toEqual([]);
    expect(opens).toBe(before);
  });

  it('lets Studio start: the session is restored as none, in the time of one deadline', async () => {
    saveActiveProjectId('p1');
    const start = restoreSession();
    const { settled, value } = await settledAfter(start, DB_OPEN_DEADLINE_MS + 50);
    expect(settled).toBe(true);
    expect(value).toMatchObject({ restored: false });
  });

  it('is asked again once some time has passed, in case it has come back', async () => {
    await settledAfter(loadProjectRecord('p1'), DB_OPEN_DEADLINE_MS + 1);
    const before = opens;
    await vi.advanceTimersByTimeAsync(60_000);
    void loadProjectRecord('p1');
    await vi.advanceTimersByTimeAsync(1);
    expect(opens).toBe(before + 1);
  });
});

describe('Try again, once the store answers', () => {
  // The start could not read the project it was to open, so it showed the dashboard and its
  // Try again. Pressed with the store answering, that refreshed the list and nothing else: the
  // project the start had been opening stayed closed until it was found and opened by hand.

  /** A start against the silent store, then the store answering with `p1` saved in it. */
  async function startSilentThenAnswer(): Promise<void> {
    saveActiveProjectId('p1');
    const start = await settledAfter(restoreSession(), DB_OPEN_DEADLINE_MS + 50);
    expect(start.value).toMatchObject({ restored: false });
    installFakeIndexedDB();
    askStoreAgain();
    await settledAfter(saveProjectRecord(record('p1')), 10);
  }

  it('opens the project the start could not', async () => {
    await startSilentThenAnswer();
    const { value } = await settledAfter(reopenUnansweredProject(), 10);
    expect(value).toEqual({ ok: true });
    expect(useWorkspaceStore.getState().projectId).toBe('p1');
    expect(useVFSStore.getState().files.get('ui/main.ui')?.content).toBe('<App />');
    // Once: a second Try again does not open it over itself.
    expect((await settledAfter(reopenUnansweredProject(), 10)).value).toBeNull();
  });

  it('leaves alone what the person opened meanwhile', async () => {
    await startSilentThenAnswer();
    // An example opened while the store was silent: that is the project being worked on now.
    claimWorkspace();
    const exampleId = beginNewProjectSession();
    useWorkspaceStore.getState().setProjectName('Reading list (example)');
    useVFSStore.getState().createFile('ui/main.ui', '<Text>Example</Text>');
    expect((await settledAfter(reopenUnansweredProject(), 10)).value).toBeNull();
    expect(useWorkspaceStore.getState().projectId).toBe(exampleId);
    expect(useVFSStore.getState().files.get('ui/main.ui')?.content).toBe('<Text>Example</Text>');
  });

  it('keeps waiting while the store still does not answer', async () => {
    saveActiveProjectId('p1');
    await settledAfter(restoreSession(), DB_OPEN_DEADLINE_MS + 50);
    askStoreAgain();
    const still = await settledAfter(reopenUnansweredProject(), DB_OPEN_DEADLINE_MS + 50);
    expect(still.value).toMatchObject({ ok: false });
    expect(useWorkspaceStore.getState().projectId).not.toBe('p1');
    installFakeIndexedDB();
    askStoreAgain();
    await settledAfter(saveProjectRecord(record('p1')), 10);
    expect((await settledAfter(reopenUnansweredProject(), 10)).value).toEqual({ ok: true });
    expect(useWorkspaceStore.getState().projectId).toBe('p1');
  });
});

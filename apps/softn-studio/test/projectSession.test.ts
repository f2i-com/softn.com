/**
 * The project session: identity, autosave, restore and reopening by id.
 *
 * Studio had one saved slot. Creating project B replaced project A's only
 * copy; two projects named alike were one recent entry; a save that failed
 * said nothing and the next start could pair one revision's metadata with
 * another's files. Pinned here: a new session mints its own id and leaves
 * the previous record alone; autosave writes once per revision and skips an
 * unchanged one; a failed save is reported and the project stays in memory
 * and exportable; after a simulated reload each project reopens by id with
 * its own content, same display name or not; deleting one project touches
 * neither the other nor the provider settings.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installFakeIndexedDB, type FakeIndexedDB } from '../../../packages/@softn/core/test/helpers/fake-indexeddb';
import {
  applyProjectRecord,
  beginNewProjectSession,
  collectProjectRecord,
  currentRevision,
  deleteProject,
  getSaveStatus,
  openProjectById,
  resetProjectSessionForImport,
  restoreSession,
  startProjectAutosave,
} from '../src/lib/projectSession';
import { loadActiveProjectId, loadGlobalSettings, loadProjectRecord, loadRecentProjects, saveGlobalSettings, type SaveResult } from '../src/lib/persistence';
import { buildBundle } from '../src/lib/exportBundle';
import { useAIStore, useVFSStore, useWorkspaceStore } from '../src/stores';

function memoryStorage() {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
    removeItem: (key: string) => {
      data.delete(key);
    },
  };
}

let idb: FakeIndexedDB;
let storage: ReturnType<typeof memoryStorage>;

const provider = { id: 'provider', type: 'custom' as const, name: 'Provider', apiKey: 'secret' };

beforeEach(() => {
  idb = installFakeIndexedDB();
  storage = memoryStorage();
  (globalThis as unknown as { window: unknown }).window = { localStorage: storage };
  useWorkspaceStore.getState().reset();
  useVFSStore.getState().reset();
  useAIStore.setState({
    providers: [],
    activeProviderId: null,
    messages: [],
    agentState: 'idle',
    currentStep: '',
    iterationsUsed: 0,
    tokensUsed: 0,
    filesChanged: 0,
  });
});

afterEach(() => {
  vi.useRealTimers();
  delete (globalThis as unknown as { indexedDB?: unknown }).indexedDB;
  delete (globalThis as unknown as { window?: unknown }).window;
});

/** Run the fake IndexedDB's microtasks and the transaction's timer. */
async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('project import session reset', () => {
  it('replaces the previous project identity and clears selection, errors, console, files, and chat', () => {
    useWorkspaceStore.setState({
      projectName: 'Old project',
      projectId: 'old-id',
      activePageId: 'old-page',
      activeFilePath: 'ui/old.ui',
      selectedComponentId: 'old-component',
      errors: [{ file: 'ui/old.ui', level: 'error', type: 'parse', message: 'Old error' }],
      consoleOutput: ['Old log'],
      themePreview: 'light',
    });
    useVFSStore.getState().createFile('ui/old.ui', '<Text>Old</Text>');
    useAIStore.getState().addProvider(provider);
    useAIStore.getState().addMessage({ id: 'old-message', role: 'user', content: 'Old chat', timestamp: 1 });
    useAIStore.setState({ agentState: 'error', currentStep: 'Old step', tokensUsed: 99 });

    const id = resetProjectSessionForImport();

    expect(id).not.toBe('old-id');
    expect(useWorkspaceStore.getState()).toMatchObject({
      projectName: '',
      projectId: id,
      activePageId: null,
      activeFilePath: null,
      selectedComponentId: null,
      errors: [],
      consoleOutput: [],
      themePreview: 'light',
    });
    expect(useVFSStore.getState().files.size).toBe(0);
    expect(useVFSStore.getState().history).toEqual([]);
    expect(useAIStore.getState()).toMatchObject({
      providers: [expect.objectContaining({ id: 'provider' })],
      messages: [],
      agentState: 'idle',
      currentStep: '',
      iterationsUsed: 0,
      tokensUsed: 0,
      filesChanged: 0,
    });
  });
});

describe('autosave', () => {
  it('writes once per revision and skips a revision it has already written', async () => {
    const save = vi.fn(async (): Promise<SaveResult> => ({ ok: true }));
    const id = beginNewProjectSession();
    useWorkspaceStore.getState().setProjectName('Notes');
    useVFSStore.getState().createFile('ui/main.ui', '<Text>One</Text>');
    const autosave = startProjectAutosave({ save, debounceMs: 10 });

    expect(await autosave.flush()).toEqual({ ok: true });
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0][0].projectId).toBe(id);
    expect(save.mock.calls[0][0].files[0].content).toBe('<Text>One</Text>');
    const writtenRevision = save.mock.calls[0][0].revision;

    // Nothing changed: no write.
    await autosave.flush();
    expect(save).toHaveBeenCalledTimes(1);
    expect(getSaveStatus()).toMatchObject({ state: 'saved', revision: writtenRevision });

    useVFSStore.getState().updateFile('ui/main.ui', '<Text>Two</Text>');
    await autosave.flush();
    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls[1][0].revision).toBeGreaterThan(writtenRevision);
    expect(save.mock.calls[1][0].files[0].content).toBe('<Text>Two</Text>');
    autosave.stop();
  });

  it('saves on its own after changes settle, and never without a project', async () => {
    vi.useFakeTimers();
    const save = vi.fn(async (): Promise<SaveResult> => ({ ok: true }));
    const autosave = startProjectAutosave({ save, debounceMs: 50, maxWaitMs: 200, now: () => Date.now() });

    // No project id yet: a store change is not a save.
    useWorkspaceStore.getState().setZoom(120);
    await vi.advanceTimersByTimeAsync(500);
    expect(save).not.toHaveBeenCalled();

    beginNewProjectSession();
    useWorkspaceStore.getState().setProjectName('Notes');
    await vi.advanceTimersByTimeAsync(30);
    expect(save).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30);
    expect(save).toHaveBeenCalledTimes(1);
    autosave.stop();
  });

  it('reports a failed save and leaves the project in memory and exportable', async () => {
    const save = vi.fn(async (): Promise<SaveResult> => ({ ok: false, reason: 'quota', message: 'full' }));
    beginNewProjectSession();
    useWorkspaceStore.getState().setProjectName('Notes');
    useVFSStore.getState().createFile('ui/main.ui', '<Text>Keep me</Text>');
    const autosave = startProjectAutosave({ save, debounceMs: 10 });

    const result = await autosave.flush();
    expect(result.ok).toBe(false);
    expect(getSaveStatus()).toMatchObject({ state: 'failed', reason: 'quota', message: 'full' });
    expect(useVFSStore.getState().files.get('ui/main.ui')?.content).toBe('<Text>Keep me</Text>');
    expect(buildBundle(useVFSStore.getState().files).length).toBeGreaterThan(0);

    // The failure is not sticky across a revision that does save.
    save.mockResolvedValueOnce({ ok: true });
    useVFSStore.getState().updateFile('ui/main.ui', '<Text>Again</Text>');
    await autosave.flush();
    expect(getSaveStatus().state).toBe('saved');
    autosave.stop();
  });

  it('reports storage that is not there at all, with the editor still working', async () => {
    delete (globalThis as unknown as { indexedDB?: unknown }).indexedDB;
    beginNewProjectSession();
    useWorkspaceStore.getState().setProjectName('Notes');
    useVFSStore.getState().createFile('ui/main.ui', '<Text>One</Text>');
    const autosave = startProjectAutosave({ debounceMs: 10 });
    const result = await autosave.flush();
    expect(!result.ok && result.reason).toBe('unavailable');
    expect(getSaveStatus()).toMatchObject({ state: 'failed', reason: 'unavailable' });
    useVFSStore.getState().updateFile('ui/main.ui', '<Text>Two</Text>');
    expect(useVFSStore.getState().files.get('ui/main.ui')?.content).toBe('<Text>Two</Text>');
    expect(buildBundle(useVFSStore.getState().files).length).toBeGreaterThan(0);
    autosave.stop();
  });

  it('does not count validation errors, the dirty flag or the theme as a change to save', async () => {
    const save = vi.fn(async (): Promise<SaveResult> => ({ ok: true }));
    beginNewProjectSession();
    useWorkspaceStore.getState().setProjectName('Notes');
    const autosave = startProjectAutosave({ save, debounceMs: 10 });
    await autosave.flush();
    expect(save).toHaveBeenCalledTimes(1);

    useWorkspaceStore.getState().clearErrors();
    useWorkspaceStore.getState().addError({ file: 'ui/main.ui', level: 'error', type: 'parse', message: 'x' });
    useWorkspaceStore.getState().setDirty(true);
    useWorkspaceStore.getState().setThemePreview('light');
    await autosave.flush();
    expect(save).toHaveBeenCalledTimes(1);

    useWorkspaceStore.getState().setZoom(80);
    await autosave.flush();
    expect(save).toHaveBeenCalledTimes(2);
    autosave.stop();
  });

  it('a legacy snapshot kept at start is removed once a later save of it has committed and read back', async () => {
    const legacyWorkspace = {
      projectName: 'Old project', projectId: null, brief: null, blueprint: null, taskGraph: [], blueprintApproved: true,
      mode: 'design', leftPanel: 'ai', leftPanelExpanded: true, rightSidebarOpen: true, bottomDrawerOpen: false, bottomTab: 'log',
      advancedMode: false, activePageId: null, activeFilePath: null, selectedComponentId: null, devicePreset: 'desktop', zoom: 100,
      themePreview: 'dark', consoleOutput: [],
    };
    storage.data.set('softn.studio.workspace.v1', JSON.stringify(legacyWorkspace));
    storage.data.set('softn.studio.vfs.v1', JSON.stringify({ files: [{ path: 'ui/main.ui', mimeType: 'text/x-softn-ui', lastModified: 1, lastModifiedBy: 'user', version: 1, kind: 'text', content: '<Text>Old</Text>' }] }));

    idb.abortNextTransaction = true;
    const outcome = await restoreSession(1000);
    expect(outcome.restored).toBe(true);
    expect(outcome.notice).toMatch(/older save/);
    expect(getSaveStatus().state).toBe('failed');
    expect(storage.data.has('softn.studio.workspace.v1')).toBe(true);
    expect(useVFSStore.getState().files.get('ui/main.ui')?.content).toBe('<Text>Old</Text>');

    const autosave = startProjectAutosave({ debounceMs: 10 });
    useVFSStore.getState().updateFile('ui/main.ui', '<Text>Edited</Text>');
    expect(await autosave.flush()).toEqual({ ok: true });
    await settle();
    expect(storage.data.has('softn.studio.workspace.v1')).toBe(false);
    expect(storage.data.has('softn.studio.vfs.v1')).toBe(false);
    const id = useWorkspaceStore.getState().projectId!;
    expect((await loadProjectRecord(id))?.files[0].content).toBe('<Text>Edited</Text>');
    autosave.stop();
  });

  it('writes provider settings to their own key and never into the record', async () => {
    const save = vi.fn(async (): Promise<SaveResult> => ({ ok: true }));
    beginNewProjectSession();
    useWorkspaceStore.getState().setProjectName('Notes');
    const autosave = startProjectAutosave({ save, debounceMs: 10 });
    useAIStore.getState().addProvider(provider);
    expect(loadGlobalSettings()?.providers[0].apiKey).toBe('secret');
    await autosave.flush();
    expect(JSON.stringify(save.mock.calls[0][0])).not.toContain('secret');
    autosave.stop();
  });
});

describe('reopening projects by id', () => {
  async function makeProject(name: string, content: string): Promise<string> {
    const id = beginNewProjectSession();
    useWorkspaceStore.getState().setProjectName(name);
    useVFSStore.getState().createFile('ui/main.ui', content);
    const autosave = startProjectAutosave({ debounceMs: 10 });
    const result = await autosave.flush();
    expect(result).toEqual({ ok: true });
    autosave.stop();
    return id;
  }

  /** Empty the stores as a reload would. */
  function simulateReload(): void {
    useWorkspaceStore.getState().reset();
    useVFSStore.getState().reset();
    useAIStore.setState({ messages: [], providers: [], activeProviderId: null });
  }

  it('create A, create B, reload: A reopens by id with its own content', async () => {
    const a = await makeProject('Alpha', '<Text>A</Text>');
    const b = await makeProject('Beta', '<Text>B</Text>');
    expect(a).not.toBe(b);
    expect((await loadProjectRecord(a))?.files[0].content).toBe('<Text>A</Text>');

    simulateReload();
    const restored = await restoreSession();
    expect(restored.restored).toBe(true);
    expect(useWorkspaceStore.getState().projectId).toBe(b);

    const opened = await openProjectById(a);
    expect(opened).toEqual({ ok: true });
    expect(useWorkspaceStore.getState().projectName).toBe('Alpha');
    expect(useVFSStore.getState().files.get('ui/main.ui')?.content).toBe('<Text>A</Text>');
    expect(useVFSStore.getState().history).toEqual([]);
    expect(loadActiveProjectId()).toBe(a);
  });

  it('two projects with the same display name are independently reopenable', async () => {
    const first = await makeProject('Notes', '<Text>first</Text>');
    const second = await makeProject('Notes', '<Text>second</Text>');
    expect(loadRecentProjects().map((r) => r.id)).toEqual([second, first]);

    simulateReload();
    await openProjectById(first);
    expect(useVFSStore.getState().files.get('ui/main.ui')?.content).toBe('<Text>first</Text>');
    await openProjectById(second);
    expect(useVFSStore.getState().files.get('ui/main.ui')?.content).toBe('<Text>second</Text>');
  });

  it('opening an id with no record says so and leaves the current project alone', async () => {
    await makeProject('Alpha', '<Text>A</Text>');
    const opened = await openProjectById('nothing-here');
    expect(opened.ok).toBe(false);
    expect(useWorkspaceStore.getState().projectName).toBe('Alpha');
  });

  it('deleting one project leaves the other and the provider settings', async () => {
    saveGlobalSettings({ providers: [provider], activeProviderId: 'provider', modelProfile: { architect: '', builder: '', repair: '', vision: '' }, maxIterations: 15, tokenBudget: 50_000 });
    const a = await makeProject('Alpha', '<Text>A</Text>');
    const b = await makeProject('Beta', '<Text>B</Text>');

    expect(await deleteProject(a)).toEqual({ ok: true });
    expect(await loadProjectRecord(a)).toBeNull();
    expect((await loadProjectRecord(b))?.files[0].content).toBe('<Text>B</Text>');
    expect(loadRecentProjects().map((r) => r.id)).toEqual([b]);
    expect(loadGlobalSettings()?.providers[0].apiKey).toBe('secret');
    // B is the one in the stores and was not the one deleted.
    expect(useWorkspaceStore.getState().projectId).toBe(b);

    // Deleting the project in the stores clears them so autosave cannot put it back.
    expect(await deleteProject(b)).toEqual({ ok: true });
    expect(useWorkspaceStore.getState().projectId).not.toBe(b);
    expect(useVFSStore.getState().files.size).toBe(0);
    expect(loadActiveProjectId()).toBeNull();
  });

  it('a restore that is superseded while reading applies nothing', async () => {
    const a = await makeProject('Alpha', '<Text>A</Text>');
    simulateReload();
    const first = restoreSession();
    const second = restoreSession();
    await first;
    await second;
    await settle();
    expect(useWorkspaceStore.getState().projectId).toBe(a);
    expect(await first).toEqual({ restored: false, notice: null });
    expect(await second).toEqual({ restored: true, notice: null });
    expect(idb.records('softn-studio', 'projects').size).toBe(1);
  });

  it('applying a record does not count as a change', () => {
    const id = beginNewProjectSession();
    useWorkspaceStore.getState().setProjectName('Notes');
    const record = collectProjectRecord(7)!;
    expect(record.projectId).toBe(id);
    applyProjectRecord(record);
    expect(currentRevision()).toBe(7);
    expect(getSaveStatus()).toMatchObject({ state: 'saved', revision: 7 });
  });
});

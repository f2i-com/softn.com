/**
 * Studio's project storage: one record per project, written whole, and
 * separate from the recent list, the active-project pointer and the AI
 * provider settings.
 *
 * Before this, the workspace, the AI state and the files each had their own
 * localStorage key and were written independently, and the write's result
 * was thrown away. A quota error on the files key after a successful
 * workspace write left a restore that paired one revision's metadata with
 * another's files, and nothing on screen said a save had failed. Recent
 * entries were keyed by display name as often as by id, two projects with the
 * same name collapsed into one entry, and removing an entry deleted the
 * active snapshot keys. Pinned here: a record write is atomic, the saver's
 * result is structured, the recent list is keyed by id only, removal from
 * the list touches nothing else, deletion is scoped to one record, provider
 * settings live outside every record, a missing store is reported rather
 * than swallowed, and a legacy snapshot is deleted only after its
 * replacement has been read back.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installFakeIndexedDB, type FakeIndexedDB } from '../../../packages/@softn/core/test/helpers/fake-indexeddb';
import {
  deleteProjectRecord,
  listProjectSummaries,
  loadActiveProjectId,
  loadGlobalSettings,
  loadProjectRecord,
  loadRecentProjects,
  loadWorkspaceSnapshot,
  migrateLegacyProject,
  PROJECTS_STORE,
  removeRecentProject,
  saveActiveProjectId,
  saveGlobalSettings,
  saveProjectRecord,
  saveRecentProject,
  STUDIO_DB,
  type PersistedWorkspace,
  type ProjectRecord,
} from '../src/lib/persistence';
import { buildBundle } from '../src/lib/exportBundle';
import type { VFSFile } from '../src/types/studio';

/** A localStorage stand-in whose writes can be made to fail per key. */
function memoryStorage(opts: { failWrite?: (key: string) => boolean } = {}) {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (opts.failWrite?.(key)) throw new DOMException('quota', 'QuotaExceededError');
      data.set(key, value);
    },
    removeItem: (key: string) => {
      data.delete(key);
    },
  };
}

function workspace(name: string): PersistedWorkspace {
  return {
    projectName: name,
    projectId: null,
    brief: null,
    blueprint: null,
    taskGraph: [],
    blueprintApproved: true,
    mode: 'design',
    leftPanel: 'ai',
    leftPanelExpanded: true,
    rightSidebarOpen: true,
    bottomDrawerOpen: false,
    bottomTab: 'log',
    advancedMode: false,
    activePageId: null,
    activeFilePath: null,
    selectedComponentId: null,
    devicePreset: 'desktop',
    zoom: 100,
    themePreview: 'dark',
    consoleOutput: [],
  };
}

function record(projectId: string, name: string, revision: number, content: string): ProjectRecord {
  return {
    projectId,
    schemaVersion: 1,
    revision,
    savedAt: revision,
    workspace: { ...workspace(name), projectId },
    files: [
      { path: 'ui/main.ui', mimeType: 'text/x-softn-ui', lastModified: 1, lastModifiedBy: 'user', version: 1, content },
      { path: 'assets/dot.png', mimeType: 'image/png', lastModified: 1, lastModifiedBy: 'user', version: 1, content: new Uint8Array([137, 80, 78, 71]) },
    ],
    session: { messages: [], iterationsUsed: 0, tokensUsed: 0, filesChanged: 0 },
  };
}

const settings = {
  providers: [{ id: 'p1', type: 'anthropic' as const, name: 'Anthropic', apiKey: 'sk-ant-test' }],
  activeProviderId: 'p1',
  modelProfile: { architect: '', builder: '', repair: '', vision: '' },
  maxIterations: 15,
  tokenBudget: 50_000,
};

let idb: FakeIndexedDB;
let storage: ReturnType<typeof memoryStorage>;

beforeEach(() => {
  idb = installFakeIndexedDB();
  storage = memoryStorage();
  (globalThis as unknown as { window: unknown }).window = { localStorage: storage };
});

afterEach(() => {
  delete (globalThis as unknown as { indexedDB?: unknown }).indexedDB;
  delete (globalThis as unknown as { window?: unknown }).window;
});

describe('project records', () => {
  it('writes a record whole and reads it back by id', async () => {
    const result = await saveProjectRecord(record('a', 'Notes', 3, '<Text>A</Text>'));
    expect(result).toEqual({ ok: true });
    const loaded = await loadProjectRecord('a');
    expect(loaded?.revision).toBe(3);
    expect(loaded?.workspace.projectName).toBe('Notes');
    expect(loaded?.files.map((f) => f.path)).toEqual(['ui/main.ui', 'assets/dot.png']);
    expect(loaded?.files[1].content).toBeInstanceOf(Uint8Array);
  });

  it('a write that does not commit leaves the previous revision whole, never a mix of two', async () => {
    await saveProjectRecord(record('a', 'Notes v1', 1, 'one'));
    idb.abortNextTransaction = true;
    const result = await saveProjectRecord(record('a', 'Notes v2', 2, 'two'));
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toBe('error');
    const loaded = await loadProjectRecord('a');
    expect(loaded?.revision).toBe(1);
    expect(loaded?.workspace.projectName).toBe('Notes v1');
    expect(loaded?.files[0].content).toBe('one');
  });

  it('reports a store that cannot be opened, and the in-memory files still export', async () => {
    idb.failOpen = true;
    const result = await saveProjectRecord(record('a', 'Notes', 1, 'one'));
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toBe('error');
    expect(await loadProjectRecord('a')).toBeNull();

    delete (globalThis as unknown as { indexedDB?: unknown }).indexedDB;
    const missing = await saveProjectRecord(record('a', 'Notes', 1, 'one'));
    expect(!missing.ok && missing.reason).toBe('unavailable');

    const files = new Map<string, VFSFile>([
      ['ui/main.ui', { path: 'ui/main.ui', content: '<Text>Still here</Text>', mimeType: 'text/x-softn-ui', lastModified: 1, lastModifiedBy: 'user', version: 1 }],
    ]);
    expect(buildBundle(files).length).toBeGreaterThan(0);
  });

  it('two projects with the same display name are separate records and separate recent entries', async () => {
    await saveProjectRecord(record('a', 'Notes', 1, 'first'));
    await saveProjectRecord(record('b', 'Notes', 1, 'second'));
    saveRecentProject({ id: 'a', name: 'Notes', target: 'web', lastModified: 'now' });
    saveRecentProject({ id: 'b', name: 'Notes', target: 'web', lastModified: 'now' });

    expect(loadRecentProjects().map((r) => r.id)).toEqual(['b', 'a']);
    expect((await loadProjectRecord('a'))?.files[0].content).toBe('first');
    expect((await loadProjectRecord('b'))?.files[0].content).toBe('second');
    expect((await listProjectSummaries()).map((s) => s.projectId).sort()).toEqual(['a', 'b']);
  });

  it('removing a recent entry leaves the record, the active pointer and the provider settings alone', async () => {
    await saveProjectRecord(record('a', 'Notes', 1, 'one'));
    saveRecentProject({ id: 'a', name: 'Notes', target: 'web', lastModified: 'now' });
    saveActiveProjectId('a');
    saveGlobalSettings(settings);

    expect(removeRecentProject('a')).toEqual({ ok: true });

    expect(loadRecentProjects()).toEqual([]);
    expect(await loadProjectRecord('a')).not.toBeNull();
    expect(loadActiveProjectId()).toBe('a');
    expect(loadGlobalSettings()?.providers[0].apiKey).toBe('sk-ant-test');
  });

  it('deleting a project removes that record only', async () => {
    await saveProjectRecord(record('a', 'Notes', 1, 'one'));
    await saveProjectRecord(record('b', 'Notes', 1, 'two'));
    saveGlobalSettings(settings);

    expect(await deleteProjectRecord('a')).toEqual({ ok: true });

    expect(await loadProjectRecord('a')).toBeNull();
    expect((await loadProjectRecord('b'))?.files[0].content).toBe('two');
    expect(loadGlobalSettings()?.providers).toHaveLength(1);
  });

  it('provider settings are never part of a project record', async () => {
    saveGlobalSettings(settings);
    await saveProjectRecord(record('a', 'Notes', 1, 'one'));
    const raw = JSON.stringify(idb.records(STUDIO_DB, PROJECTS_STORE).get('a'));
    expect(raw).not.toContain('sk-ant-test');
    expect(raw).not.toContain('providers');
  });

  it('the request timeout and output cap round-trip in the settings key and are excluded from every record', async () => {
    // STU-05 caveat: the store had requestTimeoutMs and maxOutputTokens with
    // no control and no persistence, so a reload put them back to defaults.
    saveGlobalSettings({ ...settings, requestTimeoutMs: 45_000, maxOutputTokens: 8_192 });
    const loaded = loadGlobalSettings();
    expect(loaded?.requestTimeoutMs).toBe(45_000);
    expect(loaded?.maxOutputTokens).toBe(8_192);

    await saveProjectRecord(record('a', 'Notes', 1, 'one'));
    const raw = JSON.stringify(idb.records(STUDIO_DB, PROJECTS_STORE).get('a'));
    expect(raw).not.toContain('requestTimeoutMs');
    expect(raw).not.toContain('maxOutputTokens');
    const stored = await loadProjectRecord('a');
    expect(stored && 'requestTimeoutMs' in stored).toBe(false);
    expect(stored && 'requestTimeoutMs' in stored.session).toBe(false);
  });

  it('settings written before the per-request limits existed still load, and a malformed limit does not', () => {
    saveGlobalSettings(settings);
    const loaded = loadGlobalSettings();
    expect(loaded?.providers).toHaveLength(1);
    expect(loaded?.requestTimeoutMs).toBeUndefined();
    expect(loaded?.maxOutputTokens).toBeUndefined();

    storage.data.set('softn.studio.settings.v1', JSON.stringify({ ...settings, requestTimeoutMs: '30s' }));
    expect(loadGlobalSettings()).toBeNull();
    storage.data.set('softn.studio.settings.v1', JSON.stringify({ ...settings, maxOutputTokens: 0 }));
    expect(loadGlobalSettings()).toBeNull();
  });

  it('reports quota on the small localStorage writes instead of dropping the result', () => {
    storage = memoryStorage({ failWrite: () => true });
    (globalThis as unknown as { window: unknown }).window = { localStorage: storage };
    const result = saveGlobalSettings(settings);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toBe('quota');
    const recent = saveRecentProject({ id: 'a', name: 'Notes', target: 'web', lastModified: 'now' });
    expect(!recent.ok && recent.reason).toBe('quota');
  });

  it('reports blocked storage as blocked', () => {
    const blockedWindow = {} as Window;
    Object.defineProperty(blockedWindow, 'localStorage', {
      get() {
        throw new DOMException('blocked', 'SecurityError');
      },
    });
    (globalThis as unknown as { window: unknown }).window = blockedWindow;
    const result = saveActiveProjectId('a');
    expect(!result.ok && result.reason).toBe('blocked');
  });
});

describe('legacy snapshot migration', () => {
  const legacyWorkspace = { ...workspace('Old project'), projectId: null };
  const legacyVFS = {
    files: [
      { path: 'ui/main.ui', mimeType: 'text/x-softn-ui', lastModified: 1, lastModifiedBy: 'user', version: 1, kind: 'text', content: '<Text>Old</Text>' },
    ],
  };
  const legacyAI = {
    providers: settings.providers,
    activeProviderId: 'p1',
    modelProfile: settings.modelProfile,
    messages: [{ id: 'm1', role: 'user', content: 'hello', timestamp: 1 }],
    iterationsUsed: 1,
    maxIterations: 15,
    tokensUsed: 10,
    tokenBudget: 50_000,
    filesChanged: 1,
  };

  function seedLegacy() {
    storage.data.set('softn.studio.workspace.v1', JSON.stringify(legacyWorkspace));
    storage.data.set('softn.studio.vfs.v1', JSON.stringify(legacyVFS));
    storage.data.set('softn.studio.ai.v1', JSON.stringify(legacyAI));
  }

  it('moves the legacy snapshot into a record, keeps the providers global, then deletes the old keys', async () => {
    seedLegacy();
    const outcome = await migrateLegacyProject(1000);
    expect(outcome.status).toBe('migrated');
    if (outcome.status !== 'migrated') return;
    const stored = await loadProjectRecord(outcome.record.projectId);
    expect(stored?.workspace.projectName).toBe('Old project');
    expect(stored?.files[0].content).toBe('<Text>Old</Text>');
    expect(stored?.session.messages).toHaveLength(1);
    expect(loadGlobalSettings()?.providers[0].id).toBe('p1');
    expect(storage.data.has('softn.studio.workspace.v1')).toBe(false);
    expect(storage.data.has('softn.studio.vfs.v1')).toBe(false);
    expect(storage.data.has('softn.studio.ai.v1')).toBe(false);
  });

  it('an interrupted migration keeps the legacy snapshot readable and the project in hand', async () => {
    seedLegacy();
    idb.abortNextTransaction = true;
    const outcome = await migrateLegacyProject(1000);
    expect(outcome.status).toBe('kept');
    if (outcome.status !== 'kept') return;
    // The project is still handed over from the legacy keys...
    expect(outcome.record.files[0].content).toBe('<Text>Old</Text>');
    // ...and those keys are untouched, so the next start can try again.
    expect(loadWorkspaceSnapshot()?.projectName).toBe('Old project');
    expect(storage.data.has('softn.studio.vfs.v1')).toBe(true);
    expect(idb.records(STUDIO_DB, PROJECTS_STORE).size).toBe(0);
  });

  it('does nothing when there is no legacy snapshot', async () => {
    expect((await migrateLegacyProject(1000)).status).toBe('none');
  });
});

/** @vitest-environment jsdom */
/**
 * The dashboard says why a project has no copy it can open.
 *
 * Three different things were all "No saved copy": a name left in the list
 * with no record behind it; a record a newer Studio wrote, which this one
 * will not read (and must not write over); and a browser whose storage did
 * not answer in time, where the copies may all be there. Only the first is
 * what the words said. The third now says so above the list and offers to
 * try again; the second says the project is from a newer Studio.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installFakeIndexedDB } from '@softn/test-utils/fake-indexeddb';
import { Dashboard, type RecentEntry } from '../src/components/layout/Dashboard';
import {
  DB_OPEN_DEADLINE_MS,
  PROJECTS_STORE,
  STUDIO_DB,
  askStoreAgain,
  saveProjectRecord,
  surveyProjectStore,
  type PersistedWorkspace,
  type ProjectRecord,
} from '../src/lib/persistence';

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

describe('what the store says of the saved projects', () => {
  afterEach(() => {
    vi.useRealTimers();
    askStoreAgain();
    delete (globalThis as unknown as { indexedDB?: unknown }).indexedDB;
  });

  it('lists the records it can open, and names the ones a newer Studio wrote', async () => {
    installFakeIndexedDB();
    await saveProjectRecord(record('mine'));
    await putRaw('newer', { ...record('newer'), schemaVersion: 2, workspace: { anything: 'a newer shape' } });
    await putRaw('junk', 'not a record');
    const survey = await surveyProjectStore();
    expect(survey.answered).toBe(true);
    expect(survey.summaries.map((s) => s.projectId)).toEqual(['mine']);
    expect(survey.newer).toEqual(['newer']);
  });

  it('says the store did not answer, and asks it again at once when told to', async () => {
    vi.useFakeTimers();
    let opens = 0;
    (globalThis as unknown as { indexedDB: unknown }).indexedDB = { open: () => { opens++; return {}; } };
    const asked = surveyProjectStore();
    await vi.advanceTimersByTimeAsync(DB_OPEN_DEADLINE_MS + 1);
    expect(await asked).toEqual({ answered: false, summaries: [], newer: [] });
    // Straight after, it is not waited for again; told to try again, it is asked.
    const again = surveyProjectStore();
    await vi.advanceTimersByTimeAsync(1);
    expect((await again).answered).toBe(false);
    expect(opens).toBe(1);
    askStoreAgain();
    void surveyProjectStore();
    await vi.advanceTimersByTimeAsync(1);
    expect(opens).toBe(2);
  });
});

describe('the dashboard, of a project it cannot open', () => {
  let root: Root;
  let host: HTMLDivElement;
  const entry = (id: string, name: string, extra: Partial<RecentEntry> = {}): RecentEntry => ({ id, name, target: 'web', lastModified: 'today', saved: false, active: false, ...extra });

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });
  const row = (name: string) => [...host.querySelectorAll<HTMLElement>('.st-recent-item')].find((item) => item.textContent?.includes(name))!;

  it('says which of the three it is', () => {
    act(() => root.render(
      <Dashboard
        onNewProject={() => {}}
        onDeleteProject={async () => ({ ok: true })}
        onExportProject={async () => ({ ok: true })}
        recentProjects={[entry('a', 'Only a name'), entry('b', 'From the future', { why: 'newer' }), entry('c', 'Kept', { saved: true })]}
      />,
    ));
    expect(row('Only a name').querySelector('.st-state')?.textContent).toBe('No saved copy');
    const newer = row('From the future');
    expect(newer.querySelector('.st-state')?.textContent).toBe('From a newer Studio');
    expect(newer.querySelector('.st-recent-open')?.getAttribute('title')).toMatch(/saved by a newer version of Studio.*Reload the page.*nothing here writes over it/i);
    // It cannot be opened here, and nothing offers to delete or replace what the newer Studio wrote.
    expect(newer.querySelector('.st-recent-open')?.getAttribute('aria-disabled')).toBe('true');
    expect([...newer.querySelectorAll('button')].map((b) => b.getAttribute('aria-label'))).toEqual(['Open From the future', 'Remove From the future from the recent list']);
    expect(row('Kept').querySelector('.st-state')?.textContent).toBe('Saved');
    expect(host.querySelector('[data-store-silent]')).toBeNull();
  });

  it('says that storage did not answer, above the list, and tries again when asked', () => {
    const retry = vi.fn();
    act(() => root.render(
      <Dashboard onNewProject={() => {}} storeSilent onRetryStore={retry} recentProjects={[entry('a', 'Notes', { why: 'silent' })]} />,
    ));
    const notice = host.querySelector<HTMLElement>('[data-store-silent]')!;
    expect(notice.getAttribute('role')).toBe('alert');
    expect(notice.textContent).toMatch(/This browser’s storage did not answer in time, so Studio cannot tell which of these projects have a saved copy/);
    expect(row('Notes').querySelector('.st-state')?.textContent).toBe('Storage did not answer');
    const button = [...notice.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Try again')!;
    act(() => button.click());
    expect(retry).toHaveBeenCalledTimes(1);
  });

  // Asking again can take as long as the first asking did. The button says it is asking and
  // cannot be pressed a second time, where a press used to change nothing on the page for
  // eight seconds.
  it('shows that it is asking again, until the answer is in', async () => {
    let answered!: () => void;
    const retry = vi.fn(() => new Promise<void>((resolve) => { answered = resolve; }));
    act(() => root.render(<Dashboard onNewProject={() => {}} storeSilent onRetryStore={retry} recentProjects={[entry('a', 'Notes', { why: 'silent' })]} />));
    const button = () => host.querySelector<HTMLButtonElement>('[data-store-silent] button')!;
    act(() => button().click());
    expect(button().textContent?.trim()).toBe('Asking…');
    expect(button().disabled).toBe(true);
    act(() => button().click());
    expect(retry).toHaveBeenCalledTimes(1);
    await act(async () => { answered(); });
    expect(button().textContent?.trim()).toBe('Try again');
    expect(button().disabled).toBe(false);
  });

  it('says so with no projects listed too: there may be copies it cannot see', () => {
    act(() => root.render(<Dashboard onNewProject={() => {}} storeSilent onRetryStore={() => {}} recentProjects={[]} />));
    expect(host.querySelector('[data-store-silent]')).not.toBeNull();
  });
});

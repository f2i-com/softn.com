/**
 * The Studio project the Builder has open, and what it takes to hand it back.
 *
 * A project opened from Studio (utils/studioVisit.ts) is the Builder's own
 * project in every way but one: it has somewhere to go back to. What that
 * takes is kept here, apart from the project, in three places that each do
 * one thing.
 *
 * The visit, in a database of its own. Which Studio project it is; the
 * bundle as it came; a digest of each file as Studio held it, as it came
 * and as the Builder writes it untouched; and the .xdb files as they came,
 * which a stored session does not carry (openProject.ts, captureSession).
 * With these a reload opens the same project again whether or not anything
 * was changed, and "Back to Studio" can tell a file the person changed from
 * one the Builder only read. One visit is kept for each Studio project, and
 * the newest few projects.
 *
 * Which workspaces are a visit's, in the browser's store. A stored session
 * says which workspace wrote it and nothing else, and a start that finds one
 * has to know at once, before it asks about restoring it, whether it is a
 * visit's: the list is read without waiting for a database.
 *
 * Which visit this tab is on, in the tab's own store. A reload of the tab is
 * the visit going on, and opens it without a question; the Builder opened
 * some other way finds a stored session and asks, as it always has.
 *
 * In memory, the visit is tied to the workspace it was opened as. A new
 * project, a file opened or a link followed is another workspace, and the
 * line that says "From Studio" goes with the one that was.
 */

import { create } from 'zustand';
import { useProjectStore } from '../stores/projectStore';
import type { FileDigests } from './flipHandoff';

export const LINK_DB = 'softn-builder-studio';
export const LINK_STORE = 'visits';
const LINK_DB_VERSION = 1;
/** How many Studio projects' visits are kept: each holds a copy of its bundle. */
const VISITS_KEPT = 4;
const WORKSPACES_KEPT = 12;

/** A .xdb as it came, and the Builder's writing of the collection as it was read (bundleExporter.ts, KeptXdb). */
export interface KeptXdbFile {
  name: string;
  bytes: Uint8Array;
  written: string | null;
}

export interface StudioVisit {
  /** The Studio project's id: where "Back to Studio" takes the changes. */
  projectId: string;
  /** What Studio calls the project. */
  name: string;
  /** This visit: the id of the hand-off it arrived as. */
  visit: string;
  openedAt: number;
  /** Each file as Studio held it when it handed the project over, for Studio to hold its own against on the way back. */
  sent: FileDigests;
  /** Each file of the bundle as it came. */
  came: FileDigests;
  /** Each file as the Builder writes the project with nothing changed. */
  opened: FileDigests;
  /** The bundle as it came. */
  bundle: Uint8Array;
  xdb: KeptXdbFile[];
  /** The workspaces this visit has been open as, newest last: a restored session is a new one. */
  workspaces: string[];
  /** The last hand back: its id, and the workspace and revision it was of. */
  returned: { id: string; workspace: string; revision: number } | null;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB is not available here'));
      return;
    }
    const req = indexedDB.open(LINK_DB, LINK_DB_VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(LINK_STORE)) req.result.createObjectStore(LINK_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'));
    req.onblocked = () => reject(new Error('IndexedDB open blocked'));
  });
}

function request<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error ?? new Error('IndexedDB request failed'));
  });
}

function committed(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}

function isVisit(value: unknown): value is StudioVisit {
  const visit = value as Partial<StudioVisit> | null;
  return (
    !!visit && typeof visit === 'object' && typeof visit.projectId === 'string' && typeof visit.visit === 'string' && typeof visit.name === 'string' &&
    visit.bundle instanceof Uint8Array && !!visit.sent && !!visit.came && !!visit.opened && Array.isArray(visit.workspaces) && Array.isArray(visit.xdb)
  );
}

/** Every visit kept, oldest first. */
function everyVisit(store: IDBObjectStore): Promise<StudioVisit[]> {
  return new Promise((resolve, reject) => {
    const visits: StudioVisit[] = [];
    const cursorReq = store.openCursor();
    cursorReq.onerror = () => reject(cursorReq.error ?? new Error('IndexedDB cursor failed'));
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if (!cursor) {
        resolve(visits.sort((a, b) => a.openedAt - b.openedAt));
        return;
      }
      if (isVisit(cursor.value)) visits.push(cursor.value);
      cursor.continue();
    };
  });
}

/** Keep the visit, in place of an earlier one of the same Studio project. Whether it was kept. */
export async function keepVisit(visit: StudioVisit): Promise<boolean> {
  try {
    const db = await openDb();
    try {
      const tx = db.transaction(LINK_STORE, 'readwrite');
      const store = tx.objectStore(LINK_STORE);
      await request(store.put({ ...visit, workspaces: visit.workspaces.slice(-WORKSPACES_KEPT) }, visit.projectId));
      const all = await everyVisit(store);
      for (const old of all.filter((kept) => kept.projectId !== visit.projectId).slice(0, Math.max(0, all.length - VISITS_KEPT))) {
        await request(store.delete(old.projectId));
      }
      await committed(tx);
    } finally {
      db.close();
    }
    noteWorkspaces(visit.workspaces);
    return true;
  } catch {
    return false;
  }
}

/** A lookup that does not answer is no visit: a start is not held up by a database that will not open. */
function answered<T>(work: Promise<T>, otherwise: T, withinMs = 2500): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(otherwise), withinMs);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(otherwise);
      },
    );
  });
}

async function readVisits(): Promise<StudioVisit[]> {
  const db = await openDb();
  try {
    return await everyVisit(db.transaction(LINK_STORE, 'readonly').objectStore(LINK_STORE));
  } finally {
    db.close();
  }
}

/** The visit kept for a Studio project, or null. */
export async function visitOfProject(projectId: string): Promise<StudioVisit | null> {
  return (await answered(readVisits(), [])).find((visit) => visit.projectId === projectId) ?? null;
}

/** The visit a workspace belongs to, or null: which visit a stored session is of. */
export async function visitOfWorkspace(workspace: string): Promise<StudioVisit | null> {
  return (await answered(readVisits(), [])).reverse().find((visit) => visit.workspaces.includes(workspace)) ?? null;
}

// --- Which workspaces are a visit's ------------------------------------------------

export const VISIT_WORKSPACES_KEY = 'softn.builder.studio-visits.v1';
const LISTED = 48;

function listed(): string[] {
  try {
    const list = JSON.parse(window.localStorage.getItem(VISIT_WORKSPACES_KEY) ?? '[]') as unknown;
    return Array.isArray(list) ? list.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

function noteWorkspaces(workspaces: readonly string[]): void {
  if (typeof window === 'undefined') return;
  try {
    const rest = listed().filter((id) => !workspaces.includes(id));
    window.localStorage.setItem(VISIT_WORKSPACES_KEY, JSON.stringify([...rest, ...workspaces].slice(-LISTED)));
  } catch {
    // Not listed: a stored session of this visit is then offered back as any other is, without its way back.
  }
}

/** Whether a workspace is one a visit from Studio was open as, as far as this browser's store says. */
export function isVisitWorkspace(workspace: string | null): boolean {
  return workspace !== null && typeof window !== 'undefined' && listed().includes(workspace);
}

/** The workspace and revision a stored session was written from, or null when it does not say. */
export function sessionWorkspace(raw: string | null): { workspace: string; revision: number } | null {
  if (!raw) return null;
  try {
    const session = JSON.parse(raw) as { projectId?: unknown; revision?: unknown } | null;
    return session && typeof session.projectId === 'string' ? { workspace: session.projectId, revision: typeof session.revision === 'number' ? session.revision : 0 } : null;
  } catch {
    return null;
  }
}

// --- Which visit this tab is on ----------------------------------------------------

export const TAB_VISIT_KEY = 'softn.builder.studio-visit';

export interface TabVisit {
  projectId: string;
  visit: string;
}

export function readTabVisit(): TabVisit | null {
  try {
    const value = JSON.parse(window.sessionStorage.getItem(TAB_VISIT_KEY) ?? 'null') as Partial<TabVisit> | null;
    return value && typeof value.projectId === 'string' && typeof value.visit === 'string' ? { projectId: value.projectId, visit: value.visit } : null;
  } catch {
    return null;
  }
}

export function writeTabVisit(visit: TabVisit | null): void {
  try {
    if (visit) window.sessionStorage.setItem(TAB_VISIT_KEY, JSON.stringify(visit));
    else window.sessionStorage.removeItem(TAB_VISIT_KEY);
  } catch {
    // Without it a reload asks before it restores, as the Builder does for any stored session.
  }
}

// --- The visit of the workspace that is open ----------------------------------------

/** A visit as the open workspace holds it. */
export interface OpenVisit extends StudioVisit {
  /** The workspace it is open as: it is this project's only while this is the project's id. */
  workspace: string;
  /** Files the bundle came with that a restored session could not bring back: not the person's deletions. */
  lost: string[];
}

interface VisitState {
  /** The visit of some workspace; of the one that is open when their ids agree (useStudioVisit). */
  visit: OpenVisit | null;
  /** A project is on its way in from Studio. */
  arriving: boolean;
  /** Why what Studio handed over is not open, when it is not. */
  problem: string | null;
}

export const useStudioVisitStore = create<VisitState>(() => ({ visit: null, arriving: false, problem: null }));

/** The visit of the project that is open, or null. */
export function openVisit(): OpenVisit | null {
  const { visit } = useStudioVisitStore.getState();
  return visit && visit.workspace === useProjectStore.getState().projectId ? visit : null;
}

/** The visit of the project that is open, as it changes. */
export function useStudioVisit(): OpenVisit | null {
  const visit = useStudioVisitStore((state) => state.visit);
  const workspace = useProjectStore((state) => state.projectId);
  return visit && visit.workspace === workspace ? visit : null;
}

/**
 * The workspace `workspace` (the one just opened) is this visit's from now
 * on. Kept, with the workspace among those the visit has been open as, so a
 * session written from it is known for the visit's. Whether it was kept.
 */
export async function holdVisit(visit: StudioVisit, workspace: string, lost: string[] = []): Promise<boolean> {
  const workspaces = [...visit.workspaces.filter((id) => id !== workspace), workspace];
  const held: StudioVisit = { ...visit, workspaces };
  useStudioVisitStore.setState({ visit: { ...held, workspace, lost }, arriving: false, problem: null });
  // Listed at once: a session written from this workspace is a visit's from its first write.
  noteWorkspaces([workspace]);
  const kept = await keepVisit(held);
  // The tab is on this visit while the workspace is still the one it was opened as.
  if (kept && useProjectStore.getState().projectId === workspace) writeTabVisit({ projectId: visit.projectId, visit: visit.visit });
  return kept;
}

/** Note on the visit that is open what its last hand back was. */
export async function noteReturned(returned: NonNullable<StudioVisit['returned']>): Promise<void> {
  const visit = openVisit();
  if (!visit) return;
  const { workspace, lost, ...kept } = { ...visit, returned };
  useStudioVisitStore.setState({ visit: { ...kept, workspace, lost } });
  await keepVisit(kept);
}

// A new project, a file opened, a link followed: the tab is no longer on the visit, and a reload
// must not bring it back over what the person opened instead.
if (typeof window !== 'undefined') {
  useProjectStore.subscribe((state, before) => {
    if (state.projectId === before.projectId) return;
    const { visit } = useStudioVisitStore.getState();
    if (visit && visit.workspace === before.projectId) writeTabVisit(null);
  });
}

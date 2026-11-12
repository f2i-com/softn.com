/**
 * A project that comes from Studio, is changed here by hand, and goes back.
 *
 * Studio's "Open in Builder" stages the project the way Run stages a bundle
 * (utils/flipHandoff.ts) and brings this tab here. The Builder opens it as
 * it opens any bundle: it is this editor's project, saved and exported as
 * any other is. What is different is that it has somewhere to go back to,
 * and "Back to Studio" takes it there. What that needs is kept beside the
 * project (utils/studioLink.ts); what is done with it is here.
 *
 * Coming in. The record Studio staged is read, the bundle opened, and the
 * visit kept, before the record is removed and the address tidied: a reload
 * at any point opens the same project again. Right after it is opened, and
 * before anything can be changed, the Builder writes the project out once
 * and keeps a digest of every file: that is what "nothing changed" looks
 * like when the Builder writes it, whatever the Builder's writing of a file
 * it only read turns out to be.
 *
 * Going back. The project is saved by the rule every save goes by
 * (utils/saveProject.ts): one revision, captured first, clean only if it is
 * still that revision once written. The file that save writes is the
 * hand-off. Its bundle is held against the digests kept on the way in. Where
 * every file is as the Builder wrote it untouched, nothing was changed, and
 * nothing is staged: Studio is only told which project to open. Otherwise
 * the files that are no longer as they came, and the ones taken out, are
 * named for Studio to bring in, with Studio's own digest of each for it to
 * check against. A file the Builder only read is not named, so it is not
 * touched there.
 *
 * A reload in between. Unsaved work is kept by the recovery copy as always,
 * and a tab that was on a visit restores its own copy without asking. Two
 * things a stored session does not hold are put back from the visit: the
 * .xdb files as they came (a session writes each collection anew, which
 * would come back to Studio as a change nobody made), and any picture the
 * browser's store had no room for (which would come back as a deletion).
 *
 * Work that never went back. Studio's next "Open in Builder" finds the
 * Builder still holding the earlier visit's work, with no word from Studio
 * that it arrived. It is not opened over: the person is asked which to go
 * on with.
 */

import { readBundleEntries } from '@softn/core';
import { isHostedEditor } from '@softn/editor-shared/hostedEditor';
import { randomUUID } from '@softn/bundle-format/crypto';
import { useProjectStore } from '../stores/projectStore';
import type { AssetFile } from '../types/builder';
import { loadBundle } from './bundleLoader';
import { buildProjectBundle } from './buildProjectBundle';
import { askConfirm } from './confirm';
import { isDesktop } from './desktop';
import { describeFlipFailure, digestFiles, flipTaken, flipUrl, noteFlipTaken, readFlip, removeFlip, sameOriginTarget, stageFlip, withoutFlip, type FileDigests } from './flipHandoff';
import { SESSION_STORAGE_KEY, noteOpenedFromLink, prepareProjectSnapshot, prepareSessionSnapshot, recoveryOf, restoredFromStore, type ProjectSnapshot, type ViewMode } from './openProject';
import { restoreOffer } from './recoveryCopy';
import { readLocalStorage } from './safeStorage';
import { markUnsaved } from './savedPoint';
import { saveProject } from './saveProject';
import { encodeAsset } from './sessionAssets';
import { STUDIO_URL } from './siteUrls';
import { SESSION_ASSETS_KEY, assetRef, joinStoredSession, type AssetRef, type AssetsKept } from './storedAssets';
import {
  holdVisit,
  isVisitWorkspace,
  noteReturned,
  openVisit,
  sessionWorkspace,
  useStudioVisitStore,
  visitOfProject,
  visitOfWorkspace,
  writeTabVisit,
  type OpenVisit,
  type StudioVisit,
  type TabVisit,
} from './studioLink';

/**
 * Whether there is a Studio to come from and go back to: one on this origin.
 * Not inside FormLogic, and not the desktop app, whose Studio is softn.com.
 */
export function studioOffered(): boolean {
  return !isHostedEditor() && !isDesktop() && sameOriginTarget(STUDIO_URL);
}

export interface VisitDeps {
  /** Put a candidate in the workspace, as the app does for any project it opens. */
  apply(snapshot: ProjectSnapshot): void;
  ask?: typeof askConfirm;
}

export type Arrival =
  /** Studio's project is open, as it came. */
  | { kind: 'opened'; name: string }
  /** The visit's own work, as it was left, is open again. */
  | { kind: 'restored'; name: string }
  /** Nothing of Studio's to open: the start goes on as any other does. */
  | { kind: 'none' }
  /** The stored session was offered back, and the answer was not now. */
  | { kind: 'declined' }
  /** The workspace was taken by something else while this was on its way. */
  | { kind: 'superseded' }
  | { kind: 'failed'; message: string };

/** How a start that has to do with Studio begins (openProject.ts, startupAction). */
export interface StudioStart {
  /** The id in the address: Studio has just handed a project over. */
  id: string | null;
  /** The visit this tab was on before it was reloaded. */
  tab: TabVisit | null;
  /** A stored session that a visit left. */
  session: string | null;
}

const NONE: Arrival = { kind: 'none' };
const SUPERSEDED: Arrival = { kind: 'superseded' };

/** The address without what Studio put there, once the project is safely here. */
function tidyAddress(): void {
  if (typeof window === 'undefined') return;
  window.history.replaceState(window.history.state, '', window.location.pathname + withoutFlip(window.location.search) + window.location.hash);
}

function failed(message: string): Arrival {
  useStudioVisitStore.setState({ arriving: false, problem: message });
  return { kind: 'failed', message };
}

// --- A stored session of a visit ---------------------------------------------------

type StoredAsset = ReturnType<typeof encodeAsset> & { size: number; hash: string };

/**
 * The store's record of the session's assets, with each one the session
 * names and the store has not got put back from the bundle Studio sent,
 * where that is the same file. The store is a few megabytes and takes the
 * text before the pictures; the bundle is kept whole.
 */
function assetsWithBundle(raw: string, assetsRaw: string | null, bundle: ReadonlyMap<string, Uint8Array>): string | null {
  let refs: unknown;
  try {
    refs = (JSON.parse(raw) as { files?: { assetRefs?: unknown } } | null)?.files?.assetRefs;
  } catch {
    return assetsRaw;
  }
  if (!Array.isArray(refs)) return assetsRaw;
  const have = new Map<string, StoredAsset>();
  try {
    const record = assetsRaw ? (JSON.parse(assetsRaw) as { files?: unknown }) : null;
    for (const entry of Array.isArray(record?.files) ? record.files : []) {
      if (Array.isArray(entry) && typeof entry[0] === 'string' && entry[1] && typeof entry[1] === 'object') have.set(entry[0], entry[1] as StoredAsset);
    }
  } catch {
    // A record that cannot be read holds nothing.
  }
  let added = false;
  for (const entry of refs) {
    if (!Array.isArray(entry) || typeof entry[0] !== 'string' || !entry[1] || typeof entry[1] !== 'object') continue;
    const id = entry[0];
    const ref = entry[1] as AssetRef;
    const stored = have.get(id);
    if (stored && stored.size === ref.size && stored.hash === ref.hash) continue;
    const bytes = ref.bundlePath ? bundle.get(ref.bundlePath) : undefined;
    if (!bytes || bytes.byteLength !== ref.size) continue;
    const asset: AssetFile = { bundlePath: ref.bundlePath, name: ref.name, type: ref.type, data: bytes };
    if (assetRef(asset).hash !== ref.hash) continue;
    have.set(id, { ...encodeAsset(asset), size: ref.size, hash: ref.hash });
    added = true;
  }
  return added ? JSON.stringify({ files: [...have] }) : assetsRaw;
}

/** Where the assets were that the session names and the joined session does not hold. */
function lostAssets(raw: string, joined: string): string[] {
  try {
    const refs = ((JSON.parse(raw) as { files?: { assetRefs?: unknown } }).files?.assetRefs ?? []) as Array<[string, AssetRef]>;
    const held = new Set((((JSON.parse(joined) as { files?: { assetFiles?: unknown } }).files?.assetFiles ?? []) as Array<[string, unknown]>).map(([id]) => id));
    return refs.filter((entry) => Array.isArray(entry) && !held.has(entry[0]) && typeof entry[1]?.bundlePath === 'string').map((entry) => entry[1].bundlePath!);
  } catch {
    return [];
  }
}

interface VisitRestore {
  snapshot: ProjectSnapshot;
  assets: AssetsKept;
  lost: string[];
}

/**
 * The assets in the order the bundle's manifest lists them, and any it does
 * not list after them as they stand. A stored session names its assets in
 * the order of their ids, the export lists them in the order it holds them,
 * and a manifest that lists the same pictures in another order is a file
 * changed that nobody changed.
 */
function inBundleOrder(assets: Map<string, AssetFile>, bundle: ReadonlyMap<string, Uint8Array>): Map<string, AssetFile> {
  let declared: unknown[] = [];
  try {
    const listed = (JSON.parse(new TextDecoder().decode(bundle.get('manifest.json'))) as { files?: { assets?: unknown } } | null)?.files?.assets;
    if (Array.isArray(listed)) declared = listed;
  } catch {
    // A manifest that cannot be read lists nothing: the assets stay as they are.
  }
  const place = (asset: AssetFile): number => {
    const at = declared.indexOf(asset.bundlePath);
    return at < 0 ? declared.length : at;
  };
  return new Map(
    [...assets]
      .map((entry, given) => ({ entry, given, place: place(entry[1]) }))
      .sort((a, b) => a.place - b.place || a.given - b.given)
      .map(({ entry }) => entry),
  );
}

/** The candidate for a visit's stored session, with what the visit keeps for it. Throws when the session will not restore. */
function prepareVisitRestore(visit: StudioVisit, raw: string): VisitRestore {
  const bundle = readBundleEntries(visit.bundle);
  const joined = joinStoredSession(raw, assetsWithBundle(raw, readLocalStorage(SESSION_ASSETS_KEY), bundle));
  const snapshot = prepareSessionSnapshot(joined.raw);
  if (snapshot.files.kind === 'state') snapshot.files.assetFiles = inBundleOrder(snapshot.files.assetFiles, bundle);
  // While a collection is as it was read, its file goes back as it came (bundleExporter.ts, KeptXdb).
  snapshot.project.source = { ...snapshot.project.source, xdbFiles: new Map(visit.xdb.map((file) => [file.name, { bytes: file.bytes, written: file.written }])) };
  return { snapshot, assets: joined.assets, lost: lostAssets(raw, joined.raw) };
}

/** Put a visit's stored session in the workspace, and the visit with it. */
async function restoreVisit(visit: StudioVisit, raw: string, restore: VisitRestore, deps: VisitDeps): Promise<Arrival> {
  deps.apply(restore.snapshot);
  // This tab's work now: the next write is its copy (openProject.ts).
  restoredFromStore(raw);
  if (recoveryOf(raw)) markUnsaved();
  await holdVisit(visit, useProjectStore.getState().projectId, restore.lost);
  return { kind: 'restored', name: visit.name };
}

/**
 * Work on this Studio project that the Builder holds from an earlier visit
 * and that Studio has not said it took: the stored session is that visit's,
 * and is not the very revision whose hand back reached Studio.
 */
async function unreturnedWork(projectId: string): Promise<{ visit: StudioVisit; raw: string } | null> {
  const raw = readLocalStorage(SESSION_STORAGE_KEY);
  const from = sessionWorkspace(raw);
  if (!raw || !from || !isVisitWorkspace(from.workspace)) return null;
  const visit = await visitOfProject(projectId);
  if (!visit || !visit.workspaces.includes(from.workspace)) return null;
  const back = visit.returned;
  if (back && back.workspace === from.workspace && back.revision === from.revision && flipTaken(projectId) === back.id) return null;
  return { visit, raw };
}

// --- Coming in ---------------------------------------------------------------------

/** Open the project the tab's visit is of again: its own work as it was left, or the bundle as it came. */
async function resumeVisit(tab: TabVisit, deps: VisitDeps): Promise<Arrival> {
  const generation = useProjectStore.getState().workspaceGeneration;
  const visit = await visitOfProject(tab.projectId);
  if (useProjectStore.getState().workspaceGeneration !== generation) return SUPERSEDED;
  if (!visit || visit.visit !== tab.visit) {
    writeTabVisit(null);
    return NONE;
  }
  const raw = readLocalStorage(SESSION_STORAGE_KEY);
  const from = sessionWorkspace(raw);
  if (raw && from && visit.workspaces.includes(from.workspace)) {
    try {
      return await restoreVisit(visit, raw, prepareVisitRestore(visit, raw), deps);
    } catch {
      // A session that will not restore is the start's to report and set aside, as for any other.
      writeTabVisit(null);
      return NONE;
    }
  }
  // Nothing was changed before the reload: the project as it came.
  let snapshot: ProjectSnapshot;
  try {
    snapshot = prepareProjectSnapshot(await loadBundle(visit.bundle));
  } catch {
    writeTabVisit(null);
    return NONE;
  }
  if (useProjectStore.getState().workspaceGeneration !== generation) return SUPERSEDED;
  noteOpenedFromLink();
  deps.apply(snapshot);
  await holdVisit(visit, useProjectStore.getState().projectId);
  return { kind: 'opened', name: visit.name };
}

/** Studio has just handed a project over under `id`. */
async function arriveFromStudio(id: string, tab: TabVisit | null, deps: VisitDeps): Promise<Arrival> {
  const ask = deps.ask ?? askConfirm;
  const generation = useProjectStore.getState().workspaceGeneration;
  const moved = () => useProjectStore.getState().workspaceGeneration !== generation;
  const read = await readFlip(id, 'builder');
  if (!read.ok) {
    // Taken already by this tab, which was reloaded before its address was tidied: the visit goes on.
    if (tab && tab.visit === id && (read.reason === 'unknown' || read.reason === 'expired')) {
      const resumed = await resumeVisit(tab, deps);
      if (resumed.kind !== 'none') {
        if (resumed.kind === 'opened' || resumed.kind === 'restored') tidyAddress();
        return resumed;
      }
    }
    return failed(describeFlipFailure(read.reason, 'builder'));
  }
  const { record } = read;
  const flip = record.flip;
  if (flip.kind !== 'open') return failed(describeFlipFailure('corrupt', 'builder'));

  let snapshot: ProjectSnapshot;
  try {
    snapshot = prepareProjectSnapshot(await loadBundle(record.bytes));
  } catch (e) {
    await removeFlip(id);
    return failed(`${record.name} could not be opened in the Builder: ${e instanceof Error ? e.message : String(e)} It is as it was in Studio.`);
  }
  if (moved()) return SUPERSEDED;

  const earlier = await unreturnedWork(flip.projectId);
  if (moved()) return SUPERSEDED;
  if (earlier) {
    let restore: VisitRestore | null = null;
    try {
      restore = prepareVisitRestore(earlier.visit, earlier.raw);
    } catch {
      restore = null;
    }
    if (restore) {
      const keep = await ask(
        `The Builder has work on ${earlier.visit.name} from before that did not go back to Studio. Go on with it, or start again from Studio’s copy?\n\nGoing on keeps it, and Back to Studio brings it in. Starting again leaves it out: work that was never saved to a file is kept under Export → Recovery.`,
        { title: 'Work that did not go back', confirmLabel: 'Go on with it', cancelLabel: 'Start from Studio’s copy' },
      );
      if (moved()) return SUPERSEDED;
      if (keep) {
        const restored = await restoreVisit(earlier.visit, earlier.raw, restore, deps);
        await removeFlip(id);
        tidyAddress();
        return restored;
      }
    }
  }
  if (useProjectStore.getState().isDirty) {
    const replace = await ask(`Open ${record.name} from Studio? The edits made here since the page opened will be lost.`, { title: 'Unsaved changes', confirmLabel: 'Discard and open', danger: true });
    if (moved()) return SUPERSEDED;
    if (!replace) return { kind: 'declined' };
  }

  // Whatever session the store holds is another project's, or work the person chose to leave: set
  // aside before this project's first write goes over it, as for a project opened from a link.
  noteOpenedFromLink();
  deps.apply(snapshot);
  const workspace = useProjectStore.getState().projectId;
  // Written out at once, before anything can be changed: every store is read before the first await.
  const untouched = buildProjectBundle().then(readBundleEntries, () => null);
  const xdb = [...(useProjectStore.getState().source.xdbFiles ?? [])].map(([name, kept]) => ({ name, bytes: kept.bytes, written: kept.written }));
  const came = await digestFiles(readBundleEntries(record.bytes));
  const written = await untouched;
  // A project the Builder cannot write as it stands is held against what came.
  const opened = written ? await digestFiles(written) : came;
  const kept = await holdVisit(
    { projectId: flip.projectId, name: record.name, visit: id, openedAt: Date.now(), sent: flip.sent, came, opened, bundle: record.bytes, xdb, workspaces: [], returned: null },
    workspace,
  );
  // Removed once the visit is kept: until then the record is what a reload opens.
  if (kept) {
    await removeFlip(id);
    tidyAddress();
  }
  return { kind: 'opened', name: record.name };
}

/** A stored session a visit left, found by a Builder opened some other way: offered back as any session is. */
async function offerVisitSession(raw: string, deps: VisitDeps): Promise<Arrival> {
  const generation = useProjectStore.getState().workspaceGeneration;
  const from = sessionWorkspace(raw);
  const visit = from ? await visitOfWorkspace(from.workspace) : null;
  if (!visit) return NONE;
  let restore: VisitRestore;
  try {
    restore = prepareVisitRestore(visit, raw);
  } catch {
    return NONE;
  }
  if (useProjectStore.getState().workspaceGeneration !== generation) return SUPERSEDED;
  const yes = await (deps.ask ?? askConfirm)(restoreOffer(raw, restore.assets), { title: 'Restore your work?', confirmLabel: 'Restore', cancelLabel: 'Not now' });
  if (!yes) return { kind: 'declined' };
  if (useProjectStore.getState().workspaceGeneration !== generation) return SUPERSEDED;
  return restoreVisit(visit, raw, restore, deps);
}

/**
 * What a start that has to do with Studio comes to. `none` hands the start
 * back, for the question about a stored session or nothing at all.
 */
export async function startFromStudio(start: StudioStart, deps: VisitDeps): Promise<Arrival> {
  if (start.id || start.tab) useStudioVisitStore.setState({ arriving: true, problem: null });
  try {
    if (start.id) return await arriveFromStudio(start.id, start.tab, deps);
    if (start.tab) {
      const resumed = await resumeVisit(start.tab, deps);
      // Not this tab's visit after all: a stored session of some visit is still offered back.
      if (resumed.kind !== 'none' || !start.session) return resumed;
    }
    if (start.session) return await offerVisitSession(start.session, deps);
    return NONE;
  } catch (e) {
    return failed(`What Studio handed over could not be opened: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    useStudioVisitStore.setState({ arriving: false });
  }
}

// --- Going back --------------------------------------------------------------------

interface StagedReturn {
  url: string;
  /** How many files Studio is asked to change. */
  changed: number;
  /** The hand back's id: the hand-off's, or one of its own when nothing was staged. */
  id: string;
}

/**
 * What goes back to Studio of a bundle the Builder has just written: the
 * address that takes it, and how much it is. Nothing is staged where every
 * file is as the Builder wrote it untouched.
 */
export async function stageReturn(visit: OpenVisit, bytes: Uint8Array, stage: typeof stageFlip = stageFlip): Promise<StagedReturn> {
  const now = await digestFiles(readBundleEntries(bytes));
  // A picture the browser's store lost over a reload is not one the person took out.
  const lost = new Set(visit.lost);
  const gone = Object.keys(visit.opened).filter((path) => !(path in now) && !lost.has(path));
  const touched = gone.length > 0 || Object.keys(now).some((path) => now[path] !== visit.opened[path]);
  if (!touched) return { url: flipUrl(STUDIO_URL, 'studio', { projectId: visit.projectId }), changed: 0, id: randomUUID() };
  // Held against the bundle as it came: where the Builder's writing of a file it only read is not
  // the file that came, that file goes back with the person's changes and never without them.
  const changed = Object.keys(now).filter((path) => now[path] !== visit.came[path]);
  const sent: FileDigests = {};
  for (const path of [...changed, ...gone]) if (visit.sent[path] !== undefined) sent[path] = visit.sent[path];
  const id = await stage(bytes, visit.name, 'studio', { kind: 'return', projectId: visit.projectId, changed, deleted: gone, sent });
  if (!id) throw new Error('This browser could not hold the changes for Studio. They are still here, and Export keeps a copy of them.');
  return { url: flipUrl(STUDIO_URL, 'studio', { id, projectId: visit.projectId }), changed: changed.length + gone.length, id };
}

export type Leaving = { kind: 'left'; url: string; changed: number } | { kind: 'stayed'; message: string };

export interface LeaveDeps {
  navigate?: (url: string) => void;
  stage?: typeof stageFlip;
  save?: typeof saveProject;
}

/**
 * Hand the open project back to the Studio project it came from, and take
 * this tab there. The project is saved by the rule a save goes by, with the
 * hand-off as its file; an edit made while it was being staged is handed
 * over again, so what is left behind is never ahead of what went.
 */
export async function backToStudio(view: ViewMode, deps: LeaveDeps = {}): Promise<Leaving> {
  const visit = openVisit();
  if (!visit) return { kind: 'stayed', message: 'This project did not come from Studio.' };
  if (!studioOffered()) return { kind: 'stayed', message: 'Studio is not beside this Builder. Export the project and import the file in Studio instead.' };
  const save = deps.save ?? saveProject;
  for (let attempt = 0; attempt < 3; attempt++) {
    let staged: StagedReturn | null = null;
    const outcome = await save({
      view,
      existingHandle: null,
      writeFile: async (bytes) => {
        staged = await stageReturn(visit, bytes, deps.stage);
        return null;
      },
    });
    if (outcome.kind === 'failed') return { kind: 'stayed', message: `The project could not be handed back to Studio: ${outcome.error instanceof Error ? outcome.error.message : String(outcome.error)}` };
    const sent = staged as StagedReturn | null;
    if (outcome.kind !== 'saved' || !sent) return { kind: 'stayed', message: 'The project was not handed back to Studio.' };
    if (outcome.projectChanged) return { kind: 'stayed', message: 'Another project was opened while this one was being handed back to Studio.' };
    if (outcome.stale) continue;
    await noteReturned({ id: sent.id, workspace: outcome.projectId, revision: outcome.revision });
    // Nothing for Studio to take: this revision is in Studio already.
    if (sent.changed === 0) noteFlipTaken(visit.projectId, sent.id);
    // The tab is leaving the visit: the Builder opened in it again asks before it restores anything.
    writeTabVisit(null);
    (deps.navigate ?? ((url: string) => window.location.assign(url)))(sent.url);
    return { kind: 'left', url: sent.url, changed: sent.changed };
  }
  return { kind: 'stayed', message: 'The project kept changing while it was being handed back to Studio. Try again.' };
}

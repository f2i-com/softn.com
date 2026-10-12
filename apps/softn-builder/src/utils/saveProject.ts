/**
 * Save: one revision, captured first, written whole, acknowledged only if
 * it is still the current one.
 *
 * The old save awaited the file write and then marked the project clean,
 * whatever had happened during the wait: an edit made while the picker was
 * open was marked clean without ever reaching a file, and a save begun on
 * one project could mark clean — and overwrite the recovery record of —
 * the project opened while it was pending. Its session payload was worse:
 * it mixed store snapshots taken before the write with `toJSON()` read
 * after it, so the recovery record was of no revision at all.
 *
 * Now the flush happens first, then (projectId, revision), the recovery
 * record and the bundle bytes are all taken in one synchronous pass, so
 * the file and the recovery record are the same revision. After the write:
 *  - the project is marked clean only if it is still that project at that
 *    revision; otherwise the caller is told an earlier revision was saved
 *    and the newer edits remain unsaved (the project stays dirty);
 *  - the recovery record is stored only for that same project, and never
 *    over a newer revision's record.
 * A cancelled picker, a failed write, and a written file whose recovery
 * record could not be stored are three different outcomes, reported as
 * such: the last is a successful save.
 *
 * Export goes through here too. It writes the same bundle, and it used to
 * leave the project "Unsaved" whatever it wrote and wherever: someone with
 * the whole project in the file they had just been handed was warned, on
 * closing the tab, that their changes would be lost; and in a browser that
 * gives a page no file to keep, where Save is a download as well, the two
 * buttons wrote the same bytes the same way and only one was believed.
 *  - A project with no file of its own (never saved, or a browser with no
 *    file access) is saved by its export: clean by the rule above, with its
 *    recovery record, and on the desktop the place it was written becomes
 *    the file it is kept in.
 *  - A project that has a file of its own is not: the export is a copy
 *    beside it. Marked clean, the file it was opened from would be believed
 *    current while holding an earlier revision. It stays unsaved, and the
 *    person is told the file has not been saved since their last changes.
 *    The same for a draft edited inside FormLogic, which is kept there.
 */

import { useProjectStore } from '../stores/projectStore';
import { useFilesStore } from '../stores/filesStore';
import { exportBundleToFile, saveBundleToFile } from './bundleExporter';
import { buildProjectBundle, bundleFileName, flushCanvasToActiveFile } from './buildProjectBundle';
import { captureSession, SESSION_STORAGE_KEY, type BuilderSession, type ViewMode } from './openProject';
import type { BundleFileHandle } from './desktop';
import { captureAssets, storeAssets, type AssetStore, type CapturedAssets } from './storedAssets';
import { captureSavedPoint, forgetSavedPoint, keepSavedPoint, type SavedPoint } from './savedPoint';
import { requestHostedSave } from '@softn/editor-shared/hostedEditor';

export type SaveOutcome =
  | {
      kind: 'saved';
      projectId: string;
      revision: number;
      handle: BundleFileHandle | null;
      /** True when the project moved on during the write: the file holds an earlier revision. */
      stale: boolean;
      /** True when the project itself was replaced during the write. */
      projectChanged: boolean;
      /** Whether the recovery record was stored; the error when it could not be. */
      sessionStored: boolean;
      sessionError?: unknown;
      /**
       * Where the recovery record was stored: whether the project's assets
       * are in the store with it, or the store took the text and not them.
       */
      sessionAssets?: 'kept' | 'left-out';
      /**
       * The recovery record was left as it is because it already holds a
       * newer revision of this project: a copy of work done while the file
       * was being written (utils/recoveryCopy.ts). Nothing failed.
       */
      sessionSuperseded?: boolean;
      /**
       * Export only: what was written is a copy beside the place the project
       * is kept, which it does not replace, so nothing was marked clean.
       * `of` names that place (null for a draft FormLogic holds), and
       * `unsaved` says whether the project has changes that are not in it.
       */
      copy?: { of: string | null; unsaved: boolean };
    }
  | { kind: 'cancelled' }
  | { kind: 'failed'; error: unknown };

export interface SaveDeps {
  /** The current view, kept in the recovery record. */
  view: ViewMode;
  existingHandle: BundleFileHandle | null;
  /**
   * `'export'` writes the bundle where Export writes it: a download in the
   * browser, a place asked for every time on the desktop. The same bundle,
   * captured and acknowledged by the same rule; what differs is whether the
   * write counts as the save (see the head of this file).
   */
  as?: 'save' | 'export';
  /** The project is a draft edited inside FormLogic, which is where it is kept. */
  hosted?: boolean;
  writeFile?: typeof saveBundleToFile;
  writeExport?: typeof exportBundleToFile;
  storage?: AssetStore;
  build?: () => Promise<Uint8Array>;
  capture?: (view: ViewMode) => BuilderSession;
}

/** The newest revision whose recovery record was stored, per project, this page. */
const persisted = new Map<string, number>();

/** Whether two desktop paths name one file: a dialog on Windows hands back either slash and any case. */
function samePath(a: string, b: string): boolean {
  const plain = (path: string) => path.replace(/\\/g, '/');
  const windows = /^[a-z]:\/|^\/\//i.test(plain(a));
  return windows ? plain(a).toLowerCase() === plain(b).toLowerCase() : plain(a) === plain(b);
}

export async function saveProject(deps: SaveDeps): Promise<SaveOutcome> {
  const exporting = deps.as === 'export';
  const writeFile = deps.writeFile ?? saveBundleToFile;
  const writeExport = deps.writeExport ?? exportBundleToFile;
  const build = deps.build ?? buildProjectBundle;
  // Stored with its assets apart: they are a record of their own (utils/storedAssets.ts).
  const capture = deps.capture ?? ((view: ViewMode) => captureSession(view, { assets: 'apart' }));

  // The flush may be an edit (it marks the file dirty when the canvas moved),
  // so it comes before the revision is read.
  let projectId: string;
  let revision: number;
  let name: string;
  let session: BuilderSession;
  let assets: CapturedAssets;
  let kept: SavedPoint;
  let bundlePromise: Promise<Uint8Array>;
  try {
    flushCanvasToActiveFile();
    ({ projectId, revision, name } = useProjectStore.getState());
    session = capture(deps.view);
    // What the file will hold, for what an edit that is undone comes back to.
    kept = captureSavedPoint();
    // The assets as they are now, with the text that names them: written
    // together when the file is done, whatever the project holds by then.
    assets = captureAssets(useFilesStore.getState().assetFiles);
    bundlePromise = build();
  } catch (error) {
    // Invalid or unserializable project state is a reported save failure,
    // just like a failed file write; it must not escape the UI handler.
    return { kind: 'failed', error };
  }

  let bytes: Uint8Array;
  let handle: BundleFileHandle | null;
  try {
    bytes = await bundlePromise;
    handle = exporting
      ? await writeExport(bytes, bundleFileName(name))
      : await writeFile(bytes, bundleFileName(name).replace(/\.softn$/, ''), deps.existingHandle);
  } catch (e) {
    // User cancelling the file picker throws an AbortError — quiet.
    if (e instanceof DOMException && e.name === 'AbortError') return { kind: 'cancelled' };
    if (e instanceof Error && e.name === 'AbortError') return { kind: 'cancelled' };
    return { kind: 'failed', error: e };
  }

  // An export beside the place the project is kept is a copy of it. That
  // place is FormLogic for a draft edited there, and otherwise the file the
  // project was opened from or last saved to, unless the export was written
  // over that very file, which is then a save of it by another button.
  if (exporting) {
    const own = deps.existingHandle;
    const overItself =
      own !== null && handle !== null && own.kind === 'desktop-file' && handle.kind === 'desktop-file' && samePath(own.path, handle.path);
    if (deps.hosted || (own !== null && !overItself)) {
      const now = useProjectStore.getState();
      const projectChanged = now.projectId !== projectId;
      return {
        kind: 'saved',
        projectId,
        revision,
        handle: own,
        stale: false,
        projectChanged,
        sessionStored: false,
        copy: { of: deps.hosted ? null : (own?.name ?? null), unsaved: !projectChanged && now.isDirty },
      };
    }
  }

  const cleaned = useProjectStore.getState().markCleanIf(projectId, revision);
  if (cleaned) {
    const files = useFilesStore.getState();
    for (const [id, node] of files.nodes) {
      if (node.type === 'file' && node.isDirty) files.markFileDirty(id, false);
    }
  }
  const projectChanged = useProjectStore.getState().projectId !== projectId;
  // The file holds the revision captured, whatever was done while it was
  // being written: work undone back to that revision is saved, and work
  // undone past it is not. When the project has moved on, what it is held
  // against has moved under it, and it is judged again at a new revision,
  // as an edit is, so the copy kept for recovery follows.
  if (!projectChanged && keepSavedPoint(kept) && !cleaned) useProjectStore.getState().markDirty();

  // The recovery record: of the revision on disk, for that project only, and
  // never over a newer one. Losing it does not affect the file just written.
  let sessionStored = false;
  let sessionError: unknown;
  let sessionAssets: 'kept' | 'left-out' | undefined;
  const sessionSuperseded = !projectChanged && (persisted.get(projectId) ?? -1) > revision;
  if (!projectChanged && !sessionSuperseded) {
    try {
      const storage = deps.storage ?? window.localStorage;
      storage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
      persisted.set(projectId, revision);
      sessionStored = true;
      // The text first: a store that then refuses the assets has still kept it.
      // A set the store refused while the work went on is asked for again here.
      sessionAssets = storeAssets(storage, assets, { again: true }).kind === 'refused' ? 'left-out' : 'kept';
    } catch (e) {
      sessionError = e;
    }
  }

  return {
    kind: 'saved',
    projectId,
    revision,
    handle,
    stale: !cleaned,
    projectChanged,
    sessionStored,
    sessionError,
    ...(sessionAssets ? { sessionAssets } : {}),
    ...(sessionSuperseded ? { sessionSuperseded } : {}),
  };
}

export type HostedSaveReport =
  | { kind: 'not-hosted' }
  | { kind: 'disconnected' }
  | { kind: 'saved' }
  | { kind: 'failed'; error: string };

/**
 * Save a draft edited inside FormLogic: FormLogic is asked to take it, and
 * the save is done only once it says it has (audit SN-04). A closed channel
 * keeps the edits here and says so; it is never a download instead. Not
 * hosted, the caller saves to a file.
 *
 * FormLogic takes the draft as it is when it asks for it, which is not
 * known here: from the request on, what the project was opened as is
 * nothing it can come back to, and only another save makes it clean
 * (utils/savedPoint.ts).
 */
export async function saveToHost(request: typeof requestHostedSave = requestHostedSave): Promise<HostedSaveReport> {
  const hosted = request();
  if (!hosted.handled) return { kind: hosted.reason };
  forgetSavedPoint();
  const result = await hosted.completion;
  return result.ok ? { kind: 'saved' } : { kind: 'failed', error: result.error ?? 'FormLogic could not take the draft. Your changes are still here.' };
}

/** What a person is told an export did, in the dialog and in its toast. */
export function exportMessage(outcome: Extract<SaveOutcome, { kind: 'saved' }>, fileName: string): string {
  if (outcome.copy) {
    if (!outcome.copy.unsaved) return 'Exported a copy.';
    return outcome.copy.of === null
      ? 'Exported a copy. Your last changes have not gone back to FormLogic.'
      : `Exported a copy. ${outcome.copy.of} has not been saved since your last changes.`;
  }
  const written = outcome.handle?.name ?? fileName;
  if (outcome.projectChanged) return `Exported ${written}: the project that was open when the export began, not this one.`;
  if (outcome.stale) return `Exported ${written}: an earlier revision. Edits made during the export are not in it; export or save again.`;
  return `Exported ${written}. Your project is saved in it.`;
}

/**
 * The recovery record now holds this revision of this project, written by
 * something other than a save: the copy kept of unsaved work. A save that
 * captured an earlier revision and finishes after it must not put that
 * earlier revision back over it, which is the promise at the head of this
 * file and was kept only between two saves.
 */
export function notePersistedRevision(projectId: string, revision: number): void {
  if ((persisted.get(projectId) ?? -1) < revision) persisted.set(projectId, revision);
}

/** The newest revision of the project whose record is in the store, as far as this page knows; -1 for none. */
export function persistedRevision(projectId: string): number {
  return persisted.get(projectId) ?? -1;
}

/** For tests: forget which revisions were persisted. */
export function resetPersistedRevisions(): void {
  persisted.clear();
}

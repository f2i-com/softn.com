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
 */

import { useProjectStore } from '../stores/projectStore';
import { useFilesStore } from '../stores/filesStore';
import { saveBundleToFile } from './bundleExporter';
import { buildProjectBundle, bundleFileName, flushCanvasToActiveFile } from './buildProjectBundle';
import { captureSession, SESSION_STORAGE_KEY, type BuilderSession, type ViewMode } from './openProject';

export type SaveOutcome =
  | {
      kind: 'saved';
      projectId: string;
      revision: number;
      handle: FileSystemFileHandle | null;
      /** True when the project moved on during the write: the file holds an earlier revision. */
      stale: boolean;
      /** True when the project itself was replaced during the write. */
      projectChanged: boolean;
      /** Whether the recovery record was stored; the error when it could not be. */
      sessionStored: boolean;
      sessionError?: unknown;
    }
  | { kind: 'cancelled' }
  | { kind: 'failed'; error: unknown };

export interface SaveDeps {
  /** The current view, kept in the recovery record. */
  view: ViewMode;
  existingHandle: FileSystemFileHandle | null;
  writeFile?: typeof saveBundleToFile;
  storage?: Pick<Storage, 'setItem'>;
  build?: () => Promise<Uint8Array>;
  capture?: (view: ViewMode) => BuilderSession;
}

/** The newest revision whose recovery record was stored, per project, this page. */
const persisted = new Map<string, number>();

export async function saveProject(deps: SaveDeps): Promise<SaveOutcome> {
  const writeFile = deps.writeFile ?? saveBundleToFile;
  const build = deps.build ?? buildProjectBundle;
  const capture = deps.capture ?? captureSession;

  // The flush may be an edit (it marks the file dirty when the canvas moved),
  // so it comes before the revision is read.
  let projectId: string;
  let revision: number;
  let name: string;
  let session: BuilderSession;
  let bundlePromise: Promise<Uint8Array>;
  try {
    flushCanvasToActiveFile();
    ({ projectId, revision, name } = useProjectStore.getState());
    session = capture(deps.view);
    bundlePromise = build();
  } catch (error) {
    // Invalid or unserializable project state is a reported save failure,
    // just like a failed file write; it must not escape the UI handler.
    return { kind: 'failed', error };
  }

  let bytes: Uint8Array;
  let handle: FileSystemFileHandle | null;
  try {
    bytes = await bundlePromise;
    handle = await writeFile(bytes, bundleFileName(name).replace(/\.softn$/, ''), deps.existingHandle);
  } catch (e) {
    // User cancelling the file picker throws an AbortError — quiet.
    if (e instanceof DOMException && e.name === 'AbortError') return { kind: 'cancelled' };
    if (e instanceof Error && e.name === 'AbortError') return { kind: 'cancelled' };
    return { kind: 'failed', error: e };
  }

  const cleaned = useProjectStore.getState().markCleanIf(projectId, revision);
  if (cleaned) {
    const files = useFilesStore.getState();
    for (const [id, node] of files.nodes) {
      if (node.type === 'file' && node.isDirty) files.markFileDirty(id, false);
    }
  }
  const projectChanged = useProjectStore.getState().projectId !== projectId;

  // The recovery record: of the revision on disk, for that project only, and
  // never over a newer one. Losing it does not affect the file just written.
  let sessionStored = false;
  let sessionError: unknown;
  if (!projectChanged && (persisted.get(projectId) ?? -1) <= revision) {
    try {
      const storage = deps.storage ?? window.localStorage;
      storage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
      persisted.set(projectId, revision);
      sessionStored = true;
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
  };
}

/** For tests: forget which revisions were persisted. */
export function resetPersistedRevisions(): void {
  persisted.clear();
}

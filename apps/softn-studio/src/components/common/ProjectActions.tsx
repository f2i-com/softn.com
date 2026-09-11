import { useCallback, useState } from 'react';
import { useWorkspaceStore, useVFSStore } from '../../stores';
import { exportAsBundle } from '../../lib/exportBundle';
import { prepareHandoff, type HandoffDestination, type ReadyHandoff } from '../../lib/handoff';

/**
 * The project's three ways out — Run, Publish, Export bundle — as one hook,
 * so the desktop bar and the mobile menu are the same actions with the same
 * rules rather than two copies that drift.
 *
 * The vocabulary is shared across SoftN: *Preview* is the canvas, *Run* is
 * the bundle in the runtime, *Save project* is this browser's storage,
 * *Export bundle* is a .softn file on disk, *Publish* is the directory.
 *
 * Run and Publish wait while the validator holds an error the directory
 * would refuse the bundle for. Export never waits: a file on disk can be
 * looked at, and it is the way out when storage has failed or a bundle
 * cannot be staged. It builds from the files in memory and touches no
 * storage, so it works after every kind of save failure.
 */
export interface ProjectActions {
  projectName: string;
  hasFiles: boolean;
  fileCount: number;
  /** Validator errors at level `error`. */
  problemCount: number;
  /** An error the directory would refuse the bundle for: Run and Publish wait. */
  refused: boolean;
  preparing: HandoffDestination | null;
  ready: ReadyHandoff | null;
  canRun: boolean;
  canPublish: boolean;
  canExport: boolean;
  run(): void;
  publish(): void;
  exportBundle(): void;
  dismissReady(): void;
  /** The title for a Run/Publish control in its current state. */
  describe(to: HandoffDestination, idle: string): string;
}

/** Build and download the in-memory project. Storage is not involved. */
export function exportCurrentProject(): { ok: true } | { ok: false; message: string } {
  const files = useVFSStore.getState().files;
  const projectName = useWorkspaceStore.getState().projectName;
  const log = useWorkspaceStore.getState().addConsoleOutput;
  if (files.size === 0) return { ok: false, message: 'There are no files to export.' };
  try {
    exportAsBundle(files, projectName);
    log(`Exported ${files.size} files as ${projectName || 'app'}.softn`);
    return { ok: true };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log(`Export failed: ${message}`);
    return { ok: false, message };
  }
}

export function useProjectActions(): ProjectActions {
  const { projectName, errors } = useWorkspaceStore();
  const { files } = useVFSStore();
  const hasFiles = files.size > 0;
  const refused = errors.some((e) => e.level === 'error' && e.type === 'bundle-refused');
  const problemCount = errors.filter((e) => e.level === 'error').length;
  const [preparing, setPreparing] = useState<HandoffDestination | null>(null);
  const [ready, setReady] = useState<ReadyHandoff | null>(null);

  /**
   * Stage the bundle for the runtime or the publish page, then offer the
   * link. The editor stays where it is: the opening is the person's own
   * click on that link, in a new tab or — if they choose — this one. See
   * lib/handoff.ts for why it is not a window.open here.
   */
  const handOff = useCallback(
    async (to: HandoffDestination) => {
      if (!hasFiles || refused || preparing) return;
      const log = useWorkspaceStore.getState().addConsoleOutput;
      setReady(null);
      setPreparing(to);
      try {
        const outcome = await prepareHandoff(to, files, projectName);
        if (!outcome.ok) {
          log(outcome.message);
          return;
        }
        setReady(outcome.ready);
        log(to === 'runtime' ? 'The bundle is staged for the runtime. Open it from the link in the bar.' : 'The bundle is staged for the publish page. Open it from the link in the bar.');
      } catch (err: unknown) {
        log(`Hand-off failed: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        setPreparing(null);
      }
    },
    [files, hasFiles, preparing, projectName, refused],
  );

  const describe = useCallback(
    (to: HandoffDestination, idle: string) => (preparing === to ? 'Preparing the bundle…' : refused ? 'Fix what the validator found first' : hasFiles ? idle : 'No files'),
    [hasFiles, preparing, refused],
  );

  return {
    projectName,
    hasFiles,
    fileCount: files.size,
    problemCount,
    refused,
    preparing,
    ready,
    canRun: hasFiles && !refused && preparing === null,
    canPublish: hasFiles && !refused && preparing === null,
    canExport: hasFiles,
    run: () => void handOff('runtime'),
    publish: () => void handOff('publish'),
    exportBundle: () => void exportCurrentProject(),
    dismissReady: () => setReady(null),
    describe,
  };
}

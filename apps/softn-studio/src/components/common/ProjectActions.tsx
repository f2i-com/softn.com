import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
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
  error: string | null;
  canRun: boolean;
  canPublish: boolean;
  canExport: boolean;
  run(): void;
  publish(): void;
  exportBundle(): void;
  dismissReady(): void;
  dismissError(): void;
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
  const { projectId, projectName, errors } = useWorkspaceStore();
  const { files } = useVFSStore();
  const hasFiles = files.size > 0;
  const refused = errors.some((e) => e.level === 'error' && e.type === 'bundle-refused');
  const problemCount = errors.filter((e) => e.level === 'error').length;
  const scope = useMemo(() => ({ projectId, projectName, files }), [projectId, projectName, files]);
  const activeScope = useRef<typeof scope | null>(scope);
  const pending = useRef<object | null>(null);
  const [state, setState] = useState<{
    scope: typeof scope;
    preparing: HandoffDestination | null;
    ready: ReadyHandoff | null;
    error: string | null;
  }>({ scope, preparing: null, ready: null, error: null });

  // A staged bundle belongs to the exact files/name it was built from. Reset
  // before paint so an edit never leaves a clickable link to an older copy.
  useLayoutEffect(() => {
    activeScope.current = scope;
    pending.current = null;
    setState({ scope, preparing: null, ready: null, error: null });
    return () => {
      activeScope.current = null;
      pending.current = null;
    };
  }, [scope]);

  const { preparing, ready, error } = state.scope === scope
    ? state
    : { preparing: null, ready: null, error: null };

  /**
   * Stage the bundle for the runtime or the publish page, then offer the
   * link. The editor stays where it is: the opening is the person's own
   * click on that link, in a new tab or — if they choose — this one. See
   * lib/handoff.ts for why it is not a window.open here.
   */
  const handOff = useCallback(
    async (to: HandoffDestination) => {
      if (!hasFiles || refused || pending.current || activeScope.current !== scope) return;
      const request = {};
      pending.current = request;
      const isCurrent = () => {
        const workspace = useWorkspaceStore.getState();
        return pending.current === request && activeScope.current === scope
          && workspace.projectId === scope.projectId && workspace.projectName === scope.projectName
          && useVFSStore.getState().files === scope.files;
      };
      const log = useWorkspaceStore.getState().addConsoleOutput;
      setState({ scope, preparing: to, ready: null, error: null });
      try {
        const outcome = await prepareHandoff(to, files, projectName);
        if (!isCurrent()) return;
        if (!outcome.ok) {
          setState({ scope, preparing: null, ready: null, error: outcome.message });
          log(outcome.message);
          return;
        }
        setState({ scope, preparing: null, ready: outcome.ready, error: null });
        log(to === 'runtime' ? 'The bundle is staged for the runtime. Open it from the link in the bar.' : 'The bundle is staged for the publish page. Open it from the link in the bar.');
      } catch (err: unknown) {
        if (!isCurrent()) return;
        const message = `Could not prepare the bundle: ${err instanceof Error ? err.message : String(err)}`;
        setState({ scope, preparing: null, ready: null, error: message });
        log(message);
      } finally {
        if (pending.current === request) pending.current = null;
      }
    },
    [files, hasFiles, projectName, refused, scope],
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
    error,
    canRun: hasFiles && !refused && preparing === null,
    canPublish: hasFiles && !refused && preparing === null,
    canExport: hasFiles,
    run: () => void handOff('runtime'),
    publish: () => void handOff('publish'),
    exportBundle: () => {
      const outcome = exportCurrentProject();
      setState((current) => ({ ...current, error: outcome.ok ? null : `Could not export the bundle: ${outcome.message}` }));
    },
    dismissReady: () => setState((current) => ({ ...current, ready: null })),
    dismissError: () => setState((current) => ({ ...current, error: null })),
    describe,
  };
}

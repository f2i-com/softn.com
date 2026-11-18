/**
 * SoftN Builder - Main Application
 */

import React, { lazy, Suspense, useState, useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { ProductBar } from '@softn/brand';
import type { StarterFile } from '@softn/editor-shared/webStarters';
import { StatusBar } from './components/StatusBar';
import { AssetView } from './components/files/AssetView';
import { Sheet } from './components/Sheet';
import { Toolbar } from './components/toolbar/Toolbar';
import { ExportDialog } from './components/toolbar/ExportDialog';
import { ShortcutsDialog } from './components/toolbar/ShortcutsDialog';
import { NewProjectDialog, type NewProjectConfig } from './components/toolbar/NewProjectDialog';
import { LogicEditor } from './components/editor/LogicEditor';
import { SourceView } from './components/editor/SourceView';
import { LivePreview } from './components/preview/LivePreview';
import { ensureUiRuntimeRegistered } from './utils/uiRuntimeLoader';
import { FileNavigator, FileTabs } from './components/files';
import { useCanvasStore } from './stores/canvasStore';
import { useProjectStore } from './stores/projectStore';
import { useFilesStore } from './stores/filesStore';
import { openBundleFile, loadBundle } from './utils/bundleLoader';
import {
  commitProjectSnapshot,
  openRemoteBundle,
  prepareProjectSnapshot,
  prepareSessionSnapshot,
  noteOpenedFromLink,
  noteRestoreOffered,
  takeOpenedFromLink,
  SESSION_STORAGE_KEY,
  setAsideUnrestored,
  restoredFromStore,
  type ProjectSnapshot,
  type ViewMode,
} from './utils/openProject';
import { saveProject, saveToHost, sessionNotes } from './utils/saveProject';
import { PRODUCT_URLS } from './utils/siteUrls';
import { forgetDesktopFile, isDesktop, openCompanionUrl, takeOpenedDesktopFile, type BundleFileHandle } from './utils/desktop';
import { ConfirmDialog } from './components/feedback/ConfirmDialog';
import { askConfirm, useConfirmStore } from './utils/confirm';
import { PwaUpdater } from './components/feedback/PwaUpdater';
import { toast } from './stores/notificationStore';
import { debug } from './utils/debug';
import { useProjectStartup } from './hooks/useProjectStartup';
import { startFromStudio } from './utils/studioVisit';
import { StudioOrigin } from './components/toolbar/StudioOrigin';
import { useUnsavedChanges } from './hooks/useUnsavedChanges';
import { useRecoveryCopy } from './hooks/useRecoveryCopy';
import { recoveryOf, restoreOffer } from './utils/recoveryCopy';
import { SESSION_ASSETS_KEY, joinStoredSession } from './utils/storedAssets';
import { readLocalStorage } from './utils/safeStorage';
import { useExclusiveAction } from './hooks/useExclusiveAction';
import { useWorkspaceShortcuts } from './hooks/useWorkspaceShortcuts';
import { useActiveFileOnCanvas } from './hooks/useActiveFileOnCanvas';
import { PANEL_WIDTHS, canvasWidthWith, useWorkspaceLayout, type PanelId } from './hooks/usePanelsThatFit';
import { flushCanvasToActiveFile, buildProjectBundle } from './utils/buildProjectBundle';
import { connectHostedEditor, isHostedEditor } from '@softn/editor-shared/hostedEditor';
import { useHostedSaveLabel } from '@softn/editor-shared/useHostedSaveLabel';
import { useCompilerOfflineNotice } from '@softn/editor-shared/useCompilerOfflineNotice';
import { pageInHand, viewsFor } from './utils/workspaceViews';
import { startNewProject } from './utils/newProject';
import { keepSavedPoint, markUnsaved } from './utils/savedPoint';

// The data designer and its diagram library (@xyflow with d3, about 160 KB)
// load the first time the Data view opens, not with the editor.
const DatabaseWorkspace = lazy(() => import('./components/schema/DatabaseWorkspace'));
// Visual `.ui` canvas and palette panels load only when editing a `.ui` project.
const Canvas = lazy(() => import('./components/canvas/Canvas').then((m) => ({ default: m.Canvas })));
const ComponentPalette = lazy(() => import('./components/panels/ComponentPalette').then((m) => ({ default: m.ComponentPalette })));
const PropertyPanel = lazy(() => import('./components/panels/PropertyPanel').then((m) => ({ default: m.PropertyPanel })));
const TreeView = lazy(() => import('./components/panels/TreeView').then((m) => ({ default: m.TreeView })));
const DataPanel = lazy(() => import('./components/panels/DataPanel').then((m) => ({ default: m.DataPanel })));

const styles: Record<string, React.CSSProperties> = {
  app: {
    height: '100dvh',
    display: 'flex',
    flexDirection: 'column',
    background: 'var(--ink)',
    color: 'var(--paper)',
  },
  // Everything but the status bar, the bar of panels and the dialogs: what goes inert behind a dialog or a sheet.
  shell: {
    flex: 1,
    minHeight: 0,
    display: 'flex',
    flexDirection: 'column',
  },
  main: {
    flex: 1,
    display: 'flex',
    overflow: 'hidden',
    minHeight: 0, // Important for flex scroll
    gap: 8,
    padding: 8,
    background: 'var(--ink)',
  },
  // On a phone the canvas has the screen to its edges: no frame, no gap.
  mainSheets: {
    flex: 1,
    display: 'flex',
    overflow: 'hidden',
    minHeight: 0,
    background: 'var(--ink)',
  },
  centerWithTabs: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
    minWidth: 0, // Allow flex shrinking
    border: '1px solid var(--line-soft)',
    borderRadius: 10,
    background: 'var(--ink-2)',
  },
  centerTop: {
    flex: 1,
    overflow: 'auto',
    minHeight: 0, // Important for flex scroll
  },
  centerBottom: {
    height: 250,
    flexShrink: 0,
    borderTop: '1px solid var(--line-soft)',
    overflow: 'hidden',
    background: 'var(--ink-2)',
    display: 'flex',
    flexDirection: 'column',
  },
  rightPanelTop: {
    flex: 1,
    minHeight: 0,
    overflow: 'hidden',
  },
  // The hierarchy and the app's data, under Properties: each folds to its
  // heading, and together they never take more than this of the column.
  rightPanelBottom: {
    flexShrink: 0,
    maxHeight: '42%',
    overflow: 'auto',
  },
  designShell: {
    flex: 1,
    minHeight: 0,
    display: 'flex',
    flexDirection: 'column',
  },
  logicDockHeader: {
    height: 34,
    flexShrink: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '0 10px',
    borderBottom: '1px solid var(--line-soft)',
    background: 'var(--ink)',
  },
  // Peer of Files, Components and Properties, so it is set like them.
  logicDockTitle: {
    fontFamily: 'var(--display)',
    fontSize: 14,
    color: 'var(--paper)',
    letterSpacing: '-0.01em',
    fontWeight: 600,
  },
  emptyFileState: {
    height: '100%',
    padding: 20,
    color: 'var(--dim)',
  },
  emptyFileTitle: {
    fontFamily: 'var(--display)',
    fontSize: 15,
    fontWeight: 700,
    letterSpacing: '-0.02em',
    color: 'var(--paper)',
    marginBottom: 4,
  },
  emptyFileHint: {
    fontSize: 13,
    color: 'var(--dim)',
  },
};

/** The panels a phone opens as sheets, in the order of the bar they are opened from. */
type SheetName = 'components' | 'properties' | 'hierarchy' | 'files' | 'logic';

/** The least the canvas keeps beside the app running next to it: a phone's width. */
const CANVAS_BESIDE_PREVIEW = 360;
/** The narrowest the pane of the running app is drawn (builder.css, .bl-split). */
const PREVIEW_PANE_MIN = 300;
/**
 * The logic dock starts open where the window is tall enough to leave the
 * canvas the better part of it: at 900 pixels tall it took 250 of the 720
 * the canvas had, in an editor a person opens to lay a page out.
 */
const LOGIC_OPEN_FROM = 960;

const INERT = { inert: '' } as unknown as React.HTMLAttributes<HTMLElement>;

const DOCK: { name: SheetName; label: string; icon: React.ReactNode }[] = [
  { name: 'components', label: 'Components', icon: <path d="M2.5 2.5h4.5v4.5H2.5zM9 2.5h4.5v4.5H9zM2.5 9h4.5v4.5H2.5zM11.25 9v4.5M9 11.25h4.5" /> },
  { name: 'properties', label: 'Properties', icon: <path d="M2 4.5h7M12 4.5h2M2 11.5h2M7 11.5h7M10.5 3v3M5.5 10v3" /> },
  { name: 'hierarchy', label: 'Hierarchy', icon: <path d="M2.5 3h6M5.5 8h8M5.5 13h8M3.5 3v10" /> },
  { name: 'files', label: 'Files', icon: <path d="M14 12.5a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1h3.5L8 4.5h5a1 1 0 0 1 1 1z" /> },
  { name: 'logic', label: 'Logic', icon: <path d="M5.5 4 2 8l3.5 4M10.5 4 14 8l-3.5 4" /> },
];

/** The window's width, kept as it changes: what the pane beside the canvas is fitted by. */
function useWindowWidth(): number {
  const [width, setWidth] = useState(() => window.innerWidth);
  useEffect(() => {
    const check = () => setWidth(window.innerWidth);
    check();
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  }, []);
  return width;
}

/**
 * What opening a project warned of, where the person can read it: the toast
 * shows the warnings behind "Show all". They went to the console alone, and
 * "Opened with 39 warning(s)" said nothing anybody could act on.
 */
function sayOpenedWithWarnings(warnings: readonly string[]): void {
  if (warnings.length === 0) return;
  console.warn('[App] Opened with warnings:', warnings);
  toast.warning(`Opened with ${warnings.length} ${warnings.length === 1 ? 'warning' : 'warnings'}`, [...warnings]);
}

function App() {
  useCompilerOfflineNotice('builder', toast.success);
  useUnsavedChanges();
  const hostSaveLabel = useHostedSaveLabel();
  const [view, setView] = useState<ViewMode>('design');
  // Unsaved work is kept as it is made, for the next open to offer back. A
  // draft edited inside FormLogic is kept there, and has no copy here.
  useRecoveryCopy(view, !isHostedEditor());
  // The canvas keeps the room a page needs, and the panels share what is over:
  // all three beside it in a wide window, one of them at a time in a narrow
  // one, and on a phone none, each a sheet opened over the canvas
  // (hooks/usePanelsThatFit.ts).
  const { mode: layoutMode, open: panelOpen, setOpen: setPanelOpen } = useWorkspaceLayout();
  // A web project has one sidebar. The canvas's three-panel fitting rules apply to .ui projects.
  const [webFilesOpen, setWebFilesOpen] = useState(true);
  const sheets = layoutMode === 'sheets';
  const [sheet, setSheet] = useState<SheetName | null>(null);
  const webFilesButton = useRef<HTMLButtonElement>(null);
  const closeSheet = useCallback(() => {
    setSheet(null);
    // This button is inside the inert workspace. Restore it after the dialog has closed.
    if (webFilesButton.current) requestAnimationFrame(() => webFilesButton.current?.focus());
  }, []);
  // A window that has widened has its panels beside the canvas again.
  useEffect(() => {
    if (!sheets) setSheet(null);
  }, [sheets]);
  const windowWidth = useWindowWidth();
  // From the empty page's own sentence: the panel opens with the focus in
  // its search, which is where a component is looked for. Not on a phone,
  // where the focus would bring the keyboard up over the list.
  const showComponents = useCallback(() => {
    if (sheets) {
      setSheet('components');
      return;
    }
    setPanelOpen('components', true);
    requestAnimationFrame(() => document.querySelector<HTMLElement>('[aria-label="Search components"]')?.focus());
  }, [sheets, setPanelOpen]);
  const [dockLogic, setDockLogic] = useState(() => window.innerHeight >= LOGIC_OPEN_FROM);
  // The app running beside the canvas, in Design (components/preview/LivePreview.tsx).
  const [besidePreview, setBesidePreview] = useState(false);
  const [foldHierarchy, setFoldHierarchy] = useState(false);
  const [foldData, setFoldData] = useState(true);
  const [showExportDialog, setShowExportDialog] = useState(false);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [showNewProjectDialog, setShowNewProjectDialog] = useState(false);

  const fileHandleRef = useRef<BundleFileHandle | null>(null);
  /**
   * The remote open in flight, if any. Aborted by every action that replaces
   * the workspace, and on unmount; the generation check in openRemoteBundle
   * is what holds even when a fetch ignores the signal.
   */
  const remoteOpenRef = useRef<AbortController | null>(null);
  /** The part of the page that goes inert behind the export dialog. */
  const shellRef = useRef<HTMLDivElement | null>(null);

  const openShortcuts = useCallback(() => setShowShortcuts(true), []);
  const creatingFromGeneration = useRef(0);
  const handleCreateNewProject = useCallback((config: NewProjectConfig, starterFiles?: StarterFile[]) => {
    if (useProjectStore.getState().workspaceGeneration !== creatingFromGeneration.current) {
      throw new Error('The open project changed. Close this dialog and choose New again.');
    }
    startNewProject(config, starterFiles);
    fileHandleRef.current = null;
    forgetDesktopFile();
    remoteOpenRef.current?.abort();
    setView(starterFiles ? 'preview' : 'design');
    setShowNewProjectDialog(false);
    toast.success(`Created ${config.name}`);
  }, []);

  const handleNew = useCallback(async () => {
    if (useProjectStore.getState().isDirty && !(await askConfirm('Create a new project? Unsaved changes will be lost.', {
      title: 'Unsaved changes', confirmLabel: 'Discard and create new', danger: true,
    }))) {
      return;
    }
    creatingFromGeneration.current = useProjectStore.getState().workspaceGeneration;
    setShowNewProjectDialog(true);
  }, []);

  /**
   * Put a validated candidate in the workspace, replacing whatever is there.
   * The file picker, a `?open=` link and the session restore all end here.
   * Asking about unsaved work is the caller's. Everything the candidate
   * needs was decoded and checked before this is called (utils/openProject.ts);
   * the commit itself puts every store back if any step fails.
   */
  const applySnapshot = useCallback((snapshot: ProjectSnapshot) => {
    remoteOpenRef.current?.abort();
    fileHandleRef.current = null;
    commitProjectSnapshot(snapshot);
    setView(snapshot.view);

    sayOpenedWithWarnings(snapshot.warnings);
    toast.success(snapshot.origin === 'session' ? 'Restored previous local session' : `Opened: ${snapshot.label}`);
    debug(`[App] Opened: ${snapshot.label}`);
  }, []);

  const handleOpen = useCallback(async () => {
    try {
      // The picker first, then the question: a cancelled picker asks nothing.
      const bundle = await openBundleFile();
      if (!bundle) return;
      // Decoded and checked before the question, so a bundle that cannot be
      // opened never costs the current project a confirmation.
      const snapshot = prepareProjectSnapshot(bundle);
      if (useProjectStore.getState().isDirty) {
        const generation = useProjectStore.getState().workspaceGeneration;
        if (!(await askConfirm('Open a new project? Unsaved changes will be lost.', {
          title: 'Unsaved changes', confirmLabel: 'Discard and open', danger: true,
        }))) return;
        // The answer is for the project it was asked about.
        if (useProjectStore.getState().workspaceGeneration !== generation) return;
      }
      // On the desktop the file it came from becomes the one Save writes,
      // and the one before it cannot be written, before its code can run.
      if (bundle.sourceHandle) await takeOpenedDesktopFile(bundle.sourceHandle);
      applySnapshot(snapshot);
      fileHandleRef.current = bundle.sourceHandle ?? null;
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return;
      console.error('[App] Failed to open file:', e);
      toast.error(`Failed to open file: ${e instanceof Error ? e.message : 'Unknown error'}`);
    }
  }, [applySnapshot]);

  /**
   * What the page does first: a `?open=` link, or the offer to restore the
   * last locally saved session. One decision, made once, in
   * utils/openProject.ts (startupAction): the link wins, and the session
   * stays stored for a plain launch.
   *
   * The remote open is bound to the workspace generation it started in and
   * aborted by anything that replaces the workspace, so a slow response
   * cannot land on a project opened or edited in the meantime.
   */
  const applySnapshotRef = useRef(applySnapshot);
  applySnapshotRef.current = applySnapshot;
  useEffect(() => connectHostedEditor({
    open: async (bytes, _name, { preview }) => {
      const snapshot = prepareProjectSnapshot(await loadBundle(bytes));
      applySnapshotRef.current(preview ? { ...snapshot, view: 'preview' } : snapshot);
    },
    export: buildProjectBundle,
  }, { projectZip: true }), []);
  // The project the page starts with is in no file and has nothing to lose:
  // an edit undone in it leaves it as clean as it was. Opening or restoring
  // a project holds it against what that project was kept as instead.
  useEffect(() => {
    const project = useProjectStore.getState();
    if (project.revision === 0 && !project.isDirty && project.isAsKept === null) keepSavedPoint();
  }, []);
  useProjectStartup(function start(action): void | (() => void) {
    if (action.kind === 'nothing') return;
    if (action.kind === 'from-studio') {
      // A project Studio handed over, a reload of the tab that was on one, or a stored session one
      // left (utils/studioVisit.ts). While that is found out, whatever session the store holds is
      // not to be written over: said as it is for a session that is being offered back.
      if (readLocalStorage(SESSION_STORAGE_KEY) !== null) noteRestoreOffered();
      void startFromStudio(action, { apply: (snapshot) => applySnapshotRef.current(snapshot) }).then((arrival) => {
        if (arrival.kind !== 'none' && arrival.kind !== 'failed') return;
        // Nothing of Studio's to open after all (the line over the toolbar says why, when there
        // is a why): the start any other page makes, with its own word about the stored session.
        takeOpenedFromLink();
        start(action.otherwise);
      });
      return;
    }
    if (action.kind === 'refused-link') {
      // A link wins over the restore offer, so a stored session was not offered: as after "Not now",
      // it is set aside before the empty project's first change is written over it.
      noteRestoreOffered();
      toast.error(action.message);
      return;
    }

    if (action.kind === 'restore-prompt') {
      // The session's text, with the project's assets put back into it from their own record.
      const assetsRaw = readLocalStorage(SESSION_ASSETS_KEY);
      let joined: ReturnType<typeof joinStoredSession>;
      let snapshot: ProjectSnapshot;
      try {
        // (inside the catch too: a session this Builder cannot read must not stop it starting)
        joined = joinStoredSession(action.raw, assetsRaw);
        snapshot = prepareSessionSnapshot(joined.raw);
      } catch (e) {
        // Kept, with the reason, not deleted: it may be the only copy.
        console.error('[App] The saved session could not be restored:', e);
        toast.error(`The saved session could not be restored. ${setAsideUnrestored(action.raw, e, assetsRaw)}`);
        return;
      }
      // A copy of unsaved work says so, and what of the project is not in it (utils/recoveryCopy.ts).
      // Asked in the Builder's own dialog, which may mount after this runs; the
      // answer is for the workspace it was asked about.
      const generation = useProjectStore.getState().workspaceGeneration;
      // Until it is restored, what is stored is set aside before anything is written over it:
      // "Not now", or a change made before the question is answered (utils/openProject.ts).
      noteRestoreOffered();
      void askConfirm(restoreOffer(action.raw, joined.assets), { title: 'Restore your work?', confirmLabel: 'Restore', cancelLabel: 'Not now' }).then((yes) => {
        if (!yes || useProjectStore.getState().workspaceGeneration !== generation) return;
        try {
          applySnapshotRef.current(snapshot);
          // Restored: it is this tab's work now, and the next write is its copy, unless another
          // tab has kept its own there since the offer was made (that is set aside first).
          restoredFromStore(action.raw);
          // It was not saved when it was kept, and is not now: it says "Unsaved",
          // leaving asks first, and undoing an edit does not make it saved.
          if (recoveryOf(action.raw)) markUnsaved();
        } catch (e) {
          console.error('[App] Failed to restore session:', e);
          toast.error(`Could not restore the session: ${e instanceof Error ? e.message : String(e)}. ${setAsideUnrestored(action.raw, e, assetsRaw)}`);
        }
      });
      return;
    }

    const controller = new AbortController();
    remoteOpenRef.current = controller;
    const { url } = action;
    // Said before the link is loaded: one that fails or is declined leaves an empty project, whose
    // first change, like one made while it loads, must not write over the session it found.
    noteOpenedFromLink();
    void openRemoteBundle(url, controller.signal).then((outcome) => {
      if (remoteOpenRef.current === controller) remoteOpenRef.current = null;
      if (outcome.kind === 'opened') {
        fileHandleRef.current = null;
        // A starter linked from the site opens on its running preview (`&view=preview`).
        setView(action.view ?? outcome.snapshot.view);
        sayOpenedWithWarnings(outcome.snapshot.warnings);
        toast.success(`Opened: ${outcome.snapshot.label}`);
      } else if (outcome.kind === 'failed') {
        const e = outcome.error;
        toast.error(`Could not open ${url.pathname}: ${e instanceof Error ? e.message : String(e)}`);
      }
      // superseded: quiet — the workspace moved on; declined: the person said no.
    });
    return () => controller.abort();
  });

  const saveCurrentProject = useCallback(async () => {
    // Hosted in FormLogic (audit SN-04): saved once FormLogic says it took the draft (utils/saveProject.ts).
    const hosted = await saveToHost();
    if (hosted.kind === 'saved') {
      toast.success('Your changes are back in FormLogic.');
      return;
    }
    if (hosted.kind === 'failed') {
      toast.error(hosted.error);
      return;
    }
    if (hosted.kind === 'disconnected') {
      toast.error('FormLogic is not connected. Your changes stay in the editor; try again in a moment.');
      return;
    }
    const outcome = await saveProject({ view, existingHandle: fileHandleRef.current });
    if (outcome.kind === 'cancelled') return;
    if (outcome.kind === 'failed') {
      console.error('[App] Failed to save:', outcome.error);
      toast.error(`Save failed: ${outcome.error instanceof Error ? outcome.error.message : 'Unknown error'}`);
      return;
    }
    // The handle is this project's; a project opened meanwhile must not
    // inherit it and overwrite the file with its own next save.
    if (!outcome.projectChanged) fileHandleRef.current = outcome.handle;
    const where = outcome.handle ? `Saved: ${outcome.handle.name}` : 'Bundle downloaded';
    if (outcome.projectChanged) {
      toast.warning(`${where} — the project that was open when the save began, not this one.`);
    } else if (outcome.stale) {
      toast.warning(`${where} — an earlier revision. Edits made during the save are not in it; save again.`);
    } else {
      toast.success(where);
    }
    if (outcome.sessionAssets === 'left-out' && !outcome.projectChanged) {
      toast.info('The local recovery copy was kept without the project’s pictures and other assets (this browser’s storage is full); the file itself was saved.');
    }
    for (const note of sessionNotes(outcome)) toast.info(note);
    // A newer copy of the work is already kept, or another project's unsaved work was left where it is: nothing
    // went wrong, and nothing more is said.
    if (!outcome.sessionStored && !outcome.projectChanged && !outcome.sessionSuperseded && !outcome.sessionHeld) {
      // The file is written; only the local recovery copy is missing.
      console.warn('[App] Could not store session for restore:', outcome.sessionError);
      toast.info('The local recovery copy could not be stored (storage full or blocked); the file itself was saved.');
    }
    debug('[App] Bundle saved to file');
  }, [view]);

  // Export, by the rule a save goes by. Whether it is the project's save or
  // a copy of it depends on where the project is kept, which is known here:
  // the file it was opened from or last saved to, or FormLogic.
  const exportCurrentProject = useCallback(async () => {
    const outcome = await saveProject({ as: 'export', view, existingHandle: fileHandleRef.current, hosted: isHostedEditor() });
    // An export that was the project's save, written by the desktop to a
    // place of its own, is where the next Save goes. As for a save: not for
    // a project opened while it was being written.
    if (outcome.kind === 'saved' && !outcome.copy && !outcome.projectChanged) fileHandleRef.current = outcome.handle;
    return outcome;
  }, [view]);

  const { run: handleSave, isPending: isSaving } = useExclusiveAction(saveCurrentProject);
  const changeView = useCallback((next: ViewMode) => {
    flushCanvasToActiveFile();
    setSheet(null);
    setView(next);
  }, []);
  const confirmOpen = useConfirmStore((state) => state.queue.length > 0);
  const modalOpen = showExportDialog || showNewProjectDialog || showShortcuts || confirmOpen;

  const handleExport = useCallback(() => {
    setShowExportDialog(true);
  }, []);

  // The page behind an open dialog is inert while it is open: `inert`
  // removes it from Tab order and the accessibility tree where supported,
  // aria-hidden covers the rest. The dialog itself is a sibling, outside.
  // A layout effect, not a passive one: the dialog's cleanup refocuses the
  // button that opened it, and React runs that cleanup before a passive
  // effect here would have cleared `inert` — so the focus request landed on
  // an element still inside an inert subtree and was dropped on the body.
  // A sheet is a dialog in this: the page under it is out of reach too.
  const behindSomething = modalOpen || sheet !== null;
  useLayoutEffect(() => {
    const shell = shellRef.current;
    if (!shell) return;
    shell.toggleAttribute('inert', behindSomething);
    if (behindSomething) shell.setAttribute('aria-hidden', 'true');
    else shell.removeAttribute('aria-hidden');
  }, [behindSomething]);

  // Sync active file with canvas when file selection changes
  const projectFormat = useProjectStore((state) => state.projectFormat);
  const webProject = projectFormat === 'web';
  const filesOpen = webProject ? webFilesOpen : panelOpen.files;
  const showFiles = (open: boolean) => {
    if (webProject) setWebFilesOpen(open);
    else setPanelOpen('files', open);
  };
  useEffect(() => {
    if (projectFormat !== 'web') {
      void ensureUiRuntimeRegistered().catch(() => toast.error('Classic components are unavailable. Reconnect and reopen the app to load them.'));
    }
  }, [projectFormat]);
  const activeFileId = useFilesStore((state) => state.activeFileId);
  const fileNodes = useFilesStore((state) => state.nodes);
  const activeNode = activeFileId ? fileNodes.get(activeFileId) : null;
  const activeFileType = activeNode?.fileType ?? null;

  const pageHeld = useCanvasStore((state) => state.pageId !== null);
  const somethingSelected = useCanvasStore((state) => state.selectedIds.length > 0);

  useWorkspaceShortcuts({
    // The editor is offered at every width now; nothing is held back as "narrow".
    blocked: behindSomething, narrow: false, save: handleSave, open: handleOpen,
    create: handleNew, export: handleExport, shortcuts: () => setShowShortcuts(true),
    changeView, canvas: pageInHand(view, activeFileType, pageHeld),
  });
  const isLogicFileActive = activeFileType === 'logic';
  const isAssetFileActive = activeFileType === 'asset';
  const hasActiveFile = !!activeNode;
  const pageOpen = hasActiveFile && !isLogicFileActive && !isAssetFileActive;

  // Auto-switch view to 'design' when the active file type doesn't support the current view
  useEffect(() => {
    if (!viewsFor(activeFileType, projectFormat).includes(view)) {
      setView('design');
    }
  }, [activeFileType, projectFormat, view]);

  // The page being left is put into its file, and the one opened onto the canvas.
  useActiveFileOnCanvas();

  // The app running beside the canvas has a pane of its own in the canvas's
  // column, and is drawn only where the canvas keeps a phone's width beside
  // it. Asked for where it does not fit, the panels that are in its way are
  // put away, Files first; a panel opened again later takes the room back.
  const webEditorWidth = windowWidth - (webFilesOpen ? PANEL_WIDTHS.files : PANEL_WIDTHS.rail) - 24;
  const columnWidth = sheets
    ? 0
    : webProject
      ? webEditorWidth
      : canvasWidthWith(windowWidth, panelOpen);
  const previewFits = columnWidth >= CANVAS_BESIDE_PREVIEW + PREVIEW_PANE_MIN;
  const canPreviewBeside = projectFormat === 'web' ? (hasActiveFile && !isAssetFileActive) : pageOpen;
  const previewBeside = besidePreview && previewFits && canPreviewBeside && !sheets;
  const togglePreviewBeside = useCallback(() => {
    if (previewBeside) {
      setBesidePreview(false);
      return;
    }
    flushCanvasToActiveFile();
    setBesidePreview(true);
    if (webProject) {
      if (!previewFits) setWebFilesOpen(false);
      return;
    }
    const open = { ...panelOpen };
    for (const panel of ['files', 'components', 'properties'] as const) {
      if (canvasWidthWith(window.innerWidth, open) >= CANVAS_BESIDE_PREVIEW + PREVIEW_PANE_MIN) break;
      if (!open[panel]) continue;
      open[panel] = false;
      setPanelOpen(panel, false);
    }
  }, [previewBeside, webProject, previewFits, panelOpen, setPanelOpen]);

  /** A panel beside the canvas, or the rail it is put away to. */
  const sidePanel = (panel: PanelId, name: string, width: number, body: React.ReactNode, mark = false) =>
    (panel === 'files' ? filesOpen : panelOpen[panel]) ? (
      <div data-panel={name} className="bl-panel" style={{ width, minWidth: width }}>
        {body}
      </div>
    ) : (
      // The rail is the panel's place in the row, so F6 still finds it there.
      <button type="button" data-panel={name} className="bl-rail" style={{ width: PANEL_WIDTHS.rail }} onClick={() => panel === 'files' ? showFiles(true) : setPanelOpen(panel, true)} aria-label={`Show ${name.toLowerCase()} panel`}>
        <span>{name}</span>
        {mark && <i aria-hidden="true" title="Something is selected" />}
      </button>
    );

  const logicHeader = (onHide: () => void) => (
    <div style={styles.logicDockHeader}>
      <span style={styles.logicDockTitle}>Logic</span>
      <button className="bl-mini" onClick={onHide} aria-label="Hide logic panel">
        Hide
      </button>
    </div>
  );

  const middle = (
    <>
      <div className="bl-tabrow">
        <FileTabs />
        {webProject && sheets && (
          <div className="bl-tabrow-tools">
            <button ref={webFilesButton} type="button" className="bl-workspace-tool" onClick={() => setSheet('files')} data-sheet-button="files" aria-haspopup="dialog">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
                <path d="M2 4a1 1 0 0 1 1-1h3l2 2h5a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z" />
              </svg>
              Files
            </button>
          </div>
        )}
        {/* What is done to the whole canvas, at the end of its row of tabs. */}
        {canPreviewBeside && !sheets && (
          <div className="bl-tabrow-tools">
            <button
              type="button"
              className="bl-workspace-tool"
              aria-pressed={previewBeside}
              onClick={togglePreviewBeside}
              data-action="preview-beside"
              title={previewBeside ? 'Hide split preview' : 'Show the running app beside your work'}
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.35" aria-hidden="true">
                <rect x="1.75" y="3" width="12.5" height="10" rx="1.4" /><path d="M8.5 3v10" />
              </svg>
              Live preview
            </button>
          </div>
        )}
      </div>
      {!hasActiveFile ? (
        <div data-panel="Canvas" style={styles.centerTop}>
          <div style={styles.emptyFileState}>
            <div style={styles.emptyFileTitle}>No file is open</div>
            <div style={styles.emptyFileHint}>
              Choose a file in Files to start editing.
            </div>
          </div>
        </div>
      ) : isAssetFileActive ? (
        <div data-panel="Canvas" style={styles.centerTop}>
          <AssetView />
        </div>
      ) : isLogicFileActive ? (
        projectFormat === 'web' ? (
          <div className="bl-split">
            <div data-panel="Canvas">
              <LogicEditor />
            </div>
            {previewBeside && (
              <div data-panel="Preview">
                <LivePreview beside />
              </div>
            )}
          </div>
        ) : (
          <div data-panel="Canvas" style={styles.centerTop}>
            <LogicEditor />
          </div>
        )
      ) : (
        <div className="bl-split">
          <div data-panel="Canvas">
            {projectFormat === 'web' ? (
              <SourceView />
            ) : (
              <Suspense fallback={null}>
                <Canvas onShowComponents={sheets || !panelOpen.components ? showComponents : undefined} byTouch={sheets} />
              </Suspense>
            )}
          </div>
          {previewBeside && (
            <div data-panel="Preview">
              <LivePreview beside />
            </div>
          )}
        </div>
      )}
      {projectFormat !== 'web' && pageOpen && !sheets && dockLogic && (
        <div data-panel="Logic" style={styles.centerBottom}>
          {logicHeader(() => setDockLogic(false))}
          <div style={{ flex: 1, minHeight: 0 }}>
            <LogicEditor />
          </div>
        </div>
      )}
      {projectFormat !== 'web' && pageOpen && !sheets && !dockLogic && (
        // The dock put away: its heading, as the sections under Properties fold to theirs.
        <button type="button" className="bl-section-head" style={{ borderTop: '1px solid var(--line-soft)', position: 'static', flexShrink: 0 }} onClick={() => setDockLogic(true)} aria-expanded={false} data-action="show-logic">
          <span>Logic</span>
          <span className="bl-section-count">State, computed values and functions</span>
          <span className="bl-section-chevron" aria-hidden="true">›</span>
        </button>
      )}
    </>
  );

  const renderMainContent = () => {
    switch (view) {
      case 'design':
        if (sheets) {
          return (
            <div style={styles.mainSheets}>
              <div style={{ ...styles.centerWithTabs, border: 'none', borderRadius: 0 }}>{middle}</div>
            </div>
          );
        }
        return (
          <div style={styles.designShell}>
            <div style={styles.main}>
              {/* Each part of the workspace is a panel F6 goes to (utils/panelFocus.ts). */}
              {filesOpen ? (
                <div data-panel="Files" style={{ display: 'contents' }}>
                  <FileNavigator onToggleDock={() => showFiles(false)} />
                </div>
              ) : (
                sidePanel('files', 'Files', PANEL_WIDTHS.files, null)
              )}

              {projectFormat !== 'web' && sidePanel('components', 'Components', PANEL_WIDTHS.components, <Suspense fallback={null}><ComponentPalette onToggleDock={() => setPanelOpen('components', false)} /></Suspense>)}

              <div style={styles.centerWithTabs}>{middle}</div>

              {projectFormat !== 'web' && (panelOpen.properties ? (
                <div className="bl-panel" style={{ width: PANEL_WIDTHS.properties, minWidth: PANEL_WIDTHS.properties }}>
                  <Suspense fallback={null}>
                    <div data-panel="Properties" style={styles.rightPanelTop}>
                      <PropertyPanel onToggleDock={() => setPanelOpen('properties', false)} />
                    </div>
                    <div data-panel="Hierarchy" style={styles.rightPanelBottom}>
                      <TreeView collapsed={foldHierarchy} onToggle={() => setFoldHierarchy((folded) => !folded)} />
                      <DataPanel collapsed={foldData} onToggle={() => setFoldData((folded) => !folded)} />
                    </div>
                  </Suspense>
                </div>
              ) : (
                sidePanel('properties', 'Properties', PANEL_WIDTHS.properties, null, somethingSelected)
              ))}
            </div>
          </div>
        );

      case 'preview':
        return (
          <div style={sheets ? styles.mainSheets : styles.main}>
            <div data-panel="Preview" style={{ flex: 1, height: '100%', minWidth: 0, overflow: 'hidden' }}>
              <LivePreview />
            </div>
          </div>
        );

      case 'code':
        return (
          <div style={sheets ? styles.mainSheets : styles.main}>
            <div data-panel="Code" style={{ flex: 1, minWidth: 0 }}>
              <SourceView />
            </div>
          </div>
        );

      case 'data':
        return (
          <div style={sheets ? styles.mainSheets : styles.main}>
            <div data-panel="Data" style={{ flex: 1, minWidth: 0 }}>
              <Suspense fallback={<div role="status" style={{ padding: 24, color: 'var(--dim)' }}>Opening the data designer…</div>}>
                <DatabaseWorkspace hosted={isHostedEditor()} onSave={() => void saveCurrentProject()} saveLabel={hostSaveLabel ?? 'Return to FormLogic'} />
              </Suspense>
            </div>
          </div>
        );

      default:
        return null;
    }
  };

  const openSheet = () => {
    switch (sheet) {
      case 'components':
        return <Suspense fallback={null}><ComponentPalette onToggleDock={closeSheet} onAdded={closeSheet} /></Suspense>;
      case 'properties':
        return <Suspense fallback={null}><PropertyPanel onToggleDock={closeSheet} /></Suspense>;
      case 'hierarchy':
        return <Suspense fallback={null}><TreeView onClose={closeSheet} /></Suspense>;
      case 'files':
        return <FileNavigator onToggleDock={closeSheet} onFileOpened={closeSheet} />;
      case 'logic':
        return (
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {logicHeader(closeSheet)}
            <div style={{ flex: 1, minHeight: 0 }}>
              <LogicEditor />
            </div>
          </div>
        );
      default:
        return null;
    }
  };

  return (
    <div style={styles.app}>
      <div className="bl-stage">
        {/* Everything behind a dialog or a sheet goes inert while it is open,
            so Tab and a screen reader cannot reach the page under it. */}
        <div ref={shellRef} className="bl-shell" style={styles.shell}>
          <a
            className="bl-skip-link"
            href="#builder-workspace"
            onClick={(event) => {
              event.preventDefault();
              document.getElementById('builder-workspace')?.focus();
            }}
          >
            Skip to the work area
          </a>
          {/* The same bar as the site, the runtime and Studio: the way between them. */}
          {!isHostedEditor() && <ProductBar current="builder" urls={PRODUCT_URLS} onNavigate={isDesktop() ? (href) => {
            void openCompanionUrl(href).catch(() => toast.error('Could not open the Softn website.'));
          } : undefined} />}
          {/* A project opened from Studio says so, with the way back (drawn for no other project). */}
          <StudioOrigin view={view} />
          <Toolbar
            view={view}
            onViewChange={changeView}
            onSave={handleSave}
            isSaving={isSaving}
            onNew={handleNew}
            onOpen={handleOpen}
            onShortcuts={openShortcuts}
            onExport={handleExport}
            activeFileType={activeFileType}
          />

          <main id="builder-workspace" style={styles.shell} tabIndex={-1} aria-label="Builder work area">
            {renderMainContent()}
          </main>
        </div>

        {/* A panel of a phone's editor, over the canvas (components/Sheet.tsx). */}
        {sheet !== null && (
          // A sheet of its own for each panel: going from one to the next from the bar
          // moves the focus into the new one, and gives it back to the button pressed.
          <Sheet key={sheet} title={DOCK.find((entry) => entry.name === sheet)!.label} onClose={closeSheet} tall={sheet === 'logic'}>
            {openSheet()}
          </Sheet>
        )}
      </div>

      {/* Outside the part that goes inert: a message is shown here, and is
          still to be read while a dialog is open (components/StatusBar.tsx). */}
      <StatusBar onShortcuts={openShortcuts} modalOpen={modalOpen} />

      {/* The panels of a phone's editor: the bar stays under an open sheet,
          so the next panel is one press away. */}
      {sheets && view === 'design' && !webProject && (
        <nav className="bl-dock" aria-label="Panels" {...(modalOpen ? INERT : {})}>
          {DOCK.map(({ name, label, icon }) => (
            <button
              key={name}
              type="button"
              aria-pressed={sheet === name}
              disabled={name === 'logic' && !pageOpen}
              onClick={() => setSheet((open) => (open === name ? null : name))}
              data-sheet-button={name}
            >
              <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                {icon}
              </svg>
              <span>{label}</span>
            </button>
          ))}
        </nav>
      )}

      <ExportDialog isOpen={showExportDialog} onClose={() => setShowExportDialog(false)} exportProject={exportCurrentProject} />
      <ShortcutsDialog isOpen={showShortcuts} onClose={() => setShowShortcuts(false)} />
      <NewProjectDialog
        isOpen={showNewProjectDialog}
        onClose={() => setShowNewProjectDialog(false)}
        onCreate={handleCreateNewProject}
      />
      <ConfirmDialog />
      <PwaUpdater />
    </div>
  );
}

export default App;

/**
 * SoftN Builder - Main Application
 */

import React, { useState, useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { ProductBar } from '@softn/brand';
import { Toolbar } from './components/toolbar/Toolbar';
import { NarrowScreenNotice } from './components/NarrowScreenNotice';
import { ExportDialog } from './components/toolbar/ExportDialog';
import { ShortcutsDialog } from './components/toolbar/ShortcutsDialog';
import { NewProjectDialog, type NewProjectConfig } from './components/toolbar/NewProjectDialog';
import { ComponentPalette } from './components/panels/ComponentPalette';
import { PropertyPanel } from './components/panels/PropertyPanel';
import { TreeView } from './components/panels/TreeView';
import { DataPanel } from './components/panels/DataPanel';
import { Canvas } from './components/canvas/Canvas';
import { LogicEditor } from './components/editor/LogicEditor';
import { SourceView } from './components/editor/SourceView';
import { LivePreview } from './components/preview/LivePreview';
import { SchemaDesigner } from './components/schema';
import { FileNavigator, FileTabs } from './components/files';
import { useCanvasStore } from './stores/canvasStore';
import { useProjectStore } from './stores/projectStore';
import { useHistoryStore } from './stores/historyStore';
import { useFilesStore } from './stores/filesStore';
import { openBundleFile, loadBundle } from './utils/bundleLoader';
import {
  commitProjectSnapshot,
  openRemoteBundle,
  prepareProjectSnapshot,
  prepareSessionSnapshot,
  quarantineSession,
  type ProjectSnapshot,
  type ViewMode,
} from './utils/openProject';
import { saveProject } from './utils/saveProject';
import { STUDIO_URL, RUNTIME_URL, PRODUCT_URLS } from './utils/siteUrls';
import { isDesktop, openCompanionUrl, type BundleFileHandle } from './utils/desktop';
import { ToastContainer } from './components/feedback/ToastContainer';
import { PwaUpdater } from './components/feedback/PwaUpdater';
import { toast } from './stores/notificationStore';
import { debug } from './utils/debug';
import { useProjectStartup } from './hooks/useProjectStartup';
import { useUnsavedChanges } from './hooks/useUnsavedChanges';
import { useExclusiveAction } from './hooks/useExclusiveAction';
import { useWorkspaceShortcuts } from './hooks/useWorkspaceShortcuts';
import { flushCanvasToActiveFile, buildProjectBundle } from './utils/buildProjectBundle';
import { connectHostedEditor, isHostedEditor, requestHostedSave } from '@softn/editor-shared/hostedEditor';
import { useHostedSaveLabel } from '@softn/editor-shared/useHostedSaveLabel';
import { viewsFor } from './utils/workspaceViews';
import { startNewProject } from './utils/newProject';

const styles: Record<string, React.CSSProperties> = {
  app: {
    height: '100vh',
    display: 'flex',
    flexDirection: 'column',
    background: 'var(--ink)',
    color: 'var(--paper)',
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
  leftPanel: {
    display: 'flex',
    flexDirection: 'column',
    border: '1px solid var(--line-soft)',
    borderRadius: 10,
    overflow: 'hidden',
    width: 260,
    minWidth: 260,
    background: 'var(--ink-2)',
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
    borderTop: '1px solid var(--line-soft)',
    overflow: 'hidden',
    background: 'var(--ink-2)',
  },
  rightPanel: {
    display: 'flex',
    flexDirection: 'column',
    width: 320,
    minWidth: 320,
    border: '1px solid var(--line-soft)',
    borderRadius: 10,
    background: 'var(--ink-2)',
    overflow: 'hidden',
  },
  rightPanelTop: {
    flex: 1,
    overflow: 'hidden',
  },
  rightPanelBottom: {
    borderTop: '1px solid var(--line-soft)',
    maxHeight: '45%',
    overflow: 'auto',
  },
  statusBar: {
    height: 28,
    flexShrink: 0,
    borderTop: '1px solid var(--line-soft)',
    background: 'var(--ink-2)',
    display: 'flex',
    alignItems: 'center',
    gap: 16,
    padding: '0 12px',
    fontSize: 12,
    color: 'var(--dim)',
  },
  statusStrong: {
    color: 'var(--paper)',
    fontWeight: 600,
    fontVariantNumeric: 'tabular-nums',
  },
  statusPath: {
    fontFamily: 'var(--mono)',
    fontSize: 11,
    color: 'var(--dim)',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    minWidth: 0,
  },
  statusLink: {
    border: 'none',
    background: 'transparent',
    color: 'var(--dim)',
    fontSize: 11,
    cursor: 'pointer',
    padding: '2px 4px',
    borderRadius: 4,
    whiteSpace: 'nowrap',
  },
  assetName: {
    fontFamily: 'var(--mono)',
    fontSize: 13,
    fontWeight: 600,
    marginBottom: 4,
    overflowWrap: 'anywhere',
  },
  designShell: {
    flex: 1,
    minHeight: 0,
    display: 'flex',
    flexDirection: 'column',
  },
  collapsedRailLeft: {
    width: 34,
    minWidth: 34,
    border: '1px solid var(--line-soft)',
    borderRadius: 10,
    background: 'var(--ink-2)',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'flex-start',
    paddingTop: 10,
    gap: 8,
  },
  collapsedRailRight: {
    width: 34,
    minWidth: 34,
    border: '1px solid var(--line-soft)',
    borderRadius: 10,
    background: 'var(--ink-2)',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'flex-start',
    paddingTop: 10,
    gap: 8,
  },
  collapsedLogicBar: {
    height: 34,
    borderTop: '1px solid var(--line-soft)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'flex-end',
    padding: '0 8px',
    background: 'var(--ink)',
  },
  logicDockHeader: {
    height: 34,
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
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    textAlign: 'center',
    padding: 24,
    color: 'var(--dim)',
  },
  emptyFileTitle: {
    fontFamily: 'var(--display)',
    fontSize: 17,
    fontWeight: 700,
    letterSpacing: '-0.02em',
    color: 'var(--paper)',
    marginBottom: 6,
  },
  emptyFileHint: {
    fontSize: 13,
    color: 'var(--dim)',
  },
  assetPreview: {
    height: '100%',
    overflow: 'auto',
    padding: 18,
    background: 'var(--ink)',
  },
  assetPreviewCard: {
    background: 'var(--ink-2)',
    border: '1px solid var(--line-soft)',
    borderRadius: 10,
    padding: 14,
    maxWidth: 900,
    margin: '0 auto',
  },
  assetPreviewMeta: {
    fontSize: 12,
    color: 'var(--dim)',
    marginBottom: 12,
  },
  assetImageWrap: {
    border: '1px solid var(--line-soft)',
    borderRadius: 8,
    background: 'var(--ink-2)',
    minHeight: 220,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 10,
  },
  assetImage: {
    maxWidth: '100%',
    maxHeight: 520,
    objectFit: 'contain',
  },
  assetUnsupported: {
    padding: 20,
    color: 'var(--dim)',
    fontSize: 13,
  },
};

function mimeTypeFromPath(path: string): string {
  const ext = path.toLowerCase().split('.').pop() || '';
  if (ext === 'png') return 'image/png';
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'gif') return 'image/gif';
  if (ext === 'webp') return 'image/webp';
  if (ext === 'svg') return 'image/svg+xml';
  if (ext === 'bmp') return 'image/bmp';
  return 'application/octet-stream';
}

function isPreviewableImage(path: string): boolean {
  return /\.(png|jpe?g|gif|webp|svg|bmp)$/i.test(path);
}

/** True while the window is too narrow for the builder's panel layout. */
function useNarrowScreen(minWidth = 900): boolean {
  const [narrow, setNarrow] = useState(() => window.innerWidth < minWidth);
  useEffect(() => {
    const check = () => setNarrow(window.innerWidth < minWidth);
    check();
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  }, [minWidth]);
  return narrow;
}

function App() {
  useUnsavedChanges();
  const isNarrow = useNarrowScreen();
  const hostSaveLabel = useHostedSaveLabel();
  const [narrowPreview, setNarrowPreview] = useState(false);
  const projectName = useProjectStore((state) => state.name);
  const projectDirty = useProjectStore((state) => state.isDirty);
  const [view, setView] = useState<ViewMode>('design');
  const [dockFiles, setDockFiles] = useState(true);
  const [dockComponents, setDockComponents] = useState(true);
  const [dockInspector, setDockInspector] = useState(true);
  const [dockLogic, setDockLogic] = useState(true);
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

  const loadCanvasState = useCanvasStore((state) => state.loadState);
  const clearHistory = useHistoryStore((state) => state.clear);
  const updateUIFile = useFilesStore((state) => state.updateUIFile);
  const selectedCount = useCanvasStore((state) => state.selectedIds.length);
  const elementCount = useCanvasStore((state) => state.elements.size);
  const canvasElements = useCanvasStore((state) => state.elements);
  const canvasRootId = useCanvasStore((state) => state.rootId);
  const handleCreateNewProject = useCallback((config: NewProjectConfig) => {
    fileHandleRef.current = null;
    remoteOpenRef.current?.abort();
    startNewProject(config);
    setView('design');
    setShowNewProjectDialog(false);
    toast.success(`Created ${config.name}`);
  }, []);

  const handleNew = useCallback(() => {
    const isDirty = useProjectStore.getState().isDirty;
    if (isDirty && !window.confirm('Create a new project? Unsaved changes will be lost.')) {
      return;
    }
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

    if (snapshot.warnings.length > 0) {
      console.warn('[App] Opened with warnings:', snapshot.warnings);
      toast.warning(`Opened with ${snapshot.warnings.length} warning(s)`);
    }
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
        if (!window.confirm('Open a new project? Unsaved changes will be lost.')) return;
      }
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
    open: async bytes => applySnapshotRef.current(prepareProjectSnapshot(await loadBundle(bytes))),
    export: buildProjectBundle,
  }), []);
  useProjectStartup((action) => {
    if (action.kind === 'nothing') return;
    if (action.kind === 'refused-link') {
      toast.error(action.message);
      return;
    }

    if (action.kind === 'restore-prompt') {
      let snapshot: ProjectSnapshot;
      try {
        snapshot = prepareSessionSnapshot(action.raw);
      } catch (e) {
        // Kept, with the reason, not deleted: it may be the only copy.
        console.error('[App] The saved session could not be restored; quarantined:', e);
        quarantineSession(action.raw, e);
        toast.error('The saved session could not be restored. It was kept; download it from Export → Recovery.');
        return;
      }
      if (!window.confirm('Restore the last locally saved builder session?')) return;
      try {
        applySnapshotRef.current(snapshot);
      } catch (e) {
        console.error('[App] Failed to restore session:', e);
        quarantineSession(action.raw, e);
        toast.error(`Could not restore the session: ${e instanceof Error ? e.message : String(e)}. It was kept; download it from Export → Recovery.`);
      }
      return;
    }

    const controller = new AbortController();
    remoteOpenRef.current = controller;
    const { url } = action;
    void openRemoteBundle(url, controller.signal).then((outcome) => {
      if (remoteOpenRef.current === controller) remoteOpenRef.current = null;
      if (outcome.kind === 'opened') {
        fileHandleRef.current = null;
        setView(outcome.snapshot.view);
        if (outcome.snapshot.warnings.length > 0) toast.warning(`Opened with ${outcome.snapshot.warnings.length} warning(s)`);
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
    // Hosted in FormLogic (audit SN-04): a save is only "handled" once the
    // parent confirms it took the draft. A closed channel keeps the edits here
    // and says so — it never silently falls back to a local file download.
    const hosted = requestHostedSave();
    if (hosted.handled) {
      const result = await hosted.completion;
      if (result.ok) toast.success('Your changes are back in FormLogic.');
      else toast.error(result.error ?? 'FormLogic could not take the draft. Your changes are still here.');
      return;
    }
    if (hosted.reason === 'disconnected') {
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
    if (!outcome.sessionStored && !outcome.projectChanged) {
      // The file is written; only the local recovery copy is missing.
      console.warn('[App] Could not store session for restore:', outcome.sessionError);
      toast.info('The local recovery copy could not be stored (storage full or blocked); the file itself was saved.');
    }
    debug('[App] Bundle saved to file');
  }, [view]);

  const { run: handleSave, isPending: isSaving } = useExclusiveAction(saveCurrentProject);
  const changeView = useCallback((next: ViewMode) => {
    flushCanvasToActiveFile();
    setView(next);
  }, []);
  const modalOpen = showExportDialog || showNewProjectDialog || showShortcuts;

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
  useLayoutEffect(() => {
    const shell = shellRef.current;
    if (!shell) return;
    shell.toggleAttribute('inert', modalOpen);
    if (modalOpen) shell.setAttribute('aria-hidden', 'true');
    else shell.removeAttribute('aria-hidden');
  }, [modalOpen, isNarrow]);

  useWorkspaceShortcuts({
    blocked: modalOpen, narrow: isNarrow, save: handleSave, open: handleOpen,
    create: handleNew, export: handleExport, shortcuts: () => setShowShortcuts(true),
    changeView,
  });

  // Sync active file with canvas when file selection changes
  const activeFileId = useFilesStore((state) => state.activeFileId);
  const uiFiles = useFilesStore((state) => state.uiFiles);
  const assetFiles = useFilesStore((state) => state.assetFiles);
  const fileNodes = useFilesStore((state) => state.nodes);
  const activeNode = activeFileId ? fileNodes.get(activeFileId) : null;
  const activeFileType = activeNode?.fileType ?? null;
  const isLogicFileActive = activeFileType === 'logic';
  const isAssetFileActive = activeFileType === 'asset';
  const hasActiveFile = !!activeNode;
  const activeAsset = activeFileId ? assetFiles.get(activeFileId) : undefined;
  const [activeAssetPreviewUrl, setActiveAssetPreviewUrl] = useState<string | null>(null);
  const previousActiveFileIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!isAssetFileActive || !activeAsset || !isPreviewableImage(activeAsset.name)) {
      setActiveAssetPreviewUrl(null);
      return;
    }
    const objectUrl = URL.createObjectURL(
      new Blob([Uint8Array.from(activeAsset.data)], {
        type: activeAsset.type || mimeTypeFromPath(activeAsset.name),
      })
    );
    setActiveAssetPreviewUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [isAssetFileActive, activeAsset]);

  // Auto-switch view to 'design' when the active file type doesn't support the current view
  useEffect(() => {
    if (!viewsFor(activeFileType).includes(view)) {
      setView('design');
    }
  }, [activeFileType, view]);

  // Persist currently edited UI canvas when switching files/tabs so preview and reopen stay in sync.
  useEffect(() => {
    const previousActiveId = previousActiveFileIdRef.current;
    if (previousActiveId && previousActiveId !== activeFileId) {
      const previousNode = fileNodes.get(previousActiveId);
      if (previousNode?.type === 'file' && previousNode.fileType === 'ui') {
        updateUIFile(previousActiveId, canvasElements, canvasRootId);
      }
      // The history is a stack of canvas snapshots with no idea which file each
      // came from, and undo loads one unconditionally. Left in place across a
      // switch, one Ctrl+Z would drop the previous file's element tree into the
      // file now open — and the flush above would then write it there.
      clearHistory();
    }
    previousActiveFileIdRef.current = activeFileId;
  }, [activeFileId, fileNodes, updateUIFile, canvasElements, canvasRootId, clearHistory]);

  useEffect(() => {
    if (!activeFileId) return;

    const activeFile = uiFiles.get(activeFileId);
    if (!activeFile) {
      debug('[App] Active file not found:', activeFileId);
      return;
    }

    // Only load if it's a UI file with elements
    if (activeFile.elements && activeFile.elements.size > 0) {
      debug('[App] Loading file into canvas:', activeFile.path, {
        elementsCount: activeFile.elements.size,
        rootId: activeFile.rootId,
        imports: activeFile.imports?.length || 0,
      });
      loadCanvasState(activeFile.elements, activeFile.rootId, activeFile.imports || []);
    }
  }, [activeFileId, uiFiles, loadCanvasState]);

  const renderMainContent = () => {
    switch (view) {
      case 'design':
        return (
          <div style={styles.designShell}>
            <div style={styles.main}>
              {dockFiles ? (
                <FileNavigator onToggleDock={() => setDockFiles(false)} />
              ) : (
                <div style={styles.collapsedRailLeft}>
                  <button className="bl-rail-btn" onClick={() => setDockFiles(true)} aria-label="Show files panel">
                    Files
                  </button>
                </div>
              )}

              {dockComponents && (
                <div style={styles.leftPanel}>
                  <ComponentPalette onToggleDock={() => setDockComponents(false)} />
                </div>
              )}
              {!dockComponents && (
                <div style={styles.collapsedRailLeft}>
                  <button className="bl-rail-btn" onClick={() => setDockComponents(true)} aria-label="Show components panel">
                    Components
                  </button>
                </div>
              )}

              <div style={styles.centerWithTabs}>
                <FileTabs />
                <div style={styles.centerTop}>
                  {!hasActiveFile ? (
                    <div style={styles.emptyFileState}>
                      <div>
                        <div style={styles.emptyFileTitle}>No file selected</div>
                        <div style={styles.emptyFileHint}>
                          Choose a file in the Files panel to start editing.
                        </div>
                      </div>
                    </div>
                  ) : isAssetFileActive ? (
                    activeAsset ? (
                      <div style={styles.assetPreview}>
                        <div style={styles.assetPreviewCard}>
                          <div style={styles.assetName}>{activeAsset.name}</div>
                          <div style={styles.assetPreviewMeta}>
                            {activeAsset.type || mimeTypeFromPath(activeAsset.name)} · {(activeAsset.data.byteLength / 1024).toFixed(1)} KB
                          </div>
                          {activeAssetPreviewUrl ? (
                            <div style={styles.assetImageWrap}>
                              <img src={activeAssetPreviewUrl} alt={activeAsset.name} style={styles.assetImage} />
                            </div>
                          ) : (
                            <div style={styles.assetUnsupported}>
                              Only images (PNG, JPEG, GIF, WebP, SVG and BMP) can be previewed here.
                            </div>
                          )}
                        </div>
                      </div>
                    ) : (
                      <div style={styles.emptyFileState}>
                        <div>
                          <div style={styles.emptyFileTitle}>Asset not found</div>
                          <div style={styles.emptyFileHint}>The selected asset could not be loaded.</div>
                        </div>
                      </div>
                    )
                  ) : isLogicFileActive ? (
                    <LogicEditor />
                  ) : (
                    <Canvas />
                  )}
                </div>
                {hasActiveFile && !isLogicFileActive && !isAssetFileActive && dockLogic && (
                  <div style={styles.centerBottom}>
                    <div style={styles.logicDockHeader}>
                      <span style={styles.logicDockTitle}>Logic</span>
                      <button className="bl-mini" onClick={() => setDockLogic(false)} aria-label="Hide logic panel">
                        Hide
                      </button>
                    </div>
                    <LogicEditor />
                  </div>
                )}
                {hasActiveFile && !isLogicFileActive && !isAssetFileActive && !dockLogic && (
                  <div style={styles.collapsedLogicBar}>
                    <button className="bl-mini" onClick={() => setDockLogic(true)}>
                      Show logic
                    </button>
                  </div>
                )}
              </div>

              {dockInspector && (
                <div style={styles.rightPanel}>
                  <div style={styles.rightPanelTop}>
                    <PropertyPanel onToggleDock={() => setDockInspector(false)} />
                  </div>
                  <div style={styles.rightPanelBottom}>
                    <TreeView />
                    <DataPanel />
                  </div>
                </div>
              )}
              {!dockInspector && (
                <div style={styles.collapsedRailRight}>
                  <button className="bl-rail-btn" onClick={() => setDockInspector(true)} aria-label="Show properties panel">
                    Properties
                  </button>
                </div>
              )}
            </div>
          </div>
        );

      case 'preview':
        return (
          <div style={styles.main}>
            <div style={{ flex: 1, height: '100%', overflow: 'hidden' }}>
              <LivePreview />
            </div>
          </div>
        );

      case 'code':
        return (
          <div style={styles.main}>
            <div style={{ flex: 1 }}>
              <SourceView />
            </div>
          </div>
        );

      case 'data':
        if (isHostedEditor()) return (
          <section style={{ padding: 'clamp(24px, 5vw, 56px)', maxWidth: 760, margin: '0 auto', lineHeight: 1.7 }} aria-label="FormLogic app data">
            <h1 style={{ fontFamily: 'var(--display)', fontSize: 24, letterSpacing: '-0.02em', marginBottom: 12 }}>Your app data lives in FormLogic</h1>
            <p>Browse and edit your app’s records in FormLogic: a SoftN app’s Data tab, or a forms app’s Data &amp; forms. To add a table or a column, add the next numbered migration in the app’s source, or ask AI Studio.</p>
            <p style={{ marginTop: 12 }}>Builder’s standalone database designer creates local XDB collections. Those are separate from your hosted database, so change the hosted schema in FormLogic.</p>
            <button type="button" className="bl-btn bl-btn-primary bl-btn-lg" onClick={() => void saveCurrentProject()} style={{ marginTop: 24 }}>{hostSaveLabel ?? 'Return to FormLogic'}</button>
          </section>
        );
        return (
          <div style={styles.main}>
            <div style={{ flex: 1 }}>
              <SchemaDesigner />
            </div>
          </div>
        );

      default:
        return null;
    }
  };

  // Below this the four panels stop fitting and the canvas is unusable with a
  // finger. Measured, not guessed: at 768px the toolbar alone overflows by 130px.
  if (isNarrow) {
    return <>
      {narrowPreview ? <div style={{ ...styles.app, height: '100dvh' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: 12, gap: 12, borderBottom: '1px solid var(--line-soft)', background: 'var(--ink-2)' }}>
          <button className="bl-btn" style={{ minHeight: 44 }} onClick={() => setNarrowPreview(false)}>Back</button>
          <span style={{ fontFamily: 'var(--display)', fontWeight: 700, fontSize: 15, letterSpacing: '-0.02em', overflowWrap: 'anywhere', textAlign: 'center' }}>
            {projectName}
            {projectDirty && <span style={{ display: 'block', fontFamily: 'var(--body)', fontWeight: 500, fontSize: 11, letterSpacing: 0, color: 'var(--dim)' }}>Unsaved changes</span>}
          </span>
          <button className="bl-btn" style={{ minHeight: 44 }} onClick={handleSave} disabled={isSaving} aria-busy={isSaving}>{isSaving ? 'Saving…' : hostSaveLabel ?? 'Save'}</button>
        </div>
        <div style={{ flex: 1, minHeight: 0 }}><LivePreview initialDevice="mobile" /></div>
      </div> : <div style={{ ...styles.app, height: '100dvh' }}>
        {/* The way to the other products stays, as it does on every SoftN page. */}
        {!isHostedEditor() && <ProductBar current="builder" urls={PRODUCT_URLS} onNavigate={isDesktop() ? (href) => {
          void openCompanionUrl(href).catch(() => toast.error('Could not open the Softn website.'));
        } : undefined} />}
        <NarrowScreenNotice studioUrl={STUDIO_URL} runtimeUrl={RUNTIME_URL}
          projectName={projectName} isDirty={projectDirty} isSaving={isSaving} onOpen={handleOpen} onSave={handleSave}
          onPreview={() => { flushCanvasToActiveFile(); setNarrowPreview(true); }} />
      </div>}
      <ToastContainer />
      <PwaUpdater />
    </>;
  }

  return (
    <div style={styles.app}>
      {/* Everything behind a dialog goes inert while it is open, so
          Tab and a screen reader cannot reach the page under it. */}
      <div ref={shellRef} style={styles.app}>
        {/* The same bar as the site, the runtime and Studio: the way between them. */}
        {!isHostedEditor() && <ProductBar current="builder" urls={PRODUCT_URLS} onNavigate={isDesktop() ? (href) => {
          void openCompanionUrl(href).catch(() => toast.error('Could not open the Softn website.'));
        } : undefined} />}
        <Toolbar
          view={view}
          onViewChange={changeView}
          onSave={handleSave}
          isSaving={isSaving}
          onNew={handleNew}
          onOpen={handleOpen}
          onShortcuts={() => setShowShortcuts(true)}
          onExport={handleExport}
          activeFileType={activeFileType}
        />

        {renderMainContent()}

        <div style={styles.statusBar}>
          <span>
            <span style={styles.statusStrong}>{elementCount}</span> {elementCount === 1 ? 'element' : 'elements'}
          </span>
          <span>
            <span style={styles.statusStrong}>{selectedCount}</span> selected
          </span>
          {activeNode && (
            <span style={styles.statusPath} title={activeNode.path}>{activeNode.path}</span>
          )}
          <span style={{ flex: 1 }} />
          <button type="button" style={styles.statusLink} onClick={() => setShowShortcuts(true)}>
            Press <kbd className="bl-kbd">?</kbd> for keyboard shortcuts
          </button>
        </div>
      </div>

      <ExportDialog isOpen={showExportDialog} onClose={() => setShowExportDialog(false)} />
      <ShortcutsDialog isOpen={showShortcuts} onClose={() => setShowShortcuts(false)} />
      <NewProjectDialog
        isOpen={showNewProjectDialog}
        onClose={() => setShowNewProjectDialog(false)}
        onCreate={handleCreateNewProject}
      />
      <ToastContainer />
      <PwaUpdater />
    </div>
  );
}

export default App;

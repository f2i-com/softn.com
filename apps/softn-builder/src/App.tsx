/**
 * SoftN Builder - Main Application
 */

import React, { useState, useCallback, useEffect, useRef } from 'react';
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
import { useSchemaStore } from './stores/schemaStore';
import { useFilesStore } from './stores/filesStore';
import { openBundleFile } from './utils/bundleLoader';
import {
  commitProjectSnapshot,
  openRemoteBundle,
  prepareProjectSnapshot,
  prepareSessionSnapshot,
  quarantineSession,
  startupAction,
  SESSION_STORAGE_KEY,
  type ProjectSnapshot,
  type ViewMode,
} from './utils/openProject';
import { saveProject } from './utils/saveProject';
import { STUDIO_URL, RUNTIME_URL } from './utils/siteUrls';
import { ToastContainer } from './components/feedback/ToastContainer';
import { PwaUpdater } from './components/feedback/PwaUpdater';
import { toast } from './stores/notificationStore';
import { debug } from './utils/debug';
import { readLocalStorage } from './utils/safeStorage';

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
  center: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
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
  fullHeight: {
    height: '100%',
  },
  statusBar: {
    height: 30,
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
  collapsedRailBtn: {
    writingMode: 'vertical-rl',
    transform: 'rotate(180deg)',
    border: '1px solid var(--line)',
    background: 'var(--ink)',
    color: 'var(--dim)',
    borderRadius: 8,
    padding: '8px 4px',
    fontSize: 11,
    fontWeight: 600,
    lineHeight: 1,
    cursor: 'pointer',
    letterSpacing: '0.03em',
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
  collapsedLogicBtn: {
    border: '1px solid var(--line)',
    background: 'var(--ink-2)',
    color: 'var(--dim)',
    borderRadius: 7,
    padding: '4px 9px',
    fontSize: 11,
    cursor: 'pointer',
    lineHeight: 1,
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
    fontFamily: 'var(--b-display)',
    fontSize: 14,
    color: 'var(--paper)',
    letterSpacing: '-0.01em',
    fontWeight: 600,
  },
  logicDockHideBtn: {
    border: '1px solid var(--line)',
    background: 'var(--ink-2)',
    color: 'var(--dim)',
    borderRadius: 6,
    fontSize: 11,
    padding: '3px 7px',
    cursor: 'pointer',
    lineHeight: 1,
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
    fontSize: 16,
    fontWeight: 600,
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
  const isNarrow = useNarrowScreen();
  const [view, setView] = useState<ViewMode>('design');
  const [dockFiles, setDockFiles] = useState(true);
  const [dockComponents, setDockComponents] = useState(true);
  const [dockInspector, setDockInspector] = useState(true);
  const [dockLogic, setDockLogic] = useState(true);
  const [showExportDialog, setShowExportDialog] = useState(false);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [showNewProjectDialog, setShowNewProjectDialog] = useState(false);

  const fileHandleRef = useRef<FileSystemFileHandle | null>(null);
  /**
   * The remote open in flight, if any. Aborted by every action that replaces
   * the workspace, and on unmount; the generation check in openRemoteBundle
   * is what holds even when a fetch ignores the signal.
   */
  const remoteOpenRef = useRef<AbortController | null>(null);
  /** The part of the page that goes inert behind the export dialog. */
  const shellRef = useRef<HTMLDivElement | null>(null);

  const resetCanvas = useCanvasStore((state) => state.reset);
  const loadCanvasState = useCanvasStore((state) => state.loadState);
  const resetProject = useProjectStore((state) => state.reset);
  const setProjectName = useProjectStore((state) => state.setName);
  const setProjectVersion = useProjectStore((state) => state.setVersion);
  const setProjectDescription = useProjectStore((state) => state.setDescription);
  const setThemeMode = useProjectStore((state) => state.setThemeMode);
  const clearHistory = useHistoryStore((state) => state.clear);
  const resetSchema = useSchemaStore((state) => state.reset);
  const resetFiles = useFilesStore((state) => state.reset);
  const updateUIFile = useFilesStore((state) => state.updateUIFile);
  const selectedCount = useCanvasStore((state) => state.selectedIds.length);
  const elementCount = useCanvasStore((state) => state.elements.size);
  const canvasElements = useCanvasStore((state) => state.elements);
  const canvasRootId = useCanvasStore((state) => state.rootId);
  const applyStarterTemplate = useCallback((template: NewProjectConfig['template']) => {
    const canvas = useCanvasStore.getState();
    const rootId = canvas.rootId;

    if (template === 'blank') {
      const stack = canvas.addElement('Stack', rootId);
      canvas.updateElementProps(stack, { direction: 'vertical', gap: 'md', padding: 'lg' });

      const heading = canvas.addElement('Heading', stack);
      canvas.updateElementProps(heading, {
        level: 2,
        children: 'Welcome to your new app',
      });

      const text = canvas.addElement('Text', stack);
      canvas.updateElementProps(text, {
        children: 'Start building by dragging components from the palette.',
      });
      return;
    }

    if (template === 'landing') {
      const stack = canvas.addElement('Stack', rootId);
      canvas.updateElementProps(stack, { direction: 'vertical', gap: 'lg', align: 'center', padding: 'xl' });

      const heading = canvas.addElement('Heading', stack);
      canvas.updateElementProps(heading, {
        level: 1,
        children: 'Build apps faster with SoftN',
      });

      const subText = canvas.addElement('Text', stack);
      canvas.updateElementProps(subText, {
        children: 'Compose UI visually, wire logic quickly, and ship instantly.',
      });

      const cta = canvas.addElement('Button', stack);
      canvas.updateElementProps(cta, {
        variant: 'primary',
        children: 'Get Started',
      });
      return;
    }

    if (template === 'dashboard') {
      const page = canvas.addElement('Stack', rootId);
      canvas.updateElementProps(page, { direction: 'vertical', gap: 'md', padding: 'lg' });

      const heading = canvas.addElement('Heading', page);
      canvas.updateElementProps(heading, {
        level: 1,
        children: 'Dashboard',
      });

      const stats = canvas.addElement('SmartStats', page);
      canvas.updateElementProps(stats, { columns: 3 });

      const cards = canvas.addElement('SmartCards', page);
      canvas.updateElementProps(cards, { columns: 3, titleField: 'title', descriptionField: 'description' });

      const list = canvas.addElement('SmartList', page);
      canvas.updateElementProps(list, { titleField: 'title', subtitleField: 'status' });
    }
  }, []);

  const handleCreateNewProject = useCallback((config: NewProjectConfig) => {
    fileHandleRef.current = null;
    remoteOpenRef.current?.abort();
    resetCanvas();
    resetProject();
    clearHistory();
    resetSchema();
    resetFiles();

    setProjectName(config.name);
    setProjectDescription(config.description);
    setThemeMode(config.theme);
    setProjectVersion('1.0.0');
    setView('design');

    const root = useCanvasStore.getState().getElement(useCanvasStore.getState().rootId);
    if (root) {
      useCanvasStore.getState().updateElementProps(root.id, { theme: config.theme });
    }

    applyStarterTemplate(config.template);

    useProjectStore.getState().markClean();
    setShowNewProjectDialog(false);
    toast.success(`Created new app: ${config.name}`);
  }, [
    resetCanvas,
    resetProject,
    clearHistory,
    resetSchema,
    resetFiles,
    setProjectName,
    setProjectDescription,
    setThemeMode,
    setProjectVersion,
    applyStarterTemplate,
  ]);

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
  useEffect(() => {
    const action = startupAction(window.location, window.history, readLocalStorage(SESSION_STORAGE_KEY));
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
  }, []);

  const handleSave = useCallback(async () => {
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

  const handleExport = useCallback(() => {
    setShowExportDialog(true);
  }, []);

  // The page behind the export dialog is inert while it is open: `inert`
  // removes it from Tab order and the accessibility tree where supported,
  // aria-hidden covers the rest. The dialog itself is a sibling, outside.
  useEffect(() => {
    const shell = shellRef.current;
    if (!shell) return;
    shell.toggleAttribute('inert', showExportDialog);
    if (showExportDialog) shell.setAttribute('aria-hidden', 'true');
    else shell.removeAttribute('aria-hidden');
  }, [showExportDialog]);

  // Global keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const isInput = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable;

      // ? key to show shortcuts (only when not in input)
      if (e.key === '?' && !isInput) {
        e.preventDefault();
        setShowShortcuts(true);
        return;
      }

      // Escape to close dialogs. The export dialog handles its own Escape
      // (it owns focus while open), so it is not closed twice from here.
      if (e.key === 'Escape') {
        setShowShortcuts(false);
        return;
      }

      if (isInput) {
        return;
      }

      // Ctrl/Cmd shortcuts
      if (e.ctrlKey || e.metaKey) {
        // View switching: Ctrl+1-5
        if (e.key === '1') { e.preventDefault(); setView('design'); return; }
        if (e.key === '2') { e.preventDefault(); setView('data'); return; }
        if (e.key === '3') { e.preventDefault(); setView('preview'); return; }
        if (e.key === '4') { e.preventDefault(); setView('code'); return; }

        // File operations.
        //
        // Compared lower-cased, because `e.key` carries the shifted character:
        // with Shift down it is "E", never "e", so `e.key === 'e' && e.shiftKey`
        // was a condition that could not be satisfied and Ctrl+Shift+E — the
        // only route to Export anywhere in the app — never fired once. The same
        // trap catches the other three whenever Caps Lock is on.
        const key = e.key.toLowerCase();
        if (key === 'n' && !e.shiftKey) { e.preventDefault(); handleNew(); return; }
        if (key === 'o' && !e.shiftKey) { e.preventDefault(); handleOpen(); return; }
        if (key === 's' && !e.shiftKey) { e.preventDefault(); handleSave(); return; }
        if (key === 'e' && e.shiftKey) { e.preventDefault(); handleExport(); return; }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleNew, handleOpen, handleSave, handleExport]);

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
    if (activeFileType === 'logic' || activeFileType === 'asset') {
      if (view !== 'design') {
        setView('design');
      }
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
                  <button style={styles.collapsedRailBtn} onClick={() => setDockFiles(true)}>
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
                  <button style={styles.collapsedRailBtn} onClick={() => setDockComponents(true)}>
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
                          Select a file from the Files panel to start editing.
                        </div>
                      </div>
                    </div>
                  ) : isAssetFileActive ? (
                    activeAsset ? (
                      <div style={styles.assetPreview}>
                        <div style={styles.assetPreviewCard}>
                          <div style={{ fontWeight: 700, marginBottom: 4 }}>{activeAsset.name}</div>
                          <div style={styles.assetPreviewMeta}>
                            {activeAsset.type || mimeTypeFromPath(activeAsset.name)} | {(activeAsset.data.byteLength / 1024).toFixed(1)} KB
                          </div>
                          {activeAssetPreviewUrl ? (
                            <div style={styles.assetImageWrap}>
                              <img src={activeAssetPreviewUrl} alt={activeAsset.name} style={styles.assetImage} />
                            </div>
                          ) : (
                            <div style={styles.assetUnsupported}>
                              Preview is available for images (`png`, `jpg`, `jpeg`, `gif`, `webp`, `svg`, `bmp`).
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
                      <button style={styles.logicDockHideBtn} onClick={() => setDockLogic(false)}>
                        Hide
                      </button>
                    </div>
                    <LogicEditor />
                  </div>
                )}
                {hasActiveFile && !isLogicFileActive && !isAssetFileActive && !dockLogic && (
                  <div style={styles.collapsedLogicBar}>
                    <button style={styles.collapsedLogicBtn} onClick={() => setDockLogic(true)}>
                      Show Logic Panel
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
                  <button style={styles.collapsedRailBtn} onClick={() => setDockInspector(true)}>
                    Inspector
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
    return <NarrowScreenNotice studioUrl={STUDIO_URL} runtimeUrl={RUNTIME_URL} />;
  }

  return (
    <div style={styles.app}>
      {/* Everything behind the export dialog goes inert while it is open, so
          Tab and a screen reader cannot reach the page under it. */}
      <div ref={shellRef} style={styles.app}>
        {/* The same bar as the site, the runtime and Studio: the way between them. */}
        <ProductBar current="builder" />
        <Toolbar
          view={view}
          onViewChange={setView}
          onSave={handleSave}
          onNew={handleNew}
          onOpen={handleOpen}
          onShortcuts={() => setShowShortcuts(true)}
          onExport={handleExport}
          activeFileType={activeFileType}
        />

        {renderMainContent()}

        <div style={styles.statusBar}>
          <span>
            View: <span style={styles.statusStrong}>{view}</span>
          </span>
          <span>
            Elements: <span style={styles.statusStrong}>{elementCount}</span>
          </span>
          <span>
            Selected: <span style={styles.statusStrong}>{selectedCount}</span>
          </span>
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

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
import { encodeAsset, decodeAsset, type SerializedAssetFile } from './utils/sessionAssets';
import type {
  AssetFile,
  CanvasElement as CanvasElementType,
  EntityDef,
  LogicFileState,
  ProjectFileNode,
  RelationshipDef,
  UIFileState,
} from './types/builder';
import type { SerializedProject } from './stores/projectStore';
import { openBundleFile, loadBundle, type LoadedBundle } from './utils/bundleLoader';
import { saveBundleToFile } from './utils/bundleExporter';
import { buildProjectBundle, bundleFileName } from './utils/buildProjectBundle';
import { STUDIO_URL, RUNTIME_URL } from './utils/siteUrls';
import { ToastContainer } from './components/feedback/ToastContainer';
import { PwaUpdater } from './components/feedback/PwaUpdater';
import { toast } from './stores/notificationStore';
import { debug } from './utils/debug';
import { readLocalStorage, removeLocalStorage } from './utils/safeStorage';

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

type ViewMode = 'design' | 'preview' | 'code' | 'data';
const SESSION_STORAGE_KEY = 'softn.builder.session.v1';

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

interface SerializedUIFile extends Omit<UIFileState, 'elements'> {
  elements: [string, CanvasElementType][];
}

interface BuilderSession {
  savedAt: string;
  view: ViewMode | 'logic';
  project: SerializedProject;
  canvas: {
    elements: [string, CanvasElementType][];
    rootId: string;
    imports: UIFileState['imports'];
  };
  schema: {
    entities: EntityDef[];
    relationships: RelationshipDef[];
    seedData: [string, Record<string, unknown>[]][];
    selectedEntityId: string | null;
  };
  files: {
    nodes: [string, ProjectFileNode][];
    rootFolders: string[];
    uiFiles: [string, SerializedUIFile][];
    logicFiles: [string, LogicFileState][];
    /**
     * Assets, base64-encoded.
     *
     * These were omitted entirely, so restoring a session brought back a
     * project whose every `asset('logo.png')` resolved to nothing — images
     * and sounds silently gone, with the file tree still listing them.
     *
     * Base64 rather than the raw `Uint8Array`: JSON.stringify turns a byte
     * array into `{"0":80,"1":75,…}`, roughly seven bytes of text per byte of
     * asset, which would push almost any project past the storage quota.
     */
    assetFiles?: [string, SerializedAssetFile][];
    activeFileId: string | null;
    openTabs: string[];
  };
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

  const resetCanvas = useCanvasStore((state) => state.reset);
  const loadCanvasState = useCanvasStore((state) => state.loadState);
  const resetProject = useProjectStore((state) => state.reset);
  const setProjectName = useProjectStore((state) => state.setName);
  const setProjectVersion = useProjectStore((state) => state.setVersion);
  const setProjectDescription = useProjectStore((state) => state.setDescription);
  const setThemeMode = useProjectStore((state) => state.setThemeMode);
  const setLogicSource = useProjectStore((state) => state.setLogicSource);
  const setAssets = useProjectStore((state) => state.setAssets);
  const clearHistory = useHistoryStore((state) => state.clear);
  const resetSchema = useSchemaStore((state) => state.reset);
  const loadSchemaEntities = useSchemaStore((state) => state.loadEntities);
  const loadSeedData = useSchemaStore((state) => state.loadSeedData);
  const resetFiles = useFilesStore((state) => state.reset);
  const loadFromBundle = useFilesStore((state) => state.loadFromBundle);
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
   * Put a loaded bundle on the canvas, replacing whatever is there. The file
   * picker and a `?open=` link both end here; asking about unsaved work is
   * the caller's, since a fresh page has none.
   */
  const applyLoadedBundle = useCallback(async (bundle: LoadedBundle) => {
    try {
      // Reset everything first (including saved file handle)
      fileHandleRef.current = null;
      resetCanvas();
      resetProject();
      clearHistory();
      resetSchema();
      resetFiles();

      // Load project metadata from manifest
      setProjectName(bundle.manifest.name);
      setProjectVersion(bundle.manifest.version);
      setProjectDescription(bundle.manifest.description || '');
      setThemeMode(bundle.manifest.config?.theme?.mode || 'light');
      // What the bundle declared and the icon it carried come back with it,
      // so a save writes them out again rather than dropping them.
      useProjectStore.getState().setPermissions(bundle.permissions);
      useProjectStore.getState().setIcon(bundle.iconDataUrl);

      const loadedAssets: AssetFile[] = Array.from(bundle.assets.entries()).map(
        ([path, bytes]) => ({
          name: path.replace(/^assets\//, ''),
          type: mimeTypeFromPath(path),
          data: bytes,
        })
      );
      setAssets(loadedAssets);

      const assetFilesMap = new Map<string, AssetFile>();
      for (const asset of loadedAssets) {
        assetFilesMap.set(`assets/${asset.name}`, asset);
      }

      // Load files into filesStore
      loadFromBundle(bundle.uiFiles, bundle.logicFiles, assetFilesMap);

      // Load main UI file into canvas
      // Check both normalized path and manifest.main (which might have old-style path)
      const mainUIFile = Array.from(bundle.uiFiles.values()).find(
        (f) => f.path === 'ui/main.ui' || f.path === bundle.manifest.main
      );

      debug('[App] Looking for main UI file:', {
        manifestMain: bundle.manifest.main,
        uiFilePaths: Array.from(bundle.uiFiles.values()).map((f) => f.path),
        mainUIFileFound: !!mainUIFile,
        mainUIFileElements: mainUIFile?.elements?.size,
        mainUIFileRootId: mainUIFile?.rootId,
      });

      if (mainUIFile) {
        // Ensure the App component's theme prop matches the project themeMode
        const loadedTheme = bundle.manifest.config?.theme?.mode || 'light';
        const elements = new Map(mainUIFile.elements);
        const rootElement = elements.get(mainUIFile.rootId);

        debug('[App] Main UI file elements:', {
          elementsSize: elements.size,
          rootId: mainUIFile.rootId,
          rootElement: rootElement,
          allElementIds: Array.from(elements.keys()),
        });

        if (rootElement && rootElement.componentType === 'App') {
          elements.set(mainUIFile.rootId, {
            ...rootElement,
            props: { ...rootElement.props, theme: loadedTheme },
          });
        }
        loadCanvasState(elements, mainUIFile.rootId, mainUIFile.imports || []);
      } else {
        console.error('[App] Main UI file not found!');
      }

      // Load main logic file
      const mainLogicFile = Array.from(bundle.logicFiles.values()).find(
        (f) => f.path === 'logic/main.logic'
      );
      if (mainLogicFile) {
        setLogicSource(mainLogicFile.content);
      }

      // Load schema entities and seed data
      debug(
        '[App] Bundle entities:',
        bundle.entities.length,
        bundle.entities.map((e) => e.name)
      );
      debug('[App] Bundle seedData keys:', Array.from(bundle.seedData.keys()));
      debug(
        '[App] Bundle seedData sizes:',
        Array.from(bundle.seedData.entries()).map(([k, v]) => `${k}: ${v.length}`)
      );

      if (bundle.entities.length > 0) {
        loadSchemaEntities(bundle.entities);
        debug('[App] Loaded entities into schemaStore');
      }
      if (bundle.seedData.size > 0) {
        loadSeedData(bundle.seedData);
        debug('[App] Loaded seedData into schemaStore');
      }

      // Mark as clean since we just loaded
      useProjectStore.getState().markClean();

      // Show any bundle loading warnings
      if (bundle.warnings.length > 0) {
        console.warn('[App] Bundle loaded with warnings:', bundle.warnings);
        toast.warning(`Bundle loaded with ${bundle.warnings.length} warning(s)`);
      }

      toast.success(`Opened: ${bundle.manifest.name} v${bundle.manifest.version}`);
      debug(`[App] Opened: ${bundle.manifest.name} v${bundle.manifest.version}`);
    } catch (e) {
      console.error(`[App] Failed to open file:`, e);
      toast.error(`Failed to open file: ${e instanceof Error ? e.message : 'Unknown error'}`);
    }
  }, [
    resetCanvas,
    resetProject,
    clearHistory,
    resetSchema,
    resetFiles,
    setProjectName,
    setProjectVersion,
    setProjectDescription,
    setThemeMode,
    setLogicSource,
    setAssets,
    loadFromBundle,
    loadCanvasState,
    loadSchemaEntities,
    loadSeedData,
  ]);

  const handleOpen = useCallback(async () => {
    const bundle = await openBundleFile();
    if (!bundle) return;
    if (useProjectStore.getState().isDirty) {
      if (!window.confirm('Open a new project? Unsaved changes will be lost.')) return;
    }
    await applyLoadedBundle(bundle);
  }, [applyLoadedBundle]);

  // `?open=<bundle url>`: the site's app pages link here with the bundle to
  // edit. Same-origin .softn URLs only — the value comes from the address bar
  // and is not ours to trust — read once, on mount, and taken out of the
  // address bar so a reload does not open it a second time over edited work.
  const applyLoadedBundleRef = useRef(applyLoadedBundle);
  applyLoadedBundleRef.current = applyLoadedBundle;
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const open = params.get('open');
    if (!open) return;
    let url: URL;
    try {
      url = new URL(open, window.location.origin);
    } catch {
      return;
    }
    if (url.origin !== window.location.origin || !/\.softn$/i.test(url.pathname)) {
      toast.error('Only a .softn served by this site can be opened from a link.');
      return;
    }
    params.delete('open');
    const rest = params.toString();
    window.history.replaceState({}, '', window.location.pathname + (rest ? `?${rest}` : ''));
    void (async () => {
      try {
        const resp = await fetch(url.href, { credentials: 'same-origin' });
        if (!resp.ok) throw new Error(`${url.pathname} responded ${resp.status}`);
        const bundle = await loadBundle(new Uint8Array(await resp.arrayBuffer()));
        await applyLoadedBundleRef.current(bundle);
      } catch (e) {
        toast.error(`Could not open ${url.pathname}: ${e instanceof Error ? e.message : String(e)}`);
      }
    })();
  }, []);

  const handleSave = useCallback(async () => {
    try {
      const projectState = useProjectStore.getState();
      const canvasState = useCanvasStore.getState();
      const schemaState = useSchemaStore.getState();
      // The bundle as the export dialog and the pre-flight check build it:
      // canvas flushed, collections gathered, declaration and icon included.
      const bundleData = await buildProjectBundle();
      const updatedFilesState = useFilesStore.getState();

      const handle = await saveBundleToFile(bundleData, bundleFileName(projectState.name).replace(/\.softn$/, ''), fileHandleRef.current);
      fileHandleRef.current = handle;

      // 5. Also save session to localStorage for session restore
      const session: BuilderSession = {
        savedAt: new Date().toISOString(),
        view,
        project: projectState.toJSON(),
        canvas: {
          elements: Array.from(canvasState.elements.entries()),
          rootId: canvasState.rootId,
          imports: canvasState.imports || [],
        },
        schema: {
          entities: schemaState.entities,
          relationships: schemaState.relationships,
          seedData: Array.from(schemaState.seedData.entries()),
          selectedEntityId: schemaState.selectedEntityId,
        },
        files: {
          nodes: Array.from(updatedFilesState.nodes.entries()),
          rootFolders: updatedFilesState.rootFolders,
          uiFiles: Array.from(updatedFilesState.uiFiles.entries()).map(([id, file]) => [
            id,
            {
              ...file,
              elements: Array.from(file.elements.entries()),
            },
          ]),
          logicFiles: Array.from(updatedFilesState.logicFiles.entries()),
          assetFiles: Array.from(updatedFilesState.assetFiles.entries()).map(
            ([id, asset]) => [id, encodeAsset(asset)] as [string, SerializedAssetFile]
          ),
          activeFileId: updatedFilesState.activeFileId,
          openTabs: updatedFilesState.openTabs,
        },
      };
      // 6. Mark clean and toast.
      //
      // Before the session write, and with that write guarded separately: the
      // bundle is already on disk by this point, so a failure here is not a
      // failed save. The session payload embeds every UI file's elements,
      // every logic file, the icon data URL and all seed data, so a project
      // over the ~5 MB quota threw QuotaExceededError into the catch below —
      // reporting "Save failed" for a bundle that had saved perfectly, and
      // skipping markClean() so the project stayed dirty.
      projectState.markClean();
      toast.success(handle ? `Saved: ${handle.name}` : 'Bundle downloaded');
      debug('[App] Bundle saved to file');

      try {
        localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
      } catch (sessionError) {
        // Session restore is a convenience; losing it does not affect the file
        // the user just wrote.
        console.warn('[App] Could not store session for restore:', sessionError);
      }
    } catch (e) {
      // User cancelling the file picker throws an AbortError — ignore silently
      if (e instanceof DOMException && e.name === 'AbortError') return;
      console.error('[App] Failed to save:', e);
      toast.error(`Save failed: ${e instanceof Error ? e.message : 'Unknown error'}`);
    }
  }, [view]);

  const handleExport = useCallback(() => {
    setShowExportDialog(true);
  }, []);

  useEffect(() => {
    const raw = readLocalStorage(SESSION_STORAGE_KEY);
    if (!raw) return;

    try {
      const session = JSON.parse(raw) as BuilderSession;
      if (!session?.canvas || !session?.files || !session?.project) return;

      const shouldRestore = window.confirm('Restore the last locally saved builder session?');
      if (!shouldRestore) return;

      resetCanvas();
      resetProject();
      clearHistory();
      resetSchema();
      resetFiles();

      useProjectStore.getState().fromJSON(session.project);

      const restoredCanvasElements = new Map<string, CanvasElementType>(session.canvas.elements);
      loadCanvasState(restoredCanvasElements, session.canvas.rootId, session.canvas.imports || []);

      useSchemaStore.setState({
        entities: session.schema.entities || [],
        relationships: session.schema.relationships || [],
        selectedEntityId: session.schema.selectedEntityId || session.schema.entities?.[0]?.id || null,
        seedData: new Map(session.schema.seedData || []),
      });

      const restoredUIFiles = new Map<string, UIFileState>(
        (session.files.uiFiles || []).map(([id, file]) => [
          id,
          { ...file, elements: new Map<string, CanvasElementType>(file.elements) },
        ])
      );

      useFilesStore.setState({
        nodes: new Map(session.files.nodes || []),
        rootFolders: session.files.rootFolders || [],
        uiFiles: restoredUIFiles,
        logicFiles: new Map(session.files.logicFiles || []),
        // Sessions written before assets were persisted have no entry here.
        assetFiles: new Map(
          (session.files.assetFiles || []).map(([id, asset]) => [id, decodeAsset(asset)])
        ),
        activeFileId: session.files.activeFileId || null,
        openTabs: session.files.openTabs || [],
      });

      setView(session.view === 'logic' ? 'design' : (session.view || 'design'));
      toast.success('Restored previous local session');
      debug('[App] Restored session from localStorage');
    } catch (e) {
      console.error('[App] Failed to restore session:', e);
      removeLocalStorage(SESSION_STORAGE_KEY);
    }
  }, [clearHistory, loadCanvasState, resetCanvas, resetFiles, resetProject, resetSchema]);

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

      // Escape to close dialogs
      if (e.key === 'Escape') {
        setShowShortcuts(false);
        setShowExportDialog(false);
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

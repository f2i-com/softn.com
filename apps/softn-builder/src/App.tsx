/**
 * SoftN Builder - Main Application
 */

import React, { useState, useCallback, useEffect, useRef } from 'react';
import { Toolbar } from './components/toolbar/Toolbar';
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
import { openBundleFile } from './utils/bundleLoader';
import { exportBundle, exportMultiFileBundle, saveBundleToFile } from './utils/bundleExporter';
import { ToastContainer } from './components/feedback/ToastContainer';
import { toast } from './stores/notificationStore';
import { debug } from './utils/debug';

const styles: Record<string, React.CSSProperties> = {
  app: {
    height: '100vh',
    display: 'flex',
    flexDirection: 'column',
    background: '#f8fafc',
  },
  main: {
    flex: 1,
    display: 'flex',
    overflow: 'hidden',
    minHeight: 0, // Important for flex scroll
    gap: 8,
    padding: 8,
    background: 'linear-gradient(180deg, #f8fafc 0%, #f1f5f9 100%)',
  },
  leftPanel: {
    display: 'flex',
    flexDirection: 'column',
    border: '1px solid #e2e8f0',
    borderRadius: 10,
    overflow: 'hidden',
    width: 260,
    minWidth: 260,
    background: '#fff',
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
    border: '1px solid #e2e8f0',
    borderRadius: 10,
    background: '#fff',
  },
  centerTop: {
    flex: 1,
    overflow: 'auto',
    minHeight: 0, // Important for flex scroll
  },
  centerBottom: {
    height: 250,
    borderTop: '1px solid #e2e8f0',
    overflow: 'hidden',
    background: '#fff',
  },
  rightPanel: {
    display: 'flex',
    flexDirection: 'column',
    width: 320,
    minWidth: 320,
    border: '1px solid #e2e8f0',
    borderRadius: 10,
    background: '#fff',
    overflow: 'hidden',
  },
  rightPanelTop: {
    flex: 1,
    overflow: 'hidden',
  },
  rightPanelBottom: {
    borderTop: '1px solid #e2e8f0',
    maxHeight: '45%',
    overflow: 'auto',
  },
  fullHeight: {
    height: '100%',
  },
  statusBar: {
    height: 30,
    borderTop: '1px solid #e2e8f0',
    background: '#ffffff',
    display: 'flex',
    alignItems: 'center',
    gap: 16,
    padding: '0 12px',
    fontSize: 12,
    color: '#64748b',
  },
  statusStrong: {
    color: '#0f172a',
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
    border: '1px solid #e2e8f0',
    borderRadius: 10,
    background: '#fff',
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
    border: '1px solid #e2e8f0',
    borderRadius: 10,
    background: '#fff',
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
    border: '1px solid #cbd5e1',
    background: '#f8fafc',
    color: '#475569',
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
    borderTop: '1px solid #e2e8f0',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'flex-end',
    padding: '0 8px',
    background: '#f8fafc',
  },
  collapsedLogicBtn: {
    border: '1px solid #cbd5e1',
    background: '#fff',
    color: '#475569',
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
    borderBottom: '1px solid #e2e8f0',
    background: '#f8fafc',
  },
  logicDockTitle: {
    fontSize: 11,
    color: '#64748b',
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
    fontWeight: 700,
  },
  logicDockHideBtn: {
    border: '1px solid #cbd5e1',
    background: '#fff',
    color: '#64748b',
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
    color: '#64748b',
  },
  emptyFileTitle: {
    fontSize: 16,
    fontWeight: 600,
    color: '#334155',
    marginBottom: 6,
  },
  emptyFileHint: {
    fontSize: 13,
    color: '#64748b',
  },
  assetPreview: {
    height: '100%',
    overflow: 'auto',
    padding: 18,
    background: '#f8fafc',
  },
  assetPreviewCard: {
    background: '#fff',
    border: '1px solid #e2e8f0',
    borderRadius: 10,
    padding: 14,
    maxWidth: 900,
    margin: '0 auto',
  },
  assetPreviewMeta: {
    fontSize: 12,
    color: '#64748b',
    marginBottom: 12,
  },
  assetImageWrap: {
    border: '1px solid #e2e8f0',
    borderRadius: 8,
    background: '#fff',
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
    color: '#64748b',
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
    activeFileId: string | null;
    openTabs: string[];
  };
}

function App() {
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

  const handleOpen = useCallback(async () => {
    try {
      const bundle = await openBundleFile();
      if (!bundle) return;

      // Confirm if there are unsaved changes
      const isDirty = useProjectStore.getState().isDirty;
      if (isDirty) {
        if (!window.confirm('Open a new project? Unsaved changes will be lost.')) {
          return;
        }
      }

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

  const handleSave = useCallback(async () => {
    try {
      const projectState = useProjectStore.getState();
      const canvasState = useCanvasStore.getState();
      const schemaState = useSchemaStore.getState();
      const filesState = useFilesStore.getState();

      // 1. Flush current canvas state to the active UI file
      if (filesState.activeFileId) {
        const activeNode = filesState.nodes.get(filesState.activeFileId);
        if (activeNode?.type === 'file' && activeNode.fileType === 'ui') {
          filesState.updateUIFile(filesState.activeFileId, canvasState.elements, canvasState.rootId);
        }
      }

      // Re-read filesState after flush
      const updatedFilesState = useFilesStore.getState();

      // 2. Build collections from schema entities (same logic as ExportDialog)
      const schemaCollections: import('./types/builder').CollectionDef[] = schemaState.entities.map((entity) => ({
        name: entity.name,
        alias: entity.alias,
        fields: entity.fields,
        seedData: schemaState.seedData.get(entity.id) || [],
      }));
      const schemaNames = new Set(schemaCollections.map((c) => c.name));
      const manualCollections = projectState.collections.filter((c) => !schemaNames.has(c.name));
      const collections = [...schemaCollections, ...manualCollections];

      // 3. Determine single-file vs multi-file export
      const hasMultipleFiles =
        updatedFilesState.uiFiles.size > 0 &&
        Array.from(updatedFilesState.uiFiles.values()).some((f) => f.originalSource !== undefined);

      let bundleData: Uint8Array;

      if (hasMultipleFiles) {
        bundleData = await exportMultiFileBundle({
          name: projectState.name,
          version: projectState.version,
          description: projectState.description,
          themeMode: projectState.themeMode,
          uiFiles: updatedFilesState.uiFiles,
          logicFiles: updatedFilesState.logicFiles,
          collections,
          assets: projectState.assets,
        });
      } else {
        bundleData = await exportBundle({
          name: projectState.name,
          version: projectState.version,
          description: projectState.description,
          themeMode: projectState.themeMode,
          elements: canvasState.elements,
          rootId: canvasState.rootId,
          logicSource: projectState.logicSource,
          collections,
          assets: projectState.assets,
        });
      }

      // 4. Save to file
      const safeName = projectState.name.replace(/\s+/g, '-').toLowerCase() || 'untitled';
      const handle = await saveBundleToFile(bundleData, safeName, fileHandleRef.current);
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
          activeFileId: updatedFilesState.activeFileId,
          openTabs: updatedFilesState.openTabs,
        },
      };
      localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));

      // 6. Mark clean and toast
      projectState.markClean();
      toast.success(handle ? `Saved: ${handle.name}` : 'Bundle downloaded');
      debug('[App] Bundle saved to file');
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
    const raw = localStorage.getItem(SESSION_STORAGE_KEY);
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
        activeFileId: session.files.activeFileId || null,
        openTabs: session.files.openTabs || [],
      });

      setView(session.view === 'logic' ? 'design' : (session.view || 'design'));
      toast.success('Restored previous local session');
      debug('[App] Restored session from localStorage');
    } catch (e) {
      console.error('[App] Failed to restore session:', e);
      localStorage.removeItem(SESSION_STORAGE_KEY);
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

        // File operations
        if (e.key === 'n' && !e.shiftKey) { e.preventDefault(); handleNew(); return; }
        if (e.key === 'o' && !e.shiftKey) { e.preventDefault(); handleOpen(); return; }
        if (e.key === 's' && !e.shiftKey) { e.preventDefault(); handleSave(); return; }
        if (e.key === 'e' && e.shiftKey) { e.preventDefault(); handleExport(); return; }
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
    }
    previousActiveFileIdRef.current = activeFileId;
  }, [activeFileId, fileNodes, updateUIFile, canvasElements, canvasRootId]);

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
                      <span style={styles.logicDockTitle}>Logic Panel</span>
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

  return (
    <div style={styles.app}>
      <Toolbar
        view={view}
        onViewChange={setView}
        onSave={handleSave}
        onNew={handleNew}
        onOpen={handleOpen}
        onShortcuts={() => setShowShortcuts(true)}
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
    </div>
  );
}

export default App;

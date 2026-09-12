/**
 * LivePreview - Real-time SoftN renderer
 */

import React, { useMemo, useState, useEffect, useRef, Component, ErrorInfo, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useCanvasStore } from '../../stores/canvasStore';
import { useProjectStore } from '../../stores/projectStore';
import { useFilesStore } from '../../stores/filesStore';
import { generateSource } from '../../utils/sourceGenerator';
import { useSchemaStore } from '../../stores/schemaStore';
import { debug } from '../../utils/debug';
import { buildPermissionJson } from '../../utils/permissions';
import type { CollectionDef, UIFileState } from '../../types/builder';
import { composePreviewBundle } from '../../utils/previewBundle';
import type { PermissionConfig } from '@softn/core';
import { envelopeFor } from '../../utils/xdbFormat';
import type { PreviewRuntimeProps } from './PreviewRuntime';

// Error boundary to catch rendering errors in the preview
interface ErrorBoundaryProps {
  children: ReactNode;
  fallback: (error: Error) => ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

class PreviewErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('[LivePreview] Render error:', error, errorInfo);
  }

  render() {
    if (this.state.hasError && this.state.error) {
      return this.props.fallback(this.state.error);
    }
    return this.props.children;
  }
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    height: '100%',
    display: 'flex',
    flexDirection: 'column',
    background: 'var(--ink)',
  },
  header: {
    padding: '8px 16px',
    borderBottom: '1px solid var(--line-soft)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    background: 'var(--ink-2)',
    flexWrap: 'wrap',
    gap: 8,
  },
  title: {
    fontWeight: 600,
    fontSize: 13,
    color: 'var(--paper)',
  },
  controls: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
  },
  deviceButton: {
    padding: '6px 10px',
    minHeight: 36,
    background: 'transparent',
    border: '1px solid var(--line-soft)',
    borderRadius: 4,
    fontSize: 11,
    cursor: 'pointer',
    color: 'var(--dim)',
  },
  deviceButtonActive: {
    background: 'var(--coral)',
    border: '1px solid var(--coral)',
    color: '#fff',
  },
  previewWrapper: {
    flex: 1,
    overflow: 'hidden',
    padding: 8,
    display: 'flex',
    alignItems: 'stretch',
    justifyContent: 'center',
  },
  previewFrame: {
    background: '#fff',
    borderRadius: 8,
    boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
    overflow: 'hidden',
    transition: 'width 0.3s ease',
    display: 'flex',
    flexDirection: 'column',
  },
  previewContent: {
    flex: 1,
    overflow: 'auto',
  },
  error: {
    padding: 24,
    color: '#ef4444',
    background: '#fef2f2',
    borderRadius: 8,
    margin: 16,
  },
  loading: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    height: '100%',
    color: 'var(--dimmer)',
  },
  infoBanner: {
    margin: '10px 10px 0',
    padding: '8px 10px',
    borderRadius: 8,
    border: '1px solid var(--mint-edge)',
    background: 'var(--mint-glow-soft)',
    color: 'var(--coral)',
    fontSize: 12,
  },
  emptyState: {
    height: '100%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: 'var(--dim)',
    fontSize: 13,
    textAlign: 'center',
    padding: 20,
  },
};

type DevicePreset = 'desktop' | 'tablet' | 'mobile';

const deviceDimensions: Record<DevicePreset, { width: number; height: number }> = {
  desktop: { width: 1440, height: 900 },
  tablet: { width: 768, height: 1024 },
  mobile: { width: 390, height: 844 },
};

// Threshold for warning (very large UIs)
const WARN_ELEMENTS_THRESHOLD = 500;
const WARN_SOURCE_LENGTH_THRESHOLD = 100000;

function extractFirstBlock(source: string, regex: RegExp): string | null {
  const m = source.match(regex);
  return m ? m[0].trim() : null;
}

function extractAllBlocks(source: string, regex: RegExp): string[] {
  return Array.from(source.matchAll(regex)).map((m) => m[0].trim()).filter(Boolean);
}

function mergeGeneratedTemplateIntoSource(
  originalSource: string | undefined,
  generatedSource: string
): string {
  const generatedDataBlock = extractFirstBlock(generatedSource, /<data>[\s\S]*?<\/data>/i);
  const generatedLogicBlock = extractFirstBlock(generatedSource, /<logic>[\s\S]*?<\/logic>/i);
  const templateOnly = generatedSource
    .replace(/<data>[\s\S]*?<\/data>/gi, '')
    .replace(/<logic>[\s\S]*?<\/logic>/gi, '')
    .trim();

  if (!originalSource) {
    return generatedSource;
  }

  const preservedLogicSrc = extractFirstBlock(
    originalSource,
    /<logic\s+src=["'][^"']+["']\s*\/>/i
  );
  const preservedInlineLogic = extractFirstBlock(
    originalSource,
    /<logic>[\s\S]*?<\/logic>/i
  );
  const preservedImports = extractAllBlocks(
    originalSource,
    /<import\s+(?:\{\s*[^}]+\s*\}|\w+)\s+from=["'][^"']+["']\s*\/>/gi
  );
  const preservedData = extractFirstBlock(
    originalSource,
    /<data>[\s\S]*?<\/data>/i
  );
  const preservedStyles = extractAllBlocks(
    originalSource,
    /<style>[\s\S]*?<\/style>/gi
  );

  // Prefer original logic blocks over generated; fallback to generated so
  // logic isn't silently lost for files without explicit logic references.
  const logicBlock = preservedLogicSrc || preservedInlineLogic || generatedLogicBlock;

  // Prefer original <data> block (preserves sort/limit/collection format)
  // over the generated one which may use a simplified format.
  const dataBlock = preservedData || generatedDataBlock;

  const headerBlocks = [
    logicBlock,
    preservedImports.length > 0 ? preservedImports.join('\n') : null,
    dataBlock,
    ...preservedStyles,
  ].filter((block): block is string => Boolean(block && block.trim()));

  return [headerBlocks.join('\n\n'), templateOnly].filter(Boolean).join('\n\n').trim();
}

/**
 * Resolve a relative path from a source file path
 */
function resolveRelativePath(fromPath: string, relativePath: string): string {
  // Get directory of the source file
  const parts = fromPath.split('/');
  parts.pop(); // Remove filename
  const dir = parts;

  // Handle relative path
  const relParts = relativePath.split('/');
  for (const part of relParts) {
    if (part === '..') {
      dir.pop();
    } else if (part !== '.') {
      dir.push(part);
    }
  }

  return dir.join('/');
}

interface DeviceViewportProps {
  width: number;
  height: number;
  children: ReactNode;
}

function DeviceViewport({ width, height, children }: DeviceViewportProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [scale, setScale] = useState(1);
  const [mountNode, setMountNode] = useState<HTMLElement | null>(null);

  useEffect(() => {
    const updateScale = () => {
      const container = containerRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      const nextScale = Math.min(rect.width / width, rect.height / height, 1);
      setScale(Number.isFinite(nextScale) && nextScale > 0 ? nextScale : 1);
    };

    updateScale();
    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined' && containerRef.current) {
      observer = new ResizeObserver(() => updateScale());
      observer.observe(containerRef.current);
    }
    window.addEventListener('resize', updateScale);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', updateScale);
    };
  }, [width, height]);

  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;

    const doc = iframe.contentDocument;
    if (!doc) return;

    doc.open();
    doc.write(`<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>
      html, body, #softn-preview-root {
        width: 100%;
        height: 100%;
        margin: 0;
        padding: 0;
      }
      body {
        overflow: auto;
        background: #fff;
      }
    </style>
  </head>
  <body>
    <div id="softn-preview-root"></div>
  </body>
</html>`);
    doc.close();
    setMountNode(doc.getElementById('softn-preview-root'));
  }, []);

  return (
    <div
      ref={containerRef}
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <div
        style={{
          width: `${Math.round(width * scale)}px`,
          height: `${Math.round(height * scale)}px`,
          borderRadius: 12,
          overflow: 'hidden',
          border: '1px solid var(--line)',
          boxShadow: '0 16px 32px rgba(15, 23, 42, 0.16)',
          background: '#fff',
          flexShrink: 0,
        }}
      >
        <iframe
          ref={iframeRef}
          title="Device Preview"
          style={{
            width: `${width}px`,
            height: `${height}px`,
            border: 0,
            transform: `scale(${scale})`,
            transformOrigin: 'top left',
          }}
        />
      </div>
      {mountNode ? createPortal(children, mountNode) : null}
    </div>
  );
}

export function LivePreview({ initialDevice = 'desktop' }: { initialDevice?: DevicePreset }) {
  const { elements, rootId } = useCanvasStore();
  const { projectId, logicSource, collections: projectCollections, themeMode, permissions, source: retainedSource, assets: projectAssets } = useProjectStore();
  // The preview runs under the project's own declaration, as the runtime
  // will: a call the app has not declared fails here too, not first in the
  // runtime after export.
  const previewPermissionConfig = useMemo<PermissionConfig | undefined>(() => {
    const json = buildPermissionJson(permissions);
    return json ? (JSON.parse(json) as PermissionConfig) : undefined;
  }, [permissions]);
  const { entities, seedData, recordIdentity } = useSchemaStore();
  const { activeFileId, uiFiles, logicFiles, assetFiles, nodes } = useFilesStore();
  const previewAssets = useMemo(() => new Map(
    retainedSource.manifest !== null || assetFiles.size > 0
      ? [...assetFiles.entries()].map(([id, asset]) => [nodes.get(id)?.path ?? asset.bundlePath ?? asset.name, asset] as const)
      : projectAssets.map((asset) => [asset.bundlePath ?? `assets/${asset.name}`, asset] as const)
  ), [retainedSource.manifest, assetFiles, nodes, projectAssets]);
  const [device, setDevice] = useState<DevicePreset>(initialDevice);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [forceRender, setForceRender] = useState(false);
  const [PreviewComponent, setPreviewComponent] = useState<React.ComponentType<PreviewRuntimeProps> | null>(null);
  const [previewRecordsFor, setPreviewRecordsFor] = useState<typeof import('./PreviewRuntime').previewRecordsFor | null>(null);
  const [ThemeProviderComponent, setThemeProviderComponent] = useState<React.ComponentType<{
    darkMode?: boolean;
    followSystem?: boolean;
    children: React.ReactNode;
  }> | null>(null);
  const [sourceInfo, setSourceInfo] = useState<string | null>(null);

  // Mount indicator
  useEffect(() => {
    debug('[LivePreview] Component mounted');
  }, []);

  // Reset forceRender when source changes significantly
  useEffect(() => {
    setForceRender(false);
  }, [rootId]);

  // Merge schema entities with project collections
  const collections = useMemo((): CollectionDef[] => {
    debug('[LivePreview] Building collections from entities:', {
      entityCount: entities.length,
      entityIds: entities.map((e) => e.id),
      seedDataKeys: Array.from(seedData.keys()),
      seedDataSizes: Array.from(seedData.entries()).map(([k, v]) => `${k}: ${v.length} records`),
      projectCollectionsCount: projectCollections.length,
      projectCollectionsWithFullRecords: projectCollections
        .filter((c) => c.fullRecords?.length)
        .map((c) => c.name),
    });

    const schemaCollections: CollectionDef[] = entities.map((entity) => {
      const entitySeedData = seedData.get(entity.id) || [];
      // Current editable rows win over the original imported snapshot.
      const fullRecords = entitySeedData.map((data, index) => envelopeFor(entity.name, data, recordIdentity.get(entity.id)?.[index]));

      debug(
        `[LivePreview] Entity "${entity.name}" (id=${entity.id}): ${entitySeedData.length} records, fullRecords: ${fullRecords?.length || 0}`
      );
      return {
        name: entity.name,
        alias: entity.alias,
        fields: entity.fields,
        seedData: entitySeedData,
        fullRecords, // Current Data edits with their stable imported identities
      };
    });
    const schemaNames = new Set(schemaCollections.map((c) => c.name));
    const manualCollections = projectCollections.filter((c) => !schemaNames.has(c.name));
    return [...schemaCollections, ...manualCollections];
  }, [entities, seedData, recordIdentity, projectCollections]);
  const previewRecords = useMemo(() => previewRecordsFor?.(collections) ?? {}, [previewRecordsFor, collections]);

  // Get source - prioritize ui/main.ui for stable preview behavior.
  // IMPORTANT: useMemo must be a pure computation — no setState calls.
  // Errors and info are returned as part of the result and synced via useEffect.
  const previewState = useMemo<{
    source: string; activeFilePath: string; info: string | null; error: string | null;
    composition?: ReturnType<typeof composePreviewBundle>;
  }>(() => {
    let rawSource = '';
    let activeFilePath = '';
    let info: string | null = null;
    let errorMsg: string | null = null;
    const mainUIFile = (retainedSource.mainFileId ? uiFiles.get(retainedSource.mainFileId) : undefined)
      ?? Array.from(uiFiles.values()).find((file) => file.path === retainedSource.manifest?.main || file.path === 'ui/main.ui');
    const activeNode = activeFileId ? nodes.get(activeFileId) : null;
    const activeUIFile =
      activeFileId && activeNode?.type === 'file' && activeNode.fileType === 'ui'
        ? uiFiles.get(activeFileId)
        : undefined;

    // Prefer active UI file for immediate feedback; fallback to main.ui for stability.
    const primaryUIFile = activeUIFile || mainUIFile;
    const isMainFallback = !activeUIFile && !!mainUIFile;

    // Resolve file-specific logic source for the active UI file when possible.
    const resolveLinkedLogicSource = () => {
      if (!activeUIFile?.logicSrc) {
        return logicSource;
      }

      const sourcePath = activeUIFile.logicSrc;
      const resolvedPath = resolveRelativePath(activeUIFile.path, sourcePath);
      const pathsToTry = [
        resolvedPath,
        resolvedPath.replace(/^\//, ''),
        sourcePath.replace(/^\.\//, ''),
        sourcePath,
      ];

      if (activeUIFile.path.startsWith('ui/') && sourcePath.startsWith('./')) {
        pathsToTry.push(`logic/${sourcePath.slice(2)}`);
      }

      for (const [, logicFile] of logicFiles) {
        if (pathsToTry.includes(logicFile.path)) {
          return logicFile.content;
        }
      }

      return logicSource;
    };

    const resolveImportedFileSource = (file: UIFileState): string => {
      if (file.originalSource !== undefined) {
        return file.originalSource;
      }
      // For files without originalSource, generate from canvas elements.
      // Use skipRootAppWrapper so we don't inject <App> into components
      // that had a different root element (Header.ui, Dashboard.ui, etc.).
      const generated = generateSource(file.elements, file.rootId, '', [], {
        skipRootAppWrapper: true,
      });
      return mergeGeneratedTemplateIntoSource(file.originalSource, generated);
    };

    // Authored source is authoritative, including constructs the canvas cannot
    // represent. The view switch flushes accepted canvas edits before preview.
    // Rebuilding a source-only file here loses mixed text and can show stale code.
    if (primaryUIFile?.originalSource !== undefined) {
      rawSource = primaryUIFile.originalSource;
      activeFilePath = primaryUIFile.path;
      if (!rawSource.trim()) return { source: '', activeFilePath, info: 'This UI file is empty. Add source in Code view to preview it.', error: null };
    }
    if (primaryUIFile && activeUIFile && primaryUIFile.id === activeUIFile.id && primaryUIFile.originalSource === undefined) {
      try {
        const fileLogicSource = resolveLinkedLogicSource();
        const generatedSource = generateSource(elements, rootId, fileLogicSource, collections);
        rawSource = mergeGeneratedTemplateIntoSource(activeUIFile.originalSource, generatedSource);
        activeFilePath = activeUIFile.path;
      } catch (err) {
        console.error('[LivePreview] Error generating live source from canvas:', err);
        errorMsg = err instanceof Error ? err.message : 'Failed to generate source';
        return { source: '', activeFilePath: '', info, error: errorMsg };
      }
    }

    if (!rawSource && primaryUIFile?.originalSource) {
      debug('[LivePreview] Using originalSource for preview:', {
        path: primaryUIFile.path,
        sourceLength: primaryUIFile.originalSource.length,
      });
      rawSource = primaryUIFile.originalSource;
      activeFilePath = primaryUIFile.path;
      if (isMainFallback) {
        info = 'Preview is showing ui/main.ui because no active UI file is selected.';
      }
    }

    // If UI file exists but no raw source, generate from that file's canvas snapshot.
    if (!rawSource) {
      const fileToGenerate = primaryUIFile;
      if (fileToGenerate) {
        debug('[LivePreview] Generating source from UI file state:', {
          path: fileToGenerate.path,
          elementsSize: fileToGenerate.elements.size,
          rootId: fileToGenerate.rootId,
        });
        try {
          rawSource = generateSource(
            fileToGenerate.elements,
            fileToGenerate.rootId,
            logicSource,
            collections
          );
          activeFilePath = fileToGenerate.path;
          if (isMainFallback && fileToGenerate.path === 'ui/main.ui') {
            info = 'Preview is showing ui/main.ui because no active UI file is selected.';
          }
        } catch (err) {
          console.error('[LivePreview] Error generating source from UI file state:', err);
          errorMsg = err instanceof Error ? err.message : 'Failed to generate source';
          return { source: '', activeFilePath: '', info, error: errorMsg };
        }
      }
    }

    // Final fallback: generate source from currently loaded canvas state
    if (!rawSource) {
      debug('[LivePreview] Generating source from canvas:', {
        elementsSize: elements.size,
        rootId,
        hasLogic: !!logicSource,
        collectionsCount: collections.length,
      });
      try {
        rawSource = generateSource(elements, rootId, logicSource, collections);
        debug('[LivePreview] Generated source length:', rawSource.length);
        if (activeFileId && !uiFiles.has(activeFileId)) {
          info = 'Preview is showing canvas-generated source because no UI file source is available.';
        }
      } catch (err) {
        console.error('[LivePreview] Error generating source:', err);
        errorMsg = err instanceof Error ? err.message : 'Failed to generate source';
        return { source: '', activeFilePath: '', info, error: errorMsg };
      }
    }

    try {
      const mainPath = activeFilePath || 'ui/main.ui';
      const files = new Map([...uiFiles.values()].map((file) => [file.path, resolveImportedFileSource(file)]));
      for (const file of logicFiles.values()) files.set(file.path, file.content);
      files.set(mainPath, rawSource);
      const composition = composePreviewBundle(files, mainPath, retainedSource.manifest);
      return { source: composition.source, activeFilePath, info, error: null, composition };
    } catch (err) {
      return { source: '', activeFilePath, info, error: err instanceof Error ? err.message : 'Could not prepare the preview.' };
    }
  }, [elements, rootId, logicSource, collections, activeFileId, uiFiles, logicFiles, nodes, retainedSource]);
  const source = previewState.source;

  // Sync error and info from the pure useMemo result into component state.
  useEffect(() => {
    setError(previewState.error);
    setSourceInfo(previewState.info);
  }, [previewState.error, previewState.info]);

  // Dynamically import SoftN renderer and ThemeProvider
  useEffect(() => {
    let active = true;
    const loadRenderer = async () => {
      setIsLoading(true);
      try {
        const preview = await import('./PreviewRuntime');
        if (!active) return;
        setPreviewComponent(() => preview.PreviewRuntime);
        setPreviewRecordsFor(() => preview.previewRecordsFor);
      } catch (e) {
        // If import fails, show placeholder
        console.error('[LivePreview] Failed to load @softn/core:', e);
        if (active) setPreviewComponent(null);
      }

      if (!active) return;
      try {
        // Import ThemeProvider from @softn/components
        const components = await import('@softn/components');
        debug('[LivePreview] Loaded @softn/components ThemeProvider');
        if (active) setThemeProviderComponent(() => components.ThemeProvider);
      } catch (e) {
        console.error('[LivePreview] Failed to load ThemeProvider:', e);
        if (active) setThemeProviderComponent(null);
      }
      if (active) setIsLoading(false);
    };
    loadRenderer();
    return () => {
      active = false;
    };
  }, []);

  const dimensions = deviceDimensions[device];

  // Determine if dark mode based on themeMode setting
  const isDarkMode =
    themeMode === 'dark' ||
    (themeMode === 'system' &&
      typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-color-scheme: dark)').matches);

  const renderError = (err: Error) => (
    <div style={styles.error}>
      <div style={{ fontWeight: 600, marginBottom: 8 }}>Preview Error</div>
      <div style={{ fontFamily: 'monospace', fontSize: 12 }}>{err.message}</div>
      <details style={{ marginTop: 12 }}>
        <summary style={{ cursor: 'pointer' }}>Stack trace</summary>
        <pre style={{ fontSize: 10, overflow: 'auto', maxHeight: 200 }}>{err.stack}</pre>
      </details>
    </div>
  );

  // Check if content is very large (just for warning, will still render)
  const isVeryLarge =
    elements.size > WARN_ELEMENTS_THRESHOLD || source.length > WARN_SOURCE_LENGTH_THRESHOLD;
  const shouldRender = !isVeryLarge || forceRender;

  const renderContent = () => {
    debug('[LivePreview] renderContent called:', {
      hasError: !!error,
      hasPreviewComponent: !!PreviewComponent,
      hasThemeProvider: !!ThemeProviderComponent,
      sourceLength: source.length,
      elementsCount: elements.size,
      isLoading,
      isVeryLarge,
      shouldRender,
    });

    if (isLoading) {
      return (
        <div style={styles.loading}>
          <div style={{ textAlign: 'center' }}>
            <div style={{ marginBottom: 8 }}>Loading preview...</div>
            <div style={{ fontSize: 11, color: 'var(--dimmer)' }}>Initializing renderer</div>
          </div>
        </div>
      );
    }

    if (error) {
      return <div style={styles.error}>{error}</div>;
    }

    if (!source.trim()) {
      return (
        <div style={styles.emptyState}>
          <div>
            <div style={{ fontWeight: 600, marginBottom: 6 }}>No previewable UI source</div>
            <div>Create or open `ui/main.ui` to preview this project.</div>
          </div>
        </div>
      );
    }

    // Show warning for very large UIs (500+ elements or 100KB+)
    if (isVeryLarge && !forceRender) {
      return (
        <div style={{ padding: 24, textAlign: 'center' }}>
          <div style={{ fontSize: 20, marginBottom: 16, color: '#f59e0b' }}>Warning</div>
          <div style={{ fontWeight: 600, marginBottom: 8, color: 'var(--paper)' }}>Large Preview</div>
          <div style={{ color: 'var(--dim)', marginBottom: 16, fontSize: 13 }}>
            This UI has {elements.size} elements ({source.length.toLocaleString()} characters).
            <br />
            Rendering may be slow or cause memory issues.
          </div>
          <button
            onClick={() => setForceRender(true)}
            style={{
              padding: '8px 16px',
              background: 'var(--coral)',
              color: '#fff',
              border: 'none',
              borderRadius: 6,
              cursor: 'pointer',
              fontSize: 13,
              marginRight: 8,
            }}
          >
            Render Anyway
          </button>
          <button
            onClick={() => {
              // Show source instead
              const sourceWindow = window.open('', '_blank');
              if (sourceWindow) {
                sourceWindow.document.write(
                  `<pre style="white-space:pre-wrap;font-size:12px;padding:20px;">${source.replace(/</g, '&lt;')}</pre>`
                );
              }
            }}
            style={{
              padding: '8px 16px',
              background: 'var(--line-soft)',
              color: 'var(--dim)',
              border: 'none',
              borderRadius: 6,
              cursor: 'pointer',
              fontSize: 13,
            }}
          >
            View Source
          </button>
        </div>
      );
    }

    if (PreviewComponent && shouldRender) {
      // The canonical parser handles comments. Regex removal also removes
      // comment-looking text inside strings, changing the running program.
      const cleanSource = source;
      debug(
        '[LivePreview] Rendering PreviewComponent with source length:',
        cleanSource.length
      );

      const loadingFallback = (
        <div style={{ padding: 24, textAlign: 'center', color: 'var(--dim)' }}>
          <div style={{ marginBottom: 8 }}>Rendering preview...</div>
          <div style={{ fontSize: 11 }}>Parsing {source.length.toLocaleString()} characters</div>
        </div>
      );

      const errorFallback = (err: Error) => (
        <div style={styles.error}>
          <div style={{ fontWeight: 600, marginBottom: 8 }}>Render Error</div>
          <div style={{ fontFamily: 'monospace', fontSize: 12 }}>{err.message}</div>
        </div>
      );

      const preview = (
        <PreviewErrorBoundary fallback={renderError}>
          <PreviewComponent
            source={cleanSource}
            loading={loadingFallback}
            error={errorFallback}
            projectId={projectId}
            records={previewRecords}
            assets={previewAssets}
            importResolver={previewState.composition?.importResolver}
            logicBasePath={previewState.composition?.logicBasePath}
            preIncludedLogicPaths={previewState.composition?.preIncludedLogicPaths}
            permissionConfig={previewPermissionConfig}
            onLoad={(doc: unknown) => {
              debug('[LivePreview] SoftNRenderer onLoad - document parsed:', doc);
            }}
            onError={(err: Error) => {
              console.error('[LivePreview] SoftNRenderer onError:', err);
            }}
          />
        </PreviewErrorBoundary>
      );

      // Wrap with ThemeProvider if available
      if (ThemeProviderComponent) {
        return (
          <DeviceViewport width={dimensions.width} height={dimensions.height}>
            <PreviewErrorBoundary fallback={renderError}>
              <ThemeProviderComponent
                darkMode={themeMode === 'system' ? undefined : isDarkMode}
                followSystem={themeMode === 'system'}
              >
                {preview}
              </ThemeProviderComponent>
            </PreviewErrorBoundary>
          </DeviceViewport>
        );
      }

      return (
        <DeviceViewport width={dimensions.width} height={dimensions.height}>
          {preview}
        </DeviceViewport>
      );
    }

    debug('[LivePreview] Falling back to source display (no PreviewComponent)');
    // Fallback: render a simplified preview based on the generated source
    return (
      <div style={{ padding: 16, fontSize: 14, color: 'var(--dim)' }}>
        <div style={{ marginBottom: 16, fontWeight: 600 }}>Preview (Source)</div>
        <div style={{ marginBottom: 8, fontSize: 12, color: 'var(--dimmer)' }}>
          Elements: {elements.size} | Source: {source.length.toLocaleString()} chars
        </div>
        <div
          style={{
            fontFamily: 'monospace',
            fontSize: 11,
            whiteSpace: 'pre-wrap',
            background: 'var(--ink)',
            padding: 12,
            borderRadius: 8,
            maxHeight: 400,
            overflow: 'auto',
          }}
        >
          {source || 'No components added yet'}
        </div>
      </div>
    );
  };

  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <span style={styles.title}>Live Preview</span>
        <div style={styles.controls} role="group" aria-label="Preview device">
          {(['desktop', 'tablet', 'mobile'] as DevicePreset[]).map((d) => (
            <button
              key={d}
              type="button"
              aria-pressed={device === d}
              style={{
                ...styles.deviceButton,
                ...(device === d ? styles.deviceButtonActive : {}),
              }}
              onClick={() => setDevice(d)}
            >
              {d.charAt(0).toUpperCase() + d.slice(1)}
            </button>
          ))}
        </div>
      </div>
      {sourceInfo && <div style={styles.infoBanner}>{sourceInfo}</div>}
      {collections.length > 0 && <div style={{ ...styles.infoBanner, color: 'var(--dim)' }}>Try your app here. Preview data resets when you leave; edit saved records in Data.</div>}

      <div style={styles.previewWrapper}>
        <div
          style={{
            ...styles.previewFrame,
            width: '100%',
            maxWidth: '100%',
            height: '100%',
          }}
        >
          <div style={styles.previewContent}>{renderContent()}</div>
        </div>
      </div>
    </div>
  );
}

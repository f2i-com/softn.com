/**
 * LivePreview - Real-time SoftN renderer
 */

import React, { useMemo, useState, useEffect, useRef, Component, ErrorInfo, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useCanvasStore } from '../../stores/canvasStore';
import { useProjectStore } from '../../stores/projectStore';
import { useFilesStore } from '../../stores/filesStore';
import { useSchemaStore } from '../../stores/schemaStore';
import { debug } from '../../utils/debug';
import { buildPermissionJson } from '../../utils/permissions';
import type { CollectionDef } from '../../types/builder';
import { previewSourceFor, undeclaredPythonPackage } from '../../utils/previewSource';
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
    minHeight: 44,
    padding: '6px 16px',
    borderBottom: '1px solid var(--line-soft)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    background: 'var(--ink-2)',
    flexWrap: 'wrap',
    gap: 8,
  },
  title: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 8,
    fontFamily: 'var(--display)',
    fontWeight: 700,
    fontSize: 14,
    letterSpacing: '-0.01em',
    color: 'var(--paper)',
  },
  // The one place in Builder where something is running, so the one place
  // the brand's mint belongs: the live mark, as on the runtime's player.
  live: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    padding: '1px 8px',
    borderRadius: 999,
    border: '1px solid var(--mint-edge)',
    background: 'var(--mint-glow-soft)',
    fontFamily: 'var(--body)',
    fontSize: 11,
    fontWeight: 600,
    letterSpacing: 0,
    color: 'var(--mint)',
  },
  liveDot: {
    width: 6,
    height: 6,
    borderRadius: '50%',
    background: 'var(--mint)',
  },
  size: {
    fontFamily: 'var(--mono)',
    fontSize: 11,
    color: 'var(--dim)',
  },
  controls: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
  },
  previewWrapper: {
    flex: 1,
    overflow: 'hidden',
    padding: 8,
    display: 'flex',
    alignItems: 'stretch',
    justifyContent: 'center',
  },
  // The stage the device sits on: the workspace's ground, not a white sheet
  // that lit up the whole window in the dark theme.
  previewFrame: {
    background: 'var(--ink-3)',
    borderRadius: 8,
    border: '1px solid var(--line-soft)',
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
    padding: '16px 18px',
    color: 'var(--paper)',
    background: 'var(--bl-danger-soft)',
    border: '1px solid var(--danger)',
    borderRadius: 8,
    margin: 16,
    fontSize: 13,
    lineHeight: 1.55,
    overflowWrap: 'anywhere',
    whiteSpace: 'pre-wrap',
  },
  loading: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    height: '100%',
    color: 'var(--dim)',
    fontSize: 13,
  },
  infoBanner: {
    margin: '8px 8px 0',
    padding: '7px 12px',
    borderRadius: 8,
    border: '1px solid var(--line-soft)',
    background: 'var(--ink-2)',
    color: 'var(--dim)',
    fontSize: 12,
    lineHeight: 1.45,
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

const DEVICE_LABELS: Record<DevicePreset, string> = { desktop: 'Desktop', tablet: 'Tablet', mobile: 'Phone' };

const deviceDimensions: Record<DevicePreset, { width: number; height: number }> = {
  desktop: { width: 1440, height: 900 },
  tablet: { width: 768, height: 1024 },
  mobile: { width: 390, height: 844 },
};

// Threshold for warning (very large UIs)
const WARN_ELEMENTS_THRESHOLD = 500;
const WARN_SOURCE_LENGTH_THRESHOLD = 100000;

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
  const { projectId, logicSource, collections: projectCollections, themeMode, permissions, pythonPackages, setPythonPackages, source: retainedSource, assets: projectAssets } = useProjectStore();
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
  const previewState = useMemo(
    () => previewSourceFor({ elements, rootId, logicSource, collections, activeFileId, uiFiles, logicFiles, nodes, retainedSource, pythonPackages }),
    [elements, rootId, logicSource, collections, activeFileId, uiFiles, logicFiles, nodes, retainedSource, pythonPackages]
  );
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
            <div style={{ marginBottom: 6, color: 'var(--paper)' }}>Starting the preview…</div>
            <div style={{ fontSize: 11.5 }}>Loading the SoftN runtime</div>
          </div>
        </div>
      );
    }

    if (error) {
      // The composer refuses a package the app imports but does not declare,
      // naming the manifest line to add. The Builder writes that line from a
      // project setting, so the fix is one click here rather than a trip to
      // the export dialog.
      const missing = undeclaredPythonPackage(error);
      return (
        <div style={styles.error} role="alert">
          <div style={{ fontWeight: 600, marginBottom: 6 }}>The preview could not start</div>
          {error}
          {missing && (
            <div style={{ marginTop: 12 }}>
              <button
                type="button"
                className="bl-btn bl-btn-sm bl-btn-primary"
                onClick={() => setPythonPackages([...pythonPackages, missing])}
                data-action="enable-python-package"
              >
                Enable {missing}
              </button>
            </div>
          )}
        </div>
      );
    }

    if (!source.trim()) {
      return (
        <div style={styles.emptyState}>
          <div>
            <div style={{ fontFamily: 'var(--display)', fontSize: 17, fontWeight: 700, letterSpacing: '-0.02em', color: 'var(--paper)', marginBottom: 6 }}>Nothing to preview yet</div>
            <div>This app has no UI file to run. Add <code style={{ fontFamily: 'var(--mono)', color: 'var(--coral)' }}>ui/main.ui</code> in Files.</div>
          </div>
        </div>
      );
    }

    // Show warning for very large UIs (500+ elements or 100KB+)
    if (isVeryLarge && !forceRender) {
      return (
        <div style={{ padding: 24, textAlign: 'center' }}>
          <div style={{ fontFamily: 'var(--display)', fontSize: 17, fontWeight: 700, letterSpacing: '-0.02em', marginBottom: 8, color: 'var(--paper)' }}>A large page</div>
          <div style={{ color: 'var(--dim)', marginBottom: 16, fontSize: 13 }}>
            This UI has {elements.size} elements ({source.length.toLocaleString()} characters).
            <br />
            Rendering may be slow or cause memory issues.
          </div>
          <button type="button" className="bl-btn bl-btn-primary" onClick={() => setForceRender(true)} style={{ marginRight: 8 }}>
            Preview anyway
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
            type="button"
            className="bl-btn"
          >
            View source
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
          <div style={{ marginBottom: 8 }}>Rendering the preview…</div>
          <div style={{ fontSize: 11 }}>Parsing {source.length.toLocaleString()} characters</div>
        </div>
      );

      const errorFallback = (err: Error) => (
        <div style={styles.error} role="alert">
          <div style={{ fontWeight: 600, marginBottom: 8 }}>The app stopped with an error</div>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 12 }}>{err.message}</div>
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
            // A Python app's logic is its modules, not the markup's <logic>
            // block, which the composer leaves empty; without them the preview
            // of a Python app ran nothing at all.
            python={previewState.composition?.python}
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
            fontFamily: 'var(--mono)',
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
        <span style={styles.title}>
          Preview
          {!error && !isLoading && source.trim() && (
            <span style={styles.live} data-preview-live="true">
              <span style={styles.liveDot} aria-hidden="true" />
              Running
            </span>
          )}
        </span>
        <div style={styles.controls}>
          <span style={styles.size} aria-hidden="true">
            {deviceDimensions[device].width} × {deviceDimensions[device].height}
          </span>
          <div className="bl-seg" role="group" aria-label="Preview device">
            {(['desktop', 'tablet', 'mobile'] as DevicePreset[]).map((d) => (
              <button
                key={d}
                type="button"
                aria-pressed={device === d}
                title={`${DEVICE_LABELS[d]}, ${deviceDimensions[d].width} × ${deviceDimensions[d].height}`}
                onClick={() => setDevice(d)}
              >
                {DEVICE_LABELS[d]}
              </button>
            ))}
          </div>
        </div>
      </div>
      {sourceInfo && <div style={styles.infoBanner}>{sourceInfo}</div>}
      {collections.length > 0 && <div style={styles.infoBanner}>Try your app here. Records you add in the preview are thrown away when you leave it; the app’s saved records are edited in Data.</div>}

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

import React, { useState, useMemo, useEffect, useCallback, useRef } from 'react';
import { useWorkspaceStore, useVFSStore } from '../../stores';
import { Icon } from '../common/Icon';
import { resolveActivePreviewPath, resolveManifest } from '../../lib/studioProject';
import { getXDB, type SoftNRendererProps } from '@softn/core';
import type { ThemeProviderProps } from '@softn/components';
import { normalizeProjectPath } from '../../lib/projectImport';
import {
  assemblePreviewSource,
  buildPreviewXDBState,
  clearPreviewXDBCollections,
  replacePreviewXDBCollections,
} from '../../lib/previewProject';

/**
 * Strip the author's comments from a `.ui` file's TEMPLATE, and only its template.
 *
 * Comments in a .ui header would otherwise render as visible text in the
 * preview, which is the whole reason this exists. What it must not do is reach
 * inside `<logic>`, `<script>` or `<style>`: those are other languages, they
 * handle their own comments, and this ran over them with two regexes that know
 * nothing about string literals.
 *
 * That was not theoretical. `stripComments` used to run over the assembled
 * document — the `.ui` with its external `.logic` already inlined — and the
 * AIChat demo contains `softn.files.pickFile({ accept: "image/*" }, ...)`. The
 * `/*` inside that ordinary MIME wildcard opened a comment, and the non-greedy
 * scan ran forward to the first `*\/` it could find, which was the first CSS
 * comment in the stylesheet below. Everything between was deleted, including the
 * `</logic>` that closed the inlined block. The lexer's logic-content mode then
 * ran to end of file, so the entire stylesheet and every line of markup were
 * handed to the JavaScript engine, which said, accurately, "unterminated string
 * literal". The bundle ran perfectly in the web runtime, which inlines its own
 * logic and never took this path.
 */
function stripComments(source: string): string {
  // Spans that belong to another language, left exactly as their author wrote them.
  const protectedSpans: Array<[number, number]> = [];
  const blockTag = /<(logic|script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
  for (const match of source.matchAll(blockTag)) {
    protectedSpans.push([match.index, match.index + match[0].length]);
  }

  const stripTemplate = (text: string): string =>
    text.replace(/^\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');

  let out = '';
  let cursor = 0;
  for (const [start, end] of protectedSpans) {
    out += stripTemplate(source.slice(cursor, start));
    out += source.slice(start, end);
    cursor = end;
  }
  out += stripTemplate(source.slice(cursor));

  return out.replace(/\n\s*\n\s*\n/g, '\n\n').trim();
}

function normalizeAssetPath(path: string): string {
  return path
    .replace(/\\/g, '/')
    .replace(/^\.?\//, '')
    .replace(/^\//, '')
    .toLowerCase();
}

function rewriteAssetReferences(source: string, resolveAsset: (path: string) => string): string {
  return source.replace(
    /(["'])(assets\/[^"']+|\.\.\/assets\/[^"']+|\.\/assets\/[^"']+)(\1)/g,
    (_match, quote: string, assetPath: string) => {
      return `${quote}${resolveAsset(assetPath)}${quote}`;
    }
  );
}

function fileContentToDataUrl(file: { mimeType?: string; content: string | Uint8Array }): string {
  if (typeof file.content === 'string') {
    if (file.mimeType === 'image/svg+xml') {
      return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(file.content)}`;
    }
    return `data:${file.mimeType || 'text/plain'};charset=utf-8,${encodeURIComponent(file.content)}`;
  }

  const bytes = new Uint8Array(file.content);
  let binary = '';
  for (let index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode(bytes[index]);
  }
  return `data:${file.mimeType || 'application/octet-stream'};base64,${btoa(binary)}`;
}

interface VisualCanvasProps {
  onStartBrief?: () => void;
}

interface StablePreviewSurfaceProps {
  expanded: boolean;
  isMobile: boolean;
  label: string;
  frameStyle: React.CSSProperties;
  chrome: React.ReactNode;
  onClose: () => void;
  children: React.ReactNode;
}

/**
 * The preview child always occupies the same host node. Expanding changes only
 * that host's presentation, so stateful renderers, iframes, media, and games do
 * not restart simply because the user asks for more screen space.
 */
export function StablePreviewSurface({
  expanded,
  isMobile,
  label,
  frameStyle,
  chrome,
  onClose,
  children,
}: StablePreviewSurfaceProps): React.ReactElement {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!expanded) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    closeButtonRef.current?.focus();
    return () => {
      if (previouslyFocused?.isConnected) previouslyFocused.focus();
    };
  }, [expanded]);

  const trapDialogFocus = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!expanded || event.key !== 'Tab') return;
    const surface = surfaceRef.current;
    if (!surface) return;
    const focusable = Array.from(
      surface.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      )
    ).filter(
      (element) => !element.hidden && !element.closest<HTMLElement>('[aria-hidden="true"]')
    );
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div
      ref={surfaceRef}
      data-softn-preview-surface="true"
      style={{
        ...styles.previewFrame,
        ...frameStyle,
        ...(expanded ? styles.expandedPreviewFrame : {}),
      }}
      role={expanded ? 'dialog' : undefined}
      aria-modal={expanded ? 'true' : undefined}
      aria-label={expanded ? `${label} expanded preview` : undefined}
      onKeyDown={trapDialogFocus}
    >
      <div
        style={{
          ...styles.previewChrome,
          ...(isMobile || expanded ? { display: 'none' } : {}),
        }}
        aria-hidden={isMobile || expanded || undefined}
      >
        {chrome}
      </div>
      <div
        data-softn-preview-content="true"
        style={{
          ...styles.previewContentHost,
          ...(expanded ? styles.expandedContent : {}),
        }}
      >
        {children}
      </div>
      {expanded && (
        <div style={styles.expandedFloatingBar}>
          <div style={styles.expandedFloatingLabel}>{label}</div>
          <button
            ref={closeButtonRef}
            onClick={onClose}
            style={styles.expandedCloseBtn}
            aria-label="Close expanded preview"
            title="Close expanded preview"
          >
            <Icon name="x" size={16} />
          </button>
        </div>
      )}
    </div>
  );
}

export const VisualCanvas: React.FC<VisualCanvasProps> = ({ onStartBrief }) => {
  const {
    blueprint,
    devicePreset,
    zoom,
    themePreview,
    activePageId,
    activeFilePath,
    projectId,
    projectName,
  } = useWorkspaceStore();
  const { files } = useVFSStore();
  const [hoveredTool, setHoveredTool] = useState<string | null>(null);
  const [activeVFSFile, setActiveVFSFile] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [isExpandedPreview, setIsExpandedPreview] = useState(false);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [binaryImageUrl, setBinaryImageUrl] = useState<string | null>(null);
  const [binaryMediaUrl, setBinaryMediaUrl] = useState<string | null>(null);
  const [PreviewComponent, setPreviewComponent] =
    useState<React.ComponentType<SoftNRendererProps> | null>(null);
  const [ThemeProviderComponent, setThemeProviderComponent] =
    useState<React.ComponentType<ThemeProviderProps> | null>(null);
  const [isMobile, setIsMobile] = useState(false);
  const seededPreviewRef = useRef<{
    xdb: ReturnType<typeof getXDB>;
    collections: Set<string>;
  } | null>(null);

  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 768);
    check();
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  }, []);

  const pages = blueprint?.pages ?? [];
  const currentPage = pages.find((p) => p.id === activePageId) ?? pages[0];
  const previewAppId = useMemo(() => {
    const base = projectId || projectName || blueprint?.appName || 'softn-preview';
    return `studio-preview-${String(base)
      .toLowerCase()
      .replace(/[^a-z0-9-_]+/g, '-')}`;
  }, [projectId, projectName, blueprint?.appName]);

  const manifest = resolveManifest(files);
  const manifestPages = Array.isArray(manifest?.pages)
    ? (manifest.pages as Array<Record<string, unknown>>)
    : [];

  const deviceWidths: Record<string, number> = {
    desktop: 1280,
    tablet: 768,
    mobile: 375,
  };
  const previewWidth = deviceWidths[devicePreset] ?? 1280;
  const scale = zoom / 100;

  const hasFiles = files.size > 0;
  const selectedSurfaceLabel = activeVFSFile
    ? (activeVFSFile.split('/').pop() ?? activeVFSFile)
    : (currentPage?.name ?? 'Preview');

  useEffect(() => {
    const nextPath = resolveActivePreviewPath(files, activeVFSFile, activeFilePath);
    if (nextPath !== activeVFSFile) setActiveVFSFile(nextPath);
  }, [files, activeFilePath, activeVFSFile]);

  // Get preview content for the active VFS file
  const previewFileContent = activeVFSFile
    ? (() => {
        const file = files.get(activeVFSFile);
        return file && typeof file.content === 'string' ? file.content : null;
      })()
    : null;

  const fileMimeType = activeVFSFile ? (files.get(activeVFSFile)?.mimeType ?? '') : '';
  const activeBinaryContent = activeVFSFile ? files.get(activeVFSFile)?.content : null;

  // Determine if the active file is HTML-renderable
  const isHtmlFile = activeVFSFile ? /\.(html|htm)$/i.test(activeVFSFile) : false;
  const isImageFile = activeVFSFile ? /\.(png|jpg|jpeg|gif|webp|svg)$/i.test(activeVFSFile) : false;
  const isAudioFile = activeVFSFile
    ? /\.(mp3|wav|ogg|aac|flac|m4a|wma|webm)$/i.test(activeVFSFile)
    : false;
  const isVideoFile = activeVFSFile ? /\.(mp4|webm|ogv|mov|avi)$/i.test(activeVFSFile) : false;
  const isManifestFile = activeVFSFile === 'manifest.json';
  const isSoftNUIFile = activeVFSFile ? /\.ui$/i.test(activeVFSFile) : false;

  useEffect(() => {
    let mounted = true;
    const loadRenderer = async () => {
      try {
        const components = await import('@softn/components');
        if (components.registerAllBuiltins) {
          components.registerAllBuiltins();
        }
        if (mounted && components.ThemeProvider) {
          setThemeProviderComponent(() => components.ThemeProvider);
        }
      } catch {
        if (mounted) setThemeProviderComponent(null);
      }

      try {
        const core = await import('@softn/core');
        if (mounted && core.SoftNRenderer) setPreviewComponent(() => core.SoftNRenderer);
      } catch {
        if (mounted) setPreviewComponent(null);
      }
    };

    loadRenderer();
    return () => {
      mounted = false;
    };
  }, []);

  const previewUIFiles = useMemo(() => {
    const next = new Map<string, string>();
    for (const [path, file] of files.entries()) {
      if (/\.ui$/i.test(path) && typeof file.content === 'string') next.set(path, file.content);
    }
    return next;
  }, [files]);

  const previewLogicFiles = useMemo(() => {
    const next = new Map<string, string>();
    for (const [path, file] of files.entries()) {
      if (/\.logic$/i.test(path) && typeof file.content === 'string') next.set(path, file.content);
    }
    return next;
  }, [files]);

  const previewXDBState = useMemo(() => buildPreviewXDBState(files), [files]);
  const initialData = previewXDBState.initialData;

  useEffect(() => {
    let xdb: ReturnType<typeof getXDB>;
    try {
      xdb = getXDB(previewAppId);
    } catch {
      // Storage can be unavailable in privacy-restricted contexts.
      return;
    }
    let disposed = false;
    void xdb.isReady
      .then(() => {
        if (disposed) return;
        const previous = seededPreviewRef.current;
        if (previous && previous.xdb !== xdb) {
          clearPreviewXDBCollections(previous.xdb, previous.collections);
        }
        const previousCollections = previous?.xdb === xdb ? previous.collections : [];
        const ownedCollections = new Set([...previousCollections, ...previewXDBState.collections]);
        seededPreviewRef.current = { xdb, collections: ownedCollections };
        replacePreviewXDBCollections(xdb, previewXDBState, previousCollections);
        seededPreviewRef.current = {
          xdb,
          collections: new Set(previewXDBState.collections),
        };
      })
      .catch(() => {
        // SoftNRenderer still receives initialData if persistent preview XDB
        // is unavailable, so a storage failure does not blank the preview.
      });

    return () => {
      disposed = true;
    };
  }, [previewAppId, previewXDBState]);

  useEffect(
    () => () => {
      const seeded = seededPreviewRef.current;
      seededPreviewRef.current = null;
      if (!seeded) return;
      try {
        clearPreviewXDBCollections(seeded.xdb, seeded.collections);
      } catch {
        // Disposable preview cleanup is best effort if storage is revoked.
      }
    },
    []
  );

  const resolveAssetUrl = useCallback(
    (assetPath: string) => {
      if (assetPath.startsWith('data:') || assetPath.startsWith('blob:')) return assetPath;

      const candidates = [
        normalizeAssetPath(assetPath),
        normalizeAssetPath(`assets/${assetPath}`),
        normalizeAssetPath(assetPath.replace(/^\.\.\//, '')),
        normalizeAssetPath(assetPath.replace(/^\.\//, '')),
      ];

      for (const [path, file] of files.entries()) {
        if (!path.startsWith('assets/')) continue;
        if (candidates.includes(normalizeAssetPath(path))) {
          return fileContentToDataUrl(file);
        }
      }

      return assetPath;
    },
    [files]
  );

  const rendererFunctions = useMemo<Record<string, (...args: unknown[]) => unknown>>(
    () => ({
      asset: (assetPath: unknown) => resolveAssetUrl(String(assetPath ?? '')),
    }),
    [resolveAssetUrl]
  );

  const importResolver = useCallback(
    async (path: string) => {
      const normalized = normalizeProjectPath(path);
      if (!normalized) return null;
      for (const [filePath, content] of previewLogicFiles.entries()) {
        if (normalizeProjectPath(filePath) === normalized) {
          return content;
        }
      }
      return null;
    },
    [previewLogicFiles]
  );

  const { source: softNSource, preIncludedLogicPaths } = useMemo(() => {
    if (!isSoftNUIFile || !activeVFSFile || !previewFileContent) {
      return { source: null as string | null, preIncludedLogicPaths: [] as string[] };
    }
    const assembled = assemblePreviewSource(
      activeVFSFile,
      previewFileContent,
      previewUIFiles,
      previewLogicFiles
    );
    let source = assembled.source;
    source = rewriteAssetReferences(source, resolveAssetUrl);
    source = stripComments(source);
    return { source, preIncludedLogicPaths: assembled.preIncludedLogicPaths };
  }, [
    isSoftNUIFile,
    activeVFSFile,
    previewFileContent,
    previewLogicFiles,
    previewUIFiles,
    resolveAssetUrl,
  ]);

  // Blob URLs are resources, not render calculations. Creating them in
  // useMemo leaks the URL whenever React abandons a render (and on Strict
  // Mode's development probe), because no effect cleanup ever owns it.
  useEffect(() => {
    setBlobUrl(null);
    if (!previewFileContent || !isHtmlFile) return;
    const blob = new Blob([previewFileContent], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    setBlobUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [previewFileContent, isHtmlFile, refreshKey]);

  useEffect(() => {
    setBinaryImageUrl(null);
    if (!isImageFile || !activeBinaryContent || typeof activeBinaryContent === 'string') return;
    const bytes = new Uint8Array(activeBinaryContent);
    const blob = new Blob(
      [bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)],
      {
        type: fileMimeType || 'image/png',
      }
    );
    const url = URL.createObjectURL(blob);
    setBinaryImageUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [isImageFile, activeBinaryContent, fileMimeType]);

  useEffect(() => {
    setBinaryMediaUrl(null);
    if (
      (!isAudioFile && !isVideoFile) ||
      !activeBinaryContent ||
      typeof activeBinaryContent === 'string'
    )
      return;
    const bytes = new Uint8Array(activeBinaryContent);
    const blob = new Blob(
      [bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)],
      {
        type: fileMimeType || (isAudioFile ? 'audio/mpeg' : 'video/mp4'),
      }
    );
    const url = URL.createObjectURL(blob);
    setBinaryMediaUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [isAudioFile, isVideoFile, activeBinaryContent, fileMimeType]);

  useEffect(() => {
    if (!isExpandedPreview) return;
    const previousOverflow = document.body.style.overflow;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setIsExpandedPreview(false);
    };
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', closeOnEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', closeOnEscape);
    };
  }, [isExpandedPreview]);

  // Toolbar actions
  const handleToolAction = useCallback((id: string) => {
    switch (id) {
      case 'refresh':
        setRefreshKey((k) => k + 1);
        break;
      case 'newtab':
        setIsExpandedPreview(true);
        break;
    }
  }, []);

  const renderPreviewContent = () => {
    // Binary file types — check before the text-content gate
    if (
      isImageFile &&
      (binaryImageUrl || (typeof previewFileContent === 'string' && previewFileContent))
    ) {
      return (
        <div style={styles.assetPreviewWrap}>
          <img
            src={
              binaryImageUrl ??
              `data:image/svg+xml;charset=utf-8,${encodeURIComponent(previewFileContent ?? '')}`
            }
            alt={selectedSurfaceLabel}
            style={styles.assetPreview}
          />
          <span style={styles.assetLabel}>{activeVFSFile?.split('/').pop()}</span>
        </div>
      );
    }

    if (isAudioFile && binaryMediaUrl) {
      return (
        <div style={styles.assetPreviewWrap}>
          <Icon name="file" size={48} color="var(--studio-text-dim)" />
          <span style={styles.assetLabel}>{activeVFSFile?.split('/').pop()}</span>
          <audio controls src={binaryMediaUrl} style={{ marginTop: 16, maxWidth: '100%' }} />
        </div>
      );
    }

    if (isVideoFile && binaryMediaUrl) {
      return (
        <div style={styles.assetPreviewWrap}>
          <video
            controls
            src={binaryMediaUrl}
            style={{ maxWidth: '100%', maxHeight: '70%', borderRadius: 8 }}
          />
          <span style={styles.assetLabel}>{activeVFSFile?.split('/').pop()}</span>
        </div>
      );
    }

    if (!previewFileContent) {
      // Binary file with no viewer
      if (activeVFSFile && activeBinaryContent && typeof activeBinaryContent !== 'string') {
        const sizeKB = (activeBinaryContent.byteLength / 1024).toFixed(1);
        return (
          <div style={{ ...styles.previewContent, background: 'var(--studio-bg)' }}>
            <div style={styles.previewPlaceholder}>
              <Icon name="file" size={32} color="var(--studio-border-strong)" />
              <span
                style={{
                  fontSize: 14,
                  fontWeight: 600,
                  color: 'var(--studio-text-muted)',
                  marginTop: 8,
                }}
              >
                {activeVFSFile.split('/').pop()}
              </span>
              <span style={{ fontSize: 12, color: 'var(--studio-text-dim)', marginTop: 4 }}>
                Binary file · {sizeKB} KB
              </span>
            </div>
          </div>
        );
      }

      return (
        <div style={{ ...styles.previewContent, background: 'var(--studio-bg)' }}>
          <div style={styles.previewPlaceholder}>
            <Icon name="eye" size={32} color="var(--studio-border-strong)" />
            <span style={{ fontSize: 13, color: 'var(--studio-text-dim)', marginTop: 8 }}>
              {files.size} file{files.size !== 1 ? 's' : ''} loaded — select a file to preview
            </span>
          </div>
        </div>
      );
    }

    if (isSoftNUIFile && softNSource && PreviewComponent) {
      return ThemeProviderComponent ? (
        <div style={styles.rendererWrap}>
          <ThemeProviderComponent defaultDarkMode={themePreview === 'dark'} followSystem={false}>
            <PreviewComponent
              source={softNSource}
              functions={rendererFunctions}
              initialData={initialData}
              importResolver={importResolver}
              preIncludedLogicPaths={preIncludedLogicPaths}
              appId={previewAppId}
              resumeSavedSyncRoom={false}
            />
          </ThemeProviderComponent>
        </div>
      ) : (
        <div style={styles.rendererWrap}>
          <PreviewComponent
            source={softNSource}
            functions={rendererFunctions}
            initialData={initialData}
            importResolver={importResolver}
            preIncludedLogicPaths={preIncludedLogicPaths}
            appId={previewAppId}
            resumeSavedSyncRoom={false}
          />
        </div>
      );
    }

    if (isHtmlFile && blobUrl) {
      return (
        <iframe
          key={refreshKey}
          src={blobUrl}
          style={styles.iframe}
          // allow-scripts WITHOUT allow-same-origin. Together the two cancel the
          // sandbox out: the blob inherits this origin, so previewed HTML could
          // read localStorage — where the model API key is kept — and reach back
          // into the parent document. The HTML being previewed is a model's
          // output or an imported bundle, so it is not ours to trust. Dropping
          // the flag costs nothing: the blob still loads and its scripts still
          // run, they just get an opaque origin and a SecurityError on storage.
          sandbox="allow-scripts"
          title="App Preview"
        />
      );
    }

    if (isManifestFile) {
      return (
        <div style={styles.codePreviewCard}>
          <div style={styles.manifestSummary}>
            <div style={styles.manifestStat}>
              <span style={styles.manifestLabel}>Bundle</span>
              <strong>{String(manifest?.name ?? 'Imported app')}</strong>
            </div>
            <div style={styles.manifestStat}>
              <span style={styles.manifestLabel}>Entry</span>
              <strong>{String(manifest?.entry ?? manifest?.main ?? 'n/a')}</strong>
            </div>
            <div style={styles.manifestStat}>
              <span style={styles.manifestLabel}>Pages</span>
              <strong>{manifestPages.length}</strong>
            </div>
          </div>
          <pre style={styles.filePreview}>{previewFileContent}</pre>
        </div>
      );
    }

    return (
      <div
        style={{
          ...styles.codePreview,
          background: 'var(--studio-bg)',
          color: 'var(--studio-text-muted)',
        }}
      >
        <pre style={styles.filePreview}>{previewFileContent}</pre>
      </div>
    );
  };

  return (
    <div style={styles.container}>
      {!isMobile && <div style={styles.atmosphere} />}
      {/* Canvas area */}
      <div
        style={{
          ...styles.canvasArea,
          ...(isMobile ? { padding: 0 } : {}),
          ...(isExpandedPreview ? { zIndex: 1000, overflow: 'visible' } : {}),
        }}
      >
        {hasFiles ? (
          <StablePreviewSurface
            expanded={isExpandedPreview}
            isMobile={isMobile}
            label={selectedSurfaceLabel}
            frameStyle={
              isMobile
                ? { borderRadius: 0, border: 'none', boxShadow: 'none', width: '100%' }
                : { width: Math.min(previewWidth * scale, previewWidth), maxWidth: '100%' }
            }
            onClose={() => setIsExpandedPreview(false)}
            chrome={
              <div style={styles.previewChromeLeft}>
                <div style={styles.previewTrafficLights}>
                  <span
                    style={{ ...styles.trafficLight, background: 'var(--studio-border-strong)' }}
                  />
                  <span
                    style={{ ...styles.trafficLight, background: 'var(--studio-border-strong)' }}
                  />
                  <span
                    style={{ ...styles.trafficLight, background: 'var(--studio-border-strong)' }}
                  />
                </div>
                <div style={styles.previewMeta}>
                  <span style={styles.previewLabel}>{selectedSurfaceLabel}</span>
                  <span style={styles.previewSubLabel}>
                    {devicePreset} / {themePreview}
                  </span>
                </div>
              </div>
            }
          >
            {renderPreviewContent()}
          </StablePreviewSurface>
        ) : (
          <div style={styles.emptyCanvas}>
            <div style={styles.emptyGraphic}>
              <div style={styles.emptyPhone}>
                <div style={styles.emptyPhoneScreen}>
                  <div style={styles.emptyBar} />
                  <div style={{ ...styles.emptyBar, width: '60%', opacity: 0.5 }} />
                  <div style={styles.emptyBlock} />
                  <div style={{ ...styles.emptyBar, width: '40%', opacity: 0.3, marginTop: 8 }} />
                </div>
              </div>
            </div>
            <h3 style={styles.emptyTitle}>No app yet</h3>
            <p style={styles.emptyDesc}>
              Use the AI chat or guided brief to describe your app. The AI will generate and modify
              all files for you.
            </p>
            <div style={styles.emptyActionRow}>
              <button
                onClick={() => useWorkspaceStore.getState().setLeftPanel('ai')}
                style={styles.emptyActionCard}
              >
                <span style={styles.emptyActionKicker}>Fastest start</span>
                <span style={styles.emptyActionTitle}>Open AI chat</span>
              </button>
              {onStartBrief && (
                <button onClick={onStartBrief} style={styles.emptyActionCard}>
                  <span style={styles.emptyActionKicker}>Guided</span>
                  <span style={styles.emptyActionTitle}>Run the brief wizard</span>
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Canvas toolbar (hidden on mobile) */}
      {!isMobile && (
        <div style={styles.toolbar}>
          {[
            { id: 'refresh', icon: 'refresh' as const, label: 'Refresh preview' },
            { id: 'newtab', icon: 'maximize' as const, label: 'Open in new tab' },
          ].map((tool) => (
            <button
              key={tool.id}
              onClick={() => handleToolAction(tool.id)}
              onMouseEnter={() => setHoveredTool(tool.id)}
              onMouseLeave={() => setHoveredTool(null)}
              style={{
                ...styles.toolBtn,
                ...(hoveredTool === tool.id ? styles.toolBtnHover : {}),
              }}
              title={tool.label}
              aria-label={tool.label}
            >
              <Icon name={tool.icon} size={15} />
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

const styles: Record<string, React.CSSProperties> = {
  container: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    background:
      'radial-gradient(circle at top, var(--studio-accent-soft), transparent 30%), linear-gradient(180deg, var(--studio-bg) 0%, var(--studio-bg-muted) 100%)',
    overflow: 'hidden',
    position: 'relative',
  },
  atmosphere: {
    position: 'absolute',
    inset: 0,
    background:
      'radial-gradient(circle at 20% 20%, var(--studio-surface), transparent 24%), radial-gradient(circle at 80% 0%, var(--studio-accent-soft), transparent 20%)',
    pointerEvents: 'none',
  },
  canvasArea: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    overflow: 'auto',
    padding: 16,
    position: 'relative',
    zIndex: 1,
    background: 'var(--studio-bg)',
    minHeight: 0,
  },
  previewFrame: {
    borderRadius: 18,
    overflow: 'hidden',
    border: '1px solid var(--studio-border-strong)',
    boxShadow: 'var(--studio-shadow)',
    flex: 1,
    minHeight: 0,
    transition: 'width 0.3s ease',
    position: 'relative',
    display: 'flex',
    flexDirection: 'column',
    background: 'var(--studio-bg-elevated)',
  },
  expandedPreviewFrame: {
    position: 'fixed',
    inset: 0,
    zIndex: 999,
    width: '100%',
    maxWidth: 'none',
    height: '100%',
    flex: 'none',
    borderRadius: 0,
    border: 'none',
    boxShadow: 'none',
    background: 'var(--studio-bg-elevated)',
  },
  previewContentHost: {
    flex: 1,
    minHeight: 0,
    display: 'flex',
    overflow: 'hidden',
    background: 'var(--studio-bg-elevated)',
  },
  rendererWrap: {
    width: '100%',
    flex: 1,
    minHeight: 0,
    overflow: 'auto',
    background: 'var(--studio-bg-elevated)',
  },
  expandedFloatingBar: {
    position: 'fixed',
    top: 16,
    right: 16,
    left: 16,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    pointerEvents: 'none',
    zIndex: 1001,
  },
  expandedFloatingLabel: {
    maxWidth: '70%',
    padding: '8px 12px',
    borderRadius: 999,
    background: 'var(--studio-panel)',
    border: '1px solid var(--studio-border)',
    fontFamily: 'var(--studio-mono)',
    fontSize: 13,
    fontWeight: 700,
    color: 'var(--studio-text)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    pointerEvents: 'auto',
  },
  expandedCloseBtn: {
    width: 34,
    height: 34,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    border: '1px solid var(--studio-border)',
    background: 'var(--studio-panel)',
    color: 'var(--studio-text)',
    borderRadius: 12,
    cursor: 'pointer',
    fontFamily: 'inherit',
    pointerEvents: 'auto',
  },
  expandedContent: {
    flex: 1,
    minHeight: 0,
    display: 'flex',
    background: 'var(--studio-bg-elevated)',
  },
  previewChrome: {
    height: 46,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '0 14px',
    background: 'linear-gradient(180deg, var(--studio-bg-elevated), var(--studio-panel))',
    borderBottom: '1px solid var(--studio-border)',
    flexShrink: 0,
  },
  previewChromeLeft: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
  },
  previewTrafficLights: {
    display: 'flex',
    gap: 6,
  },
  trafficLight: {
    width: 10,
    height: 10,
    borderRadius: '50%',
    boxShadow: '0 0 0 1px var(--studio-border) inset',
  },
  previewMeta: {
    display: 'flex',
    flexDirection: 'column',
    gap: 1,
  },
  previewLabel: {
    fontFamily: 'var(--studio-mono)',
    fontSize: 12,
    fontWeight: 700,
    color: 'var(--studio-text)',
  },
  previewSubLabel: {
    fontFamily: 'var(--studio-mono)',
    fontSize: 10,
    color: 'var(--studio-text-muted)',
    textTransform: 'capitalize' as const,
    letterSpacing: '0.08em',
  },
  iframe: {
    width: '100%',
    flex: 1,
    border: 'none',
    background: 'var(--studio-bg-elevated)',
    minHeight: 0,
  },
  codePreview: {
    width: '100%',
    flex: 1,
    overflow: 'auto',
    minHeight: 0,
  },
  codePreviewCard: {
    width: '100%',
    flex: 1,
    overflow: 'auto',
    minHeight: 0,
    background: 'var(--studio-bg-elevated)',
  },
  manifestSummary: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
    gap: 10,
    padding: 16,
    borderBottom: '1px solid var(--studio-border)',
  },
  manifestStat: {
    padding: 12,
    borderRadius: 14,
    background: 'var(--studio-inset)',
    border: '1px solid var(--studio-border)',
    fontFamily: 'var(--studio-mono)',
    fontSize: 12,
    color: 'var(--studio-text)',
    overflowWrap: 'anywhere',
  },
  manifestLabel: {
    display: 'block',
    fontSize: 10,
    color: 'var(--studio-text-muted)',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.08em',
    marginBottom: 8,
  },
  assetPreviewWrap: {
    width: '100%',
    flex: 1,
    minHeight: 0,
    background: `radial-gradient(circle at top, var(--studio-accent-soft), transparent 24%), var(--studio-bg)`,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 20,
    gap: 10,
  },
  assetPreview: {
    maxWidth: '100%',
    maxHeight: '70%',
    objectFit: 'contain' as const,
    borderRadius: 18,
    boxShadow: 'var(--studio-shadow)',
    background: 'var(--studio-panel-strong)',
  },
  assetLabel: {
    fontFamily: 'var(--studio-mono)',
    fontSize: 12,
    color: 'var(--studio-text-dim)',
    fontWeight: 500,
  },
  previewContent: {
    width: '100%',
    flex: 1,
    minHeight: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'auto',
  },
  previewPlaceholder: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
  },
  filePreview: {
    width: '100%',
    margin: 0,
    padding: 16,
    fontSize: 12,
    lineHeight: 1.6,
    fontFamily: 'var(--studio-mono)',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    overflow: 'auto',
  },
  emptyCanvas: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    textAlign: 'center',
    padding: 40,
  },
  emptyGraphic: {
    marginBottom: 24,
  },
  emptyPhone: {
    width: 120,
    height: 200,
    borderRadius: 16,
    border: '2px solid var(--studio-border-strong)',
    padding: 8,
    background: 'var(--studio-inset)',
    boxShadow: 'var(--studio-shadow)',
  },
  emptyPhoneScreen: {
    width: '100%',
    height: '100%',
    borderRadius: 10,
    background: 'var(--studio-surface)',
    padding: 12,
  },
  emptyBar: {
    width: '80%',
    height: 6,
    borderRadius: 3,
    background: 'var(--studio-surface-hover)',
    marginBottom: 6,
  },
  emptyBlock: {
    width: '100%',
    height: 40,
    borderRadius: 6,
    background: 'var(--studio-surface-hover)',
    marginTop: 8,
    marginBottom: 8,
  },
  emptyTitle: {
    fontFamily: 'var(--studio-display)',
    fontSize: 26,
    fontWeight: 800,
    letterSpacing: '-0.03em',
    color: 'var(--studio-text)',
    margin: 0,
  },
  emptyDesc: {
    fontSize: 14,
    color: 'var(--studio-text-muted)',
    lineHeight: 1.6,
    maxWidth: 360,
    marginTop: 10,
  },
  emptyActionRow: {
    display: 'flex',
    gap: 12,
    marginTop: 24,
    flexWrap: 'wrap',
    justifyContent: 'center',
  },
  emptyActionCard: {
    minWidth: 180,
    padding: '14px 16px',
    borderRadius: 16,
    background: 'var(--studio-inset)',
    border: '1px solid var(--studio-border)',
    textAlign: 'left' as const,
    boxShadow: 'var(--studio-shadow)',
    cursor: 'pointer',
    fontFamily: 'inherit',
    transition: 'all 0.15s',
  },
  emptyActionKicker: {
    display: 'block',
    fontFamily: 'var(--studio-mono)',
    fontSize: 10,
    fontWeight: 700,
    letterSpacing: '0.12em',
    textTransform: 'uppercase' as const,
    color: 'var(--studio-accent)',
    marginBottom: 8,
  },
  emptyActionTitle: {
    display: 'block',
    fontFamily: 'var(--studio-display)',
    fontSize: 15,
    fontWeight: 700,
    letterSpacing: '-0.02em',
    color: 'var(--studio-text)',
  },
  toolbar: {
    position: 'absolute',
    bottom: 16,
    left: '50%',
    transform: 'translateX(-50%)',
    display: 'flex',
    gap: 4,
    padding: 6,
    background: 'var(--studio-panel)',
    backdropFilter: 'blur(12px)',
    borderRadius: 14,
    border: '1px solid var(--studio-border)',
    boxShadow: 'var(--studio-shadow)',
    zIndex: 2,
  },
  toolBtn: {
    width: 34,
    height: 34,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    border: 'none',
    background: 'transparent',
    color: 'var(--studio-text-muted)',
    borderRadius: 10,
    cursor: 'pointer',
    transition: 'all 0.15s',
    fontFamily: 'inherit',
  },
  toolBtnHover: {
    color: 'var(--studio-text)',
    background: 'var(--studio-surface-hover)',
  },
};

import React, { useState, useMemo, useEffect, useCallback } from 'react';
import { useWorkspaceStore, useVFSStore } from '../../stores';
import { Icon } from '../common/Icon';
import { getBundleEntryPath, resolveManifest } from '../../lib/studioProject';

function stripComments(source: string): string {
  return source
    .replace(/^\/\/.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\n\s*\n\s*\n/g, '\n\n')
    .trim();
}

function resolveRelativePath(fromPath: string, relativePath: string): string {
  const parts = fromPath.split('/');
  parts.pop();
  const dir = parts;
  for (const part of relativePath.split('/')) {
    if (part === '..') dir.pop();
    else if (part !== '.') dir.push(part);
  }
  return dir.join('/');
}

function normalizeUiPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.?\//, '').replace(/\/+/g, '/').replace(/\/$/, '').toLowerCase();
}

function normalizeAssetPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.?\//, '').replace(/^\//, '').toLowerCase();
}

function rewriteAssetReferences(source: string, resolveAsset: (path: string) => string): string {
  return source.replace(/(["'])(assets\/[^"']+|\.\.\/assets\/[^"']+|\.\/assets\/[^"']+)(\1)/g, (_match, quote: string, assetPath: string) => {
    return `${quote}${resolveAsset(assetPath)}${quote}`;
  });
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

function findUiFileForImport(
  uiFiles: Map<string, string>,
  fromUiPath: string,
  importPath: string,
  importName: string,
): [string, string] | undefined {
  const resolved = resolveRelativePath(fromUiPath, importPath);
  const candidates = new Set([
    normalizeUiPath(importPath),
    normalizeUiPath(resolved),
    normalizeUiPath(importPath.replace(/^\.\//, '')),
    normalizeUiPath(resolved.replace(/^\//, '')),
  ]);

  for (const [path, content] of uiFiles.entries()) {
    if (candidates.has(normalizeUiPath(path))) return [path, content];
  }

  const expectedName = `${importName.toLowerCase()}.ui`;
  for (const [path, content] of uiFiles.entries()) {
    if ((path.split('/').pop() || '').toLowerCase() === expectedName) return [path, content];
  }

  return undefined;
}

function resolveExternalLogic(source: string, uiFilePath: string, logicFiles: Map<string, string>): string {
  const logicSrcRegex = /<logic\s+src=["']([^"']+)["']\s*\/>/g;
  return source.replace(logicSrcRegex, (_match, srcPath: string) => {
    const resolvedPath = resolveRelativePath(uiFilePath, srcPath);
    const pathsToTry = [resolvedPath, resolvedPath.replace(/^\//, ''), srcPath.replace(/^\.\//, ''), srcPath];

    for (const [path, content] of logicFiles.entries()) {
      if (pathsToTry.includes(path)) {
        return `<logic>\n${content}\n</logic>`;
      }
    }

    return `<logic>\n// Logic file not found: ${srcPath}\n</logic>`;
  });
}

function getExternalLogicPath(source: string, uiFilePath: string): string | null {
  const match = source.match(/<logic\s+src=["']([^"']+)["']\s*\/>/);
  if (!match) return null;
  return resolveRelativePath(uiFilePath, match[1]);
}

function resolveUIImports(source: string, uiFilePath: string, uiFiles: Map<string, string>, depth = 0): string {
  if (depth > 8) return source;

  const importRegex = /<import\s+(?:\{\s*([^}]+)\s*\}|(\w+))\s+from=["']([^"']+)["']\s*\/>/g;
  const imports: { name: string; sourcePath: string }[] = [];
  let match: RegExpExecArray | null;

  while ((match = importRegex.exec(source)) !== null) {
    const names = (match[1] || match[2]).split(',').map((name) => name.trim()).filter(Boolean);
    for (const name of names) imports.push({ name, sourcePath: match[3] });
  }

  let result = source.replace(/<import\s+[^>]+\/>/g, '');

  for (const imp of imports) {
    const matched = findUiFileForImport(uiFiles, uiFilePath, imp.sourcePath, imp.name);
    if (!matched) continue;

    const [componentPath, componentSource] = matched;
    const resolvedComponent = resolveUIImports(componentSource, componentPath, uiFiles, depth + 1)
      .replace(/<data>[\s\S]*?<\/data>/g, '')
      .replace(/<logic>[\s\S]*?<\/logic>/g, '')
      .replace(/<logic\s+[^>]*\/>/g, '')
      .replace(/<import\s+[^>]+\/>/g, '')
      .trim();

    result = result.replace(new RegExp(`<${imp.name}(\\s+[^>]*)?\\/\\s*>`, 'g'), resolvedComponent);
    result = result.replace(new RegExp(`<${imp.name}(\\s+[^>]*)?>([\\s\\S]*?)<\\/${imp.name}>`, 'g'), resolvedComponent);
  }

  return result;
}

interface VisualCanvasProps {
  onStartBrief?: () => void;
}

export const VisualCanvas: React.FC<VisualCanvasProps> = ({ onStartBrief }) => {
  const { blueprint, devicePreset, zoom, themePreview, activePageId, activeFilePath, projectId, projectName } = useWorkspaceStore();
  const { files } = useVFSStore();
  const [hoveredTool, setHoveredTool] = useState<string | null>(null);
  const [activeVFSFile, setActiveVFSFile] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [isExpandedPreview, setIsExpandedPreview] = useState(false);
  const [PreviewComponent, setPreviewComponent] = useState<React.ComponentType<any> | null>(null);
  const [ThemeProviderComponent, setThemeProviderComponent] = useState<React.ComponentType<any> | null>(null);
  const [isMobile, setIsMobile] = useState(false);

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
    return `studio-preview-${String(base).toLowerCase().replace(/[^a-z0-9-_]+/g, '-')}`;
  }, [projectId, projectName, blueprint?.appName]);

  const manifest = resolveManifest(files);
  const manifestPages = Array.isArray(manifest?.pages) ? manifest.pages as Array<Record<string, unknown>> : [];

  const deviceWidths: Record<string, number> = {
    desktop: 1280,
    tablet: 768,
    mobile: 375,
  };
  const previewWidth = deviceWidths[devicePreset] ?? 1280;
  const scale = zoom / 100;

  const hasFiles = files.size > 0;
  const selectedSurfaceLabel = activeVFSFile
    ? activeVFSFile.split('/').pop() ?? activeVFSFile
    : currentPage?.name ?? 'Preview';

  // Auto-select first UI file if none selected
  useEffect(() => {
    if (!activeVFSFile && files.size > 0) {
      setActiveVFSFile(activeFilePath || getBundleEntryPath(files));
    }
  }, [files, activeVFSFile, activeFilePath]);

  useEffect(() => {
    if (activeFilePath && activeFilePath !== activeVFSFile) {
      setActiveVFSFile(activeFilePath);
    }
  }, [activeFilePath, activeVFSFile]);

  // Get preview content for the active VFS file
  const previewFileContent = activeVFSFile
    ? (() => {
        const file = files.get(activeVFSFile);
        return file && typeof file.content === 'string' ? file.content : null;
      })()
    : null;

  const fileMimeType = activeVFSFile ? files.get(activeVFSFile)?.mimeType ?? '' : '';
  const activeBinaryContent = activeVFSFile
    ? files.get(activeVFSFile)?.content
    : null;

  // Determine if the active file is HTML-renderable
  const isHtmlFile = activeVFSFile
    ? /\.(html|htm)$/i.test(activeVFSFile)
    : false;
  const isImageFile = activeVFSFile
    ? /\.(png|jpg|jpeg|gif|webp|svg)$/i.test(activeVFSFile)
    : false;
  const isAudioFile = activeVFSFile
    ? /\.(mp3|wav|ogg|aac|flac|m4a|wma|webm)$/i.test(activeVFSFile)
    : false;
  const isVideoFile = activeVFSFile
    ? /\.(mp4|webm|ogv|mov|avi)$/i.test(activeVFSFile)
    : false;
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
          setThemeProviderComponent(() => components.ThemeProvider as unknown as React.ComponentType<any>);
        }
      } catch {
        if (mounted) setThemeProviderComponent(null);
      }

      try {
        const core = await import('@softn/core');
        if (mounted && core.SoftNRenderer) setPreviewComponent(() => core.SoftNRenderer as React.ComponentType<any>);
      } catch {
        if (mounted) setPreviewComponent(null);
      }
    };

    loadRenderer();
    return () => { mounted = false; };
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

  const activeLogicBasePath = useMemo(() => {
    if (!activeVFSFile || !previewFileContent) return undefined;
    // If the file has an explicit <logic src="..."> tag, use that path
    const explicit = getExternalLogicPath(previewFileContent, activeVFSFile);
    if (explicit) return explicit;
    // Fall back to the first .logic file in the project (for component previews)
    if (previewLogicFiles.size > 0) {
      return previewLogicFiles.keys().next().value as string;
    }
    return undefined;
  }, [activeVFSFile, previewFileContent, previewLogicFiles]);

  const initialData = useMemo(() => {
    const data: Record<string, unknown[]> = {};

    for (const [path, file] of files.entries()) {
      if (!/\.xdb$/i.test(path) || typeof file.content !== 'string') continue;

      try {
        const parsed = JSON.parse(file.content) as {
          collection?: string;
          records?: unknown[];
          data?: unknown[];
        };

        const collectionName = parsed.collection || path.split('/').pop()?.replace(/\.xdb$/i, '');
        if (!collectionName) continue;

        if (Array.isArray(parsed.records)) {
          data[collectionName] = parsed.records;
        } else if (Array.isArray(parsed.data)) {
          data[collectionName] = parsed.data;
        } else {
          data[collectionName] = [];
        }
      } catch {
        data[path.split('/').pop()?.replace(/\.xdb$/i, '') || path] = [];
      }
    }

    return data;
  }, [files]);

  useEffect(() => {
    if (typeof window === 'undefined' || !window.localStorage) return;
    for (const [collection, records] of Object.entries(initialData)) {
      try {
        window.localStorage.setItem(`xdb:${collection}`, JSON.stringify(records));
      } catch {
        // ignore local preview storage failures
      }
    }
  }, [initialData]);

  const resolveAssetUrl = useCallback((assetPath: string) => {
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
  }, [files]);

  const rendererFunctions = useMemo(() => ({
    asset: (assetPath: string) => resolveAssetUrl(assetPath),
  }), [resolveAssetUrl]);

  const importResolver = useCallback(async (path: string) => {
    const normalized = normalizeUiPath(path);
    for (const [filePath, content] of previewLogicFiles.entries()) {
      if (normalizeUiPath(filePath) === normalized) {
        return content;
      }
    }
    return null;
  }, [previewLogicFiles]);

  const { source: softNSource, preIncludedLogicPaths } = useMemo(() => {
    if (!isSoftNUIFile || !activeVFSFile || !previewFileContent) {
      return { source: null as string | null, preIncludedLogicPaths: [] as string[] };
    }
    let source = previewFileContent;
    source = resolveExternalLogic(source, activeVFSFile, previewLogicFiles);
    source = resolveUIImports(source, activeVFSFile, previewUIFiles);
    source = rewriteAssetReferences(source, resolveAssetUrl);
    source = stripComments(source);

    // If the resolved source has no <logic> block (e.g. a component .ui file
    // being previewed standalone), inject all project .logic files so that
    // shared functions are available to the template.
    // Files inlined here are already part of this compilation. They are
    // reported to the runtime so an `import` naming one is skipped rather
    // than inlining it twice — a repeated class or `let` is a SyntaxError.
    let preIncluded: string[] = [];
    if (!/<logic[\s>]/i.test(source) && previewLogicFiles.size > 0) {
      const combined = Array.from(previewLogicFiles.values()).join('\n');
      preIncluded = Array.from(previewLogicFiles.keys());
      source = `<logic>\n${combined}\n</logic>\n${source}`;
    }

    return { source, preIncludedLogicPaths: preIncluded };
  }, [isSoftNUIFile, activeVFSFile, previewFileContent, previewLogicFiles, previewUIFiles, resolveAssetUrl]);

  // Create a blob URL for HTML preview in iframe
  const blobUrl = useMemo(() => {
    if (!previewFileContent || !isHtmlFile) return null;
    const blob = new Blob([previewFileContent], { type: 'text/html' });
    return URL.createObjectURL(blob);
  }, [previewFileContent, isHtmlFile, refreshKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const binaryImageUrl = useMemo(() => {
    if (!isImageFile || !activeBinaryContent || typeof activeBinaryContent === 'string') return null;
    const bytes = new Uint8Array(activeBinaryContent);
    const blob = new Blob([bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)], {
      type: fileMimeType || 'image/png',
    });
    return URL.createObjectURL(blob);
  }, [isImageFile, activeBinaryContent, fileMimeType]);

  const binaryMediaUrl = useMemo(() => {
    if ((!isAudioFile && !isVideoFile) || !activeBinaryContent || typeof activeBinaryContent === 'string') return null;
    const bytes = new Uint8Array(activeBinaryContent);
    const blob = new Blob([bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)], {
      type: fileMimeType || (isAudioFile ? 'audio/mpeg' : 'video/mp4'),
    });
    return URL.createObjectURL(blob);
  }, [isAudioFile, isVideoFile, activeBinaryContent, fileMimeType]);

  // Revoke old blob URLs
  useEffect(() => {
    return () => {
      if (blobUrl) URL.revokeObjectURL(blobUrl);
    };
  }, [blobUrl]);

  useEffect(() => {
    return () => {
      if (binaryImageUrl) URL.revokeObjectURL(binaryImageUrl);
    };
  }, [binaryImageUrl]);

  useEffect(() => {
    return () => {
      if (binaryMediaUrl) URL.revokeObjectURL(binaryMediaUrl);
    };
  }, [binaryMediaUrl]);

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
    if (isImageFile && (binaryImageUrl || (typeof previewFileContent === 'string' && previewFileContent))) {
      return (
        <div style={styles.assetPreviewWrap}>
          <img
            src={binaryImageUrl
              ?? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(previewFileContent ?? '')}`}
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
          <video controls src={binaryMediaUrl} style={{ maxWidth: '100%', maxHeight: '70%', borderRadius: 8 }} />
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
              <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--studio-text-muted)', marginTop: 8 }}>
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
                        logicBasePath={activeLogicBasePath}
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
                      logicBasePath={activeLogicBasePath}
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
          sandbox="allow-scripts allow-same-origin"
          title="App Preview"
        />
      );
    }

    if (isManifestFile) {
      return (
        <div style={styles.codePreviewCard}>
          <div style={styles.manifestSummary}>
            <div style={styles.manifestStat}><span style={styles.manifestLabel}>Bundle</span><strong>{String(manifest?.name ?? 'Imported app')}</strong></div>
            <div style={styles.manifestStat}><span style={styles.manifestLabel}>Entry</span><strong>{String(manifest?.entry ?? manifest?.main ?? 'n/a')}</strong></div>
            <div style={styles.manifestStat}><span style={styles.manifestLabel}>Pages</span><strong>{manifestPages.length}</strong></div>
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
      <div style={{ ...styles.canvasArea, ...(isMobile ? { padding: 0 } : {}) }}>
        {hasFiles ? (
          <div
            style={{
              ...styles.previewFrame,
              ...(isMobile
                ? { borderRadius: 0, border: 'none', boxShadow: 'none', width: '100%' }
                : { width: Math.min(previewWidth * scale, previewWidth), maxWidth: '100%' }),
            }}
          >
            {!isMobile && (
              <div style={styles.previewChrome}>
                <div style={styles.previewChromeLeft}>
                  <div style={styles.previewTrafficLights}>
                    <span style={{ ...styles.trafficLight, background: 'var(--studio-border-strong)' }} />
                    <span style={{ ...styles.trafficLight, background: 'var(--studio-border-strong)' }} />
                    <span style={{ ...styles.trafficLight, background: 'var(--studio-border-strong)' }} />
                  </div>
                  <div style={styles.previewMeta}>
                    <span style={styles.previewLabel}>{selectedSurfaceLabel}</span>
                    <span style={styles.previewSubLabel}>{devicePreset} / {themePreview}</span>
                  </div>
                </div>
              </div>
            )}

            {renderPreviewContent()}
          </div>
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
              Use the AI chat or guided brief to describe your app.
              The AI will generate and modify all files for you.
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
                <button
                  onClick={onStartBrief}
                  style={styles.emptyActionCard}
                >
                  <span style={styles.emptyActionKicker}>Guided</span>
                  <span style={styles.emptyActionTitle}>Run the brief wizard</span>
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Canvas toolbar (hidden on mobile) */}
      {!isMobile && <div style={styles.toolbar}>
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
          >
            <Icon name={tool.icon} size={15} />
          </button>
        ))}
      </div>}

      {isExpandedPreview && (
        <div style={styles.expandedOverlay}>
          <div style={styles.expandedShell}>
            <div style={styles.expandedContent}>
              {renderPreviewContent()}
            </div>
            <div style={styles.expandedFloatingBar}>
              <div style={styles.expandedFloatingLabel}>{selectedSurfaceLabel}</div>
              <button onClick={() => setIsExpandedPreview(false)} style={styles.expandedCloseBtn}>
                <Icon name="x" size={16} />
              </button>
            </div>
          </div>
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
    background: 'radial-gradient(circle at top, var(--studio-accent-soft), transparent 30%), linear-gradient(180deg, var(--studio-bg) 0%, var(--studio-bg-muted) 100%)',
    overflow: 'hidden',
    position: 'relative',
  },
  atmosphere: {
    position: 'absolute',
    inset: 0,
    background: 'radial-gradient(circle at 20% 20%, var(--studio-surface), transparent 24%), radial-gradient(circle at 80% 0%, var(--studio-accent-soft), transparent 20%)',
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
  rendererWrap: {
    width: '100%',
    flex: 1,
    minHeight: 0,
    overflow: 'auto',
    background: 'var(--studio-bg-elevated)',
  },
  expandedOverlay: {
    position: 'fixed',
    inset: 0,
    background: 'var(--studio-overlay)',
    backdropFilter: 'blur(10px)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 0,
    zIndex: 999,
  },
  expandedShell: {
    width: '100%',
    height: '100%',
    borderRadius: 0,
    overflow: 'hidden',
    border: 'none',
    background: 'var(--studio-bg-elevated)',
    boxShadow: 'none',
    display: 'flex',
    flexDirection: 'column',
    position: 'relative',
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

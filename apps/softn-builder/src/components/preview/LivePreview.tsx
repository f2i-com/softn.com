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
import type { CollectionDef, LogicFileState, UIFileState } from '../../types/builder';

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
    background: '#f8fafc',
  },
  header: {
    padding: '8px 16px',
    borderBottom: '1px solid #e2e8f0',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    background: '#fff',
  },
  title: {
    fontWeight: 600,
    fontSize: 13,
    color: '#1e293b',
  },
  controls: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
  },
  deviceButton: {
    padding: '4px 8px',
    background: 'transparent',
    border: '1px solid #e2e8f0',
    borderRadius: 4,
    fontSize: 11,
    cursor: 'pointer',
    color: '#64748b',
  },
  deviceButtonActive: {
    background: '#3b82f6',
    borderColor: '#3b82f6',
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
    color: '#94a3b8',
  },
  infoBanner: {
    margin: '10px 10px 0',
    padding: '8px 10px',
    borderRadius: 8,
    border: '1px solid #bfdbfe',
    background: '#eff6ff',
    color: '#1d4ed8',
    fontSize: 12,
  },
  emptyState: {
    height: '100%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: '#64748b',
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

/**
 * Strip comments from source before passing to SoftNRenderer
 * The parser may not handle top-level comments correctly
 */
function stripComments(source: string): string {
  return (
    source
      // Remove single-line comments (// ...) but not inside strings
      .replace(/^\/\/.*$/gm, '')
      // Remove multi-line comments (/* ... */)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      // Clean up extra blank lines
      .replace(/\n\s*\n\s*\n/g, '\n\n')
      .trim()
  );
}

/**
 * Resolve UI component imports and inline them into the source.
 * Replaces <import X from="./path.ui" /> and <X /> with the actual component content.
 */
function resolveUIImports(
  source: string,
  uiFilePath: string,
  uiFiles: Map<string, UIFileState>,
  resolveFileSource: (file: UIFileState) => string,
  depth: number = 0
): string {
  if (depth > 8) {
    return source;
  }

  // Parse all import statements: <import ComponentName from="./path.ui" />
  const importRegex = /<import\s+(?:\{\s*([^}]+)\s*\}|(\w+))\s+from=["']([^"']+)["']\s*\/>/g;
  const imports: { name: string; sourcePath: string }[] = [];

  let match;
  while ((match = importRegex.exec(source)) !== null) {
    const namesStr = match[1] || match[2];
    const importPath = match[3];
    const names = namesStr.split(',').map((n: string) => n.trim());
    for (const name of names) {
      if (name) {
        imports.push({ name, sourcePath: importPath });
      }
    }
  }

  if (imports.length > 0) {
    debug(
      '[LivePreview] Resolving UI imports:',
      imports.map((i) => `${i.name} from ${i.sourcePath}`)
    );
  }

  // Remove import statements from source
  let result = source.replace(/<import\s+[^>]+\/>/g, '');

  // For each import, find the UI file and inline its content
  for (const imp of imports) {
    const resolvedPath = resolveRelativePath(uiFilePath, imp.sourcePath);
    debug('[LivePreview] Looking for UI file:', resolvedPath);

    // Find the UI file
    let componentSource: string | null = null;
    let componentFilePath = '';
    const matchedFile = findUiFileForImport(uiFiles, uiFilePath, imp.sourcePath, imp.name);
    if (matchedFile) {
      componentFilePath = matchedFile.path;
      componentSource = resolveFileSource(matchedFile);
      debug('[LivePreview] Found UI file:', matchedFile.path);
    }

    if (componentSource) {
      // Resolve nested imports relative to the imported component file.
      const resolvedComponentSource = resolveUIImports(
        componentSource,
        componentFilePath || uiFilePath,
        uiFiles,
        resolveFileSource,
        depth + 1
      );

      // Extract just the template content from the component (remove imports, logic refs, data blocks, comments)
      const templateContent = resolvedComponentSource
        .replace(/<data>[\s\S]*?<\/data>/g, '')
        .replace(/<logic>[\s\S]*?<\/logic>/g, '')
        .replace(/<logic\s+[^>]*\/>/g, '')
        .replace(/<import\s+[^>]+\/>/g, '')
        .trim();

      // Replace self-closing usage: <ComponentName /> or <ComponentName attr="val" />
      const selfClosingRegex = new RegExp(`<${imp.name}(\\s+[^>]*)?\\/\\s*>`, 'g');
      result = result.replace(selfClosingRegex, () => {
        return templateContent;
      });

      // Replace paired usage: <ComponentName>...</ComponentName>
      const pairedRegex = new RegExp(`<${imp.name}(\\s+[^>]*)?>([\\s\\S]*?)<\\/${imp.name}>`, 'g');
      result = result.replace(pairedRegex, () => {
        return templateContent;
      });
    } else {
      console.warn('[LivePreview] UI file not found for import:', imp.name, 'from', imp.sourcePath);
    }
  }

  // Fallback: if unresolved uppercase component tags remain, try matching by file basename.
  const unresolvedNames = Array.from(result.matchAll(/<([A-Z][A-Za-z0-9_]*)\b/g)).map((m) => m[1]);
  const syntheticImports: { name: string; sourcePath: string }[] = [];
  for (const name of unresolvedNames) {
    for (const [, file] of uiFiles) {
      const base = file.path.split('/').pop() || '';
      if (base.toLowerCase() === `${name.toLowerCase()}.ui`) {
        if (!syntheticImports.some((imp) => imp.name === name && imp.sourcePath === file.path)) {
          syntheticImports.push({ name, sourcePath: file.path });
        }
        break;
      }
    }
  }

  if (syntheticImports.length > 0) {
    const syntheticBlock = syntheticImports
      .map((imp) => `<import ${imp.name} from="${imp.sourcePath}" />`)
      .join('\n');
    return resolveUIImports(
      `${syntheticBlock}\n\n${result}`,
      uiFilePath,
      uiFiles,
      resolveFileSource,
      depth + 1
    );
  }

  // Final fallback: inline by matching unresolved component tag names to ui file basenames.
  // This handles cases where import metadata is stale/missing in builder state.
  const unresolvedAfterFallback = Array.from(
    result.matchAll(/<([A-Z][A-Za-z0-9_]*)\b/g)
  ).map((m) => m[1]);
  if (unresolvedAfterFallback.length > 0) {
    let changed = false;
    for (const componentName of unresolvedAfterFallback) {
      const matchedFile = findUiFileForImport(uiFiles, uiFilePath, `${componentName}.ui`, componentName);
      if (!matchedFile) continue;

      const resolvedComponentSource = resolveUIImports(
        resolveFileSource(matchedFile),
        matchedFile.path,
        uiFiles,
        resolveFileSource,
        depth + 1
      );
      const templateContent = resolvedComponentSource
        .replace(/<data>[\s\S]*?<\/data>/g, '')
        .replace(/<logic>[\s\S]*?<\/logic>/g, '')
        .replace(/<logic\s+[^>]*\/>/g, '')
        .replace(/<import\s+[^>]+\/>/g, '')
        .trim();

      const selfClosingRegex = new RegExp(`<${componentName}(\\s+[^>]*)?\\/\\s*>`, 'g');
      const pairedRegex = new RegExp(`<${componentName}(\\s+[^>]*)?>([\\s\\S]*?)<\\/${componentName}>`, 'g');
      const before = result;
      result = result.replace(selfClosingRegex, templateContent);
      result = result.replace(pairedRegex, templateContent);
      if (before !== result) {
        changed = true;
      }
    }

    if (changed) {
      return resolveUIImports(result, uiFilePath, uiFiles, resolveFileSource, depth + 1);
    }
  }

  return result;
}

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
 * Resolve external logic file references and inline them into the source.
 * Replaces <logic src="./path.logic" /> with <logic>...content...</logic>
 */
function resolveExternalLogic(
  source: string,
  uiFilePath: string,
  logicFiles: Map<string, LogicFileState>
): string {
  // Match <logic src="..." /> or <logic src='...' />
  const logicSrcRegex = /<logic\s+src=["']([^"']+)["']\s*\/>/g;

  return source.replace(logicSrcRegex, (_match, srcPath: string) => {
    debug('[LivePreview] Resolving external logic:', srcPath, 'from:', uiFilePath);

    // Try multiple path resolution strategies
    const pathsToTry: string[] = [];

    // 1. Resolve relative path from UI file location
    const resolvedPath = resolveRelativePath(uiFilePath, srcPath);
    pathsToTry.push(resolvedPath);
    pathsToTry.push(resolvedPath.replace(/^\//, ''));

    // 2. If UI is in ui/ folder and references ./file.logic, also try logic/ folder
    if (uiFilePath.startsWith('ui/') && srcPath.startsWith('./')) {
      const filename = srcPath.slice(2); // Remove ./
      pathsToTry.push(`logic/${filename}`);
    }

    // 3. Try the path as-is (without ./)
    if (srcPath.startsWith('./')) {
      pathsToTry.push(srcPath.slice(2));
    }

    debug('[LivePreview] Trying paths:', pathsToTry);

    // Find the logic file by trying all possible paths
    let logicContent: string | null = null;
    for (const [, logicFile] of logicFiles) {
      debug('[LivePreview] Checking logic file:', logicFile.path);
      for (const tryPath of pathsToTry) {
        if (logicFile.path === tryPath) {
          logicContent = logicFile.content;
          debug(
            '[LivePreview] Found logic file:',
            logicFile.path,
            'content length:',
            logicContent.length
          );
          break;
        }
      }
      if (logicContent) break;
    }

    if (logicContent) {
      // Return inline logic block
      return `<logic>\n${logicContent}\n</logic>`;
    } else {
      console.warn('[LivePreview] Logic file not found. Tried paths:', pathsToTry);
      // Return empty logic block to avoid parse errors
      return `<logic>\n// Logic file not found: ${srcPath}\n</logic>`;
    }
  });
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

function normalizeUiPath(path: string): string {
  return path
    .replace(/\\/g, '/')
    .replace(/^\.?\//, '')
    .replace(/\/+/g, '/')
    .replace(/\/$/, '')
    .toLowerCase();
}

function findUiFileForImport(
  uiFiles: Map<string, UIFileState>,
  fromUiPath: string,
  importPath: string,
  importName: string
): UIFileState | undefined {
  const resolved = resolveRelativePath(fromUiPath, importPath);
  const normalizedCandidates = new Set<string>([
    normalizeUiPath(importPath),
    normalizeUiPath(resolved),
    normalizeUiPath(importPath.replace(/^\.\//, '')),
    normalizeUiPath(resolved.replace(/^\//, '')),
  ]);

  if (importPath.startsWith('./') && fromUiPath.startsWith('ui/')) {
    normalizedCandidates.add(normalizeUiPath(`ui/${importPath.slice(2)}`));
  }

  for (const [, file] of uiFiles) {
    const fileNorm = normalizeUiPath(file.path);
    if (normalizedCandidates.has(fileNorm)) {
      return file;
    }
  }

  const expectedFileName = `${importName.toLowerCase()}.ui`;
  for (const [, file] of uiFiles) {
    const base = (file.path.split('/').pop() || '').toLowerCase();
    if (base === expectedFileName) {
      return file;
    }
  }

  return undefined;
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
  }, [width, height]);

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
          border: '1px solid #cbd5e1',
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

export function LivePreview() {
  const { elements, rootId } = useCanvasStore();
  const { logicSource, collections: projectCollections, themeMode } = useProjectStore();
  const { entities, seedData } = useSchemaStore();
  const { activeFileId, uiFiles, logicFiles, nodes } = useFilesStore();
  const [device, setDevice] = useState<DevicePreset>('desktop');
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [forceRender, setForceRender] = useState(false);
  const [PreviewComponent, setPreviewComponent] = useState<React.ComponentType<{
    source: string;
    loading?: React.ReactNode;
    error?: React.ReactNode | ((error: Error) => React.ReactNode);
    initialData?: Record<string, unknown[]>;
    initialState?: Record<string, unknown>;
    onLoad?: (doc: unknown) => void;
    onError?: (err: Error) => void;
  }> | null>(null);
  const [ThemeProviderComponent, setThemeProviderComponent] = useState<React.ComponentType<{
    defaultDarkMode?: boolean;
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
      // Check if projectCollections has fullRecords for this entity
      const projectCol = projectCollections.find((c) => c.name === entity.name);
      const fullRecords = projectCol?.fullRecords;

      debug(
        `[LivePreview] Entity "${entity.name}" (id=${entity.id}): ${entitySeedData.length} records, fullRecords: ${fullRecords?.length || 0}`
      );
      return {
        name: entity.name,
        alias: entity.alias,
        fields: entity.fields,
        seedData: entitySeedData,
        fullRecords: fullRecords, // Preserve fullRecords from projectCollections
      };
    });
    const schemaNames = new Set(schemaCollections.map((c) => c.name));
    const manualCollections = projectCollections.filter((c) => !schemaNames.has(c.name));
    return [...schemaCollections, ...manualCollections];
  }, [entities, seedData, projectCollections]);

  // Get source - prioritize ui/main.ui for stable preview behavior.
  // IMPORTANT: useMemo must be a pure computation — no setState calls.
  // Errors and info are returned as part of the result and synced via useEffect.
  const previewState = useMemo(() => {
    let rawSource = '';
    let activeFilePath = '';
    let info: string | null = null;
    let errorMsg: string | null = null;
    const mainUIFile = Array.from(uiFiles.values()).find((file) => file.path === 'ui/main.ui');
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
      if (file.originalSource?.trim()) {
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

    // If the file being previewed is actively open in design, always merge the
    // live canvas template into the source so canvas edits are reflected
    // immediately — even for files with imports like ui/main.ui.
    if (primaryUIFile && activeUIFile && primaryUIFile.id === activeUIFile.id) {
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

    // Resolve external logic file references
    if (rawSource && logicFiles.size > 0) {
      debug(
        '[LivePreview] Resolving external logic files, logicFiles count:',
        logicFiles.size
      );
      rawSource = resolveExternalLogic(rawSource, activeFilePath, logicFiles);
    }

    // Resolve UI component imports (inline imported components)
    if (rawSource && uiFiles.size > 0) {
      debug('[LivePreview] Resolving UI imports, uiFiles count:', uiFiles.size);
      rawSource = resolveUIImports(rawSource, activeFilePath, uiFiles, resolveImportedFileSource);
    }

    return { source: rawSource, activeFilePath, info, error: null as string | null };
  }, [elements, rootId, logicSource, collections, activeFileId, uiFiles, logicFiles, nodes]);
  const source = previewState.source;

  // Sync error and info from the pure useMemo result into component state.
  useEffect(() => {
    setError(previewState.error);
    setSourceInfo(previewState.info);
  }, [previewState.error, previewState.info]);

  // Dynamically import SoftN renderer and ThemeProvider
  useEffect(() => {
    const loadRenderer = async () => {
      setIsLoading(true);
      try {
        // Try to import @softn/core renderer
        const core = await import('@softn/core');
        debug('[LivePreview] Loaded @softn/core:', Object.keys(core));
        // Use SoftNRenderer directly (not SoftNWithXDB) to avoid IndexedDB issues
        // The builder preview doesn't need persistent storage
        if (core.SoftNRenderer) {
          debug('[LivePreview] Using SoftNRenderer (no XDB for preview)');
          setPreviewComponent(() => core.SoftNRenderer);
        } else if (core.SoftNWithXDB) {
          debug('[LivePreview] Falling back to SoftNWithXDB');
          setPreviewComponent(() => core.SoftNWithXDB);
        }
      } catch (e) {
        // If import fails, show placeholder
        console.error('[LivePreview] Failed to load @softn/core:', e);
        setPreviewComponent(null);
      }

      try {
        // Import ThemeProvider from @softn/components
        const components = await import('@softn/components');
        debug('[LivePreview] Loaded @softn/components ThemeProvider');
        setThemeProviderComponent(() => components.ThemeProvider);
      } catch (e) {
        console.error('[LivePreview] Failed to load ThemeProvider:', e);
        setThemeProviderComponent(null);
      }
      setIsLoading(false);
    };
    loadRenderer();
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
            <div style={{ fontSize: 11, color: '#94a3b8' }}>Initializing renderer</div>
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
          <div style={{ fontWeight: 600, marginBottom: 8, color: '#1e293b' }}>Large Preview</div>
          <div style={{ color: '#64748b', marginBottom: 16, fontSize: 13 }}>
            This UI has {elements.size} elements ({source.length.toLocaleString()} characters).
            <br />
            Rendering may be slow or cause memory issues.
          </div>
          <button
            onClick={() => setForceRender(true)}
            style={{
              padding: '8px 16px',
              background: '#3b82f6',
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
              background: '#e2e8f0',
              color: '#475569',
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
      // Strip comments from source before rendering - parser may not handle top-level comments
      const cleanSource = stripComments(source);
      debug(
        '[LivePreview] Rendering PreviewComponent with source length:',
        cleanSource.length
      );

      const loadingFallback = (
        <div style={{ padding: 24, textAlign: 'center', color: '#64748b' }}>
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

      // Build initialData from collections with their seed data
      // Use fullRecords if available (preserves { id, collection, data, ... } structure)
      // Otherwise transform flat seedData into full record structure for the renderer
      const mockInitialData: Record<string, unknown[]> = {};
      for (const col of collections) {
        const key = col.alias || col.name;

        if (col.fullRecords && col.fullRecords.length > 0) {
          // Use full records directly (already has { id, collection, data, ... } structure)
          mockInitialData[key] = col.fullRecords;
          debug(
            `[LivePreview] initialData["${key}"]: ${mockInitialData[key].length} records (using fullRecords)`
          );
        } else if (col.seedData && col.seedData.length > 0) {
          // Transform flat data into full record structure
          mockInitialData[key] = col.seedData.map((data, index) => ({
            id: `preview_${col.name}_${index}`,
            collection: col.name,
            data: data,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          }));
          debug(
            `[LivePreview] initialData["${key}"]: ${mockInitialData[key].length} records (transformed from seedData)`
          );
        } else {
          mockInitialData[key] = [];
          debug(`[LivePreview] initialData["${key}"]: 0 records`);
        }
      }
      debug(
        '[LivePreview] Providing initialData for collections:',
        Object.keys(mockInitialData),
        'Total records:',
        Object.values(mockInitialData).reduce((sum, arr) => sum + arr.length, 0)
      );

      const preview = (
        <PreviewErrorBoundary fallback={renderError}>
          <PreviewComponent
            source={cleanSource}
            loading={loadingFallback}
            error={errorFallback}
            initialData={mockInitialData}
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
                defaultDarkMode={isDarkMode}
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
      <div style={{ padding: 16, fontSize: 14, color: '#64748b' }}>
        <div style={{ marginBottom: 16, fontWeight: 600 }}>Preview (Source)</div>
        <div style={{ marginBottom: 8, fontSize: 12, color: '#94a3b8' }}>
          Elements: {elements.size} | Source: {source.length.toLocaleString()} chars
        </div>
        <div
          style={{
            fontFamily: 'monospace',
            fontSize: 11,
            whiteSpace: 'pre-wrap',
            background: '#f8fafc',
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
        <div style={styles.controls}>
          {(['desktop', 'tablet', 'mobile'] as DevicePreset[]).map((d) => (
            <button
              key={d}
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

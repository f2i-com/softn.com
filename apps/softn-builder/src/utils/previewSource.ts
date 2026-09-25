/**
 * The source the preview runs, from the stores as they stand.
 *
 * A pure function, out of the component, so that what the preview runs can be
 * asserted without mounting a renderer — the preview was where a stale copy
 * of the logic survived longest, and nothing could see it.
 *
 * Logic reaches the preview the way it reaches every runtime: through a
 * `<logic src>` naming a file, which the composer reads. It used to be
 * inlined here from the project's copy, which was JavaScript whatever the
 * project was, and which no export reads.
 */

import type { CanvasElement, CollectionDef, LogicFileState, ProjectFileNode, UIFileState } from '../types/builder';
import type { RetainedSource } from '../stores/projectStore';
import { generateSource } from './sourceGenerator';
import { composePreviewBundle } from './previewBundle';
import { previewManifest } from './bundleExporter';
import { entryFileId, linkedLogicFile, logicSrcOf, relativeImportPath } from './logicFiles';
import { debug } from './debug';
import { PYTHON_PACKAGES } from '@softn/core';

export interface PreviewSourceInput {
  /** The canvas: the active UI file's tree as it is being edited. */
  elements: Map<string, CanvasElement>;
  rootId: string;
  /** The project's own copy, used only when there is no UI file at all. */
  logicSource: string;
  collections: CollectionDef[];
  activeFileId: string | null;
  uiFiles: Map<string, UIFileState>;
  logicFiles: Map<string, LogicFileState>;
  nodes: Map<string, ProjectFileNode>;
  retainedSource: RetainedSource;
  /**
   * The Python packages the project declares, as export writes them. Absent:
   * whatever the retained manifest declares.
   */
  pythonPackages?: string[];
}

export interface PreviewSourceResult {
  source: string;
  activeFilePath: string;
  info: string | null;
  error: string | null;
  composition?: ReturnType<typeof composePreviewBundle>;
}

/**
 * The package a composer refusal says the app imports without declaring, when
 * it is one the runtime offers — the one an "Enable" action can declare.
 */
export function undeclaredPythonPackage(error: string | null): string | null {
  const name = error?.match(/ imports (\w+), which an app asks for in manifest\.json/)?.[1];
  return name && PYTHON_PACKAGES.includes(name) ? name : null;
}

export function previewSourceFor(input: PreviewSourceInput): PreviewSourceResult {
  const { elements, rootId, logicSource, collections, activeFileId, uiFiles, logicFiles, nodes, retainedSource } = input;
  let rawSource = '';
  let activeFilePath = '';
  let info: string | null = null;
  const entryId = entryFileId(uiFiles, retainedSource);
  const mainUIFile = entryId ? uiFiles.get(entryId) : undefined;
  const activeNode = activeFileId ? nodes.get(activeFileId) : null;
  const activeUIFile =
    activeFileId && activeNode?.type === 'file' && activeNode.fileType === 'ui'
      ? uiFiles.get(activeFileId)
      : undefined;

  // Prefer active UI file for immediate feedback; fallback to main.ui for stability.
  const primaryUIFile = activeUIFile || mainUIFile;
  const isMainFallback = !activeUIFile && !!mainUIFile;

  // A file the Builder generates is previewed in the shape export writes it:
  // a `<logic src>` naming its linked file. A page with no logic of its own
  // is previewed with the entry's, which is the logic it runs inside.
  const generatedWithLogic = (file: UIFileState, fileElements: Map<string, CanvasElement>, fileRootId: string) => {
    let logicSrc = logicSrcOf(file, logicFiles);
    if (!logicSrc) {
      const entryLogic = linkedLogicFile(mainUIFile, logicFiles);
      if (entryLogic) logicSrc = relativeImportPath(file.path, entryLogic.path);
    }
    return generateSource(fileElements, fileRootId, '', collections, { logicSrc });
  };

  const resolveImportedFileSource = (file: UIFileState): string => {
    if (file.originalSource !== undefined) {
      return file.originalSource;
    }
    // For files without originalSource, generate from canvas elements.
    // Use skipRootAppWrapper so we don't inject <App> into components
    // that had a different root element (Header.ui, Dashboard.ui, etc.).
    return generateSource(file.elements, file.rootId, '', [], {
      skipRootAppWrapper: true,
    });
  };

  // Authored source is authoritative, including constructs the canvas cannot
  // represent. The view switch flushes accepted canvas edits before preview.
  // Rebuilding a source-only file here loses mixed text and can show stale code.
  if (primaryUIFile?.originalSource !== undefined) {
    rawSource = primaryUIFile.originalSource;
    activeFilePath = primaryUIFile.path;
    if (!rawSource.trim()) return { source: '', activeFilePath, info: 'This UI file is empty. Add source in Code view to preview it.', error: null };
    if (isMainFallback) {
      info = 'Preview is showing the entry file because no UI file is active.';
    }
  } else if (primaryUIFile) {
    // The active file is the canvas, as it is being edited; the entry file,
    // shown while a logic file is open, is its stored tree.
    const live = primaryUIFile === activeUIFile;
    try {
      rawSource = generatedWithLogic(
        primaryUIFile,
        live ? elements : primaryUIFile.elements,
        live ? rootId : primaryUIFile.rootId
      );
      activeFilePath = primaryUIFile.path;
      if (isMainFallback) {
        info = 'Preview is showing the entry file because no UI file is active.';
      }
    } catch (err) {
      console.error('[LivePreview] Error generating source from UI file state:', err);
      return { source: '', activeFilePath: '', info, error: err instanceof Error ? err.message : 'Failed to generate source' };
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
      return { source: '', activeFilePath: '', info, error: err instanceof Error ? err.message : 'Failed to generate source' };
    }
  }

  try {
    const mainPath = activeFilePath || 'ui/main.ui';
    const files = new Map([...uiFiles.values()].map((file) => [file.path, resolveImportedFileSource(file)]));
    for (const file of logicFiles.values()) files.set(file.path, file.content);
    files.set(mainPath, rawSource);
    const manifest = previewManifest(
      retainedSource.manifest,
      [...logicFiles.values()].map((file) => file.path),
      input.pythonPackages
    );
    const composition = composePreviewBundle(files, mainPath, manifest);
    return { source: composition.source, activeFilePath, info, error: null, composition };
  } catch (err) {
    return { source: '', activeFilePath, info, error: err instanceof Error ? err.message : 'Could not prepare the preview.' };
  }
}

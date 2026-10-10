/**
 * SourceView - Editable .ui source view with live preview sync
 */

import React, { useMemo, useCallback, useRef } from 'react';
import { useCanvasStore } from '../../stores/canvasStore';
import { useHistoryStore } from '../../stores/historyStore';
import { useProjectStore } from '../../stores/projectStore';
import { useFilesStore } from '../../stores/filesStore';
import { generateSource } from '../../utils/sourceGenerator';
import { logicSrcOf } from '../../utils/logicFiles';
import { liveImports } from '../../utils/pageImports';
import { gatherCollections } from '../../utils/buildProjectBundle';
import { useSchemaStore } from '../../stores/schemaStore';
import { useSourceFidelity, summariseReasons } from '../../utils/useSourceFidelity';
import { CodeEditor } from './CodeEditor';
import { EditorWayOut } from './EditorWayOut';

const styles: Record<string, React.CSSProperties> = {
  container: {
    height: '100%',
    display: 'flex',
    flexDirection: 'column',
    background: 'var(--ink-2)',
  },
  header: {
    minHeight: 40,
    padding: '6px 16px',
    gap: 12,
    borderBottom: '1px solid var(--line-soft)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  title: {
    fontFamily: 'var(--mono)',
    fontWeight: 500,
    fontSize: 12.5,
    color: 'var(--paper)',
  },
  titleContainer: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    minWidth: 0,
  },
  hint: {
    fontSize: 11.5,
    color: 'var(--dim)',
  },
  editorWrapper: {
    flex: 1,
    overflow: 'hidden',
  },
};

export function SourceView() {
  const { elements, rootId } = useCanvasStore();
  const projectCollections = useProjectStore((state) => state.collections);
  const entities = useSchemaStore((state) => state.entities);
  const { activeFileId, uiFiles, logicFiles, nodes, updateUIFileSource } = useFilesStore();
  const isDirty = activeFileId ? nodes.get(activeFileId)?.isDirty : false;

  // Get the initial source - prefer original source from loaded bundle.
  //
  // A file with no source of its own yet is shown in the shape export writes
  // it: its logic linked with `<logic src>`, never inlined. This text becomes
  // the file's source on the first keystroke, and an inline copy there was a
  // copy nothing else edits — the dock went on writing the logic file, while
  // the preview and the export ran the copy, and every later logic edit was
  // silently lost.
  const initialSource = useMemo(() => {
    const activeFile = activeFileId ? uiFiles.get(activeFileId) : undefined;
    if (activeFile?.originalSource !== undefined) {
      return activeFile.originalSource;
    }
    const logicSrc = activeFile ? logicSrcOf(activeFile, logicFiles) : undefined;
    // The collections export declares, schema first. It refuses a schema it
    // cannot write (two collections of one name); the Code view still shows
    // the file, with the collections defined by hand.
    let collections = projectCollections;
    try {
      collections = gatherCollections();
    } catch {
      // Export says why when it is asked to write the bundle.
    }
    // With the pages it uses, as they stand on the canvas now.
    const canvasNow = useCanvasStore.getState();
    const imports = liveImports(elements, canvasNow.imports, canvasNow.writtenImports);
    return generateSource(elements, rootId, '', collections, { logicSrc, imports });
    // `entities` is read through gatherCollections, and is what makes the view follow the schema.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [elements, rootId, projectCollections, entities, activeFileId, uiFiles, logicFiles]);

  // What is written here is one step for Undo, taken once: the canvas as it
  // was when this view was opened, or the file changed under it. Without
  // one, Undo back in Design went to before the last change made on the
  // canvas, and took that change away along with everything written here.
  // One and not one per keystroke: the tree of a line half typed is not a
  // state to step back to and write the file from.
  const recordedFor = useRef<string | null>(null);

  // Handle source changes from the editor
  const handleSourceChange = useCallback(
    (newSource: string) => {
      // Update the store immediately for live preview
      if (activeFileId) {
        if (recordedFor.current !== activeFileId) {
          recordedFor.current = activeFileId;
          const canvas = useCanvasStore.getState();
          useHistoryStore.getState().push(canvas.elements, canvas.rootId);
        }
        updateUIFileSource(activeFileId, newSource);
      }
    },
    [activeFileId, updateUIFileSource]
  );

  // Determine if showing original or generated source
  const activeFile = activeFileId ? uiFiles.get(activeFileId) : null;
  const isFromBundle = activeFile?.originalSource !== undefined;

  // Which editing mode is safe for this file. A file the visual model
  // cannot write back is edited here, as source; the canvas will not
  // regenerate it, and says so when an edit there was refused.
  const { fidelity, blocked } = useSourceFidelity(activeFile);
  const sourceOnly = fidelity !== null && !fidelity.lossless;

  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <div style={styles.titleContainer}>
          <span style={styles.title}>
            {isFromBundle ? activeFile?.path || 'Source (.ui)' : 'Source (.ui)'}
          </span>
          {isDirty && <span className="bl-dirty-dot" title="Unsaved changes" role="img" aria-label="Unsaved changes" />}
          {fidelity && (
            <span
              className="bl-badge"
              data-tone={sourceOnly ? 'warn' : undefined}
              title={
                sourceOnly
                  ? `The visual editor cannot write this file back:\n${fidelity.reasons.join('\n')}`
                  : 'The canvas can write this file back; both editors are safe.'
              }
              data-fidelity={sourceOnly ? 'source-only' : 'visual'}
            >
              {sourceOnly ? 'Source-only' : 'Visual + source'}
            </span>
          )}
        </div>
        <span style={styles.hint}>Edits here update the canvas and the preview</span>
      </div>
      <EditorWayOut style={{ display: 'block', padding: '3px 16px', borderBottom: '1px solid var(--line-soft)' }} />
      {(sourceOnly || blocked) && (
        <div className="bl-notice" role="status">
          {blocked
            ? `A canvas edit was not written to this file — it has constructs the visual editor cannot write back: ${summariseReasons(blocked)}. Edit its source here.`
            : `This file has constructs the visual editor cannot write back: ${summariseReasons(fidelity!.reasons)}. Edit its source here; the canvas will not change it.`}
        </div>
      )}
      {/* What the parser warns of in a page it reads whole: the page runs and
          is edited in Design, and something written in it does nothing. */}
      {fidelity?.warnings && fidelity.warnings.length > 0 && (
        <div className="bl-notice" role="status" data-source-warnings="">
          {fidelity.warnings.length === 1 ? 'A warning for this page. ' : `${fidelity.warnings.length} warnings for this page. `}
          {fidelity.warnings.join(' ')}
        </div>
      )}
      <div style={styles.editorWrapper}>
        <CodeEditor
          value={initialSource}
          onChange={handleSourceChange}
          language="xml"
          readOnly={false}
          height="100%"
        />
      </div>
    </div>
  );
}

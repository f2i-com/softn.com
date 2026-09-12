/**
 * SourceView - Editable .ui source view with live preview sync
 */

import React, { useMemo, useCallback } from 'react';
import { useCanvasStore } from '../../stores/canvasStore';
import { useProjectStore } from '../../stores/projectStore';
import { useFilesStore } from '../../stores/filesStore';
import { generateSource } from '../../utils/sourceGenerator';
import { useSourceFidelity, summariseReasons } from '../../utils/useSourceFidelity';
import { CodeEditor } from './CodeEditor';

const styles: Record<string, React.CSSProperties> = {
  container: {
    height: '100%',
    display: 'flex',
    flexDirection: 'column',
    background: 'var(--ink-2)',
  },
  header: {
    padding: '8px 16px',
    borderBottom: '1px solid var(--line-soft)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  title: {
    fontWeight: 600,
    fontSize: 13,
    color: 'var(--paper)',
  },
  titleContainer: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
  },
  dirtyIndicator: {
    width: 8,
    height: 8,
    borderRadius: '50%',
    background: '#f59e0b',
  },
  hint: {
    fontSize: 11,
    color: 'var(--dimmer)',
  },
  badgeVisual: {
    fontSize: 10,
    fontWeight: 600,
    padding: '2px 6px',
    borderRadius: 4,
    background: 'var(--mint-glow-soft)',
    color: 'var(--paper)',
    border: '1px solid var(--mint-edge)',
  },
  badgeSourceOnly: {
    fontSize: 10,
    fontWeight: 600,
    padding: '2px 6px',
    borderRadius: 4,
    background: '#fffbeb',
    color: '#92400e',
    border: '1px solid #fde68a',
  },
  notice: {
    padding: '6px 16px',
    fontSize: 12,
    lineHeight: 1.4,
    background: '#fffbeb',
    color: '#92400e',
    borderBottom: '1px solid #fde68a',
  },
  editorWrapper: {
    flex: 1,
    overflow: 'hidden',
  },
};

export function SourceView() {
  const { elements, rootId } = useCanvasStore();
  const { logicSource, collections } = useProjectStore();
  const { activeFileId, uiFiles, nodes, updateUIFileSource } = useFilesStore();
  const isDirty = activeFileId ? nodes.get(activeFileId)?.isDirty : false;

  // Get the initial source - prefer original source from loaded bundle
  const initialSource = useMemo(() => {
    if (activeFileId) {
      const activeFile = uiFiles.get(activeFileId);
      if (activeFile?.originalSource !== undefined) {
        return activeFile.originalSource;
      }
    }
    return generateSource(elements, rootId, logicSource, collections);
  }, [elements, rootId, logicSource, collections, activeFileId, uiFiles]);

  // Handle source changes from the editor
  const handleSourceChange = useCallback(
    (newSource: string) => {
      // Update the store immediately for live preview
      if (activeFileId) {
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
          {isDirty && <div style={styles.dirtyIndicator} title="Unsaved changes" />}
          {fidelity && (
            <span
              style={sourceOnly ? styles.badgeSourceOnly : styles.badgeVisual}
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
        <span style={styles.hint}>Edit source code - changes sync to preview</span>
      </div>
      {(sourceOnly || blocked) && (
        <div style={styles.notice} role="status">
          {blocked
            ? `A canvas edit was not written to this file — it has constructs the visual editor cannot write back: ${summariseReasons(blocked)}. Edit its source here.`
            : `This file has constructs the visual editor cannot write back: ${summariseReasons(fidelity!.reasons)}. Edit its source here; the canvas will not change it.`}
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

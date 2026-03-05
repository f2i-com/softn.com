/**
 * SourceView - Editable .ui source view with live preview sync
 */

import React, { useMemo, useState, useCallback, useEffect } from 'react';
import { useCanvasStore } from '../../stores/canvasStore';
import { useProjectStore } from '../../stores/projectStore';
import { useFilesStore } from '../../stores/filesStore';
import { generateSource } from '../../utils/sourceGenerator';
import { CodeEditor } from './CodeEditor';

const styles: Record<string, React.CSSProperties> = {
  container: {
    height: '100%',
    display: 'flex',
    flexDirection: 'column',
    background: '#fff',
  },
  header: {
    padding: '8px 16px',
    borderBottom: '1px solid #e2e8f0',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  title: {
    fontWeight: 600,
    fontSize: 13,
    color: '#1e293b',
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
    color: '#94a3b8',
  },
  editorWrapper: {
    flex: 1,
    overflow: 'hidden',
  },
};

export function SourceView() {
  const { elements, rootId } = useCanvasStore();
  const { logicSource, collections } = useProjectStore();
  const { activeFileId, uiFiles, updateUIFileSource } = useFilesStore();
  const [localSource, setLocalSource] = useState<string>('');
  const [isDirty, setIsDirty] = useState(false);

  // Get the initial source - prefer original source from loaded bundle
  const initialSource = useMemo(() => {
    if (activeFileId) {
      const activeFile = uiFiles.get(activeFileId);
      if (activeFile?.originalSource) {
        return activeFile.originalSource;
      }
    }
    return generateSource(elements, rootId, logicSource, collections);
  }, [elements, rootId, logicSource, collections, activeFileId, uiFiles]);

  // Sync local source when file changes or initial source updates
  useEffect(() => {
    setLocalSource(initialSource);
    setIsDirty(false);
  }, [initialSource]);

  // Handle source changes from the editor
  const handleSourceChange = useCallback(
    (newSource: string) => {
      setLocalSource(newSource);
      setIsDirty(true);

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

  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <div style={styles.titleContainer}>
          <span style={styles.title}>
            {isFromBundle ? activeFile?.path || 'Source (.ui)' : 'Source (.ui)'}
          </span>
          {isDirty && <div style={styles.dirtyIndicator} title="Unsaved changes" />}
        </div>
        <span style={styles.hint}>Edit source code - changes sync to preview</span>
      </div>
      <div style={styles.editorWrapper}>
        <CodeEditor
          value={localSource}
          onChange={handleSourceChange}
          language="xml"
          readOnly={false}
          height="100%"
        />
      </div>
    </div>
  );
}

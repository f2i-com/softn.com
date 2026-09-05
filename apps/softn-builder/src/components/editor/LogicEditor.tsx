/**
 * LogicEditor - .logic code editor
 */

import React from 'react';
import { useProjectStore } from '../../stores/projectStore';
import { useFilesStore } from '../../stores/filesStore';
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
  hint: {
    fontSize: 11,
    color: 'var(--dimmer)',
  },
  editorWrapper: {
    flex: 1,
    overflow: 'hidden',
  },
};

export function LogicEditor() {
  const { logicSource, setLogicSource } = useProjectStore();
  const { activeFileId, nodes, logicFiles, updateLogicFile } = useFilesStore((state) => ({
    activeFileId: state.activeFileId,
    nodes: state.nodes,
    logicFiles: state.logicFiles,
    updateLogicFile: state.updateLogicFile,
  }));

  const activeNode = activeFileId ? nodes.get(activeFileId) : null;
  const isActiveLogicFile = activeNode?.type === 'file' && activeNode.fileType === 'logic';
  const activeLogicFile =
    isActiveLogicFile && activeFileId ? logicFiles.get(activeFileId) : undefined;
  const editorValue = activeLogicFile?.content ?? logicSource;
  const editorTitle = activeLogicFile ? `Logic (${activeLogicFile.path})` : 'Logic';

  const handleChange = (next: string) => {
    if (activeLogicFile && activeFileId) {
      updateLogicFile(activeFileId, next);
      if (activeLogicFile.path === 'logic/main.logic') {
        setLogicSource(next);
      }
      return;
    }

    // No logic file is open — this is the dock beneath the canvas, edited while
    // a .ui file is active. It used to write only to the project's logicSource,
    // and Save takes the multi-file path whenever a project has more than one
    // file, which every New Project does (ui/main.ui plus logic/main.logic).
    // That path reads logicFiles and never looks at logicSource, so everything
    // typed here was dropped from the saved bundle without a word.
    setLogicSource(next);
    const mainLogic = useFilesStore.getState().getFileByPath('logic/main.logic');
    if (mainLogic) {
      updateLogicFile(mainLogic.id, next);
    }
  };

  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <span style={styles.title}>{editorTitle}</span>
        <span style={styles.hint}>Define state, computed values, and functions</span>
      </div>
      <div style={styles.editorWrapper}>
        <CodeEditor
          value={editorValue}
          onChange={handleChange}
          language="javascript"
          height="100%"
        />
      </div>
    </div>
  );
}

/**
 * LogicEditor - FormLogic code editor
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
  hint: {
    fontSize: 11,
    color: '#94a3b8',
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
  const editorTitle = activeLogicFile ? `Logic (${activeLogicFile.path})` : 'Logic (FormLogic)';

  const handleChange = (next: string) => {
    if (activeLogicFile && activeFileId) {
      updateLogicFile(activeFileId, next);
      if (activeLogicFile.path === 'logic/main.logic') {
        setLogicSource(next);
      }
      return;
    }
    setLogicSource(next);
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

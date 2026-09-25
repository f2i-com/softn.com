/**
 * LogicEditor - .logic code editor
 */

import React from 'react';
import { useProjectStore } from '../../stores/projectStore';
import { useFilesStore } from '../../stores/filesStore';
import { CodeEditor } from './CodeEditor';
import { editorLanguageFor } from './logicLanguage';
import { dockLogicFile, entryFileId } from '../../utils/logicFiles';
import { dockInlineLogicHolder } from '../../utils/inlineLogic';
import { toast } from '../../stores/notificationStore';

const styles: Record<string, React.CSSProperties> = {
  container: {
    height: '100%',
    display: 'flex',
    flexDirection: 'column',
    background: 'var(--ink-2)',
  },
  header: {
    minHeight: 36,
    gap: 12,
    padding: '6px 16px',
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
    fontSize: 11.5,
    color: 'var(--dim)',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  editorWrapper: {
    flex: 1,
    overflow: 'hidden',
  },
  empty: {
    padding: '12px 16px',
    fontSize: 12,
    lineHeight: 1.5,
    color: 'var(--dim)',
  },
  titleRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    minWidth: 0,
  },
  path: {
    fontFamily: 'var(--mono)',
    fontSize: 12,
    color: 'var(--dim)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
};

export function LogicEditor() {
  const retainedSource = useProjectStore((state) => state.source);
  const { activeFileId, nodes, uiFiles, logicFiles, updateLogicFile } = useFilesStore((state) => ({
    activeFileId: state.activeFileId,
    nodes: state.nodes,
    uiFiles: state.uiFiles,
    logicFiles: state.logicFiles,
    updateLogicFile: state.updateLogicFile,
  }));

  const activeNode = activeFileId ? nodes.get(activeFileId) : null;
  const isActiveLogicFile = activeNode?.type === 'file' && activeNode.fileType === 'logic';
  // An open logic file is edited as itself. The dock beneath the canvas edits
  // the logic file the active UI file links with `<logic src>`, else the one
  // the entry file links — the file the preview and the export run. It used
  // to edit a project field when no `logic/main.logic` existed, which is
  // every Python app, and the multi-file export never reads that field: every
  // edit made there was dropped on save.
  const logicFile =
    isActiveLogicFile && activeFileId
      ? logicFiles.get(activeFileId)
      : dockLogicFile(activeFileId, uiFiles, logicFiles, entryFileId(uiFiles, retainedSource));

  if (!logicFile) {
    // A file whose logic is an inline block — an authored bundle may do that,
    // and a session saved before the Code view linked logic did it by accident
    // — runs, but has nothing here to edit. One click moves the block into a
    // file and links it; a file that holds other logic is never overwritten.
    const holder = isActiveLogicFile ? undefined : dockInlineLogicHolder(activeFileId, uiFiles, entryFileId(uiFiles, retainedSource));
    const moveToFile = () => {
      if (!holder) return;
      try {
        const move = useFilesStore.getState().moveInlineLogicToFile(holder.id);
        toast.success(
          move.sparedPath
            ? `Moved the logic of ${holder.path} to ${move.logicPath}; ${move.sparedPath} holds other logic and was left as it was.`
            : `Moved the logic of ${holder.path} to ${move.logicPath}.`
        );
      } catch (e) {
        toast.error(e instanceof Error ? e.message : String(e));
      }
    };
    return (
      <div style={styles.container}>
        <div style={styles.header}>
          <span style={styles.title}>No logic file</span>
        </div>
        {holder ? (
          <div style={styles.empty} role="status">
            {holder.path} keeps its logic inline, in a {'<logic>'} block, which is edited only in Code view.
            <div>
              <button type="button" className="bl-btn bl-btn-sm" style={{ marginTop: 8 }} onClick={moveToFile} data-action="move-inline-logic">
                Move logic to a file
              </button>
            </div>
          </div>
        ) : (
          <div style={styles.empty} role="status">
            This UI file links no logic file. Add a {'<logic src="…" />'} to it in Code view to edit its logic here.
          </div>
        )}
      </div>
    );
  }

  // The file name is what says which language this is, exactly as it does for
  // the runtime: a `.py` logic file is Python. Getting this wrong is not
  // cosmetic — the highlighter would mark correct Python as broken, and its
  // auto-indent would fight code whose indentation is the program.
  const editorLanguage = editorLanguageFor(logicFile.path);

  return (
    <div style={styles.container}>
      <div style={styles.header}>
        {/* The panel around the dock already says Logic; this says which
            file, and in which language, since a Python app's dock is not
            JavaScript and the editor behaves differently for it. */}
        <span style={styles.titleRow}>
          <span className="bl-badge" data-tone="code" data-logic-language={editorLanguage}>
            {editorLanguage === 'python' ? 'Python' : 'JavaScript'}
          </span>
          <span style={styles.path} title={logicFile.path}>{logicFile.path}</span>
        </span>
        <span style={styles.hint}>
          {editorLanguage === 'python'
            ? 'Top-level names are state; functions are callable'
            : 'Define state, computed values, and functions'}
        </span>
      </div>
      <div style={styles.editorWrapper}>
        <CodeEditor
          value={logicFile.content}
          onChange={(next) => updateLogicFile(logicFile.id, next)}
          language={editorLanguage}
          height="100%"
        />
      </div>
    </div>
  );
}

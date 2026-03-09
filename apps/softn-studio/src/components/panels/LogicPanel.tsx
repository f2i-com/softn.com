import React, { useState, useCallback } from 'react';
import { useVFSStore, useWorkspaceStore } from '../../stores';
import { Icon } from '../common/Icon';

const LOGIC_EXTS = /\.(logic|js|ts|jsx|tsx)$/i;

export const LogicPanel: React.FC = () => {
  const { files, createFile } = useVFSStore();
  const [selectedFile, setSelectedFile] = useState<string | null>(null);

  const logicFiles = Array.from(files.keys()).filter((p) => LOGIC_EXTS.test(p));

  const handleAddFunction = useCallback(() => {
    const existing = Array.from(files.keys()).filter((p) => /^logic\/function-\d+\.logic$/i.test(p));
    const num = existing.length + 1;
    const path = `logic/function-${num}.logic`;
    const content = `// Function ${num}\n// Write your FormLogic here\n\nfunction handler(event) {\n  // handle event\n  return event;\n}\n`;
    createFile(path, content, 'user');
    setSelectedFile(path);
    useWorkspaceStore.getState().addConsoleOutput(`Created ${path}`);
  }, [files, createFile]);

  if (logicFiles.length === 0) {
    return (
      <div style={styles.container}>
        <div style={styles.empty}>
          <Icon name="zap" size={24} color="var(--studio-text-dim)" />
          <p style={styles.emptyText}>FormLogic functions</p>
          <p style={styles.emptyHint}>
            Functions and event handlers will appear here once your app has logic files (.logic, .js, .ts).
          </p>
          <button onClick={handleAddFunction} style={styles.addBtn}>
            <Icon name="plus" size={14} />
            Add Function
          </button>
        </div>
      </div>
    );
  }

  const selectedContent = (() => {
    if (!selectedFile) return null;
    const file = files.get(selectedFile);
    return file && typeof file.content === 'string' ? file.content : null;
  })();

  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <span style={styles.fileCount}>{logicFiles.length} logic file{logicFiles.length !== 1 ? 's' : ''}</span>
      </div>
      <div style={styles.list}>
        {logicFiles.map((path) => {
          const name = path.split('/').pop() ?? path;
          const ext = name.split('.').pop() ?? '';
          return (
            <button
              key={path}
              onClick={() => {
                setSelectedFile(selectedFile === path ? null : path);
                useWorkspaceStore.getState().setActiveFilePath(path);
              }}
              style={{
                ...styles.fileItem,
                ...(selectedFile === path ? styles.fileItemActive : {}),
              }}
            >
              <Icon name="zap" size={14} color="var(--studio-warning)" />
              <span style={styles.fileName}>{name}</span>
              <span style={styles.extBadge}>.{ext}</span>
            </button>
          );
        })}
      </div>
      {selectedContent !== null && selectedFile && (
        <div style={styles.preview}>
          <div style={styles.previewHeader}>
            <span style={styles.previewPath}>{selectedFile}</span>
            <button onClick={() => setSelectedFile(null)} style={styles.previewClose}>
              <Icon name="x" size={12} />
            </button>
          </div>
          <pre style={styles.previewCode}>{selectedContent}</pre>
        </div>
      )}
      <div style={styles.footer}>
        <button onClick={handleAddFunction} style={styles.addBtnSmall}>
          <Icon name="plus" size={14} />
          Add Function
        </button>
      </div>
    </div>
  );
};

const styles: Record<string, React.CSSProperties> = {
  container: { display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 },
  empty: {
    flex: 1, display: 'flex', flexDirection: 'column',
    alignItems: 'center', justifyContent: 'center',
    padding: 24, textAlign: 'center', gap: 4,
  },
  emptyText: { fontSize: 13, color: 'var(--studio-text-dim)', margin: '8px 0 0' },
  emptyHint: { fontSize: 11, color: 'var(--studio-text-dim)', lineHeight: 1.4, margin: '4px 0 12px' },
  addBtn: {
    display: 'flex', alignItems: 'center', gap: 6,
    padding: '8px 14px', border: '1px solid var(--studio-border)',
    borderRadius: 7, background: 'var(--studio-surface)',
    color: 'var(--studio-text-muted)', fontSize: 12, cursor: 'pointer', fontFamily: 'inherit',
  },
  header: {
    padding: '8px 12px',
    borderBottom: '1px solid var(--studio-border)',
    flexShrink: 0,
  },
  fileCount: { fontSize: 11, color: 'var(--studio-text-dim)' },
  list: {
    flex: 1, overflow: 'auto', minHeight: 0, padding: '4px 8px',
  },
  fileItem: {
    display: 'flex', alignItems: 'center', gap: 8,
    width: '100%', padding: '8px 10px',
    background: 'transparent', border: 'none', borderRadius: 6,
    color: 'var(--studio-text-muted)', fontSize: 12, cursor: 'pointer', textAlign: 'left',
    transition: 'all 0.15s',
  },
  fileItemActive: {
    background: 'rgba(59,130,246,0.1)', color: 'var(--studio-text)',
  },
  fileName: {
    flex: 1, fontWeight: 500,
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  },
  extBadge: {
    fontSize: 9, color: 'var(--studio-warning)', background: 'rgba(251,191,36,0.1)',
    padding: '1px 5px', borderRadius: 3, fontFamily: 'monospace', flexShrink: 0,
  },
  preview: {
    minHeight: 120, maxHeight: '50%', borderTop: '1px solid var(--studio-border)',
    display: 'flex', flexDirection: 'column', overflow: 'hidden',
  },
  previewHeader: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '6px 10px', borderBottom: '1px solid var(--studio-border-subtle)', flexShrink: 0,
  },
  previewPath: {
    fontSize: 10, color: 'var(--studio-text-dim)', fontFamily: 'monospace',
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  },
  previewClose: {
    width: 18, height: 18, display: 'flex', alignItems: 'center', justifyContent: 'center',
    border: 'none', background: 'transparent', color: 'var(--studio-text-dim)', cursor: 'pointer',
    borderRadius: 3, flexShrink: 0,
  },
  previewCode: {
    flex: 1, overflow: 'auto', padding: '8px 10px', margin: 0,
    fontSize: 10, lineHeight: 1.5, color: 'var(--studio-text-muted)', fontFamily: 'monospace',
    whiteSpace: 'pre-wrap', wordBreak: 'break-word',
  },
  footer: {
    padding: '8px 12px', borderTop: '1px solid var(--studio-border)',
  },
  addBtnSmall: {
    display: 'flex', alignItems: 'center', gap: 6,
    width: '100%', padding: '7px 10px',
    border: '1px dashed var(--studio-border-strong)', borderRadius: 6,
    background: 'transparent', color: 'var(--studio-text-dim)', fontSize: 11,
    cursor: 'pointer', fontFamily: 'inherit', justifyContent: 'center',
  },
};

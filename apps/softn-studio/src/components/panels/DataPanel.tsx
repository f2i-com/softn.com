import React, { useState, useCallback } from 'react';
import { useWorkspaceStore, useVFSStore } from '../../stores';
import { Icon } from '../common/Icon';

const DATA_EXTS = /\.(xdb|json|yaml|yml|toml|csv)$/i;

export const DataPanel: React.FC = () => {
  const { blueprint } = useWorkspaceStore();
  const { files, createFile } = useVFSStore();
  const [selectedFile, setSelectedFile] = useState<string | null>(null);

  const collections = blueprint?.collections ?? [];
  const dataFiles = Array.from(files.keys()).filter((p) => DATA_EXTS.test(p));

  const hasCollections = collections.length > 0;
  const hasDataFiles = dataFiles.length > 0;
  const isEmpty = !hasCollections && !hasDataFiles;

  const selectedContent = (() => {
    if (!selectedFile) return null;
    const file = files.get(selectedFile);
    return file && typeof file.content === 'string' ? file.content : null;
  })();

  const handleAddCollection = useCallback(() => {
    const existing = Array.from(files.keys()).filter((p) => /^data\/collection-\d+\.json$/i.test(p));
    const num = existing.length + 1;
    const path = `data/collection-${num}.json`;
    const content = JSON.stringify({
      name: `Collection ${num}`,
      fields: [
        { name: 'id', type: 'string', required: true },
        { name: 'name', type: 'string', required: true },
        { name: 'createdAt', type: 'datetime', required: false },
      ],
      records: [],
    }, null, 2);
    createFile(path, content, 'user');
    setSelectedFile(path);
    useWorkspaceStore.getState().addConsoleOutput(`Created ${path}`);
  }, [files, createFile]);

  return (
    <div style={styles.container}>
      {isEmpty ? (
        <div style={styles.empty}>
          <Icon name="database" size={24} color="var(--studio-text-dim)" />
          <p style={styles.emptyText}>No data collections</p>
          <p style={styles.emptyHint}>
            Data files (.xdb, .json, .yaml) and collections will appear here.
          </p>
          <button onClick={handleAddCollection} style={styles.addBtn}>
            <Icon name="plus" size={14} />
            Add Collection
          </button>
        </div>
      ) : (
        <>
          <div style={styles.list}>
            {/* Blueprint collections */}
            {collections.map((coll) => (
              <div key={coll.id} style={styles.collItem}>
                <div style={styles.collHeader}>
                  <Icon name="database" size={14} color="var(--studio-success)" />
                  <span style={styles.collName}>{coll.name}</span>
                  <span style={styles.fieldCount}>{coll.fields.length} fields</span>
                </div>
                <div style={styles.fields}>
                  {coll.fields.map((f) => (
                    <div key={f.name} style={styles.fieldRow}>
                      <span style={styles.fieldName}>{f.name}</span>
                      <span style={styles.fieldType}>{f.type}</span>
                      {f.required && <span style={styles.reqBadge}>req</span>}
                    </div>
                  ))}
                </div>
              </div>
            ))}

            {/* VFS data files */}
            {hasDataFiles && (
              <>
                {hasCollections && (
                  <div style={styles.sectionDivider}>
                    <span style={styles.sectionLabel}>Data Files</span>
                  </div>
                )}
                {dataFiles.map((path) => {
                  const name = path.split('/').pop() ?? path;
                  const ext = name.split('.').pop()?.toLowerCase() ?? '';
                  return (
                    <button
                      key={path}
                      onClick={() => {
                        setSelectedFile(selectedFile === path ? null : path);
                        useWorkspaceStore.getState().setActiveFilePath(path);
                      }}
                      style={{
                        ...styles.dataFileItem,
                        ...(selectedFile === path ? styles.dataFileItemActive : {}),
                      }}
                    >
                      <Icon name="database" size={14} color="var(--studio-success)" />
                      <span style={styles.dataFileName}>{name}</span>
                      <span style={styles.extBadge}>.{ext}</span>
                    </button>
                  );
                })}
              </>
            )}
          </div>

          {/* File preview */}
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
            <button onClick={handleAddCollection} style={styles.addBtnSmall}>
              <Icon name="plus" size={14} />
              Add Collection
            </button>
          </div>
        </>
      )}
    </div>
  );
};

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    flexDirection: 'column',
    flex: 1,
    minHeight: 0,
  },
  empty: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    textAlign: 'center',
    gap: 4,
  },
  emptyText: {
    fontSize: 13,
    color: 'var(--studio-text-dim)',
    margin: '8px 0 0',
  },
  emptyHint: {
    fontSize: 11,
    color: 'var(--studio-text-dim)',
    lineHeight: 1.4,
    margin: '4px 0 12px',
  },
  addBtn: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    padding: '8px 14px',
    border: '1px solid var(--studio-border)',
    borderRadius: 7,
    background: 'var(--studio-surface)',
    color: 'var(--studio-text-muted)',
    fontSize: 12,
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  list: {
    flex: 1,
    overflow: 'auto',
    minHeight: 0,
    padding: '8px',
  },
  collItem: {
    background: 'var(--studio-surface)',
    borderRadius: 8,
    border: '1px solid var(--studio-border-subtle)',
    marginBottom: 8,
    overflow: 'hidden',
  },
  collHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '10px 12px',
    borderBottom: '1px solid var(--studio-border-subtle)',
  },
  collName: {
    flex: 1,
    fontSize: 13,
    fontWeight: 600,
    color: 'var(--studio-text)',
  },
  fieldCount: {
    fontSize: 10,
    color: 'var(--studio-text-dim)',
  },
  fields: {
    padding: '6px 12px',
  },
  fieldRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    padding: '4px 0',
  },
  fieldName: {
    flex: 1,
    fontSize: 12,
    color: 'var(--studio-text-muted)',
  },
  fieldType: {
    fontSize: 10,
    color: 'var(--studio-accent)',
    background: 'var(--studio-accent-soft)',
    padding: '1px 6px',
    borderRadius: 4,
    fontFamily: 'monospace',
  },
  reqBadge: {
    fontSize: 9,
    color: 'var(--studio-warning)',
    background: 'rgba(251,191,36,0.1)',
    padding: '1px 4px',
    borderRadius: 3,
    fontWeight: 600,
  },
  sectionDivider: {
    padding: '10px 4px 6px',
  },
  sectionLabel: {
    fontSize: 10,
    fontWeight: 600,
    color: 'var(--studio-text-dim)',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.5px',
  },
  dataFileItem: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    width: '100%',
    padding: '8px 10px',
    background: 'transparent',
    border: 'none',
    borderRadius: 6,
    color: 'var(--studio-text-muted)',
    fontSize: 12,
    cursor: 'pointer',
    textAlign: 'left',
    transition: 'all 0.15s',
  },
  dataFileItemActive: {
    background: 'rgba(59,130,246,0.1)',
    color: 'var(--studio-text)',
  },
  dataFileName: {
    flex: 1,
    fontWeight: 500,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  extBadge: {
    fontSize: 9,
    color: 'var(--studio-success)',
    background: 'rgba(74,222,128,0.1)',
    padding: '1px 5px',
    borderRadius: 3,
    fontFamily: 'monospace',
    flexShrink: 0,
  },
  preview: {
    minHeight: 120,
    maxHeight: '50%',
    borderTop: '1px solid var(--studio-border)',
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
  },
  previewHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '6px 10px',
    borderBottom: '1px solid var(--studio-border-subtle)',
    flexShrink: 0,
  },
  previewPath: {
    fontSize: 10,
    color: 'var(--studio-text-dim)',
    fontFamily: 'monospace',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  previewClose: {
    width: 18,
    height: 18,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    border: 'none',
    background: 'transparent',
    color: 'var(--studio-text-dim)',
    cursor: 'pointer',
    fontFamily: 'inherit',
    borderRadius: 3,
    flexShrink: 0,
  },
  previewCode: {
    flex: 1,
    overflow: 'auto',
    padding: '8px 10px',
    margin: 0,
    fontSize: 10,
    lineHeight: 1.5,
    color: 'var(--studio-text-muted)',
    fontFamily: 'monospace',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
  },
  footer: {
    padding: '8px 12px',
    borderTop: '1px solid var(--studio-border)',
  },
  addBtnSmall: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    width: '100%',
    padding: '7px 10px',
    border: '1px dashed var(--studio-border-strong)',
    borderRadius: 6,
    background: 'transparent',
    color: 'var(--studio-text-dim)',
    fontSize: 11,
    cursor: 'pointer',
    fontFamily: 'inherit',
    justifyContent: 'center',
  },
};

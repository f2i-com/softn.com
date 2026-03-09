import React, { useState, useRef, useCallback } from 'react';
import { useVFSStore, useWorkspaceStore } from '../../stores';
import { Icon } from '../common/Icon';

const ASSET_EXTS = /\.(png|jpg|jpeg|gif|webp|svg|ico|bmp|mp3|mp4|wav|ogg|woff|woff2|ttf|otf|pdf)$/i;

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export const AssetsPanel: React.FC = () => {
  const { files, createFile } = useVFSStore();
  const [selectedAsset, setSelectedAsset] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const assetFiles = Array.from(files.entries()).filter(([p]) => ASSET_EXTS.test(p));

  const handleUpload = useCallback((uploadedFiles: FileList | null) => {
    if (!uploadedFiles) return;
    for (let i = 0; i < uploadedFiles.length; i++) {
      const file = uploadedFiles[i];
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result;
        if (result instanceof ArrayBuffer) {
          const path = `assets/${file.name}`;
          createFile(path, new Uint8Array(result), 'user');
          useWorkspaceStore.getState().addConsoleOutput(`Uploaded ${path} (${formatSize(file.size)})`);
        }
      };
      reader.readAsArrayBuffer(file);
    }
  }, [createFile]);

  if (assetFiles.length === 0) {
    return (
      <div style={styles.container}>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*,audio/*,video/*,.woff,.woff2,.ttf,.otf,.pdf,.svg"
          multiple
          style={{ display: 'none' }}
          onChange={(e) => { handleUpload(e.target.files); e.target.value = ''; }}
        />
        <div style={styles.empty}>
          <Icon name="image" size={24} color="var(--studio-text-dim)" />
          <p style={styles.emptyText}>No assets</p>
          <p style={styles.emptyHint}>
            Images, fonts, and media files from your project will appear here.
          </p>
          <button onClick={() => fileInputRef.current?.click()} style={styles.uploadBtn}>
            <Icon name="upload" size={14} />
            Upload Asset
          </button>
        </div>
      </div>
    );
  }

  return (
    <div style={styles.container}>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*,audio/*,video/*,.woff,.woff2,.ttf,.otf,.pdf,.svg"
        multiple
        style={{ display: 'none' }}
        onChange={(e) => { handleUpload(e.target.files); e.target.value = ''; }}
      />
      <div style={styles.header}>
        <span style={styles.fileCount}>{assetFiles.length} asset{assetFiles.length !== 1 ? 's' : ''}</span>
        <button onClick={() => fileInputRef.current?.click()} style={styles.headerUploadBtn} title="Upload asset">
          <Icon name="upload" size={12} />
        </button>
      </div>
      <div style={styles.list}>
        {assetFiles.map(([path, file]) => {
          const name = path.split('/').pop() ?? path;
          const ext = name.split('.').pop()?.toLowerCase() ?? '';
          const size = typeof file.content === 'string'
            ? new TextEncoder().encode(file.content).length
            : file.content.length;
          const isImage = /^(png|jpg|jpeg|gif|webp|svg|ico|bmp)$/.test(ext);

          return (
            <button
              key={path}
              onClick={() => setSelectedAsset(selectedAsset === path ? null : path)}
              style={{
                ...styles.assetItem,
                ...(selectedAsset === path ? styles.assetItemActive : {}),
              }}
            >
              <div style={{
                ...styles.assetIcon,
                background: isImage ? 'var(--studio-accent-soft)' : 'rgba(168,85,247,0.1)',
              }}>
                <Icon
                  name={isImage ? 'image' : 'file'}
                  size={16}
                  color={isImage ? 'var(--studio-accent)' : '#a78bfa'}
                />
              </div>
              <div style={styles.assetInfo}>
                <span style={styles.assetName}>{name}</span>
                <span style={styles.assetMeta}>{ext.toUpperCase()} &middot; {formatSize(size)}</span>
              </div>
            </button>
          );
        })}
      </div>
      {selectedAsset && (() => {
        const file = files.get(selectedAsset);
        if (!file) return null;
        const name = selectedAsset.split('/').pop() ?? '';
        const ext = name.split('.').pop()?.toLowerCase() ?? '';
        const isSvg = ext === 'svg' && typeof file.content === 'string';
        return (
          <div style={styles.preview}>
            <div style={styles.previewHeader}>
              <span style={styles.previewPath}>{selectedAsset}</span>
              <button onClick={() => setSelectedAsset(null)} style={styles.previewClose}>
                <Icon name="x" size={12} />
              </button>
            </div>
            <div style={styles.previewBody}>
              {isSvg ? (
                <img
                  src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(file.content as string)}`}
                  alt={name}
                  style={{ maxWidth: '100%', maxHeight: 120 }}
                />
              ) : (
                <div style={styles.previewPlaceholder}>
                  <Icon name="image" size={24} color="var(--studio-text-dim)" />
                  <span style={styles.previewLabel}>
                    {typeof file.content === 'string' ? `${file.content.length} chars` : `${file.content.length} bytes`}
                  </span>
                </div>
              )}
            </div>
          </div>
        );
      })()}
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
  uploadBtn: {
    display: 'flex', alignItems: 'center', gap: 6,
    padding: '8px 14px', border: '1px solid var(--studio-border)',
    borderRadius: 7, background: 'var(--studio-surface)',
    color: 'var(--studio-text-muted)', fontSize: 12, cursor: 'pointer', fontFamily: 'inherit',
  },
  header: {
    padding: '8px 12px',
    borderBottom: '1px solid var(--studio-border)',
    flexShrink: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  fileCount: { fontSize: 11, color: 'var(--studio-text-dim)' },
  headerUploadBtn: {
    width: 22, height: 22, display: 'flex', alignItems: 'center', justifyContent: 'center',
    border: 'none', background: 'var(--studio-surface)', color: 'var(--studio-text-dim)',
    borderRadius: 4, cursor: 'pointer',
  },
  list: {
    flex: 1, overflow: 'auto', minHeight: 0, padding: '4px 8px',
  },
  assetItem: {
    display: 'flex', alignItems: 'center', gap: 10,
    width: '100%', padding: '8px 10px',
    background: 'transparent', border: 'none', borderRadius: 6,
    color: 'var(--studio-text-muted)', fontSize: 12, cursor: 'pointer', textAlign: 'left',
    transition: 'all 0.15s',
  },
  assetItemActive: {
    background: 'rgba(59,130,246,0.1)', color: 'var(--studio-text)',
  },
  assetIcon: {
    width: 32, height: 32, borderRadius: 6,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    flexShrink: 0,
  },
  assetInfo: {
    flex: 1, display: 'flex', flexDirection: 'column', gap: 2,
    minWidth: 0,
  },
  assetName: {
    fontSize: 12, fontWeight: 500, color: 'var(--studio-text)',
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  },
  assetMeta: {
    fontSize: 10, color: 'var(--studio-text-dim)',
  },
  preview: {
    minHeight: 100, maxHeight: '40%', borderTop: '1px solid var(--studio-border)',
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
  previewBody: {
    flex: 1, overflow: 'auto', padding: 10,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
  },
  previewPlaceholder: {
    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6,
  },
  previewLabel: {
    fontSize: 10, color: 'var(--studio-text-dim)',
  },
};

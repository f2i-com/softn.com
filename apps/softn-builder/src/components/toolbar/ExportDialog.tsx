/**
 * ExportDialog - Bundle export modal
 */

import React, { useState, useCallback, useMemo } from 'react';
import { useCanvasStore } from '../../stores/canvasStore';
import { useProjectStore } from '../../stores/projectStore';
import { useSchemaStore } from '../../stores/schemaStore';
import { useFilesStore } from '../../stores/filesStore';
import { exportBundle, exportMultiFileBundle } from '../../utils/bundleExporter';
import { toast } from '../../stores/notificationStore';
import { debug } from '../../utils/debug';
import type { CollectionDef } from '../../types/builder';

const styles: Record<string, React.CSSProperties> = {
  overlay: {
    position: 'fixed' as const,
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    background: 'rgba(0,0,0,0.5)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1000,
  },
  dialog: {
    background: '#fff',
    borderRadius: 12,
    width: 480,
    maxWidth: '90vw',
    boxShadow: '0 20px 40px rgba(0,0,0,0.2)',
    overflow: 'hidden',
  },
  header: {
    padding: '16px 24px',
    borderBottom: '1px solid #e2e8f0',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  title: {
    fontSize: 18,
    fontWeight: 600,
    color: '#1e293b',
  },
  closeButton: {
    background: 'transparent',
    border: 'none',
    fontSize: 24,
    color: '#94a3b8',
    cursor: 'pointer',
    padding: 4,
    lineHeight: 1,
  },
  content: {
    padding: 24,
  },
  field: {
    marginBottom: 16,
  },
  label: {
    display: 'block',
    fontSize: 13,
    fontWeight: 500,
    color: '#374151',
    marginBottom: 6,
  },
  input: {
    width: '100%',
    padding: '10px 12px',
    border: '1px solid #e2e8f0',
    borderRadius: 8,
    fontSize: 14,
    outline: 'none',
  },
  textarea: {
    width: '100%',
    padding: '10px 12px',
    border: '1px solid #e2e8f0',
    borderRadius: 8,
    fontSize: 14,
    outline: 'none',
    minHeight: 80,
    resize: 'vertical' as const,
  },
  select: {
    width: '100%',
    padding: '10px 12px',
    border: '1px solid #e2e8f0',
    borderRadius: 8,
    fontSize: 14,
    outline: 'none',
    background: '#fff',
  },
  footer: {
    padding: '16px 24px',
    borderTop: '1px solid #e2e8f0',
    display: 'flex',
    justifyContent: 'flex-end',
    gap: 12,
  },
  button: {
    padding: '10px 20px',
    borderRadius: 8,
    fontSize: 14,
    fontWeight: 500,
    cursor: 'pointer',
    transition: 'all 0.15s',
  },
  cancelButton: {
    background: 'transparent',
    border: '1px solid #e2e8f0',
    color: '#64748b',
  },
  exportButton: {
    background: '#3b82f6',
    border: '1px solid #3b82f6',
    color: '#fff',
  },
  exportButtonDisabled: {
    opacity: 0.5,
    cursor: 'not-allowed',
  },
  progress: {
    textAlign: 'center' as const,
    padding: 24,
    color: '#64748b',
  },
  success: {
    textAlign: 'center' as const,
    padding: 24,
    color: '#10b981',
  },
  error: {
    padding: 12,
    background: '#fef2f2',
    border: '1px solid #fecaca',
    borderRadius: 8,
    color: '#ef4444',
    fontSize: 13,
    marginBottom: 16,
  },
};

interface ExportDialogProps {
  isOpen: boolean;
  onClose: () => void;
}

export function ExportDialog({ isOpen, onClose }: ExportDialogProps) {
  const { elements, rootId } = useCanvasStore();
  const {
    name,
    version,
    description,
    themeMode,
    logicSource,
    collections: projectCollections,
    assets,
    setName,
    setVersion,
    setDescription,
  } = useProjectStore();

  // Get files from filesStore
  const { uiFiles, logicFiles, activeFileId, updateUIFile, nodes } = useFilesStore();

  // Get schema entities and convert to collections
  const { entities, seedData } = useSchemaStore();

  // Merge schema entities with project collections
  const collections = useMemo((): CollectionDef[] => {
    // Convert schema entities to collections
    const schemaCollections: CollectionDef[] = entities.map((entity) => ({
      name: entity.name,
      alias: entity.alias,
      fields: entity.fields,
      seedData: seedData.get(entity.id) || [],
    }));

    // Merge with any manually defined collections (avoid duplicates by name)
    const schemaNames = new Set(schemaCollections.map((c) => c.name));
    const manualCollections = projectCollections.filter((c) => !schemaNames.has(c.name));

    return [...schemaCollections, ...manualCollections];
  }, [entities, seedData, projectCollections]);

  // Check if we have files from a loaded bundle
  const hasMultipleFiles =
    uiFiles.size > 0 && Array.from(uiFiles.values()).some((f) => f.originalSource !== undefined);

  const [isExporting, setIsExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const handleExport = useCallback(async () => {
    try {
      setIsExporting(true);
      setError(null);

      // Flush current canvas state to the active UI file so the export
      // captures the latest edits (updateUIFile normally only runs on
      // file switch, so unsaved canvas changes would be missed).
      if (activeFileId) {
        const activeNode = nodes.get(activeFileId);
        if (activeNode?.type === 'file' && activeNode.fileType === 'ui') {
          updateUIFile(activeFileId, elements, rootId);
        }
      }

      let bundleData: Uint8Array;

      if (hasMultipleFiles) {
        // Use multi-file export (preserves originalSource with imports)
        debug('[ExportDialog] Using multi-file export');
        bundleData = await exportMultiFileBundle({
          name,
          version,
          description,
          themeMode,
          uiFiles,
          logicFiles,
          collections,
          assets,
        });
      } else {
        // Use legacy single-file export
        debug('[ExportDialog] Using legacy single-file export');
        bundleData = await exportBundle({
          name,
          version,
          description,
          themeMode,
          elements,
          rootId,
          logicSource,
          collections,
          assets,
        });
      }

      // Download the bundle
      const blob = new Blob([new Uint8Array(bundleData)], { type: 'application/zip' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${name.replace(/\s+/g, '-').toLowerCase()}.softn`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      setSuccess(true);
      toast.success('Bundle exported successfully!');
      setTimeout(() => {
        setSuccess(false);
        onClose();
      }, 2000);
    } catch (err) {
      console.error('[ExportDialog] Export error:', err);
      const errorMsg = err instanceof Error ? err.message : 'Export failed';
      setError(errorMsg);
      toast.error(`Export failed: ${errorMsg}`);
    } finally {
      setIsExporting(false);
    }
  }, [
    name,
    version,
    description,
    themeMode,
    elements,
    rootId,
    logicSource,
    collections,
    assets,
    uiFiles,
    logicFiles,
    hasMultipleFiles,
    activeFileId,
    updateUIFile,
    nodes,
    onClose,
  ]);

  if (!isOpen) return null;

  return (
    <div style={styles.overlay} onClick={onClose}>
      <div style={styles.dialog} onClick={(e) => e.stopPropagation()}>
        <div style={styles.header}>
          <span style={styles.title}>Export Bundle</span>
          <button style={styles.closeButton} onClick={onClose}>
            ×
          </button>
        </div>

        <div style={styles.content}>
          {success ? (
            <div style={styles.success}>
              <div style={{ fontSize: 48, marginBottom: 16 }}>✓</div>
              <div style={{ fontSize: 16, fontWeight: 500 }}>Bundle exported successfully!</div>
            </div>
          ) : isExporting ? (
            <div style={styles.progress}>
              <div style={{ fontSize: 24, marginBottom: 16 }}>⏳</div>
              <div>Creating bundle...</div>
            </div>
          ) : (
            <>
              {error && <div style={styles.error}>{error}</div>}

              <div style={styles.field}>
                <label style={styles.label}>App Name</label>
                <input
                  type="text"
                  style={styles.input}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="My App"
                />
              </div>

              <div style={styles.field}>
                <label style={styles.label}>Version</label>
                <input
                  type="text"
                  style={styles.input}
                  value={version}
                  onChange={(e) => setVersion(e.target.value)}
                  placeholder="1.0.0"
                />
              </div>

              <div style={styles.field}>
                <label style={styles.label}>Description</label>
                <textarea
                  style={styles.textarea}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="A brief description of your app..."
                />
              </div>
            </>
          )}
        </div>

        {!success && !isExporting && (
          <div style={styles.footer}>
            <button style={{ ...styles.button, ...styles.cancelButton }} onClick={onClose}>
              Cancel
            </button>
            <button
              style={{
                ...styles.button,
                ...styles.exportButton,
                ...(isExporting ? styles.exportButtonDisabled : {}),
              }}
              onClick={handleExport}
              disabled={isExporting}
            >
              Export .softn
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

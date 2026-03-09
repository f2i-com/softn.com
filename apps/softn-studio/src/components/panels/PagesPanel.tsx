import React from 'react';
import { useWorkspaceStore, useVFSStore } from '../../stores';
import { Icon } from '../common/Icon';
import { getBundleEntryPath } from '../../lib/studioProject';

export const PagesPanel: React.FC = () => {
  const { blueprint, activePageId, activeFilePath, setActivePage, setActiveFilePath } = useWorkspaceStore();
  const { files } = useVFSStore();

  const blueprintPages = blueprint?.pages ?? [];

  // Also find .ui files in VFS as pages
  const uiFiles = Array.from(files.keys()).filter(
    (p) => p.endsWith('.ui') || p.endsWith('.html') || p.endsWith('.htm') || p.endsWith('.tsx') || p.endsWith('.jsx')
  );

  const hasBlueprint = blueprintPages.length > 0;
  const hasVFSPages = uiFiles.length > 0;
  const isEmpty = !hasBlueprint && !hasVFSPages;

  const bundleEntry = getBundleEntryPath(files);

  return (
    <div style={styles.container}>
      {isEmpty ? (
        <div style={styles.empty}>
          <Icon name="pages" size={24} color="var(--studio-text-dim)" />
          <p style={styles.emptyText}>No pages yet</p>
          <p style={styles.emptyHint}>Generate or import an app to populate pages here.</p>
        </div>
      ) : (
        <>
          <div style={styles.pageList}>
            {bundleEntry && (
              <div style={styles.viewerCard}>
                <div>
                  <span style={styles.viewerEyebrow}>Live viewer</span>
                  <div style={styles.viewerTitle}>Bundle entry</div>
                  <div style={styles.viewerPath}>{bundleEntry}</div>
                </div>
                <button
                  onClick={() => {
                    setActiveFilePath(bundleEntry);
                  }}
                  style={styles.viewerButton}
                >
                  Preview
                </button>
              </div>
            )}
            {/* Blueprint pages */}
            {blueprintPages.map((page) => (
              <button
                key={page.id}
                onClick={() => {
                  setActivePage(page.id);
                  const slug = page.name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
                  const resolved =
                    files.has(`pages/${slug}.html`) ? `pages/${slug}.html` :
                    files.has(`pages/${slug}.htm`) ? `pages/${slug}.htm` :
                    files.has(`pages/${slug}.ui`) ? `pages/${slug}.ui` :
                    files.has(`ui/${slug}.ui`) ? `ui/${slug}.ui` :
                    null;
                  if (resolved) setActiveFilePath(resolved);
                }}
                style={{
                  ...styles.pageItem,
                  ...(activePageId === page.id ? styles.pageItemActive : {}),
                }}
              >
                <Icon name="file" size={14} />
                <span style={styles.pageName}>{page.name}</span>
                {page.route && (
                  <span style={styles.pageRoute}>{page.route}</span>
                )}
              </button>
            ))}
            {/* VFS .ui files (when no blueprint, or as supplement) */}
            {hasVFSPages && !hasBlueprint && (
              <>
                {uiFiles.map((path) => {
                  const name = path.split('/').pop() ?? path;
                  return (
                    <button
                      key={path}
                      onClick={() => {
                        setActiveFilePath(path);
                      }}
                      style={{
                        ...styles.pageItem,
                        ...(activeFilePath === path ? styles.pageItemActive : {}),
                      }}
                    >
                      <Icon name="file" size={14} />
                      <span style={styles.pageName}>{name}</span>
                      <span style={styles.pageRoute}>{path}</span>
                    </button>
                  );
                })}
              </>
            )}
            {hasVFSPages && hasBlueprint && (
              <>
                <div style={styles.sectionDivider}>
                  <span style={styles.sectionLabel}>VFS Files</span>
                </div>
                {uiFiles.map((path) => {
                  const name = path.split('/').pop() ?? path;
                  return (
                    <button
                      key={path}
                      onClick={() => {
                        setActiveFilePath(path);
                      }}
                      style={{
                        ...styles.pageItem,
                        ...(activeFilePath === path ? styles.pageItemActive : {}),
                      }}
                    >
                      <Icon name="file" size={14} />
                      <span style={styles.pageName}>{name}</span>
                      <span style={styles.pageRoute}>{path}</span>
                    </button>
                  );
                })}
              </>
            )}
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
  pageList: {
    flex: 1,
    overflow: 'auto',
    minHeight: 0,
    padding: '4px 8px',
  },
  viewerCard: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    padding: '12px',
    marginBottom: 10,
    borderRadius: 14,
    background: 'linear-gradient(180deg, rgba(56,189,248,0.12), rgba(37,99,235,0.08))',
    border: '1px solid rgba(56,189,248,0.16)',
  },
  viewerEyebrow: {
    display: 'block',
    fontSize: 10,
    fontWeight: 700,
    color: 'var(--studio-accent)',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.1em',
    marginBottom: 6,
  },
  viewerTitle: {
    fontSize: 13,
    fontWeight: 700,
    color: 'var(--studio-text)',
  },
  viewerPath: {
    fontSize: 10,
    color: 'var(--studio-accent)',
    fontFamily: 'monospace',
    marginTop: 3,
  },
  viewerButton: {
    padding: '8px 12px',
    borderRadius: 10,
    border: 'none',
    background: 'var(--studio-bg-muted)',
    color: 'var(--studio-text)',
    fontSize: 12,
    fontWeight: 700,
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  pageItem: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    width: '100%',
    padding: '8px 10px',
    background: 'transparent',
    border: 'none',
    borderRadius: 6,
    color: 'var(--studio-text-dim)',
    fontSize: 12,
    cursor: 'pointer',
    textAlign: 'left',
    transition: 'all 0.15s',
    fontFamily: 'inherit',
  },
  pageItemActive: {
    background: 'rgba(59,130,246,0.1)',
    color: 'var(--studio-text)',
  },
  pageName: {
    flex: 1,
    fontWeight: 500,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  pageRoute: {
    fontSize: 10,
    color: 'var(--studio-text-dim)',
    fontFamily: 'monospace',
    flexShrink: 0,
  },
  sectionDivider: {
    padding: '10px 10px 4px',
  },
  sectionLabel: {
    fontSize: 10,
    fontWeight: 600,
    color: 'var(--studio-text-dim)',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.5px',
  },
};

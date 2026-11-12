import React from 'react';
import { useWorkspaceStore, useVFSStore } from '../../stores';
import { Icon } from '../common/Icon';
import { findPageFile, getBundleEntryPath } from '../../lib/studioProject';
import { confirmShowing } from '../../lib/handEdit';

/** One row of the panel: a page, with the file it is in when it has one. */
export interface PageRow {
  key: string;
  /** The page's name in the plan, or the file's name for a page the plan does not list. */
  name: string;
  /** The page's file, or null for a page the plan lists and nothing has written yet. */
  path: string | null;
  /** The plan's page, or null for a file the plan does not list. */
  pageId: string | null;
  route?: string;
}

const PAGE_FILE = /\.(ui|html?|tsx|jsx)$/;

/**
 * The app's pages as one list: the plan's pages in the plan's order, each with its file, then
 * the page files the plan does not list. The panel used to show the plan's pages and then,
 * under "All pages", every page file, so each page of an app Studio made was listed twice,
 * once by name and once by file. The entry page has its own card above the list and is not
 * repeated in it, unless the plan lists it as a page.
 */
export function pageRows(
  files: ReadonlyMap<string, unknown>,
  planPages: readonly { id: string; name: string; route?: string }[],
  entry: string | null,
): PageRow[] {
  const rows: PageRow[] = [];
  const listed = new Set<string>();
  planPages.forEach((page, index) => {
    const found = findPageFile(files, planPages, index);
    // Two plan pages cannot share a file (their slugs differ); the guard keeps the keys unique anyway.
    const path = found && !listed.has(found) ? found : null;
    if (path) listed.add(path);
    rows.push({ key: `page:${page.id}`, name: page.name, path, pageId: page.id, route: page.route });
  });
  for (const path of files.keys()) {
    if (!PAGE_FILE.test(path) || listed.has(path) || path === entry) continue;
    rows.push({ key: `file:${path}`, name: path.split('/').pop() ?? path, path, pageId: null });
  }
  return rows;
}

export const PagesPanel: React.FC = () => {
  const { blueprint, activePageId, activeFilePath, setActivePage, setActiveFilePath: putOnCanvas } = useWorkspaceStore();
  // Another file takes the canvas from the one being edited by hand: a draft that is not
  // saved is asked about first, and nothing changes when the answer is no.
  const setActiveFilePath = (path: string): boolean => {
    if (!confirmShowing(path)) return false;
    putOnCanvas(path);
    return true;
  };
  const { files } = useVFSStore();

  const bundleEntry = getBundleEntryPath(files);
  const rows = pageRows(files, blueprint?.pages ?? [], bundleEntry);
  const isEmpty = rows.length === 0 && !bundleEntry;
  // What the canvas shows: the file that was put on it, else the entry page.
  const shown = activeFilePath ?? bundleEntry;

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
              <div style={{ ...styles.viewerCard, ...(shown === bundleEntry ? styles.viewerCardActive : {}) }} data-shown={shown === bundleEntry || undefined}>
                <div>
                  <div style={styles.viewerTitle}>Entry page</div>
                  <div style={styles.viewerPath}>{bundleEntry}</div>
                </div>
                {/* Named for what it shows: the canvas's own "Preview" switch was a second
                    control of the same name. */}
                <button
                  type="button"
                  onClick={() => {
                    setActiveFilePath(bundleEntry);
                  }}
                  className="st-tap"
                  style={styles.viewerButton}
                  aria-label={`Preview the entry page, ${bundleEntry}`}
                >
                  Preview
                </button>
              </div>
            )}
            {/* One list: each page once, by its name in the plan where it has one, with its file. */}
            <ul style={styles.rows} aria-label="Pages">
              {rows.map((row) => {
                // The row that is lit is the one whose file the canvas shows; a page nothing has
                // written yet is lit when it is the page chosen.
                const active = row.path ? shown === row.path : activePageId === row.pageId && !activeFilePath;
                return (
                  <li key={row.key}>
                    <button
                      type="button"
                      onClick={() => {
                        if (row.path && !setActiveFilePath(row.path)) return;
                        if (row.pageId) setActivePage(row.pageId);
                      }}
                      className="st-tap"
                      aria-current={active ? 'page' : undefined}
                      title={row.path ? (row.route ? `${row.path}, shown at ${row.route}` : row.path) : 'In the plan. Nothing has written this page yet.'}
                      style={{
                        ...styles.pageItem,
                        ...(active ? styles.pageItemActive : {}),
                      }}
                    >
                      <Icon name="file" size={14} />
                      <span style={styles.pageName}>{row.name}</span>
                      <span style={styles.pageRoute}>{row.path ?? 'Not written yet'}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
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
    borderRadius: 10,
    background: 'var(--studio-bg-muted)',
    border: '1px solid var(--studio-border)',
  },
  viewerTitle: {
    fontFamily: 'var(--studio-display)',
    fontSize: 14,
    fontWeight: 700,
    letterSpacing: '-0.02em',
    color: 'var(--studio-text)',
  },
  viewerPath: {
    fontSize: 11,
    color: 'var(--studio-text-muted)',
    fontFamily: 'var(--studio-mono)',
    marginTop: 3,
  },
  viewerButton: {
    padding: '8px 12px',
    borderRadius: 8,
    border: '1px solid var(--studio-border-strong)',
    background: 'var(--studio-bg-elevated)',
    color: 'var(--studio-text)',
    fontSize: 12.5,
    fontWeight: 500,
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
    color: 'var(--studio-text-muted)',
    fontSize: 13,
    cursor: 'pointer',
    textAlign: 'left',
    transition: 'background 0.15s, color 0.15s',
    fontFamily: 'inherit',
  },
  pageItemActive: {
    background: 'var(--studio-bg-muted)',
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
    fontFamily: 'var(--studio-mono)',
    flexShrink: 0,
  },
  rows: {
    listStyle: 'none',
    margin: 0,
    padding: 0,
  },
  /** The entry page is what the canvas shows. */
  viewerCardActive: {
    border: '1px solid var(--studio-border-strong)',
  },
};

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useVFSStore, useWorkspaceStore } from '../../stores';
import { Icon } from '../common/Icon';
import { getBundleEntryPath } from '../../lib/studioProject';

interface TreeNode {
  name: string;
  path: string;
  isDir: boolean;
  children: TreeNode[];
}

function buildTree(paths: string[]): TreeNode[] {
  const root: TreeNode[] = [];
  for (const path of paths.sort()) {
    const parts = path.split('/');
    let current = root;
    let accumulated = '';
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      accumulated = accumulated ? `${accumulated}/${part}` : part;
      const isLast = i === parts.length - 1;
      let existing = current.find((n) => n.name === part && n.isDir === !isLast);
      if (!existing) {
        existing = { name: part, path: accumulated, isDir: !isLast, children: [] };
        current.push(existing);
      }
      current = existing.children;
    }
  }
  return root;
}

const FileTreeItem: React.FC<{
  node: TreeNode;
  depth: number;
  selectedPath: string | null;
  activeFilePath: string | null;
  onSelect: (path: string) => void;
  expanded: Set<string>;
  onToggle: (path: string) => void;
}> = ({ node, depth, selectedPath, activeFilePath, onSelect, expanded, onToggle }) => {
  const isOpen = expanded.has(node.path);
  const isSelected = selectedPath === node.path || activeFilePath === node.path;

  return (
    <>
      <button
        onClick={() => {
          if (node.isDir) {
            onToggle(node.path);
          } else {
            onSelect(node.path);
          }
        }}
        style={{
          ...styles.treeItem,
          paddingLeft: 8 + depth * 16,
          ...(isSelected && !node.isDir ? styles.treeItemSelected : {}),
        }}
      >
        {node.isDir ? (
          <Icon name={isOpen ? 'chevron-down' : 'chevron-right'} size={12} color="var(--studio-text-dim)" />
        ) : (
          <span style={{ width: 12 }} />
        )}
        <Icon
          name={node.isDir ? 'folder' : 'file'}
          size={14}
          color={node.isDir ? 'var(--studio-warning)' : 'var(--studio-text-dim)'}
        />
        <span style={styles.treeName}>{node.name}</span>
      </button>
      {node.isDir && isOpen && node.children.map((child) => (
        <FileTreeItem
          key={child.path}
          node={child}
          depth={depth + 1}
          selectedPath={selectedPath}
          activeFilePath={activeFilePath}
          onSelect={onSelect}
          expanded={expanded}
          onToggle={onToggle}
        />
      ))}
    </>
  );
};

export const FilesPanel: React.FC = () => {
  const { files } = useVFSStore();
  const { activeFilePath, setActiveFilePath } = useWorkspaceStore();
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const paths = useMemo(() => Array.from(files.keys()), [files]);
  const tree = useMemo(() => buildTree(paths), [paths]);
  const rootFolders = useMemo(() => tree.filter((node) => node.isDir).map((node) => node.path), [tree]);
  const rootFolderKey = rootFolders.join('|');
  const preferredPath = useMemo(() => (
    getBundleEntryPath(files) ?? paths[0] ?? null
  ), [files, paths]);

  const handleSelect = useCallback((path: string) => {
    setSelectedPath(path);
    setActiveFilePath(path);
  }, [setActiveFilePath]);

  useEffect(() => {
    if (rootFolders.length === 0) return;
    setExpanded((prev) => {
      const next = new Set(prev);
      rootFolders.forEach((path) => next.add(path));
      if (next.size === prev.size && Array.from(next).every((path) => prev.has(path))) {
        return prev;
      }
      return next;
    });
  }, [rootFolderKey, rootFolders]);

  useEffect(() => {
    if (!preferredPath) return;
    if (!selectedPath || !files.has(selectedPath)) {
      handleSelect(preferredPath);
    }
  }, [preferredPath, selectedPath, files, handleSelect]);

  const handleToggle = (path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  if (paths.length === 0) {
    return (
      <div style={styles.container}>
        <div style={styles.empty}>
          <Icon name="folder" size={24} color="var(--studio-text-dim)" />
          <p style={styles.emptyText}>No files</p>
          <p style={styles.emptyHint}>
            Import a .softn bundle or generate an app to see files here.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <span style={styles.fileCount}>{paths.length} file{paths.length !== 1 ? 's' : ''}</span>
      </div>
      <div style={styles.importHint}>
        <Icon name="folder" size={14} color="var(--studio-accent)" />
        <span style={styles.importHintText}>Bundle contents are shown below. Root folders auto-expand after import.</span>
      </div>
      <div style={styles.tree}>
        {tree.map((node) => (
          <FileTreeItem
            key={node.path}
            node={node}
            depth={0}
            selectedPath={selectedPath}
            activeFilePath={activeFilePath}
            onSelect={handleSelect}
            expanded={expanded}
            onToggle={handleToggle}
          />
        ))}
      </div>
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
  header: {
    padding: '8px 12px',
    borderBottom: '1px solid var(--studio-border)',
    flexShrink: 0,
  },
  importHint: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '10px 12px',
    borderBottom: '1px solid var(--studio-border)',
    background: 'var(--studio-accent-soft)',
  },
  importHintText: {
    fontSize: 11,
    color: 'var(--studio-text-muted)',
    lineHeight: 1.4,
  },
  fileCount: {
    fontFamily: 'var(--studio-mono)',
    fontSize: 11,
    color: 'var(--studio-text-muted)',
  },
  tree: {
    flex: 1,
    overflow: 'auto',
    minHeight: 0,
    padding: '4px 0',
  },
  treeItem: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    width: '100%',
    padding: '5px 8px',
    background: 'transparent',
    border: 'none',
    color: 'var(--studio-text-muted)',
    fontSize: 12,
    cursor: 'pointer',
    textAlign: 'left',
    transition: 'background 0.1s',
    fontFamily: 'inherit',
  },
  treeItemSelected: {
    background: 'var(--studio-accent-soft)',
    color: 'var(--studio-text)',
  },
  treeName: {
    flex: 1,
    fontFamily: 'var(--studio-mono)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
};

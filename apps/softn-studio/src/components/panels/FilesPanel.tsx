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

/** SoftN's own file types, whose extension is set in the language colour. */
const LANGUAGE_EXT = /\.(ui|logic|py|xdb)$/i;

function splitName(name: string): { base: string; ext: string } {
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return { base: name, ext: '' };
  return { base: name.slice(0, dot), ext: name.slice(dot) };
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
  const { base, ext } = splitName(node.name);

  return (
    <>
      <button
        type="button"
        className="st-tree-item"
        onClick={() => {
          if (node.isDir) {
            onToggle(node.path);
          } else {
            onSelect(node.path);
          }
        }}
        aria-expanded={node.isDir ? isOpen : undefined}
        aria-current={!node.isDir && isSelected ? 'true' : undefined}
        title={node.path}
        style={{ paddingLeft: 10 + depth * 14 }}
      >
        {node.isDir ? (
          <Icon name={isOpen ? 'chevron-down' : 'chevron-right'} size={12} />
        ) : (
          <span style={{ width: 12, flexShrink: 0 }} />
        )}
        <Icon name={node.isDir ? 'folder' : 'file'} size={14} />
        <span className="st-tree-name">
          {node.isDir ? node.name : (
            <>
              {base}
              {ext && <span className={LANGUAGE_EXT.test(ext) ? 'ext lang' : 'ext'}>{ext}</span>}
            </>
          )}
        </span>
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
      <p className="st-panel-note">
        {paths.length} file{paths.length !== 1 ? 's' : ''} in the bundle. Choose one to preview it.
      </p>
      <div className="st-tree" role="group" aria-label="Project files">
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
};

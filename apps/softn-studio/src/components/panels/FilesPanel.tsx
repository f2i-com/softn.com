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
  /** The file showing on the canvas. */
  selectedPath: string | null;
  onSelect: (path: string) => void;
  expanded: Set<string>;
  onToggle: (path: string) => void;
}> = ({ node, depth, selectedPath, onSelect, expanded, onToggle }) => {
  const isOpen = expanded.has(node.path);
  const isSelected = selectedPath === node.path;
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
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const paths = useMemo(() => Array.from(files.keys()), [files]);
  const tree = useMemo(() => buildTree(paths), [paths]);
  const rootFolders = useMemo(() => tree.filter((node) => node.isDir).map((node) => node.path), [tree]);
  const rootFolderKey = rootFolders.join('|');
  // The file showing on the canvas: the workspace's active file, and with none (or one that
  // is gone) the bundle's entry, which is what the canvas falls back to. The panel marks it
  // and nothing more. It used to keep a selection of its own, empty each time the panel was
  // opened, and on finding none made the entry the workspace's active file: opening the panel,
  // or reloading with it open, put the main page on the canvas in place of the file the
  // person had chosen, and counted as a change to the project.
  const shownPath = useMemo(() => (
    activeFilePath && files.has(activeFilePath) ? activeFilePath : getBundleEntryPath(files)
  ), [activeFilePath, files]);

  const handleSelect = useCallback((path: string) => {
    setActiveFilePath(path);
  }, [setActiveFilePath]);

  // The top folders start open, and so do the folders the file showing is in, so that it can
  // be seen. A folder closed by hand stays closed until another file is shown.
  useEffect(() => {
    const open = [...rootFolders];
    const parts = shownPath ? shownPath.split('/').slice(0, -1) : [];
    parts.forEach((_, index) => open.push(parts.slice(0, index + 1).join('/')));
    if (open.length === 0) return;
    setExpanded((prev) => {
      const next = new Set(prev);
      open.forEach((path) => next.add(path));
      return next.size === prev.size ? prev : next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rootFolderKey, shownPath]);

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
            selectedPath={shownPath}
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

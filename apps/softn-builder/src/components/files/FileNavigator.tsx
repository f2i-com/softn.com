/**
 * FileNavigator - Tree view for project files and folders
 */

import React, { useState, useCallback } from 'react';
import { useFilesStore } from '../../stores/filesStore';
import { useShallow } from 'zustand/react/shallow';
import type { ProjectFileNode } from '../../types/builder';
import { FileGlyph, type FileGlyphKind } from './fileIcons';

const styles: Record<string, React.CSSProperties> = {
  container: {
    height: '100%',
    display: 'flex',
    flexDirection: 'column',
    background: '#fff',
    borderRight: '1px solid #e2e8f0',
    width: 280,
    minWidth: 280,
  },
  header: {
    padding: '12px 12px 8px',
    borderBottom: '1px solid #e2e8f0',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  title: {
    fontWeight: 600,
    fontSize: 12,
    color: '#64748b',
    textTransform: 'uppercase',
    letterSpacing: '0.5px',
  },
  actions: {
    display: 'flex',
    gap: 4,
  },
  actionBtn: {
    background: '#f8fafc',
    border: '1px solid #e2e8f0',
    padding: '4px 6px',
    cursor: 'pointer',
    color: '#475569',
    borderRadius: 4,
    fontSize: 12,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  quickCreate: {
    padding: 12,
    borderBottom: '1px solid #e2e8f0',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'stretch',
    gap: 10,
    background: '#f8fafc',
    boxShadow: 'inset 0 -1px 0 rgba(226,232,240,0.8)',
  },
  quickCreateTop: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  quickCreateLabel: {
    fontSize: 11,
    fontWeight: 600,
    color: '#64748b',
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
  },
  quickCreateSub: {
    fontSize: 11,
    color: '#64748b',
    marginTop: 2,
  },
  quickCreateClose: {
    border: '1px solid #cbd5e1',
    background: '#ffffff',
    color: '#64748b',
    borderRadius: 6,
    width: 22,
    height: 22,
    cursor: 'pointer',
    lineHeight: 1,
    padding: 0,
  },
  quickCreateInput: {
    border: '1px solid #cbd5e1',
    borderRadius: 8,
    padding: '10px 12px',
    fontSize: 14,
    outline: 'none',
    background: '#ffffff',
    width: '100%',
    minHeight: 40,
  },
  quickCreateActions: {
    display: 'flex',
    justifyContent: 'stretch',
    gap: 8,
  },
  quickCreateBtn: {
    border: '1px solid #cbd5e1',
    background: '#ffffff',
    color: '#334155',
    borderRadius: 8,
    padding: '8px 10px',
    fontSize: 13,
    flex: 1,
    cursor: 'pointer',
  },
  quickCreateBtnPrimary: {
    background: '#2563eb',
    color: '#ffffff',
    borderColor: '#2563eb',
  },
  tree: {
    flex: 1,
    overflow: 'auto',
    padding: '8px 0',
  },
  node: {
    display: 'flex',
    alignItems: 'center',
    padding: '4px 12px',
    cursor: 'pointer',
    userSelect: 'none',
    fontSize: 13,
    color: '#334155',
    gap: 6,
  },
  nodeHover: {
    background: '#f1f5f9',
  },
  nodeActive: {
    background: '#e0f2fe',
    color: '#0369a1',
  },
  nodeDirty: {
    fontStyle: 'italic',
  },
  icon: {
    width: 18,
    height: 18,
    textAlign: 'center',
    flexShrink: 0,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  name: {
    flex: 1,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  dirtyDot: {
    width: 6,
    height: 6,
    borderRadius: '50%',
    background: '#f59e0b',
    flexShrink: 0,
  },
  contextMenu: {
    position: 'fixed',
    background: '#fff',
    border: '1px solid #e2e8f0',
    borderRadius: 6,
    boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
    padding: '4px 0',
    minWidth: 140,
    zIndex: 1000,
  },
  menuItem: {
    padding: '8px 12px',
    cursor: 'pointer',
    fontSize: 13,
    color: '#334155',
    display: 'flex',
    alignItems: 'center',
    gap: 8,
  },
  menuIcon: {
    width: 16,
    height: 16,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  menuItemHover: {
    background: '#f1f5f9',
  },
  menuItemDanger: {
    color: '#dc2626',
  },
  separator: {
    height: 1,
    background: '#e2e8f0',
    margin: '4px 0',
  },
  renameInput: {
    flex: 1,
    border: '1px solid #3b82f6',
    borderRadius: 3,
    padding: '2px 6px',
    fontSize: 13,
    outline: 'none',
  },
};

interface ContextMenuState {
  x: number;
  y: number;
  nodeId: string;
  nodeType: 'file' | 'folder';
}

interface FileNavigatorProps {
  onToggleDock?: () => void;
}

interface FileNodeProps {
  node: ProjectFileNode;
  depth: number;
  isActive: boolean;
  onSelect: (id: string) => void;
  onContextMenu: (e: React.MouseEvent, node: ProjectFileNode) => void;
  renamingId: string | null;
  onRename: (id: string, name: string) => void;
  onCancelRename: () => void;
}

function FileNode({
  node,
  depth,
  isActive,
  onSelect,
  onContextMenu,
  renamingId,
  onRename,
  onCancelRename,
}: FileNodeProps) {
  const [isHovered, setIsHovered] = useState(false);
  const [isExpanded, setIsExpanded] = useState(true);
  const [renameValue, setRenameValue] = useState(node.name);
  const { nodes, activeFileId } = useFilesStore((state) => ({
    nodes: state.nodes,
    activeFileId: state.activeFileId,
  }));

  const isRenaming = renamingId === node.id;

  const handleClick = useCallback(() => {
    if (node.type === 'folder') {
      setIsExpanded(!isExpanded);
    } else {
      onSelect(node.id);
    }
  }, [node, isExpanded, onSelect]);

  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      onContextMenu(e, node);
    },
    [node, onContextMenu]
  );

  const handleRenameSubmit = useCallback(() => {
    if (renameValue.trim() && renameValue !== node.name) {
      onRename(node.id, renameValue.trim());
    } else {
      onCancelRename();
    }
  }, [node, renameValue, onRename, onCancelRename]);

  const handleRenameKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') {
        handleRenameSubmit();
      } else if (e.key === 'Escape') {
        onCancelRename();
      }
    },
    [handleRenameSubmit, onCancelRename]
  );

  // Get icon based on file type
  const getIcon = (): FileGlyphKind => {
    if (node.type === 'folder') return isExpanded ? 'folder-open' : 'folder';
    if (node.fileType === 'ui') return 'ui';
    if (node.fileType === 'logic') return 'logic';
    if (node.fileType === 'asset') return 'file';
    return 'file';
  };

  const nodeStyle: React.CSSProperties = {
    ...styles.node,
    paddingLeft: 12 + depth * 16,
    ...(isHovered && !isActive ? styles.nodeHover : {}),
    ...(isActive ? styles.nodeActive : {}),
    ...(node.isDirty ? styles.nodeDirty : {}),
  };

  return (
    <>
      <div
        style={nodeStyle}
        onClick={handleClick}
        onContextMenu={handleContextMenu}
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
      >
        <span style={styles.icon}>
          <FileGlyph kind={getIcon()} />
        </span>
        {isRenaming ? (
          <input
            type="text"
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onBlur={handleRenameSubmit}
            onKeyDown={handleRenameKeyDown}
            style={styles.renameInput}
            autoFocus
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <span style={styles.name}>{node.name}</span>
        )}
        {node.isDirty && <span style={styles.dirtyDot} title="Unsaved changes" />}
      </div>

      {node.type === 'folder' && isExpanded && node.children && (
        <>
          {node.children.map((childId) => {
            const childNode = nodes.get(childId);
            if (!childNode) return null;
            return (
              <FileNode
                key={childId}
                node={childNode}
                depth={depth + 1}
                isActive={activeFileId === childId}
                onSelect={onSelect}
                onContextMenu={onContextMenu}
                renamingId={renamingId}
                onRename={onRename}
                onCancelRename={onCancelRename}
              />
            );
          })}
        </>
      )}
    </>
  );
}

export function FileNavigator({ onToggleDock }: FileNavigatorProps) {
  const {
    nodes,
    rootFolders,
    activeFileId,
    openFile,
    createFile,
    createFolder,
    deleteFile,
    deleteFolder,
    renameFile,
    renameFolder,
  } = useFilesStore(
    useShallow((state) => ({
      nodes: state.nodes,
      rootFolders: state.rootFolders,
      activeFileId: state.activeFileId,
      openFile: state.openFile,
      createFile: state.createFile,
      createFolder: state.createFolder,
      deleteFile: state.deleteFile,
      deleteFolder: state.deleteFolder,
      renameFile: state.renameFile,
      renameFolder: state.renameFolder,
    }))
  );

  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [menuHoveredItem, setMenuHoveredItem] = useState<string | null>(null);
  const [quickCreateType, setQuickCreateType] = useState<'ui' | 'logic' | 'folder' | null>(null);
  const [quickCreateName, setQuickCreateName] = useState('');
  const [quickCreateParentPath, setQuickCreateParentPath] = useState<string | null>(null);

  const handleSelect = useCallback(
    (id: string) => {
      openFile(id);
    },
    [openFile]
  );

  const handleContextMenu = useCallback((e: React.MouseEvent, node: ProjectFileNode) => {
    setContextMenu({
      x: e.clientX,
      y: e.clientY,
      nodeId: node.id,
      nodeType: node.type,
    });
  }, []);

  const closeContextMenu = useCallback(() => {
    setContextMenu(null);
    setMenuHoveredItem(null);
  }, []);

  const resolveDefaultParentPath = useCallback(
    (type: 'ui' | 'logic' | 'folder') => {
      const activeNode = activeFileId ? nodes.get(activeFileId) : null;
      if (activeNode?.type === 'folder') {
        return activeNode.path;
      }
      if (activeNode?.type === 'file') {
        return activeNode.path.split('/').slice(0, -1).join('/');
      }
      if (type === 'logic') return 'logic';
      return 'ui';
    },
    [activeFileId, nodes]
  );

  const handleQuickCreateStart = useCallback((type: 'ui' | 'logic' | 'folder', parentPath?: string) => {
    setQuickCreateType(type);
    setQuickCreateName('');
    setQuickCreateParentPath(parentPath || null);
  }, []);

  const handleQuickCreateCancel = useCallback(() => {
    setQuickCreateType(null);
    setQuickCreateName('');
    setQuickCreateParentPath(null);
  }, []);

  const handleQuickCreateSubmit = useCallback(() => {
    if (!quickCreateType) return;
    const trimmed = quickCreateName.trim();
    if (!trimmed) return;

    const parentPath = quickCreateParentPath || resolveDefaultParentPath(quickCreateType);
    if (quickCreateType === 'folder') {
      createFolder(parentPath, trimmed);
    } else if (quickCreateType === 'ui') {
      createFile(parentPath, trimmed.endsWith('.ui') ? trimmed : `${trimmed}.ui`, 'ui');
    } else {
      createFile(parentPath, trimmed.endsWith('.logic') ? trimmed : `${trimmed}.logic`, 'logic');
    }

    handleQuickCreateCancel();
  }, [
    quickCreateType,
    quickCreateName,
    resolveDefaultParentPath,
    quickCreateParentPath,
    createFolder,
    createFile,
    handleQuickCreateCancel,
  ]);

  const handleNewUIFile = useCallback(() => {
    if (!contextMenu) return;
    const node = nodes.get(contextMenu.nodeId);
    if (!node) return;

    const parentPath =
      node.type === 'folder' ? node.path : node.path.split('/').slice(0, -1).join('/');
    handleQuickCreateStart('ui', parentPath);
    closeContextMenu();
  }, [contextMenu, nodes, handleQuickCreateStart, closeContextMenu]);

  const handleNewLogicFile = useCallback(() => {
    if (!contextMenu) return;
    const node = nodes.get(contextMenu.nodeId);
    if (!node) return;

    const parentPath =
      node.type === 'folder' ? node.path : node.path.split('/').slice(0, -1).join('/');
    handleQuickCreateStart('logic', parentPath);
    closeContextMenu();
  }, [contextMenu, nodes, handleQuickCreateStart, closeContextMenu]);

  const handleNewFolder = useCallback(() => {
    if (!contextMenu) return;
    const node = nodes.get(contextMenu.nodeId);
    if (!node) return;

    const parentPath =
      node.type === 'folder' ? node.path : node.path.split('/').slice(0, -1).join('/');
    handleQuickCreateStart('folder', parentPath);
    closeContextMenu();
  }, [contextMenu, nodes, handleQuickCreateStart, closeContextMenu]);

  const handleRenameStart = useCallback(() => {
    if (!contextMenu) return;
    setRenamingId(contextMenu.nodeId);
    closeContextMenu();
  }, [contextMenu, closeContextMenu]);

  const handleRename = useCallback(
    (id: string, newName: string) => {
      const node = nodes.get(id);
      if (!node) return;

      if (node.type === 'folder') {
        renameFolder(id, newName);
      } else {
        renameFile(id, newName);
      }
      setRenamingId(null);
    },
    [nodes, renameFile, renameFolder]
  );

  const handleDelete = useCallback(() => {
    if (!contextMenu) return;
    const node = nodes.get(contextMenu.nodeId);
    if (!node) return;

    const confirmMsg =
      node.type === 'folder'
        ? `Delete folder "${node.name}" and all its contents?`
        : `Delete file "${node.name}"?`;

    if (window.confirm(confirmMsg)) {
      if (node.type === 'folder') {
        deleteFolder(contextMenu.nodeId);
      } else {
        deleteFile(contextMenu.nodeId);
      }
    }
    closeContextMenu();
  }, [contextMenu, nodes, deleteFile, deleteFolder, closeContextMenu]);

  // Close context menu when clicking outside
  React.useEffect(() => {
    const handleClickOutside = () => {
      if (contextMenu) {
        closeContextMenu();
      }
    };

    document.addEventListener('click', handleClickOutside);
    return () => document.removeEventListener('click', handleClickOutside);
  }, [contextMenu, closeContextMenu]);

  const renderContextMenu = () => {
    if (!contextMenu) return null;

    const node = nodes.get(contextMenu.nodeId);
    const isFolder = node?.type === 'folder';
    const isMainFile = contextMenu.nodeId === 'main_ui' || contextMenu.nodeId === 'main_logic';

    return (
      <div
        style={{
          ...styles.contextMenu,
          left: contextMenu.x,
          top: contextMenu.y,
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {isFolder && (
          <>
            <div
              style={{
                ...styles.menuItem,
                ...(menuHoveredItem === 'newUI' ? styles.menuItemHover : {}),
              }}
              onClick={handleNewUIFile}
              onMouseEnter={() => setMenuHoveredItem('newUI')}
              onMouseLeave={() => setMenuHoveredItem(null)}
            >
              <span style={styles.menuIcon}>
                <FileGlyph kind="ui" />
              </span>
              New UI File
            </div>
            <div
              style={{
                ...styles.menuItem,
                ...(menuHoveredItem === 'newLogic' ? styles.menuItemHover : {}),
              }}
              onClick={handleNewLogicFile}
              onMouseEnter={() => setMenuHoveredItem('newLogic')}
              onMouseLeave={() => setMenuHoveredItem(null)}
            >
              <span style={styles.menuIcon}>
                <FileGlyph kind="logic" />
              </span>
              New Logic File
            </div>
            <div
              style={{
                ...styles.menuItem,
                ...(menuHoveredItem === 'newFolder' ? styles.menuItemHover : {}),
              }}
              onClick={handleNewFolder}
              onMouseEnter={() => setMenuHoveredItem('newFolder')}
              onMouseLeave={() => setMenuHoveredItem(null)}
            >
              <span style={styles.menuIcon}>
                <FileGlyph kind="folder" />
              </span>
              New Folder
            </div>
            <div style={styles.separator} />
          </>
        )}
        <div
          style={{
            ...styles.menuItem,
            ...(menuHoveredItem === 'rename' ? styles.menuItemHover : {}),
          }}
          onClick={handleRenameStart}
          onMouseEnter={() => setMenuHoveredItem('rename')}
          onMouseLeave={() => setMenuHoveredItem(null)}
        >
          Rename
        </div>
        {!isMainFile && (
          <div
            style={{
              ...styles.menuItem,
              ...styles.menuItemDanger,
              ...(menuHoveredItem === 'delete' ? styles.menuItemHover : {}),
            }}
            onClick={handleDelete}
            onMouseEnter={() => setMenuHoveredItem('delete')}
            onMouseLeave={() => setMenuHoveredItem(null)}
          >
            Delete
          </div>
        )}
      </div>
    );
  };

  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <span style={styles.title}>Files</span>
        <div style={styles.actions}>
          {onToggleDock && (
            <button
              style={styles.actionBtn}
              onClick={onToggleDock}
              title="Hide Files panel"
            >
              Hide
            </button>
          )}
          <button
            style={styles.actionBtn}
            onClick={() => handleQuickCreateStart('ui')}
            title="New UI File"
          >
            <FileGlyph kind="ui" size={12} />
          </button>
          <button
            style={styles.actionBtn}
            onClick={() => handleQuickCreateStart('logic')}
            title="New Logic File"
          >
            <FileGlyph kind="logic" size={12} />
          </button>
          <button
            style={styles.actionBtn}
            onClick={() => handleQuickCreateStart('folder')}
            title="New Folder"
          >
            <FileGlyph kind="folder" size={12} />
          </button>
        </div>
      </div>
      {quickCreateType && (
        <div style={styles.quickCreate}>
          <div style={styles.quickCreateTop}>
            <div>
              <div style={styles.quickCreateLabel}>New {quickCreateType}</div>
              <div style={styles.quickCreateSub}>
                {quickCreateType === 'folder'
                  ? `Create folder in ${quickCreateParentPath || resolveDefaultParentPath('folder')}`
                  : `Create ${quickCreateType} file in ${quickCreateParentPath || resolveDefaultParentPath(quickCreateType)}`}
              </div>
            </div>
            <button style={styles.quickCreateClose} onClick={handleQuickCreateCancel} title="Close">
              x
            </button>
          </div>
          <input
            type="text"
            style={styles.quickCreateInput}
            value={quickCreateName}
            onChange={(e) => setQuickCreateName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                handleQuickCreateSubmit();
              }
              if (e.key === 'Escape') {
                e.preventDefault();
                handleQuickCreateCancel();
              }
            }}
            placeholder={
              quickCreateType === 'folder'
                ? 'Folder name'
                : quickCreateType === 'ui'
                  ? 'Component.ui'
                  : 'utils.logic'
            }
            autoFocus
          />
          <div style={styles.quickCreateActions}>
            <button style={styles.quickCreateBtn} onClick={handleQuickCreateCancel}>
              Cancel
            </button>
            <button
              style={{ ...styles.quickCreateBtn, ...styles.quickCreateBtnPrimary }}
              onClick={handleQuickCreateSubmit}
            >
              Create
            </button>
          </div>
        </div>
      )}
      <div style={styles.tree} key={`tree-${rootFolders.length}-${nodes.size}`}>
        {rootFolders.map((folderId) => {
          const folder = nodes.get(folderId);
          if (!folder) return null;
          return (
            <FileNode
              key={folderId}
              node={folder}
              depth={0}
              isActive={activeFileId === folderId}
              onSelect={handleSelect}
              onContextMenu={handleContextMenu}
              renamingId={renamingId}
              onRename={handleRename}
              onCancelRename={() => setRenamingId(null)}
            />
          );
        })}
      </div>
      {renderContextMenu()}
    </div>
  );
}

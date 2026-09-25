/**
 * FileNavigator - Tree view for project files and folders
 */

import React, { useState, useCallback } from 'react';
import { useFilesStore } from '../../stores/filesStore';
import { useProjectStore } from '../../stores/projectStore';
import { dockLogicFile, entryFileId, logicLanguageOf } from '../../utils/logicFiles';
import { useShallow } from 'zustand/react/shallow';
import { useSourceFidelity } from '../../utils/useSourceFidelity';
import type { ProjectFileNode } from '../../types/builder';
import { FileGlyph, type FileGlyphKind } from './fileIcons';

const styles: Record<string, React.CSSProperties> = {
  container: {
    height: '100%',
    display: 'flex',
    flexDirection: 'column',
    background: 'var(--ink-2)',
    borderRight: '1px solid var(--line-soft)',
    width: 280,
    minWidth: 280,
  },
  header: {
    padding: '12px 12px 8px',
    borderBottom: '1px solid var(--line-soft)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  // A panel header, matching Components and Properties: the four panels are
  // peers, so they are set alike. Sections INSIDE a panel (Hierarchy, Data)
  // are smaller and dimmer, in sentence case like everything else.
  title: {
    fontFamily: 'var(--display)',
    fontWeight: 700,
    fontSize: 14,
    letterSpacing: '-0.01em',
    color: 'var(--paper)',
  },
  actions: {
    display: 'flex',
    gap: 4,
  },
  quickCreate: {
    padding: 12,
    borderBottom: '1px solid var(--line-soft)',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'stretch',
    gap: 10,
    background: 'var(--ink)',
  },
  quickCreateTop: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  quickCreateLabel: {
    fontSize: 13,
    fontWeight: 600,
    color: 'var(--paper)',
  },
  quickCreateSub: {
    fontFamily: 'var(--mono)',
    fontSize: 11,
    color: 'var(--dim)',
    marginTop: 2,
  },
  quickCreateInput: {
    borderRadius: 8,
    padding: '8px 10px',
    fontSize: 13,
    fontFamily: 'var(--mono)',
    width: '100%',
    minHeight: 36,
  },
  quickCreateActions: {
    display: 'flex',
    justifyContent: 'stretch',
    gap: 8,
  },
  tree: {
    flex: 1,
    overflow: 'auto',
    padding: '8px 0',
  },
  node: {
    display: 'flex',
    alignItems: 'center',
    minHeight: 26,
    padding: '3px 12px',
    cursor: 'pointer',
    userSelect: 'none',
    fontSize: 13,
    color: 'var(--paper)',
    gap: 6,
  },
  nodeHover: {
    background: 'var(--bl-hover)',
  },
  // The open file: the ink, faintly, with a rule. It was mint, which the
  // brand keeps for something running.
  nodeActive: {
    background: 'var(--bl-select)',
    boxShadow: 'inset 2px 0 0 var(--paper)',
    fontWeight: 500,
  },
  // Unsaved is said by the dot at the row's end; the italic it also had
  // was a slant the brand's faces do not ship, drawn by the browser.
  nodeDirty: {},
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
  // The "Source-only" mark is the badge the source view and the canvas use
  // (.bl-badge[data-tone=warn]), so the three surfaces say one thing.
  contextMenu: {
    position: 'fixed',
    background: 'var(--ink-2)',
    border: '1px solid var(--line)',
    borderRadius: 8,
    boxShadow: 'var(--bl-shadow-pop)',
    padding: '4px',
    minWidth: 170,
    zIndex: 1000,
  },
  menuItem: {
    padding: '7px 10px',
    borderRadius: 5,
    cursor: 'pointer',
    fontSize: 13,
    color: 'var(--paper)',
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
    background: 'var(--bl-hover)',
  },
  menuItemDanger: {
    color: 'var(--danger)',
  },
  menuItemDisabled: {
    opacity: 0.45,
    cursor: 'not-allowed',
  },
  error: {
    margin: '8px 12px 0',
    padding: '8px 10px',
    borderRadius: 6,
    fontSize: 12,
    lineHeight: 1.4,
    background: 'var(--bl-danger-soft)',
    color: 'var(--paper)',
    border: '1px solid var(--danger)',
    display: 'flex',
    gap: 8,
    alignItems: 'flex-start',
  },
  errorDismiss: {
    marginLeft: 'auto',
    border: 'none',
    background: 'transparent',
    color: 'inherit',
    cursor: 'pointer',
    padding: 0,
    fontSize: 14,
    lineHeight: 1,
  },
  separator: {
    height: 1,
    background: 'var(--line-soft)',
    margin: '4px 0',
  },
  renameInput: {
    flex: 1,
    border: '1px solid var(--line-strong)',
    borderRadius: 4,
    padding: '2px 6px',
    fontSize: 13,
    minWidth: 0,
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

/** Where a context menu opens, from a pointer or from a row a key was pressed on. */
interface MenuPoint {
  clientX: number;
  clientY: number;
  viaKeyboard?: boolean;
}

/** Move focus to the row before or after this one, in the order they are shown. */
function focusSiblingRow(row: HTMLElement, step: 1 | -1 | 'first' | 'last'): void {
  const tree = row.closest('[role="tree"]');
  if (!tree) return;
  const rows = [...tree.querySelectorAll<HTMLElement>('[data-file-row]')];
  const index = rows.indexOf(row);
  const next = step === 'first' ? rows[0] : step === 'last' ? rows[rows.length - 1] : rows[index + step];
  next?.focus();
}

interface FileNodeProps {
  node: ProjectFileNode;
  depth: number;
  isActive: boolean;
  onSelect: (id: string) => void;
  onContextMenu: (point: MenuPoint, node: ProjectFileNode) => void;
  onRequestRename: (id: string) => void;
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
  onRequestRename,
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

  // Which editing mode is safe for a .ui file, shown before it is opened.
  // The source view and the canvas carry the badge for the ACTIVE file;
  // here every row carries it, so the creator can see which files the
  // canvas can write back without opening each one to find out. The
  // verdict is the store's cached one when it has it, otherwise assessed
  // lazily by the hook a moment after the source settles; a file with no
  // source yet (new, unsaved) has nothing to assess and gets no mark.
  const uiFile = useFilesStore((state) =>
    node.type === 'file' && node.fileType === 'ui' ? state.uiFiles.get(node.id) : undefined
  );
  const { fidelity } = useSourceFidelity(uiFile);
  const sourceOnly = fidelity !== null && !fidelity.lossless;

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

  // The tree was mouse-only: rows were plain divs, so no file could be
  // opened, renamed or deleted from the keyboard. Arrows walk the rows,
  // Enter opens, F2 renames, and the menu key (or Shift+F10) opens the menu.
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.target !== e.currentTarget) return;
      const row = e.currentTarget;
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        handleClick();
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        focusSiblingRow(row, e.key === 'ArrowDown' ? 1 : -1);
      } else if (e.key === 'Home' || e.key === 'End') {
        e.preventDefault();
        focusSiblingRow(row, e.key === 'Home' ? 'first' : 'last');
      } else if (e.key === 'ArrowRight' && node.type === 'folder') {
        e.preventDefault();
        if (!isExpanded) setIsExpanded(true);
        else focusSiblingRow(row, 1);
      } else if (e.key === 'ArrowLeft' && node.type === 'folder' && isExpanded) {
        e.preventDefault();
        setIsExpanded(false);
      } else if (e.key === 'F2') {
        e.preventDefault();
        onRequestRename(node.id);
      } else if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
        e.preventDefault();
        const rect = row.getBoundingClientRect();
        onContextMenu({ clientX: rect.left + 24, clientY: rect.bottom, viaKeyboard: true }, node);
      }
    },
    [handleClick, isExpanded, node, onContextMenu, onRequestRename]
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
        role="treeitem"
        tabIndex={0}
        data-file-row={node.id}
        aria-level={depth + 1}
        aria-selected={node.type === 'file' ? isActive : undefined}
        aria-expanded={node.type === 'folder' ? isExpanded : undefined}
        onClick={handleClick}
        onKeyDown={handleKeyDown}
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
        {sourceOnly && (
          <span
            className="bl-badge"
            data-tone="warn"
            style={{ fontSize: 9.5, padding: '0 5px' }}
            data-fidelity="source-only"
            title={`Source-only: the visual editor cannot write this file back.\n${fidelity.reasons.join('\n')}`}
            aria-label="Source-only file"
          >
            source
          </span>
        )}
        {node.isDirty && <span className="bl-dirty-dot" title="Unsaved changes" role="img" aria-label="Unsaved changes" />}
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
                onRequestRename={onRequestRename}
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
    deletionRefusedReason,
    uiFiles,
    logicFiles,
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
      deletionRefusedReason: state.deletionRefusedReason,
      uiFiles: state.uiFiles,
      logicFiles: state.logicFiles,
    }))
  );
  const retainedSource = useProjectStore((state) => state.source);

  // A logic file named without an extension takes the project's language,
  // which is the language of the logic its entry file links: an app's logic
  // is all one language, and the runtime refuses one that mixes them.
  const entryLogic = dockLogicFile(null, uiFiles, logicFiles, entryFileId(uiFiles, retainedSource));
  const logicExtension = entryLogic && logicLanguageOf(entryLogic.path) === 'python' ? '.py' : '.logic';

  // What the last file action was refused for, said where it was asked. The
  // store refuses a name that is taken, a .py name Python cannot import, and
  // deleting the entry file or the logic it links.
  const [fileError, setFileError] = useState<string | null>(null);
  const attempt = useCallback((action: () => void): boolean => {
    try {
      action();
      setFileError(null);
      return true;
    } catch (e) {
      setFileError(e instanceof Error ? e.message : String(e));
      return false;
    }
  }, []);

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

  const menuRef = React.useRef<HTMLDivElement | null>(null);
  /** The row a keyboard-opened menu returns focus to. */
  const menuOpenerRef = React.useRef<HTMLElement | null>(null);

  const handleContextMenu = useCallback((point: MenuPoint, node: ProjectFileNode) => {
    menuOpenerRef.current = point.viaKeyboard && document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setContextMenu({
      x: point.clientX,
      y: point.clientY,
      nodeId: node.id,
      nodeType: node.type,
    });
  }, []);

  const closeContextMenu = useCallback(() => {
    setContextMenu(null);
    setMenuHoveredItem(null);
    const opener = menuOpenerRef.current;
    menuOpenerRef.current = null;
    if (opener?.isConnected) opener.focus();
  }, []);

  // A menu opened from the keyboard takes focus, so its items can be reached.
  React.useEffect(() => {
    if (!contextMenu || !menuOpenerRef.current) return;
    menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])')?.focus();
  }, [contextMenu]);

  const handleMenuKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    const items = [...e.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    const index = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'Escape' || e.key === 'Tab') {
      e.preventDefault();
      e.stopPropagation();
      closeContextMenu();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const step = e.key === 'ArrowDown' ? 1 : -1;
      items[(index + step + items.length) % items.length]?.focus();
    } else if ((e.key === 'Enter' || e.key === ' ') && index >= 0) {
      e.preventDefault();
      items[index].click();
    }
  }, [closeContextMenu]);

  const resolveDefaultParentPath = useCallback(
    (type: 'ui' | 'logic' | 'folder') => {
      const activeNode = activeFileId ? nodes.get(activeFileId) : null;
      if (activeNode?.type === 'folder') {
        return activeNode.path;
      }
      // Beside the open file when it is the same kind; a logic file made
      // while a UI file is open belongs with the logic, not in ui/.
      if (activeNode?.type === 'file' && (type === 'folder' || activeNode.fileType === type)) {
        return activeNode.path.split('/').slice(0, -1).join('/');
      }
      if (type === 'logic') return 'logic';
      return 'ui';
    },
    [activeFileId, nodes]
  );

  const handleQuickCreateStart = useCallback((type: 'ui' | 'logic' | 'folder', parentPath?: string) => {
    setFileError(null);
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
    // A refused name keeps the form open, with the reason under it.
    const created = attempt(() => {
      if (quickCreateType === 'folder') {
        createFolder(parentPath, trimmed);
      } else if (quickCreateType === 'ui') {
        createFile(parentPath, trimmed.endsWith('.ui') ? trimmed : `${trimmed}.ui`, 'ui');
      } else {
        // `.py` is a logic file too: it used to become `helpers.py.logic`.
        const named = /\.(logic|py)$/i.test(trimmed) ? trimmed : `${trimmed}${logicExtension}`;
        createFile(parentPath, named, 'logic');
      }
    });
    if (!created) return;

    handleQuickCreateCancel();
  }, [
    quickCreateType,
    quickCreateName,
    resolveDefaultParentPath,
    quickCreateParentPath,
    createFolder,
    createFile,
    handleQuickCreateCancel,
    attempt,
    logicExtension,
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

      attempt(() => {
        if (node.type === 'folder') {
          renameFolder(id, newName);
        } else {
          renameFile(id, newName);
        }
      });
      setRenamingId(null);
    },
    [nodes, renameFile, renameFolder, attempt]
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
      attempt(() => {
        if (node.type === 'folder') {
          deleteFolder(contextMenu.nodeId);
        } else {
          deleteFile(contextMenu.nodeId);
        }
      });
    }
    closeContextMenu();
  }, [contextMenu, nodes, deleteFile, deleteFolder, closeContextMenu, attempt]);

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
    // The entry file and the logic it links, found as export finds them:
    // they used to be recognised by the ids a new project gives them, so an
    // opened app's entry file offered Delete, and export then refused the app.
    const deleteRefused = deletionRefusedReason(contextMenu.nodeId);

    return (
      <div
        ref={menuRef}
        role="menu"
        aria-label={node ? `${node.name} actions` : 'File actions'}
        style={{
          ...styles.contextMenu,
          left: Math.min(contextMenu.x, window.innerWidth - 190),
          top: Math.min(contextMenu.y, window.innerHeight - 200),
        }}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleMenuKeyDown}
      >
        {isFolder && (
          <>
            <div
              style={{
                ...styles.menuItem,
                ...(menuHoveredItem === 'newUI' ? styles.menuItemHover : {}),
              }}
              onClick={handleNewUIFile}
              role="menuitem"
              tabIndex={-1}
              onMouseEnter={() => setMenuHoveredItem('newUI')}
              onMouseLeave={() => setMenuHoveredItem(null)}
            >
              <span style={styles.menuIcon}>
                <FileGlyph kind="ui" />
              </span>
              New UI file
            </div>
            <div
              style={{
                ...styles.menuItem,
                ...(menuHoveredItem === 'newLogic' ? styles.menuItemHover : {}),
              }}
              onClick={handleNewLogicFile}
              role="menuitem"
              tabIndex={-1}
              onMouseEnter={() => setMenuHoveredItem('newLogic')}
              onMouseLeave={() => setMenuHoveredItem(null)}
            >
              <span style={styles.menuIcon}>
                <FileGlyph kind="logic" />
              </span>
              New logic file
            </div>
            <div
              style={{
                ...styles.menuItem,
                ...(menuHoveredItem === 'newFolder' ? styles.menuItemHover : {}),
              }}
              onClick={handleNewFolder}
              role="menuitem"
              tabIndex={-1}
              onMouseEnter={() => setMenuHoveredItem('newFolder')}
              onMouseLeave={() => setMenuHoveredItem(null)}
            >
              <span style={styles.menuIcon}>
                <FileGlyph kind="folder" />
              </span>
              New folder
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
              role="menuitem"
              tabIndex={-1}
          onMouseEnter={() => setMenuHoveredItem('rename')}
          onMouseLeave={() => setMenuHoveredItem(null)}
        >
          Rename
        </div>
        {deleteRefused ? (
          <div
            style={{ ...styles.menuItem, ...styles.menuItemDisabled }}
            title={deleteRefused}
            role="menuitem"
            tabIndex={-1}
            aria-disabled="true"
          >
            Delete
          </div>
        ) : (
          <div
            style={{
              ...styles.menuItem,
              ...styles.menuItemDanger,
              ...(menuHoveredItem === 'delete' ? styles.menuItemHover : {}),
            }}
            onClick={handleDelete}
              role="menuitem"
              tabIndex={-1}
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
          <button
            className="bl-mini"
            onClick={() => handleQuickCreateStart('ui')}
            title="New UI file"
            aria-label="New UI file"
          >
            <FileGlyph kind="ui" size={12} />
          </button>
          <button
            className="bl-mini"
            onClick={() => handleQuickCreateStart('logic')}
            title="New logic file"
            aria-label="New logic file"
          >
            <FileGlyph kind="logic" size={12} />
          </button>
          <button
            className="bl-mini"
            onClick={() => handleQuickCreateStart('folder')}
            title="New folder"
            aria-label="New folder"
          >
            <FileGlyph kind="folder" size={12} />
          </button>
          {onToggleDock && (
            <button
              className="bl-mini"
              onClick={onToggleDock}
              title="Hide the files panel"
              aria-label="Hide files panel"
            >
              Hide
            </button>
          )}
        </div>
      </div>
      {quickCreateType && (
        <div style={styles.quickCreate}>
          <div style={styles.quickCreateTop}>
            <div>
              <div style={styles.quickCreateLabel}>
                {quickCreateType === 'folder' ? 'New folder' : quickCreateType === 'ui' ? 'New UI file' : 'New logic file'}
              </div>
              <div style={styles.quickCreateSub}>
                {quickCreateType === 'folder'
                  ? `in ${quickCreateParentPath || resolveDefaultParentPath('folder')}/`
                  : `in ${quickCreateParentPath || resolveDefaultParentPath(quickCreateType)}/`}
              </div>
            </div>
            <button className="bl-close" style={{ width: 28, height: 28, fontSize: 18 }} onClick={handleQuickCreateCancel} aria-label="Cancel">
              ×
            </button>
          </div>
          <input
            type="text"
            aria-label={quickCreateType === 'folder' ? 'Folder name' : 'File name'}
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
                  : `utils${logicExtension}`
            }
            autoFocus
          />
          <div style={styles.quickCreateActions}>
            <button className="bl-btn bl-btn-sm" style={{ flex: 1 }} onClick={handleQuickCreateCancel}>
              Cancel
            </button>
            <button className="bl-btn bl-btn-sm bl-btn-primary" style={{ flex: 1 }} onClick={handleQuickCreateSubmit}>
              Create
            </button>
          </div>
        </div>
      )}
      {fileError && (
        <div style={styles.error} role="alert">
          <span>{fileError}</span>
          <button style={styles.errorDismiss} onClick={() => setFileError(null)} aria-label="Dismiss message">
            ×
          </button>
        </div>
      )}
      <div style={styles.tree} key={`tree-${rootFolders.length}-${nodes.size}`} role="tree" aria-label="Project files">
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
              onRequestRename={setRenamingId}
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

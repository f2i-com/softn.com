/**
 * FileTabs - Tab bar for open files
 */

import React, { useState, useCallback, useEffect, useRef } from 'react';
import { useFilesStore } from '../../stores/filesStore';
import { FileGlyph, type FileGlyphKind } from './fileIcons';

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    alignItems: 'center',
    background: '#f8fafc',
    borderBottom: '1px solid #e2e8f0',
    height: 36,
    minHeight: 36,
    overflow: 'hidden',
  },
  tabsWrapper: {
    display: 'flex',
    flex: 1,
    overflow: 'auto',
    scrollbarWidth: 'none',
  },
  navButton: {
    width: 30,
    minWidth: 30,
    height: 36,
    border: 'none',
    borderRight: '1px solid #e2e8f0',
    background: '#f1f5f9',
    color: '#64748b',
    fontSize: 14,
    cursor: 'pointer',
  },
  navButtonRight: {
    borderRight: 'none',
    borderLeft: '1px solid #e2e8f0',
  },
  navButtonDisabled: {
    opacity: 0.4,
    cursor: 'not-allowed',
  },
  tab: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    padding: '0 12px',
    height: 36,
    cursor: 'pointer',
    fontSize: 13,
    color: '#64748b',
    borderRight: '1px solid #e2e8f0',
    background: '#f1f5f9',
    whiteSpace: 'nowrap',
    userSelect: 'none',
  },
  tabActive: {
    background: '#fff',
    color: '#0f172a',
    borderBottom: '2px solid #3b82f6',
    marginBottom: -1,
  },
  tabHover: {
    background: '#e2e8f0',
  },
  tabDirty: {
    fontStyle: 'italic',
  },
  icon: {
    minWidth: 18,
    height: 18,
    textAlign: 'center',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  name: {
    maxWidth: 120,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  closeBtn: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 16,
    height: 16,
    borderRadius: 3,
    background: 'transparent',
    border: 'none',
    cursor: 'pointer',
    color: '#94a3b8',
    fontSize: 14,
    lineHeight: 1,
    padding: 0,
    marginLeft: 4,
  },
  closeBtnHover: {
    background: '#e2e8f0',
    color: '#64748b',
  },
  dirtyDot: {
    width: 8,
    height: 8,
    borderRadius: '50%',
    background: '#f59e0b',
  },
  emptyState: {
    flex: 1,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: '#94a3b8',
    fontSize: 13,
  },
  contextMenu: {
    position: 'fixed',
    minWidth: 190,
    background: '#fff',
    border: '1px solid #cbd5e1',
    borderRadius: 8,
    boxShadow: '0 12px 24px rgba(15, 23, 42, 0.18)',
    zIndex: 2000,
    padding: 4,
  },
  contextMenuItem: {
    width: '100%',
    textAlign: 'left',
    background: 'transparent',
    border: 'none',
    borderRadius: 6,
    padding: '8px 10px',
    fontSize: 12,
    color: '#334155',
    cursor: 'pointer',
  },
  contextMenuItemDisabled: {
    opacity: 0.45,
    cursor: 'not-allowed',
  },
  contextMenuDivider: {
    height: 1,
    background: '#e2e8f0',
    margin: '4px 0',
  },
};

interface TabProps {
  fileId: string;
  isActive: boolean;
  onSelect: () => void;
  onClose: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
}

function Tab({ fileId, isActive, onSelect, onClose, onContextMenu }: TabProps) {
  const [isHovered, setIsHovered] = useState(false);
  const [isCloseHovered, setIsCloseHovered] = useState(false);
  const nodes = useFilesStore((state) => state.nodes);

  const handleClose = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      onClose();
    },
    [onClose]
  );

  const handleMiddleClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.button === 1) {
        e.preventDefault();
        onClose();
      }
    },
    [onClose]
  );

  const node = nodes.get(fileId);
  if (!node) return null;

  const getIcon = (): FileGlyphKind => {
    if (node.fileType === 'ui') return 'ui';
    if (node.fileType === 'logic') return 'logic';
    if (node.fileType === 'asset') return 'file';
    return 'file';
  };

  const tabStyle: React.CSSProperties = {
    ...styles.tab,
    ...(isActive ? styles.tabActive : {}),
    ...(isHovered && !isActive ? styles.tabHover : {}),
    ...(node.isDirty ? styles.tabDirty : {}),
  };

  return (
    <div
      style={tabStyle}
      onClick={onSelect}
      onMouseDown={handleMiddleClick}
      onContextMenu={onContextMenu}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      <span style={styles.icon}>
        <FileGlyph kind={getIcon()} />
      </span>
      <span style={styles.name}>{node.name}</span>
      {node.isDirty ? (
        <span style={styles.dirtyDot} title="Unsaved changes" />
      ) : (
        <button
          style={{
            ...styles.closeBtn,
            ...(isCloseHovered ? styles.closeBtnHover : {}),
          }}
          onClick={handleClose}
          onMouseEnter={() => setIsCloseHovered(true)}
          onMouseLeave={() => setIsCloseHovered(false)}
          title="Close"
        >
          x
        </button>
      )}
    </div>
  );
}

export function FileTabs() {
  const { openTabs, activeFileId, setActiveFile, closeFile } = useFilesStore();
  const tabsRef = useRef<HTMLDivElement | null>(null);
  const [contextMenu, setContextMenu] = useState<{
    fileId: string;
    tabIndex: number;
    x: number;
    y: number;
  } | null>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);

  const updateScrollState = useCallback(() => {
    const el = tabsRef.current;
    if (!el) {
      setCanScrollLeft(false);
      setCanScrollRight(false);
      return;
    }
    setCanScrollLeft(el.scrollLeft > 0);
    setCanScrollRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 1);
  }, []);

  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    window.addEventListener('click', close);
    window.addEventListener('resize', close);
    window.addEventListener('blur', close);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('resize', close);
      window.removeEventListener('blur', close);
    };
  }, [contextMenu]);

  useEffect(() => {
    updateScrollState();
  }, [openTabs, updateScrollState]);

  useEffect(() => {
    const onResize = () => updateScrollState();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [updateScrollState]);

  const scrollTabs = useCallback(
    (direction: 'left' | 'right') => {
      const el = tabsRef.current;
      if (!el) return;
      const amount = Math.max(180, Math.floor(el.clientWidth * 0.5));
      el.scrollBy({
        left: direction === 'left' ? -amount : amount,
        behavior: 'smooth',
      });
      requestAnimationFrame(updateScrollState);
    },
    [updateScrollState]
  );

  const closeTabs = useCallback(
    (ids: string[]) => {
      for (const id of ids) {
        closeFile(id);
      }
    },
    [closeFile]
  );

  if (openTabs.length === 0) {
    return (
      <div style={styles.container}>
        <div style={styles.emptyState}>No files open</div>
      </div>
    );
  }

  return (
    <div style={styles.container}>
      <button
        style={{
          ...styles.navButton,
          ...(canScrollLeft ? {} : styles.navButtonDisabled),
        }}
        disabled={!canScrollLeft}
        onClick={() => scrollTabs('left')}
        title="Scroll tabs left"
      >
        {'<'}
      </button>
      <div
        ref={tabsRef}
        style={styles.tabsWrapper}
        onScroll={updateScrollState}
        onWheel={(e) => {
          if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
            e.currentTarget.scrollLeft += e.deltaY;
            updateScrollState();
          }
        }}
      >
        {openTabs.map((fileId) => (
          <Tab
            key={fileId}
            fileId={fileId}
            isActive={fileId === activeFileId}
            onSelect={() => setActiveFile(fileId)}
            onClose={() => closeFile(fileId)}
            onContextMenu={(e) => {
              e.preventDefault();
              const tabIndex = openTabs.indexOf(fileId);
              setContextMenu({
                fileId,
                tabIndex,
                x: e.clientX,
                y: e.clientY,
              });
            }}
          />
        ))}
      </div>
      <button
        style={{
          ...styles.navButton,
          ...styles.navButtonRight,
          ...(canScrollRight ? {} : styles.navButtonDisabled),
        }}
        disabled={!canScrollRight}
        onClick={() => scrollTabs('right')}
        title="Scroll tabs right"
      >
        {'>'}
      </button>
      {contextMenu && (
        <div
          style={{
            ...styles.contextMenu,
            left: contextMenu.x,
            top: contextMenu.y,
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            style={styles.contextMenuItem}
            onClick={() => {
              closeFile(contextMenu.fileId);
              setContextMenu(null);
            }}
          >
            Close
          </button>
          <button
            style={{
              ...styles.contextMenuItem,
              ...(openTabs.length <= 1 ? styles.contextMenuItemDisabled : {}),
            }}
            disabled={openTabs.length <= 1}
            onClick={() => {
              const others = openTabs.filter((id) => id !== contextMenu.fileId);
              closeTabs(others);
              setContextMenu(null);
            }}
          >
            Close Other Tabs
          </button>
          <div style={styles.contextMenuDivider} />
          <button
            style={{
              ...styles.contextMenuItem,
              ...(contextMenu.tabIndex <= 0 ? styles.contextMenuItemDisabled : {}),
            }}
            disabled={contextMenu.tabIndex <= 0}
            onClick={() => {
              const leftTabs = openTabs.slice(0, contextMenu.tabIndex);
              closeTabs(leftTabs);
              setContextMenu(null);
            }}
          >
            Close Tabs To The Left
          </button>
          <button
            style={{
              ...styles.contextMenuItem,
              ...(contextMenu.tabIndex >= openTabs.length - 1
                ? styles.contextMenuItemDisabled
                : {}),
            }}
            disabled={contextMenu.tabIndex >= openTabs.length - 1}
            onClick={() => {
              const rightTabs = openTabs.slice(contextMenu.tabIndex + 1);
              closeTabs(rightTabs);
              setContextMenu(null);
            }}
          >
            Close Tabs To The Right
          </button>
          <div style={styles.contextMenuDivider} />
          <button
            style={{
              ...styles.contextMenuItem,
              ...(openTabs.length === 0 ? styles.contextMenuItemDisabled : {}),
            }}
            disabled={openTabs.length === 0}
            onClick={() => {
              closeTabs([...openTabs]);
              setContextMenu(null);
            }}
          >
            Close All Tabs
          </button>
        </div>
      )}
    </div>
  );
}

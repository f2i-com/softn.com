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
    background: 'var(--ink)',
    borderBottom: '1px solid var(--line-soft)',
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
    borderRight: '1px solid var(--line-soft)',
    background: 'var(--ink)',
    color: 'var(--dim)',
    fontSize: 14,
    cursor: 'pointer',
    flexShrink: 0,
  },
  navButtonRight: {
    borderRight: 'none',
    borderLeft: '1px solid var(--line-soft)',
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
    color: 'var(--dim)',
    borderRight: '1px solid var(--line-soft)',
    background: 'var(--ink)',
    whiteSpace: 'nowrap',
    userSelect: 'none',
    flexShrink: 0,
  },
  // The open tab is the ink, raised, with a rule in the ink: coral is kept
  // for the language, and a tab is not code.
  tabActive: {
    background: 'var(--ink-2)',
    color: 'var(--paper)',
    boxShadow: 'inset 0 -2px 0 var(--paper)',
  },
  tabHover: {
    background: 'var(--bl-hover)',
    color: 'var(--paper)',
  },
  tabDirty: {},
  icon: {
    minWidth: 18,
    height: 18,
    textAlign: 'center',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  name: {
    maxWidth: 160,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  closeBtn: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 18,
    height: 18,
    borderRadius: 4,
    background: 'transparent',
    border: 'none',
    cursor: 'pointer',
    color: 'var(--dimmer)',
    fontSize: 14,
    lineHeight: 1,
    padding: 0,
    marginLeft: 4,
  },
  closeBtnHover: {
    background: 'var(--bl-hover)',
    color: 'var(--paper)',
  },
  emptyState: {
    flex: 1,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: 'var(--dimmer)',
    fontSize: 13,
  },
  contextMenu: {
    position: 'fixed',
    minWidth: 190,
    background: 'var(--ink-2)',
    border: '1px solid var(--line)',
    borderRadius: 8,
    boxShadow: 'var(--bl-shadow-pop)',
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
    color: 'var(--paper)',
    cursor: 'pointer',
  },
  contextMenuItemDisabled: {
    opacity: 0.45,
    cursor: 'not-allowed',
  },
  contextMenuDivider: {
    height: 1,
    background: 'var(--line-soft)',
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
      role="tab"
      tabIndex={isActive ? 0 : -1}
      aria-selected={isActive}
      data-tab-file={fileId}
      title={node.path}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect();
        } else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
          // Tabs are one stop in the Tab order; the arrows move between them.
          e.preventDefault();
          const tabs = [...(e.currentTarget.parentElement?.querySelectorAll<HTMLElement>('[role="tab"]') ?? [])];
          const next = tabs[tabs.indexOf(e.currentTarget) + (e.key === 'ArrowRight' ? 1 : -1)];
          next?.focus();
          next?.click();
        } else if (e.key === 'Delete') {
          e.preventDefault();
          onClose();
        }
      }}
      onMouseDown={handleMiddleClick}
      onContextMenu={onContextMenu}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      <span style={styles.icon}>
        <FileGlyph kind={getIcon()} />
      </span>
      <span style={styles.name}>{node.name}</span>
      {/* An unsaved file shows a dot where its close button is, and the
          button on hover, as editors do: it used to have no close button at
          all, so the only way to close it was the context menu. Closing
          loses nothing — closeFile only drops the tab; the file's content
          stays in the store, and App flushes the canvas into it first. */}
      <button
        style={{
          ...styles.closeBtn,
          ...(isCloseHovered ? styles.closeBtnHover : {}),
        }}
        onClick={handleClose}
        onMouseEnter={() => setIsCloseHovered(true)}
        onMouseLeave={() => setIsCloseHovered(false)}
        tabIndex={-1}
        aria-label={node.isDirty ? `Close ${node.name} (unsaved changes)` : `Close ${node.name}`}
        title={node.isDirty ? 'Unsaved changes — close' : 'Close'}
      >
        {node.isDirty && !isHovered ? <span className="bl-dirty-dot" aria-hidden="true" /> : '×'}
      </button>
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
        <div style={styles.emptyState}>No files open — choose one in Files</div>
      </div>
    );
  }

  return (
    <div style={styles.container}>
      {(canScrollLeft || canScrollRight) && (
        <button
          style={{
            ...styles.navButton,
            ...(canScrollLeft ? {} : styles.navButtonDisabled),
          }}
          disabled={!canScrollLeft}
          onClick={() => scrollTabs('left')}
          aria-label="Scroll tabs left"
        >
          ‹
        </button>
      )}
      <div
        ref={tabsRef}
        role="tablist"
        aria-label="Open files"
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
      {(canScrollLeft || canScrollRight) && (
        <button
          style={{
            ...styles.navButton,
            ...styles.navButtonRight,
            ...(canScrollRight ? {} : styles.navButtonDisabled),
          }}
          disabled={!canScrollRight}
          onClick={() => scrollTabs('right')}
          aria-label="Scroll tabs right"
        >
          ›
        </button>
      )}
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
            Close other tabs
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
            Close tabs to the left
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
            Close tabs to the right
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
            Close all tabs
          </button>
        </div>
      )}
    </div>
  );
}

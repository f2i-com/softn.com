/**
 * TreeView - Component hierarchy tree
 */

import React, { useState, useCallback } from 'react';
import { useCanvasStore } from '../../stores/canvasStore';
import { useHistoryStore } from '../../stores/historyStore';
import { blockHeaderText } from '../../utils/sourceGenerator';
import type { CanvasElement } from '../../types/builder';

const styles: Record<string, React.CSSProperties> = {
  container: {
    background: 'var(--ink-2)',
    borderTop: '1px solid var(--line-soft)',
    maxHeight: 250,
    overflow: 'auto',
  },
  // A section inside the Properties panel: small and dim, sentence case.
  header: {
    padding: '8px 16px',
    borderBottom: '1px solid var(--line-soft)',
    fontWeight: 600,
    fontSize: 12,
    color: 'var(--dim)',
    position: 'sticky' as const,
    top: 0,
    background: 'var(--ink-2)',
    zIndex: 1,
  },
  tree: {
    padding: '6px 0',
  },
  emptyHint: {
    padding: '2px 16px 10px 28px',
    fontSize: 11.5,
    lineHeight: 1.5,
    color: 'var(--dim)',
  },
};

interface TreeNodeProps {
  element: CanvasElement;
  depth: number;
}

const nodeBaseStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  minHeight: 24,
  padding: '2px 8px',
  cursor: 'pointer',
  fontSize: 12.5,
  color: 'var(--paper)',
  transition: 'background 0.15s',
};

const nodeHoverStyle: React.CSSProperties = {
  background: 'var(--bl-hover)',
};

// The ink, faintly, with a rule. It was mint with dark-blue text, which the
// dark theme could not read and the brand keeps for something running.
const nodeSelectedStyle: React.CSSProperties = {
  background: 'var(--bl-select)',
  boxShadow: 'inset 2px 0 0 var(--paper)',
  fontWeight: 600,
};

const toggleStyle: React.CSSProperties = {
  width: 16,
  height: 16,
  padding: 0,
  border: 'none',
  background: 'transparent',
  color: 'var(--dim)',
  fontSize: 12,
  lineHeight: 1,
  cursor: 'pointer',
  flexShrink: 0,
  transition: 'transform 0.15s',
};

const deleteStyle: React.CSSProperties = {
  width: 18,
  height: 18,
  padding: 0,
  border: 'none',
  borderRadius: 4,
  background: 'transparent',
  color: 'var(--danger)',
  fontSize: 14,
  lineHeight: 1,
  cursor: 'pointer',
};

/** Move focus to the hierarchy row before or after this one, as shown. */
function focusSiblingRow(row: HTMLElement, step: 1 | -1): void {
  const tree = row.closest('[role="tree"]');
  const rows = [...(tree?.querySelectorAll<HTMLElement>('[data-hierarchy-row]') ?? [])];
  rows[rows.indexOf(row) + step]?.focus();
}

function TreeNode({ element, depth }: TreeNodeProps) {
  const [isExpanded, setIsExpanded] = useState(true);
  const [isHovered, setIsHovered] = useState(false);

  const { elements, rootId, selectedIds, selectElement, deleteElement } = useCanvasStore();
  const { push } = useHistoryStore();

  const isSelected = selectedIds.includes(element.id);
  const hasChildren = element.children.length > 0;

  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      selectElement(element.id, e.shiftKey);
    },
    [element.id, selectElement]
  );

  const handleToggle = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setIsExpanded((prev) => !prev);
  }, []);

  const handleDelete = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      if (element.parentId) {
        push(elements, rootId);
        deleteElement(element.id);
      }
    },
    [element.id, element.parentId, elements, rootId, push, deleteElement]
  );

  // Rows walk like the canvas tree: arrows move, Enter selects (Shift adds),
  // left and right fold, Delete removes. They were mouse-only before.
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.target !== e.currentTarget) return;
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        selectElement(element.id, e.shiftKey);
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        focusSiblingRow(e.currentTarget, e.key === 'ArrowDown' ? 1 : -1);
      } else if (e.key === 'ArrowLeft' && hasChildren && isExpanded) {
        e.preventDefault();
        setIsExpanded(false);
      } else if (e.key === 'ArrowRight' && hasChildren && !isExpanded) {
        e.preventDefault();
        setIsExpanded(true);
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && element.parentId) {
        e.preventDefault();
        e.stopPropagation();
        push(elements, rootId);
        deleteElement(element.id);
      }
    },
    [element.id, element.parentId, hasChildren, isExpanded, selectElement, elements, rootId, push, deleteElement]
  );

  const nodeStyle: React.CSSProperties = {
    ...nodeBaseStyle,
    paddingLeft: 8 + depth * 16,
    ...(isHovered && !isSelected ? nodeHoverStyle : {}),
    ...(isSelected ? nodeSelectedStyle : {}),
  };

  return (
    <div>
      <div
        style={nodeStyle}
        role="treeitem"
        tabIndex={isSelected || (depth === 0 && selectedIds.length === 0) ? 0 : -1}
        data-hierarchy-row={element.id}
        aria-level={depth + 1}
        aria-selected={isSelected}
        aria-expanded={hasChildren ? isExpanded : undefined}
        onKeyDown={handleKeyDown}
        onClick={handleClick}
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
      >
        {hasChildren ? (
          <button
            type="button"
            tabIndex={-1}
            onClick={handleToggle}
            aria-label={isExpanded ? 'Collapse' : 'Expand'}
            style={{ ...toggleStyle, transform: isExpanded ? 'rotate(90deg)' : undefined }}
          >
            ›
          </button>
        ) : (
          <span style={{ width: 16 }} />
        )}

        {/* A block is named by its header line — `#if (open)`, `#each (item in
            items)` — so the tree reads as the source does; a bare `#if` said
            nothing about which branch this was. */}
        <span
          style={{
            flex: 1,
            marginLeft: 4,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            ...(element.block ? { fontFamily: 'var(--mono)', fontWeight: 400, color: 'var(--coral)' } : {}),
          }}
          data-tree-label={element.block ? 'block' : 'component'}
        >
          {blockHeaderText(element) ?? element.componentType}
        </span>

        {element.parentId && isHovered && (
          <button
            type="button"
            tabIndex={-1}
            onClick={handleDelete}
            style={deleteStyle}
            title="Delete (Del)"
            aria-label={`Delete ${element.componentType}`}
          >
            ×
          </button>
        )}
      </div>

      {hasChildren && isExpanded && (
        <div>
          {element.children.map((childId) => {
            const child = elements.get(childId);
            if (!child) return null;
            return <TreeNode key={childId} element={child} depth={depth + 1} />;
          })}
        </div>
      )}
    </div>
  );
}

export function TreeView() {
  const { elements, rootId } = useCanvasStore();
  const rootElement = elements.get(rootId);

  if (!rootElement) return null;

  return (
    <div style={styles.container}>
      <div style={styles.header} id="builder-hierarchy-title">Hierarchy</div>
      <div style={styles.tree} role="tree" aria-labelledby="builder-hierarchy-title">
        <TreeNode element={rootElement} depth={0} />
        {/* A tree of one node says nothing about how to grow it. */}
        {rootElement.children.length === 0 && (
          <div style={styles.emptyHint} data-tree-empty>
            Empty so far. Drag a component from the palette onto the canvas, and it appears here.
          </div>
        )}
      </div>
    </div>
  );
}

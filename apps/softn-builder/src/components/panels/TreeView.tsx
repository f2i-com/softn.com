/**
 * TreeView - Component hierarchy tree
 */

import React, { useState, useCallback } from 'react';
import { useCanvasStore } from '../../stores/canvasStore';
import { useHistoryStore } from '../../stores/historyStore';
import type { CanvasElement } from '../../types/builder';

const styles: Record<string, React.CSSProperties> = {
  container: {
    background: '#fff',
    borderTop: '1px solid #e2e8f0',
    maxHeight: 250,
    overflow: 'auto',
  },
  header: {
    padding: '8px 16px',
    borderBottom: '1px solid #e2e8f0',
    fontWeight: 600,
    fontSize: 12,
    color: '#64748b',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.05em',
    position: 'sticky' as const,
    top: 0,
    background: '#fff',
    zIndex: 1,
  },
  tree: {
    padding: '8px 0',
  },
};

interface TreeNodeProps {
  element: CanvasElement;
  depth: number;
}

const nodeBaseStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  padding: '4px 8px',
  cursor: 'pointer',
  fontSize: 12,
  transition: 'background 0.15s',
};

const nodeHoverStyle: React.CSSProperties = {
  background: '#f1f5f9',
};

const nodeSelectedStyle: React.CSSProperties = {
  background: '#dbeafe',
  color: '#1e40af',
};

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
        onClick={handleClick}
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
      >
        {hasChildren ? (
          <span
            onClick={handleToggle}
            style={{
              width: 16,
              textAlign: 'center' as const,
              fontSize: 10,
              color: '#94a3b8',
              cursor: 'pointer',
            }}
          >
            {isExpanded ? 'v' : '>'}
          </span>
        ) : (
          <span style={{ width: 16 }} />
        )}

        <span style={{ flex: 1, marginLeft: 4 }}>{element.componentType}</span>

        {element.parentId && isHovered && (
          <span
            onClick={handleDelete}
            style={{
              fontSize: 14,
              color: '#ef4444',
              opacity: 0.6,
              cursor: 'pointer',
            }}
            title="Delete"
          >
            x
          </span>
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
      <div style={styles.header}>Hierarchy</div>
      <div style={styles.tree}>
        <TreeNode element={rootElement} depth={0} />
      </div>
    </div>
  );
}

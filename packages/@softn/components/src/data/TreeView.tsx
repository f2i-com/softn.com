/**
 * TreeView Component
 *
 * Hierarchical tree display with expand/collapse functionality.
 */

import * as React from 'react';

export interface TreeNode {
  id: string;
  label: React.ReactNode;
  children?: TreeNode[];
  icon?: React.ReactNode;
  disabled?: boolean;
  data?: any;
}

export interface TreeViewProps {
  nodes: TreeNode[];
  expandedIds?: Set<string>;
  selectedId?: string;
  onExpand?: (id: string, expanded: boolean) => void;
  onSelect?: (id: string, node: TreeNode) => void;
  defaultExpandAll?: boolean;
  showLines?: boolean;
  indent?: number;
  className?: string;
  style?: React.CSSProperties;
}

interface TreeNodeItemProps {
  node: TreeNode;
  level: number;
  expandedIds: Set<string>;
  selectedId?: string;
  onExpand: (id: string, expanded: boolean) => void;
  onSelect?: (id: string, node: TreeNode) => void;
  showLines: boolean;
  indent: number;
}

function TreeNodeItem({
  node,
  level,
  expandedIds,
  selectedId,
  onExpand,
  onSelect,
  showLines,
  indent,
}: TreeNodeItemProps) {
  const hasChildren = node.children && node.children.length > 0;
  const isExpanded = expandedIds.has(node.id);
  const isSelected = selectedId === node.id;

  const handleToggle = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (hasChildren) {
      onExpand(node.id, !isExpanded);
    }
  };

  const handleSelect = () => {
    if (!node.disabled && onSelect) {
      onSelect(node.id, node);
    }
  };

  const nodeStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    padding: '0.375rem 0.5rem',
    marginLeft: level * indent,
    cursor: node.disabled ? 'not-allowed' : 'pointer',
    borderRadius: '4px',
    backgroundColor: isSelected ? 'var(--color-gray-50, rgba(255, 255, 255, 0.03))' : 'transparent',
    opacity: node.disabled ? 0.5 : 1,
    transition: 'background-color 0.15s cubic-bezier(0.16, 1, 0.3, 1)',
  };

  const expandIconStyle: React.CSSProperties = {
    width: '20px',
    height: '20px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: '0.25rem',
    transition: 'transform 0.15s cubic-bezier(0.16, 1, 0.3, 1)',
    transform: isExpanded ? 'rotate(90deg)' : 'rotate(0deg)',
  };

  const labelStyle: React.CSSProperties = {
    flex: 1,
    display: 'flex',
    alignItems: 'center',
    gap: '0.5rem',
  };

  return (
    <div>
      <div
        style={nodeStyle}
        onClick={handleSelect}
        onMouseEnter={(e) => {
          if (!isSelected && !node.disabled) {
            e.currentTarget.style.backgroundColor = 'var(--color-gray-50, rgba(255, 255, 255, 0.03))';
          }
        }}
        onMouseLeave={(e) => {
          if (!isSelected) {
            e.currentTarget.style.backgroundColor = 'transparent';
          }
        }}
      >
        <span style={expandIconStyle} onClick={handleToggle}>
          {hasChildren && (
            <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor">
              <path d="M4 2L10 6L4 10V2Z" />
            </svg>
          )}
        </span>
        <span style={labelStyle}>
          {node.icon && <span>{node.icon}</span>}
          {node.label}
        </span>
      </div>
      {hasChildren && isExpanded && (
        <div style={{ position: 'relative' }}>
          {showLines && (
            <div
              style={{
                position: 'absolute',
                left: level * indent + 10,
                top: 0,
                bottom: 0,
                width: '1px',
                backgroundColor: 'var(--color-border, rgba(255, 255, 255, 0.08))',
              }}
            />
          )}
          {node.children!.map((child) => (
            <TreeNodeItem
              key={child.id}
              node={child}
              level={level + 1}
              expandedIds={expandedIds}
              selectedId={selectedId}
              onExpand={onExpand}
              onSelect={onSelect}
              showLines={showLines}
              indent={indent}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function getAllNodeIds(nodes: TreeNode[]): string[] {
  const ids: string[] = [];
  const traverse = (nodeList: TreeNode[]) => {
    for (const node of nodeList) {
      ids.push(node.id);
      if (node.children) {
        traverse(node.children);
      }
    }
  };
  traverse(nodes);
  return ids;
}

export function TreeView({
  nodes,
  expandedIds: controlledExpandedIds,
  selectedId,
  onExpand,
  onSelect,
  defaultExpandAll = false,
  showLines = false,
  indent = 20,
  className = '',
  style,
}: TreeViewProps) {
  const [internalExpandedIds, setInternalExpandedIds] = React.useState<Set<string>>(() => {
    if (defaultExpandAll) {
      return new Set(getAllNodeIds(nodes));
    }
    return new Set();
  });

  const expandedIds = controlledExpandedIds ?? internalExpandedIds;

  const handleExpand = (id: string, expanded: boolean) => {
    if (onExpand) {
      onExpand(id, expanded);
    } else {
      setInternalExpandedIds((prev) => {
        const next = new Set(prev);
        if (expanded) {
          next.add(id);
        } else {
          next.delete(id);
        }
        return next;
      });
    }
  };

  const containerStyle: React.CSSProperties = {
    fontFamily: 'inherit',
    fontSize: '0.875rem',
    ...style,
  };

  return (
    <div className={`softn-tree-view ${className}`} style={containerStyle}>
      {nodes.map((node) => (
        <TreeNodeItem
          key={node.id}
          node={node}
          level={0}
          expandedIds={expandedIds}
          selectedId={selectedId}
          onExpand={handleExpand}
          onSelect={onSelect}
          showLines={showLines}
          indent={indent}
        />
      ))}
    </div>
  );
}

export default TreeView;

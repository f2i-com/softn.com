/**
 * TreeView Component
 *
 * Hierarchical tree display with expand/collapse functionality.
 *
 * Follows the WAI-ARIA tree pattern: the root is a `tree`, each row a
 * `treeitem` with its level, position, expanded and selected state, and the
 * tree is one tab stop — arrow keys move between visible rows, Right/Left
 * open and close a branch (or step into and out of it), Home/End jump to the
 * ends, and Enter or Space select.
 */

import * as React from 'react';

export interface TreeNode {
  id: string;
  label: React.ReactNode;
  children?: TreeNode[];
  icon?: React.ReactNode;
  disabled?: boolean;
  /** Whatever the app attaches to the node; the tree only carries it. */
  data?: unknown;
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
  /** Accessible name for the tree */
  ariaLabel?: string;
  className?: string;
  style?: React.CSSProperties;
}

interface TreeNodeItemProps {
  node: TreeNode;
  level: number;
  posInSet: number;
  setSize: number;
  expandedIds: Set<string>;
  selectedId?: string;
  selectable: boolean;
  focusId: string | null;
  onExpand: (id: string, expanded: boolean) => void;
  onSelect?: (id: string, node: TreeNode) => void;
  onFocusNode: (id: string) => void;
  registerItem: (id: string, element: HTMLDivElement | null) => void;
  showLines: boolean;
  indent: number;
}

function TreeNodeItem({
  node,
  level,
  posInSet,
  setSize,
  expandedIds,
  selectedId,
  selectable,
  focusId,
  onExpand,
  onSelect,
  onFocusNode,
  registerItem,
  showLines,
  indent,
}: TreeNodeItemProps) {
  const hasChildren = !!node.children && node.children.length > 0;
  const isExpanded = expandedIds.has(node.id);
  const isSelected = selectedId === node.id;

  const handleToggle = (e: React.MouseEvent) => {
    e.stopPropagation();
    onFocusNode(node.id);
    if (hasChildren) {
      onExpand(node.id, !isExpanded);
    }
  };

  const handleSelect = () => {
    onFocusNode(node.id);
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
    flex: 'none',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: '0.25rem',
    transition: 'transform 0.15s cubic-bezier(0.16, 1, 0.3, 1)',
    transform: isExpanded ? 'rotate(90deg)' : 'rotate(0deg)',
  };

  const labelStyle: React.CSSProperties = {
    flex: 1,
    minWidth: 0,
    display: 'flex',
    alignItems: 'center',
    gap: '0.5rem',
    overflowWrap: 'anywhere',
  };

  return (
    <div>
      <div
        ref={(element) => registerItem(node.id, element)}
        role="treeitem"
        aria-level={level + 1}
        aria-posinset={posInSet}
        aria-setsize={setSize}
        aria-expanded={hasChildren ? isExpanded : undefined}
        aria-selected={selectable ? isSelected : undefined}
        aria-disabled={node.disabled || undefined}
        tabIndex={focusId === node.id ? 0 : -1}
        data-tree-id={node.id}
        style={nodeStyle}
        onClick={handleSelect}
        onFocus={(e) => {
          if (e.target === e.currentTarget) onFocusNode(node.id);
        }}
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
        <span style={expandIconStyle} onClick={handleToggle} aria-hidden="true">
          {hasChildren && (
            <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" focusable="false">
              <path d="M4 2L10 6L4 10V2Z" />
            </svg>
          )}
        </span>
        <span style={labelStyle}>
          {node.icon && <span aria-hidden="true">{node.icon}</span>}
          {node.label}
        </span>
      </div>
      {hasChildren && isExpanded && (
        <div style={{ position: 'relative' }}>
          {showLines && (
            <div
              aria-hidden="true"
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
          {node.children!.map((child, index) => (
            <TreeNodeItem
              key={child.id}
              node={child}
              level={level + 1}
              posInSet={index + 1}
              setSize={node.children!.length}
              expandedIds={expandedIds}
              selectedId={selectedId}
              selectable={selectable}
              focusId={focusId}
              onExpand={onExpand}
              onSelect={onSelect}
              onFocusNode={onFocusNode}
              registerItem={registerItem}
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
      if (!node) continue;
      ids.push(node.id);
      if (node.children) {
        traverse(node.children);
      }
    }
  };
  traverse(nodes);
  return ids;
}

interface VisibleNode {
  node: TreeNode;
  parentId: string | null;
}

/** The rows a reader can reach, in the order they are drawn. */
function visibleNodes(nodes: TreeNode[], expandedIds: Set<string>): VisibleNode[] {
  const out: VisibleNode[] = [];
  const walk = (list: TreeNode[], parentId: string | null) => {
    for (const node of list) {
      if (!node) continue;
      out.push({ node, parentId });
      if (node.children && node.children.length > 0 && expandedIds.has(node.id)) walk(node.children, node.id);
    }
  };
  walk(nodes, null);
  return out;
}

export function TreeView({
  nodes: nodesProp,
  expandedIds: controlledExpandedIds,
  selectedId,
  onExpand,
  onSelect,
  defaultExpandAll = false,
  showLines = false,
  indent = 20,
  ariaLabel,
  className = '',
  style,
}: TreeViewProps) {
  // Bound to data that has not arrived yet, the tree is empty, not an error.
  const nodes = React.useMemo(
    () => (Array.isArray(nodesProp) ? nodesProp.filter(Boolean) : []),
    [nodesProp]
  );
  const [internalExpandedIds, setInternalExpandedIds] = React.useState<Set<string>>(() => {
    if (defaultExpandAll) {
      return new Set(getAllNodeIds(nodes));
    }
    return new Set();
  });

  const expandedIds = controlledExpandedIds ?? internalExpandedIds;

  const handleExpand = (id: string, expanded: boolean) => {
    onExpand?.(id, expanded);

    // Ownership is decided by `expandedIds`, not by whether a callback exists.
    //
    // Treating the presence of `onExpand` as "the caller drives expansion" meant
    // anyone passing it just to observe — logging, analytics, syncing a
    // breadcrumb — got a tree that could never open, while the callback fired
    // correctly every time they clicked. This matches how Checkbox, Radio and
    // Select decide the same question.
    if (controlledExpandedIds) return;

    setInternalExpandedIds((prev) => {
      const next = new Set(prev);
      if (expanded) {
        next.add(id);
      } else {
        next.delete(id);
      }
      return next;
    });
  };

  const visible = React.useMemo(() => visibleNodes(nodes, expandedIds), [nodes, expandedIds]);
  const [focusedId, setFocusedId] = React.useState<string | null>(null);
  const items = React.useRef(new Map<string, HTMLDivElement>());
  const registerItem = React.useCallback((id: string, element: HTMLDivElement | null) => {
    if (element) items.current.set(id, element);
    else items.current.delete(id);
  }, []);

  // One tab stop: the row last focused while it is still visible, else the
  // selected row, else the first.
  const isVisible = (id: string | null | undefined) => id != null && visible.some((v) => v.node.id === id);
  const focusId = isVisible(focusedId)
    ? focusedId
    : isVisible(selectedId)
      ? (selectedId as string)
      : (visible[0]?.node.id ?? null);

  const moveFocus = (id: string | undefined) => {
    if (id === undefined) return;
    setFocusedId(id);
    items.current.get(id)?.focus();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    if (target.getAttribute('role') !== 'treeitem') return;
    const id = target.getAttribute('data-tree-id');
    const index = visible.findIndex((v) => v.node.id === id);
    if (index < 0) return;
    const { node, parentId } = visible[index];
    const hasChildren = !!node.children && node.children.length > 0;
    const expanded = expandedIds.has(node.id);
    switch (e.key) {
      case 'ArrowDown':
        moveFocus(visible[index + 1]?.node.id);
        break;
      case 'ArrowUp':
        moveFocus(visible[index - 1]?.node.id);
        break;
      case 'Home':
        moveFocus(visible[0]?.node.id);
        break;
      case 'End':
        moveFocus(visible[visible.length - 1]?.node.id);
        break;
      case 'ArrowRight':
        if (!hasChildren) return;
        if (!expanded) handleExpand(node.id, true);
        else moveFocus(visible[index + 1]?.node.id);
        break;
      case 'ArrowLeft':
        if (hasChildren && expanded) handleExpand(node.id, false);
        else if (parentId !== null) moveFocus(parentId);
        else return;
        break;
      case 'Enter':
      case ' ':
        if (!node.disabled) onSelect?.(node.id, node);
        break;
      default:
        return;
    }
    e.preventDefault();
  };

  const containerStyle: React.CSSProperties = {
    fontFamily: 'inherit',
    fontSize: '0.875rem',
    ...style,
  };

  return (
    <div
      className={`softn-tree-view ${className}`}
      style={containerStyle}
      role="tree"
      aria-label={ariaLabel}
      onKeyDown={handleKeyDown}
    >
      {nodes.map((node, index) => (
        <TreeNodeItem
          key={node.id}
          node={node}
          level={0}
          posInSet={index + 1}
          setSize={nodes.length}
          expandedIds={expandedIds}
          selectedId={selectedId}
          selectable={!!onSelect || selectedId !== undefined}
          focusId={focusId}
          onExpand={handleExpand}
          onSelect={onSelect}
          onFocusNode={setFocusedId}
          registerItem={registerItem}
          showLines={showLines}
          indent={indent}
        />
      ))}
    </div>
  );
}

export default TreeView;

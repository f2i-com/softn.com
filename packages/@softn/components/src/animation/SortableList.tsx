/**
 * SortableList Component
 *
 * A drag-to-reorder list using pointer events.
 * Items animate smoothly to their new positions.
 */

import * as React from 'react';

export interface SortableListProps {
  /** Array of items to render */
  items: any[];
  /** Field name to use as React key (defaults to index) */
  renderKey?: string;
  /** Field name for primary text display */
  primary?: string;
  /** Field name for secondary/subtitle text display */
  secondary?: string;
  /** Layout direction */
  direction?: 'vertical' | 'horizontal';
  /** Gap between items in pixels */
  gap?: number;
  /** Callback with the reordered items array */
  onReorder?: (newItems: any[]) => void;
  /** Additional CSS class */
  className?: string;
  /** Inline styles */
  style?: React.CSSProperties;
}

interface DragState {
  dragIndex: number;
  overIndex: number;
  startY: number;
  startX: number;
  currentY: number;
  currentX: number;
  itemSize: number;
}

function getItemKey(item: any, index: number, renderKey?: string): string {
  if (renderKey && item != null && typeof item === 'object' && renderKey in item) {
    return String(item[renderKey]);
  }
  return String(index);
}

function getItemText(item: any, field?: string): string {
  if (field && item != null && typeof item === 'object' && field in item) {
    return String(item[field]);
  }
  if (typeof item === 'string' || typeof item === 'number') {
    return String(item);
  }
  return '';
}

const gripIconStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: '24px',
  height: '24px',
  flexShrink: 0,
  cursor: 'grab',
  color: '#999',
  fontSize: '16px',
  lineHeight: 1,
  userSelect: 'none',
};

const GripIcon = (): React.ReactElement => (
  <span style={gripIconStyle} aria-hidden="true">
    ⠿
  </span>
);

export function SortableList({
  items = [],
  renderKey,
  primary,
  secondary,
  direction = 'vertical',
  gap = 8,
  onReorder,
  className,
  style,
}: SortableListProps): React.ReactElement {
  const [dragState, setDragState] = React.useState<DragState | null>(null);
  const containerRef = React.useRef<HTMLDivElement>(null);
  const itemRefs = React.useRef<Map<number, HTMLDivElement>>(new Map());
  const dragStateRef = React.useRef<DragState | null>(null);

  const isVertical = direction === 'vertical';

  // Clean up stale refs when items shrink
  const itemCount = items?.length ?? 0;
  React.useEffect(() => {
    if (itemCount === 0) return;
    for (const key of itemRefs.current.keys()) {
      if (key >= itemCount) {
        itemRefs.current.delete(key);
      }
    }
  }, [itemCount]);

  // Calculate the over index based on current drag position
  const calculateOverIndex = React.useCallback(
    (state: DragState): number => {
      const delta = isVertical
        ? state.currentY - state.startY
        : state.currentX - state.startX;

      const itemSizeWithGap = state.itemSize + gap;
      const rawOffset = delta / itemSizeWithGap;
      let newIndex = state.dragIndex + Math.round(rawOffset);

      newIndex = Math.max(0, Math.min(items.length - 1, newIndex));
      return newIndex;
    },
    [isVertical, gap, items.length]
  );

  const handlePointerDown = React.useCallback(
    (index: number, e: React.PointerEvent<HTMLDivElement>) => {
      const el = itemRefs.current.get(index);
      if (!el) return;

      el.setPointerCapture(e.pointerId);

      const rect = el.getBoundingClientRect();
      const itemSize = isVertical ? rect.height : rect.width;

      const newState: DragState = {
        dragIndex: index,
        overIndex: index,
        startY: e.clientY,
        startX: e.clientX,
        currentY: e.clientY,
        currentX: e.clientX,
        itemSize,
      };

      dragStateRef.current = newState;
      setDragState(newState);
    },
    [isVertical]
  );

  const handlePointerMove = React.useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const state = dragStateRef.current;
      if (!state) return;

      const updated: DragState = {
        ...state,
        currentY: e.clientY,
        currentX: e.clientX,
      };

      updated.overIndex = calculateOverIndex(updated);
      dragStateRef.current = updated;
      setDragState(updated);
    },
    [calculateOverIndex]
  );

  const handlePointerUp = React.useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const state = dragStateRef.current;
      if (!state) return;

      const el = itemRefs.current.get(state.dragIndex);
      if (el) el.releasePointerCapture(e.pointerId);

      const { dragIndex, overIndex } = state;

      if (dragIndex !== overIndex && onReorder) {
        const newItems = [...items];
        const [movedItem] = newItems.splice(dragIndex, 1);
        newItems.splice(overIndex, 0, movedItem);
        onReorder(newItems);
      }

      dragStateRef.current = null;
      setDragState(null);
    },
    [items, onReorder]
  );

  // Calculate the visual shift for each item during drag
  const getItemShift = (index: number): number => {
    if (!dragState) return 0;

    const { dragIndex, overIndex } = dragState;
    const itemSizeWithGap = dragState.itemSize + gap;

    if (index === dragIndex) return 0; // dragged item is handled separately

    if (dragIndex < overIndex) {
      // Dragging down/right: items between drag and over shift up/left
      if (index > dragIndex && index <= overIndex) {
        return -itemSizeWithGap;
      }
    } else if (dragIndex > overIndex) {
      // Dragging up/left: items between over and drag shift down/right
      if (index >= overIndex && index < dragIndex) {
        return itemSizeWithGap;
      }
    }

    return 0;
  };

  // Calculate the dragged item's visual offset
  const getDraggedOffset = (): React.CSSProperties => {
    if (!dragState) return {};

    const deltaX = dragState.currentX - dragState.startX;
    const deltaY = dragState.currentY - dragState.startY;

    const translateX = isVertical ? 0 : deltaX;
    const translateY = isVertical ? deltaY : 0;

    return {
      transform: `translate(${translateX}px, ${translateY}px) scale(1.02)`,
      boxShadow: '0 8px 24px rgba(0, 0, 0, 0.15)',
      zIndex: 999,
      position: 'relative' as const,
      transition: 'box-shadow 200ms ease, transform 0ms',
    };
  };

  const containerStyle: React.CSSProperties = {
    display: 'flex',
    flexDirection: isVertical ? 'column' : 'row',
    gap: `${gap}px`,
    position: 'relative',
    ...style,
  };

  const itemBaseStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
    padding: '12px',
    borderRadius: '8px',
    backgroundColor: '#fff',
    border: '1px solid #e5e7eb',
    userSelect: 'none',
    touchAction: 'none',
  };

  return (
    <div ref={containerRef} className={className} style={containerStyle}>
      {items.map((item, index) => {
        const key = getItemKey(item, index, renderKey);
        const isDragged = dragState?.dragIndex === index;
        const shift = getItemShift(index);

        const shiftTransform = isVertical
          ? `translateY(${shift}px)`
          : `translateX(${shift}px)`;

        const itemStyle: React.CSSProperties = {
          ...itemBaseStyle,
          ...(isDragged
            ? getDraggedOffset()
            : {
                transform: shift !== 0 ? shiftTransform : undefined,
                transition: 'transform 200ms ease',
              }),
        };

        // Hover effect (only when not dragging)
        const handleMouseEnter = (e: React.MouseEvent<HTMLDivElement>) => {
          if (!dragState) {
            e.currentTarget.style.backgroundColor = '#f9fafb';
          }
        };
        const handleMouseLeave = (e: React.MouseEvent<HTMLDivElement>) => {
          if (!dragState) {
            e.currentTarget.style.backgroundColor = '#fff';
          }
        };

        const primaryText = getItemText(item, primary);
        const secondaryText = getItemText(item, secondary);

        return (
          <div
            key={key}
            ref={(el) => {
              if (el) {
                itemRefs.current.set(index, el);
              } else {
                itemRefs.current.delete(index);
              }
            }}
            style={itemStyle}
            onPointerDown={(e) => handlePointerDown(index, e)}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onMouseEnter={handleMouseEnter}
            onMouseLeave={handleMouseLeave}
          >
            <GripIcon />
            <div style={{ flex: 1, minWidth: 0 }}>
              {primaryText && (
                <div
                  style={{
                    fontWeight: 500,
                    fontSize: '14px',
                    lineHeight: '20px',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {primaryText}
                </div>
              )}
              {secondaryText && (
                <div
                  style={{
                    fontSize: '12px',
                    lineHeight: '16px',
                    color: '#6b7280',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {secondaryText}
                </div>
              )}
              {!primaryText && !secondaryText && (
                <div style={{ fontSize: '14px', lineHeight: '20px' }}>
                  {String(item)}
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export default SortableList;

/**
 * SortableList Component
 *
 * A drag-to-reorder list using pointer events.
 * Items animate smoothly to their new positions.
 *
 * Every item also has a grip button for the keyboard: Space or Enter picks
 * the item up, the arrow keys (and Home/End) move it, calling `onReorder` at
 * each step, Space or Enter drops it and Escape puts it back where it
 * started. Each step is announced in a live region.
 */

import * as React from 'react';

export interface SortableListProps {
  /** Array of items to render */
  items: unknown[];
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
  onReorder?: (newItems: unknown[]) => void;
  /** Accessible name for the list */
  ariaLabel?: string;
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

function getItemKey(item: unknown, index: number, renderKey?: string): string {
  if (renderKey && item != null && typeof item === 'object' && renderKey in item) {
    return String((item as Record<string, unknown>)[renderKey]);
  }
  return String(index);
}

function getItemText(item: unknown, field?: string): string {
  if (field && item != null && typeof item === 'object' && field in item) {
    return String((item as Record<string, unknown>)[field]);
  }
  if (typeof item === 'string' || typeof item === 'number') {
    return String(item);
  }
  return '';
}

/** Move the item at `from` to `to`, returning a new array. */
function moveItem(items: unknown[], from: number, to: number): unknown[] {
  const next = [...items];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

const gripStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: '24px',
  height: '24px',
  flexShrink: 0,
  padding: 0,
  margin: 0,
  border: 'none',
  borderRadius: '4px',
  background: 'transparent',
  cursor: 'grab',
  color: 'var(--color-text-muted, gray)',
  fontSize: '16px',
  lineHeight: 1,
  userSelect: 'none',
  touchAction: 'none',
};

const visuallyHidden: React.CSSProperties = {
  position: 'absolute',
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: 'hidden',
  clip: 'rect(0, 0, 0, 0)',
  whiteSpace: 'nowrap',
  border: 0,
};

const ITEM_BACKGROUND = 'var(--color-surface, white)';
const ITEM_HOVER_BACKGROUND = 'var(--color-surface-hover, rgba(0, 0, 0, 0.03))';

interface Grabbed {
  /** Where the picked-up item is now. */
  index: number;
  /** Where it started, and the order before it moved, for Escape. */
  origin: number;
  original: unknown[];
}

export function SortableList({
  items = [],
  renderKey,
  primary,
  secondary,
  direction = 'vertical',
  gap = 8,
  onReorder,
  ariaLabel,
  className,
  style,
}: SortableListProps): React.ReactElement {
  const [dragState, setDragState] = React.useState<DragState | null>(null);
  const containerRef = React.useRef<HTMLDivElement>(null);
  const itemRefs = React.useRef<Map<number, HTMLDivElement>>(new Map());
  const dragStateRef = React.useRef<DragState | null>(null);
  const [grabbed, setGrabbed] = React.useState<Grabbed | null>(null);
  const [announcement, setAnnouncement] = React.useState('');
  const gripRefs = React.useRef<Map<number, HTMLButtonElement>>(new Map());
  const pendingFocus = React.useRef<number | null>(null);
  const instructionsId = React.useId();

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

      el.setPointerCapture?.(e.pointerId);

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

  const endDrag = React.useCallback(
    (e: React.PointerEvent<HTMLDivElement>, commit: boolean) => {
      const state = dragStateRef.current;
      if (!state) return;
      dragStateRef.current = null;

      const el = itemRefs.current.get(state.dragIndex);
      try {
        if (el?.hasPointerCapture?.(e.pointerId)) el.releasePointerCapture(e.pointerId);
      } catch {
        // The capture is already gone.
      }

      const { dragIndex, overIndex } = state;
      if (commit && dragIndex !== overIndex && onReorder) {
        onReorder(moveItem(items, dragIndex, overIndex));
      }
      setDragState(null);
    },
    [items, onReorder]
  );

  const handlePointerUp = React.useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => endDrag(e, true),
    [endDrag]
  );

  // A drag the browser takes away (a scroll gesture, a lost capture) ends
  // without reordering, rather than leaving the item floating mid-list.
  const handlePointerCancel = React.useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => endDrag(e, false),
    [endDrag]
  );

  // After a keyboard move the list re-renders in its new order, and the grip
  // that had focus may now belong to another item: focus follows the moved one.
  React.useEffect(() => {
    const index = pendingFocus.current;
    if (index === null) return;
    pendingFocus.current = null;
    gripRefs.current.get(index)?.focus();
  }, [items]);

  // The list shrank under a picked-up item (a parent replaced it): let go.
  React.useEffect(() => {
    if (grabbed && grabbed.index >= items.length) setGrabbed(null);
  }, [grabbed, items.length]);

  const describe = (item: unknown, index: number): string =>
    getItemText(item, primary) || getItemText(item) || `Item ${index + 1}`;

  const handleGripKeyDown = (index: number, e: React.KeyboardEvent<HTMLButtonElement>) => {
    const name = describe(items[index], index);
    const back = isVertical ? 'ArrowUp' : 'ArrowLeft';
    const forward = isVertical ? 'ArrowDown' : 'ArrowRight';

    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      if (grabbed) {
        setGrabbed(null);
        setAnnouncement(`${name} dropped at position ${index + 1} of ${items.length}.`);
      } else {
        setGrabbed({ index, origin: index, original: items });
        setAnnouncement(`${name} picked up at position ${index + 1} of ${items.length}.`);
      }
      return;
    }

    if (e.key === 'Escape' && grabbed) {
      e.preventDefault();
      e.stopPropagation();
      if (grabbed.index !== grabbed.origin && onReorder) {
        pendingFocus.current = grabbed.origin;
        onReorder(grabbed.original);
      }
      setAnnouncement(`Reorder cancelled. ${name} is back at position ${grabbed.origin + 1}.`);
      setGrabbed(null);
      return;
    }

    if (!grabbed) return;
    if (e.key !== back && e.key !== forward && e.key !== 'Home' && e.key !== 'End') return;
    e.preventDefault();
    const target =
      e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : index + (e.key === back ? -1 : 1);
    if (target < 0 || target >= items.length || target === index || !onReorder) return;
    pendingFocus.current = target;
    setGrabbed({ ...grabbed, index: target });
    onReorder(moveItem(items, index, target));
    setAnnouncement(`${name} moved to position ${target + 1} of ${items.length}.`);
  };

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

  // Theme tokens, so a dark theme does not get white cards under light text.
  const itemBaseStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
    padding: '12px',
    borderRadius: '8px',
    backgroundColor: ITEM_BACKGROUND,
    color: 'var(--color-text, inherit)',
    border: '1px solid var(--color-border, rgba(0, 0, 0, 0.1))',
    userSelect: 'none',
    touchAction: 'none',
  };

  return (
    <div ref={containerRef} className={className} style={containerStyle} role="list" aria-label={ariaLabel}>
      <span id={instructionsId} style={visuallyHidden}>
        Press Space or Enter to pick the item up, the arrow keys to move it, Space or Enter to drop it, and Escape
        to cancel.
      </span>
      <span style={visuallyHidden} aria-live="assertive" aria-atomic="true">
        {announcement}
      </span>
      {items.map((item, index) => {
        const key = getItemKey(item, index, renderKey);
        const isDragged = dragState?.dragIndex === index;
        const isGrabbed = grabbed?.index === index;
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
          ...(isGrabbed ? { boxShadow: '0 0 0 2px var(--color-primary-500, currentColor)' } : null),
        };

        // Hover effect (only when not dragging)
        const handleMouseEnter = (e: React.MouseEvent<HTMLDivElement>) => {
          if (!dragState) {
            e.currentTarget.style.backgroundColor = ITEM_HOVER_BACKGROUND;
          }
        };
        const handleMouseLeave = (e: React.MouseEvent<HTMLDivElement>) => {
          if (!dragState) {
            e.currentTarget.style.backgroundColor = ITEM_BACKGROUND;
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
            role="listitem"
            style={itemStyle}
            onPointerDown={(e) => handlePointerDown(index, e)}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerCancel}
            onLostPointerCapture={handlePointerCancel}
            onMouseEnter={handleMouseEnter}
            onMouseLeave={handleMouseLeave}
          >
            <button
              type="button"
              ref={(el) => {
                if (el) gripRefs.current.set(index, el);
                else gripRefs.current.delete(index);
              }}
              style={gripStyle}
              aria-label={`Reorder ${describe(item, index)}`}
              aria-describedby={instructionsId}
              aria-pressed={isGrabbed}
              disabled={!onReorder}
              onKeyDown={(e) => handleGripKeyDown(index, e)}
              onBlur={() => {
                if (isGrabbed && pendingFocus.current === null) setGrabbed(null);
              }}
            >
              <span aria-hidden="true">⠿</span>
            </button>
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
                    color: 'var(--color-text-muted, gray)',
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

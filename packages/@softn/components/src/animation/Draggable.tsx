/**
 * Draggable Component
 *
 * Makes its children draggable via pointer events.
 * Uses document-level event listeners for reliable drag tracking.
 * Supports axis locking, grid snapping, and bounds constraints.
 */

import * as React from 'react';

export interface DragPosition {
  x: number;
  y: number;
}

export interface DragBounds {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface DraggableProps {
  /** Constrain drag axis */
  axis?: 'both' | 'x' | 'y';
  /** Constrain drag to parent element or fixed bounds */
  bounds?: 'parent' | DragBounds;
  /** Disable dragging */
  disabled?: boolean;
  /** Snap to grid interval in pixels */
  grid?: number;
  /** Callback when dragging starts */
  onDragStart?: (pos: DragPosition) => void;
  /** Callback during dragging */
  onDrag?: (pos: DragPosition) => void;
  /** Callback when dragging ends */
  onDragEnd?: (pos: DragPosition) => void;
  /** Content to make draggable */
  children: React.ReactNode;
  /** Additional CSS class */
  className?: string;
  /** Inline styles */
  style?: React.CSSProperties;
}

function snapToGrid(value: number, gridSize: number): number {
  return Math.round(value / gridSize) * gridSize;
}

function clampVal(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function Draggable({
  axis = 'both',
  bounds,
  disabled = false,
  grid,
  onDragStart,
  onDrag,
  onDragEnd,
  children,
  className,
  style,
}: DraggableProps): React.ReactElement {
  const elementRef = React.useRef<HTMLDivElement>(null);
  const positionRef = React.useRef<DragPosition>({ x: 0, y: 0 });
  const startPointerRef = React.useRef<DragPosition>({ x: 0, y: 0 });
  const startPositionRef = React.useRef<DragPosition>({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = React.useState(false);
  const activeListenersRef = React.useRef<{ move: (e: PointerEvent) => void; up: () => void } | null>(null);

  // Clean up document listeners on unmount
  React.useEffect(() => {
    return () => {
      if (activeListenersRef.current) {
        document.removeEventListener('pointermove', activeListenersRef.current.move);
        document.removeEventListener('pointerup', activeListenersRef.current.up);
        activeListenersRef.current = null;
      }
    };
  }, []);

  // Store callbacks in refs to avoid stale closures in document listeners
  const axisRef = React.useRef(axis);
  const boundsRef = React.useRef(bounds);
  const gridRef = React.useRef(grid);
  const onDragRef = React.useRef(onDrag);
  const onDragEndRef = React.useRef(onDragEnd);

  React.useEffect(() => { axisRef.current = axis; }, [axis]);
  React.useEffect(() => { boundsRef.current = bounds; }, [bounds]);
  React.useEffect(() => { gridRef.current = grid; }, [grid]);
  React.useEffect(() => { onDragRef.current = onDrag; }, [onDrag]);
  React.useEffect(() => { onDragEndRef.current = onDragEnd; }, [onDragEnd]);

  const applyTransform = React.useCallback((pos: DragPosition) => {
    if (elementRef.current) {
      elementRef.current.style.transform = `translate(${pos.x}px, ${pos.y}px)`;
    }
  }, []);

  const getBounds = React.useCallback((): DragBounds | null => {
    const b = boundsRef.current;
    if (!b) return null;

    if (b === 'parent') {
      const el = elementRef.current;
      if (!el || !el.parentElement) return null;

      const parentRect = el.parentElement.getBoundingClientRect();
      const elRect = el.getBoundingClientRect();
      const currentPos = positionRef.current;

      const elBaseLeft = elRect.left - currentPos.x;
      const elBaseTop = elRect.top - currentPos.y;

      return {
        left: parentRect.left - elBaseLeft,
        top: parentRect.top - elBaseTop,
        right: parentRect.right - (elBaseLeft + elRect.width),
        bottom: parentRect.bottom - (elBaseTop + elRect.height),
      };
    }

    return b;
  }, []);

  const constrainPosition = React.useCallback(
    (pos: DragPosition): DragPosition => {
      let { x, y } = pos;
      const currentAxis = axisRef.current;
      const currentGrid = gridRef.current;

      if (currentAxis === 'x') y = 0;
      if (currentAxis === 'y') x = 0;

      if (currentGrid) {
        x = snapToGrid(x, currentGrid);
        y = snapToGrid(y, currentGrid);
      }

      const b = getBounds();
      if (b) {
        x = clampVal(x, b.left, b.right);
        y = clampVal(y, b.top, b.bottom);
      }

      return { x, y };
    },
    [getBounds]
  );

  const handlePointerDown = React.useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (disabled) return;
      e.preventDefault();
      e.stopPropagation();

      setIsDragging(true);

      startPointerRef.current = { x: e.clientX, y: e.clientY };
      startPositionRef.current = { ...positionRef.current };

      onDragStart?.(constrainPosition(positionRef.current));

      // Use document-level listeners for reliable tracking
      const handleMove = (ev: PointerEvent) => {
        ev.preventDefault();

        const dx = ev.clientX - startPointerRef.current.x;
        const dy = ev.clientY - startPointerRef.current.y;

        const rawPos: DragPosition = {
          x: startPositionRef.current.x + dx,
          y: startPositionRef.current.y + dy,
        };

        const constrained = constrainPosition(rawPos);
        positionRef.current = constrained;
        applyTransform(constrained);
        onDragRef.current?.(constrained);
      };

      const handleUp = () => {
        document.removeEventListener('pointermove', handleMove);
        document.removeEventListener('pointerup', handleUp);
        activeListenersRef.current = null;
        setIsDragging(false);
        onDragEndRef.current?.(positionRef.current);
      };

      document.addEventListener('pointermove', handleMove);
      document.addEventListener('pointerup', handleUp);
      activeListenersRef.current = { move: handleMove, up: handleUp };
    },
    [disabled, constrainPosition, applyTransform, onDragStart]
  );

  const computedStyle: React.CSSProperties = {
    touchAction: 'none',
    cursor: disabled ? 'default' : isDragging ? 'grabbing' : 'grab',
    userSelect: isDragging ? 'none' : undefined,
    ...style,
  };

  return (
    <div
      ref={elementRef}
      className={className}
      style={computedStyle}
      onPointerDown={handlePointerDown}
    >
      {children}
    </div>
  );
}

export default Draggable;

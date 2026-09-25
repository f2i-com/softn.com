/**
 * Split Component
 *
 * A resizable split pane layout component.
 */

import React, { useState, useCallback, useRef, useEffect } from 'react';
import { cssPaint } from '../utils/egress';

export interface SplitProps {
  /** First pane content */
  children: [React.ReactNode, React.ReactNode];
  /** Direction of the split */
  direction?: 'horizontal' | 'vertical';
  /** Initial size of the first pane (percentage or pixels) */
  initialSize?: string | number;
  /** Minimum size of first pane in pixels */
  minSize?: number;
  /** Maximum size of first pane in pixels */
  maxSize?: number;
  /** Width of the gutter/divider */
  gutterSize?: number;
  /** Color of the gutter */
  gutterColor?: string;
  /** Callback when size changes */
  onResize?: (size: number) => void;
  /** Accessible name for the divider (default "Resize panes") */
  ariaLabel?: string;
  /** Additional CSS class */
  className?: string;
  /** Inline styles */
  style?: React.CSSProperties;
}

export function Split({
  children,
  direction = 'horizontal',
  initialSize = '50%',
  minSize = 100,
  maxSize,
  gutterSize = 4,
  gutterColor = 'var(--color-border, rgba(255, 255, 255, 0.08))',
  onResize,
  ariaLabel = 'Resize panes',
  className,
  style,
}: SplitProps): React.ReactElement {
  const containerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<number | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const startPosRef = useRef<number>(0);
  const startSizeRef = useRef<number>(0);

  // Calculate initial size in pixels
  useEffect(() => {
    if (containerRef.current && size === null) {
      const containerSize =
        direction === 'horizontal'
          ? containerRef.current.offsetWidth
          : containerRef.current.offsetHeight;

      if (typeof initialSize === 'string' && initialSize.endsWith('%')) {
        const percentage = parseFloat(initialSize) / 100;
        setSize(containerSize * percentage);
      } else {
        setSize(typeof initialSize === 'number' ? initialSize : parseInt(initialSize, 10));
      }
    }
  }, [initialSize, direction, size]);

  const containerSize = () =>
    containerRef.current
      ? direction === 'horizontal'
        ? containerRef.current.offsetWidth
        : containerRef.current.offsetHeight
      : 0;

  /** The largest the first pane may be: `maxSize`, and room for the second. */
  const upperBound = () => {
    const total = containerSize();
    let bound = total > 0 ? total - minSize - gutterSize : Number.POSITIVE_INFINITY;
    if (maxSize !== undefined) bound = Math.min(bound, maxSize);
    return Math.max(minSize, bound);
  };

  const applySize = (next: number) => {
    const clamped = Math.min(upperBound(), Math.max(minSize, next));
    setSize(clamped);
    onResize?.(clamped);
  };
  const applySizeRef = useRef(applySize);
  applySizeRef.current = applySize;

  // Pointer events, so touch and pen drag the divider as a mouse does, with
  // the pointer captured so the drag survives leaving the gutter.
  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.button !== undefined && e.button !== 0) return;
      e.preventDefault();
      setIsDragging(true);
      startPosRef.current = direction === 'horizontal' ? e.clientX : e.clientY;
      startSizeRef.current = size ?? 0;
      try {
        e.currentTarget.setPointerCapture?.(e.pointerId);
      } catch {
        // A synthetic pointer has nothing to capture.
      }
    },
    [direction, size]
  );

  useEffect(() => {
    if (!isDragging) return;

    const handleMove = (e: PointerEvent | MouseEvent) => {
      const currentPos = direction === 'horizontal' ? e.clientX : e.clientY;
      applySizeRef.current(startSizeRef.current + currentPos - startPosRef.current);
    };
    const handleUp = () => setIsDragging(false);

    document.addEventListener('pointermove', handleMove);
    document.addEventListener('pointerup', handleUp);
    document.addEventListener('pointercancel', handleUp);

    return () => {
      document.removeEventListener('pointermove', handleMove);
      document.removeEventListener('pointerup', handleUp);
      document.removeEventListener('pointercancel', handleUp);
    };
  }, [isDragging, direction]);

  // The divider is a focusable separator: arrow keys move it (Shift for a
  // larger step), Home and End take it to its limits.
  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 50 : 10;
    const current = size ?? 0;
    const back = direction === 'horizontal' ? 'ArrowLeft' : 'ArrowUp';
    const forward = direction === 'horizontal' ? 'ArrowRight' : 'ArrowDown';
    if (e.key === back) applySize(current - step);
    else if (e.key === forward) applySize(current + step);
    else if (e.key === 'Home') applySize(minSize);
    else if (e.key === 'End') applySize(upperBound());
    else return;
    e.preventDefault();
  };

  const isHorizontal = direction === 'horizontal';

  const containerStyle: React.CSSProperties = {
    display: 'flex',
    flexDirection: isHorizontal ? 'row' : 'column',
    width: '100%',
    height: '100%',
    overflow: 'hidden',
    ...style,
  };

  const firstPaneStyle: React.CSSProperties = {
    [isHorizontal ? 'width' : 'height']: size !== null ? `${size}px` : initialSize,
    [isHorizontal ? 'minWidth' : 'minHeight']: `${minSize}px`,
    overflow: 'auto',
    flexShrink: 0,
  };

  const gutterStyle: React.CSSProperties = {
    [isHorizontal ? 'width' : 'height']: `${gutterSize}px`,
    // A colour, never an image: `background` would fetch a `url()` here.
    background: cssPaint(gutterColor) ?? 'var(--color-border, rgba(255, 255, 255, 0.08))',
    cursor: isHorizontal ? 'col-resize' : 'row-resize',
    flexShrink: 0,
    touchAction: 'none',
    transition: isDragging ? 'none' : 'background 0.2s',
  };

  const gutterActiveStyle: React.CSSProperties = {
    ...gutterStyle,
    background: 'var(--color-text-muted, #a1a1aa)',
  };

  const secondPaneStyle: React.CSSProperties = {
    flex: 1,
    overflow: 'auto',
    minWidth: isHorizontal ? `${minSize}px` : undefined,
    minHeight: !isHorizontal ? `${minSize}px` : undefined,
  };

  const [firstChild, secondChild] = React.Children.toArray(children);
  const bound = upperBound();

  return (
    <div ref={containerRef} className={className} style={containerStyle}>
      <div style={firstPaneStyle}>{firstChild}</div>
      <div
        style={isDragging ? gutterActiveStyle : gutterStyle}
        onPointerDown={handlePointerDown}
        onKeyDown={handleKeyDown}
        role="separator"
        tabIndex={0}
        aria-label={ariaLabel}
        aria-orientation={isHorizontal ? 'vertical' : 'horizontal'}
        aria-valuenow={size !== null ? Math.round(size) : undefined}
        aria-valuemin={minSize}
        aria-valuemax={Number.isFinite(bound) ? Math.round(bound) : undefined}
      />
      <div style={secondPaneStyle}>{secondChild}</div>
    </div>
  );
}

export default Split;

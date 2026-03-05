/**
 * Split Component
 *
 * A resizable split pane layout component.
 */

import React, { useState, useCallback, useRef, useEffect } from 'react';

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

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      setIsDragging(true);
      startPosRef.current = direction === 'horizontal' ? e.clientX : e.clientY;
      startSizeRef.current = size ?? 0;
    },
    [direction, size]
  );

  useEffect(() => {
    if (!isDragging) return;

    const handleMouseMove = (e: MouseEvent) => {
      if (!containerRef.current) return;

      const containerSize =
        direction === 'horizontal'
          ? containerRef.current.offsetWidth
          : containerRef.current.offsetHeight;

      const currentPos = direction === 'horizontal' ? e.clientX : e.clientY;
      const delta = currentPos - startPosRef.current;
      let newSize = startSizeRef.current + delta;

      // Apply constraints
      newSize = Math.max(minSize, newSize);
      if (maxSize !== undefined) {
        newSize = Math.min(maxSize, newSize);
      }
      newSize = Math.min(containerSize - minSize - gutterSize, newSize);

      setSize(newSize);
      onResize?.(newSize);
    };

    const handleMouseUp = () => {
      setIsDragging(false);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDragging, direction, minSize, maxSize, gutterSize, onResize]);

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
    background: gutterColor,
    cursor: isHorizontal ? 'col-resize' : 'row-resize',
    flexShrink: 0,
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

  const [firstChild, secondChild] = children;

  return (
    <div ref={containerRef} className={className} style={containerStyle}>
      <div style={firstPaneStyle}>{firstChild}</div>
      <div
        style={isDragging ? gutterActiveStyle : gutterStyle}
        onMouseDown={handleMouseDown}
        role="separator"
        aria-orientation={isHorizontal ? 'vertical' : 'horizontal'}
      />
      <div style={secondPaneStyle}>{secondChild}</div>
    </div>
  );
}

export default Split;

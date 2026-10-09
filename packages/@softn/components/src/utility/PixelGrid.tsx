/**
 * PixelGrid Component
 *
 * A generic grid-based renderer that displays colored cells at grid positions.
 * No knowledge of what the cells represent — useful for games, heatmaps,
 * pixel art, Game of Life, and other grid visualizations.
 *
 * The board is `cols * cellSize` wide when there is room for it. Where there
 * is not (a phone, a narrow column), it is drawn at the width it is given,
 * every cell smaller by the same amount. It used to keep its size and be cut
 * off by whatever held it: a ten-column game showed about seven.
 */

import React from 'react';
import { cssPaint } from '../utils/egress';

export interface PixelGridItem {
  x: number;
  y: number;
  color: string;
  borderRadius?: string;
  opacity?: number;
}

export interface PixelGridProps {
  /** Number of rows (default 20) */
  rows?: number;
  /** Number of columns (default 20) */
  cols?: number;
  /** Pixel size per cell (default 20), at most: the board fits the width it is given */
  cellSize?: number;
  /** Cells to render */
  items?: PixelGridItem[];
  /** Board background color */
  background?: string;
  /** Show subtle grid lines (default true) */
  showGrid?: boolean;
  /** Grid line color */
  gridColor?: string;
  /** Centered overlay text */
  overlay?: string;
  /** Style for overlay */
  overlayStyle?: React.CSSProperties;
  /** Outer container style */
  style?: React.CSSProperties;
  /** CSS class name */
  className?: string;
}

export function PixelGrid({
  rows = 20,
  cols = 20,
  cellSize = 20,
  items = [],
  background = '#1a1a2e',
  showGrid = true,
  gridColor,
  overlay,
  overlayStyle,
  style,
  className,
}: PixelGridProps) {
  const width = cols * cellSize;
  // The width the board was given, once it has been laid out with less than
  // it asked for. Its own `width` and `maxWidth: 100%` do the shrinking; this
  // only follows it, so the height and the cells can be made to match.
  const rootRef = React.useRef<HTMLDivElement>(null);
  const [given, setGiven] = React.useState<number | null>(null);
  React.useEffect(() => {
    const element = rootRef.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver((entries) => {
      const measured = entries[0]?.contentRect.width ?? 0;
      setGiven(measured > 0 && measured < width - 0.5 ? measured : null);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [width]);
  const scale = given === null || width <= 0 ? 1 : given / width;
  // To a thousandth of a pixel: 24 * 0.65 is 15.600000000000001 otherwise.
  const cell = Math.round(cellSize * scale * 1000) / 1000;
  const height = rows * cell;

  // Interpolated into `backgroundImage`, so only a colour may come through.
  const resolvedGridColor = cssPaint(gridColor) || 'rgba(255,255,255,0.06)';

  const gridBackground = showGrid
    ? `repeating-linear-gradient(0deg, transparent, transparent ${cell - 1}px, ${resolvedGridColor} ${cell - 1}px, ${resolvedGridColor} ${cell}px), repeating-linear-gradient(90deg, transparent, transparent ${cell - 1}px, ${resolvedGridColor} ${cell - 1}px, ${resolvedGridColor} ${cell}px)`
    : undefined;

  return (
    <div
      ref={rootRef}
      className={className}
      style={{
        position: 'relative',
        width,
        maxWidth: '100%',
        height,
        backgroundColor: background,
        backgroundImage: gridBackground,
        overflow: 'hidden',
        borderRadius: 8,
        ...style,
      }}
    >
      {items.map((item, i) => (
        <div
          key={`${item.x}-${item.y}-${i}`}
          style={{
            position: 'absolute',
            left: item.x * cell,
            top: item.y * cell,
            width: cell,
            height: cell,
            backgroundColor: item.color,
            borderRadius: item.borderRadius || undefined,
            opacity: item.opacity ?? 1,
            transition: 'left 0.05s linear, top 0.05s linear',
          }}
        />
      ))}

      {overlay && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: 'rgba(0,0,0,0.6)',
            color: '#fff',
            // With the board, so the words that fitted it still do.
            fontSize: Math.max(10, 28 * scale),
            fontWeight: 700,
            letterSpacing: 2 * scale,
            textTransform: 'uppercase',
            ...overlayStyle,
          }}
        >
          {overlay}
        </div>
      )}
    </div>
  );
}

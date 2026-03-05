/**
 * PixelGrid Component
 *
 * A generic grid-based renderer that displays colored cells at grid positions.
 * No knowledge of what the cells represent — useful for games, heatmaps,
 * pixel art, Game of Life, and other grid visualizations.
 */

import React from 'react';

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
  /** Pixel size per cell (default 20) */
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
  const height = rows * cellSize;

  const resolvedGridColor = gridColor || 'rgba(255,255,255,0.06)';

  const gridBackground = showGrid
    ? `repeating-linear-gradient(0deg, transparent, transparent ${cellSize - 1}px, ${resolvedGridColor} ${cellSize - 1}px, ${resolvedGridColor} ${cellSize}px), repeating-linear-gradient(90deg, transparent, transparent ${cellSize - 1}px, ${resolvedGridColor} ${cellSize - 1}px, ${resolvedGridColor} ${cellSize}px)`
    : undefined;

  return (
    <div
      className={className}
      style={{
        position: 'relative',
        width,
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
            left: item.x * cellSize,
            top: item.y * cellSize,
            width: cellSize,
            height: cellSize,
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
            fontSize: 28,
            fontWeight: 700,
            letterSpacing: 2,
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

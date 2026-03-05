/**
 * Sprite Component
 *
 * CSS-based sprite sheet renderer with internal animation loop.
 * Uses requestAnimationFrame + direct DOM mutation for zero-rerender animation.
 */

import * as React from 'react';

export interface SpriteProps {
  /** URL of the sprite sheet image */
  src: string;
  /** Width of a single frame in pixels */
  frameWidth?: number;
  /** Height of a single frame in pixels */
  frameHeight?: number;
  /** Number of columns in the sprite sheet (frames per row) */
  columns?: number;
  /** Number of rows in the sprite sheet (direction rows) */
  rows?: number;
  /** Row index for direction (0=down, 1=left, 2=right, 3=up) */
  row?: number;
  /** Column offset for color variant (variantIndex × columns) */
  colOffset?: number;
  /** Whether the animation is playing */
  playing?: boolean;
  /** Animation frames per second */
  fps?: number;
  /** Display scale multiplier */
  scale?: number;
  /** CSS z-index */
  zIndex?: number;
  /** Additional inline styles */
  style?: React.CSSProperties;
  /** Additional CSS class */
  className?: string;
  /** Click handler */
  onClick?: () => void;
}

export function Sprite({
  src,
  frameWidth = 32,
  frameHeight = 32,
  columns = 8,
  row = 0,
  colOffset = 0,
  playing = true,
  fps = 8,
  scale = 2,
  zIndex,
  style,
  className,
  onClick,
}: SpriteProps) {
  const divRef = React.useRef<HTMLDivElement>(null);
  const frameRef = React.useRef(0);
  const rafRef = React.useRef<number>(0);

  // Track row/colOffset in refs so the animation loop always reads fresh values
  // without restarting (which would reset the frame counter and cause hitches)
  const rowRef = React.useRef(row);
  const colOffsetRef = React.useRef(colOffset);
  const columnsRef = React.useRef(columns);
  const fpsRef = React.useRef(fps);

  React.useEffect(() => { rowRef.current = row; }, [row]);
  React.useEffect(() => { colOffsetRef.current = colOffset; }, [colOffset]);
  React.useEffect(() => { columnsRef.current = columns; }, [columns]);
  React.useEffect(() => { fpsRef.current = fps; }, [fps]);

  // Update background position immediately when row/colOffset change (direction switch)
  React.useEffect(() => {
    if (divRef.current) {
      const x = (colOffset + frameRef.current) * frameWidth;
      const y = row * frameHeight;
      divRef.current.style.backgroundPosition = `-${x}px -${y}px`;
    }
  }, [row, colOffset, frameWidth, frameHeight]);

  // Animation loop — mutates DOM directly, no React re-renders.
  // Uses global time to compute frame index so ALL sprites with the same fps
  // stay perfectly in sync (body, eyes, clothes, hair move together).
  React.useEffect(() => {
    if (!playing) {
      // Show idle frame when paused
      if (divRef.current) {
        const x = (colOffsetRef.current) * frameWidth;
        const y = rowRef.current * frameHeight;
        divRef.current.style.backgroundPosition = `-${x}px -${y}px`;
      }
      frameRef.current = 0;
      return;
    }

    const animate = (time: number) => {
      const interval = 1000 / fpsRef.current;
      // Global time-based frame: all sprites with same fps compute same frame
      const frame = Math.floor(time / interval) % columnsRef.current;

      if (frame !== frameRef.current) {
        frameRef.current = frame;
        if (divRef.current) {
          const x = (colOffsetRef.current + frame) * frameWidth;
          const y = rowRef.current * frameHeight;
          divRef.current.style.backgroundPosition = `-${x}px -${y}px`;
        }
      }

      rafRef.current = requestAnimationFrame(animate);
    };

    rafRef.current = requestAnimationFrame(animate);

    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [playing, frameWidth, frameHeight]);

  const initialX = colOffset * frameWidth;
  const initialY = row * frameHeight;

  const computedStyle: React.CSSProperties = {
    position: 'absolute',
    width: frameWidth,
    height: frameHeight,
    backgroundImage: `url(${src})`,
    backgroundPosition: `-${initialX}px -${initialY}px`,
    backgroundRepeat: 'no-repeat',
    imageRendering: 'pixelated',
    transform: `scale(${scale})`,
    transformOrigin: 'top left',
    pointerEvents: onClick ? 'auto' : 'none',
    cursor: onClick ? 'pointer' : undefined,
    zIndex,
    ...style,
  };

  return (
    <div
      ref={divRef}
      className={className}
      style={computedStyle}
      onClick={onClick}
    />
  );
}

export default Sprite;

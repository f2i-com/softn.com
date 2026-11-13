/**
 * Sprite Component
 *
 * CSS-based sprite sheet renderer with internal animation loop.
 * Uses requestAnimationFrame + direct DOM mutation for zero-rerender animation.
 *
 * A sprite is one frame of a sheet, shown in a box of the frame's size. Left
 * alone it plays the frames of its `row`, left to right, again and again.
 * `frames` names the frames to play instead, `loop={false}` plays them once
 * and says so with `@end`, `x` and `y` put the sprite at a place in its
 * container, and `flipX` turns it to face the other way.
 */

import * as React from 'react';
import { isSafeUrl } from '@softn/core';
import { usePrefersReducedMotion } from '../utils/motion';
import { useBundleSrc } from '../utils/bundle-src';

export interface SpriteProps {
  /**
   * URL of the sprite sheet image. A path with no scheme
   * (`"assets/hero.png"`) names a file in the app's own bundle, so logic can
   * name a sheet without `asset()`; a path the bundle does not have is
   * loaded as written.
   */
  src: string;
  /** Width of a single frame in pixels */
  frameWidth?: number;
  /** Height of a single frame in pixels */
  frameHeight?: number;
  /** Number of columns in the sprite sheet (frames per row) */
  columns?: number;
  /** Number of rows in the sprite sheet (direction rows); `row` is kept within them */
  rows?: number;
  /**
   * Row index into the sheet. Which direction each row faces is the sheet's
   * business, not this component's — the packs differ, and a stated convention
   * here reads as a promise. Check the sheet.
   */
  row?: number;
  /** Column offset for color variant (variantIndex × columns) */
  colOffset?: number;
  /**
   * The frames to play, in order, instead of the whole row: `frames={[4, 5, 6]}`.
   * A frame is counted along the sheet from the first frame of `row`, left to
   * right and then down, so with `columns={8}` frame 9 is the second frame
   * of the row below. A list of one frame holds that frame.
   */
  frames?: number[];
  /**
   * Whether the frames start again after the last (default true). With
   * `loop={false}` they play once from the first, stay on the last, and
   * `@end` is called: a jump, an explosion. It plays again when `frames`
   * changes, or when `playing` is turned off and on.
   */
  loop?: boolean;
  /** Whether the animation is playing */
  playing?: boolean;
  /** Animation frames per second */
  fps?: number;
  /** Display scale multiplier */
  scale?: number;
  /**
   * Where the sprite's left edge is, in pixels from the left of its
   * container (the nearest positioned element: give the playing field
   * `position: relative`). Moved by a transform, which the browser does
   * without laying the page out again.
   */
  x?: number;
  /** Where the sprite's top edge is, in pixels from the top of its container */
  y?: number;
  /** Mirror the sprite left to right, in place: a walk drawn facing right, shown facing left */
  flipX?: boolean;
  /** CSS z-index */
  zIndex?: number;
  /** Additional inline styles */
  style?: React.CSSProperties;
  /** Additional CSS class */
  className?: string;
  /** Click handler; the sprite becomes a button, operable with Enter and Space */
  onClick?: () => void;
  /**
   * Called when a `loop={false}` run reaches its last frame. Where the
   * person has asked for reduced motion the frames are not played: the last
   * is shown and this is called at once.
   */
  onEnd?: () => void;
  /** Accessible name; a clickable sprite without one is called "Sprite" */
  ariaLabel?: string;
}

/** The frames a sprite was given, as whole numbers from zero; null when it was given none to play. */
function framesToPlay(frames: unknown): number[] | null {
  if (!Array.isArray(frames)) return null;
  const list = frames.filter((frame): frame is number => typeof frame === 'number' && Number.isFinite(frame) && frame >= 0).map(Math.floor);
  return list.length > 0 ? list : null;
}

export function Sprite({
  src,
  frameWidth = 32,
  frameHeight = 32,
  columns: rawColumns = 8,
  rows,
  row: rawRow = 0,
  colOffset = 0,
  frames,
  loop = true,
  playing = true,
  fps = 8,
  scale = 2,
  x,
  y,
  flipX = false,
  zIndex,
  style,
  className,
  onClick,
  onEnd,
  ariaLabel,
}: SpriteProps) {
  // Bound values arrive as anything: a column count of zero made every frame
  // NaN, and a row past the sheet showed an empty frame.
  const columns = Number.isFinite(rawColumns) && rawColumns >= 1 ? Math.floor(rawColumns) : 1;
  const lastRow = typeof rows === 'number' && Number.isFinite(rows) && rows >= 1 ? Math.floor(rows) - 1 : Infinity;
  const row = Math.min(lastRow, Math.max(0, Number.isFinite(rawRow) ? Math.floor(rawRow) : 0));
  // A sheet named by its path in the bundle is the bundle's file: a game
  // keeps its sprites in logic, which has no `asset()` to turn a path into
  // one, and the path as written was asked of the page's own address.
  const sheet = useBundleSrc(src);
  // A page hands over a new list at every draw: what it says is what is
  // played, and the same frames again do not start the run over.
  const framesText = Array.isArray(frames) ? frames.join(',') : '';
  // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed by what `frames` says
  const sequence = React.useMemo(() => framesToPlay(frames), [framesText]);
  // Reduced motion holds the idle frame, as a paused sprite does.
  const reducedMotion = usePrefersReducedMotion();
  const animating = playing && !reducedMotion && Number.isFinite(fps) && fps > 0;
  // A run that plays once and cannot be played is over as soon as it is asked for.
  const endsAtOnce = playing && !loop && !animating;
  const divRef = React.useRef<HTMLDivElement>(null);
  /** The frame shown, counted along the sheet from the first frame of `row`. */
  const frameRef = React.useRef(sequence ? sequence[0] : 0);
  const rafRef = React.useRef<number>(0);

  // Track row/colOffset in refs so the animation loop always reads fresh values
  // without restarting (which would reset the frame counter and cause hitches)
  const rowRef = React.useRef(row);
  const colOffsetRef = React.useRef(colOffset);
  const columnsRef = React.useRef(columns);
  const fpsRef = React.useRef(fps);
  const onEndRef = React.useRef(onEnd);
  onEndRef.current = onEnd;

  React.useEffect(() => { rowRef.current = row; }, [row]);
  React.useEffect(() => { colOffsetRef.current = colOffset; }, [colOffset]);
  React.useEffect(() => { columnsRef.current = columns; }, [columns]);
  React.useEffect(() => { fpsRef.current = fps; }, [fps]);

  /** Show `frame`: frames past the end of the row are on the rows below it. */
  const show = React.useCallback(
    (frame: number) => {
      frameRef.current = frame;
      if (!divRef.current) return;
      const across = frame % columnsRef.current;
      const down = Math.floor(frame / columnsRef.current);
      const left = (colOffsetRef.current + across) * frameWidth;
      const top = (rowRef.current + down) * frameHeight;
      divRef.current.style.backgroundPosition = `-${left}px -${top}px`;
    },
    [frameWidth, frameHeight]
  );

  // Update background position immediately when row/colOffset change (direction switch)
  React.useEffect(() => {
    rowRef.current = row;
    colOffsetRef.current = colOffset;
    columnsRef.current = columns;
    show(frameRef.current);
  }, [row, colOffset, columns, show]);

  // Animation loop — mutates DOM directly, no React re-renders.
  // Uses global time to compute frame index so ALL sprites with the same fps
  // stay perfectly in sync (body, eyes, clothes, hair move together).
  React.useEffect(() => {
    const first = sequence ? sequence[0] : 0;
    const last = sequence ? sequence[sequence.length - 1] : Math.max(0, columnsRef.current - 1);
    if (!animating) {
      // Show the idle frame when paused: the first, or the last of a run
      // that plays once and has nothing left to play.
      show(endsAtOnce ? last : first);
      if (endsAtOnce) onEndRef.current?.();
      return;
    }

    /** When a run that plays once began; such a run starts from its first frame. */
    let began: number | null = null;
    if (!loop) show(first);

    const animate = (time: number) => {
      const interval = 1000 / fpsRef.current;
      const count = sequence ? sequence.length : columnsRef.current;
      let step: number;
      if (loop) {
        // Global time-based frame: all sprites with same fps compute same frame
        step = Math.floor(time / interval) % count;
      } else {
        if (began === null) began = time;
        step = Math.min(count - 1, Math.floor((time - began) / interval));
      }
      const frame = sequence ? sequence[step] : step;
      if (frame !== frameRef.current) show(frame);

      if (!loop && step >= count - 1) {
        // The last frame is on screen: the run is over, and stays there.
        rafRef.current = 0;
        onEndRef.current?.();
        return;
      }
      rafRef.current = requestAnimationFrame(animate);
    };

    rafRef.current = requestAnimationFrame(animate);

    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
    };
  }, [animating, endsAtOnce, loop, sequence, show]);

  const initialFrame = sequence ? sequence[0] : 0;
  const initialX = (colOffset + (initialFrame % columns)) * frameWidth;
  const initialY = (row + Math.floor(initialFrame / columns)) * frameHeight;

  // Where it is and which way it faces, in one transform. A mirrored sprite
  // is moved back by its own width, so it turns round where it stands.
  const placed = typeof x === 'number' || typeof y === 'number';
  const left = (typeof x === 'number' && Number.isFinite(x) ? x : 0) + (flipX ? frameWidth * scale : 0);
  const top = typeof y === 'number' && Number.isFinite(y) ? y : 0;
  const move = placed || flipX ? `translate(${left}px, ${top}px) ` : '';
  const transform = `${move}scale(${flipX ? -scale : scale}${flipX ? `, ${scale}` : ''})`;

  const computedStyle: React.CSSProperties = {
    position: 'absolute',
    // A sprite given a place starts from its container's corner.
    ...(placed ? { left: 0, top: 0 } : {}),
    width: frameWidth,
    height: frameHeight,
    // Interpolating the sheet URL into a CSS value is the same trust decision
    // as putting it in an `<img src>`, and the sheet is named by the bundle.
    backgroundImage: sheet && isSafeUrl(sheet) ? `url("${sheet.replace(/["\\]/g, '\\$&')}")` : undefined,
    backgroundPosition: `-${initialX}px -${initialY}px`,
    backgroundRepeat: 'no-repeat',
    imageRendering: 'pixelated',
    transform,
    transformOrigin: 'top left',
    pointerEvents: onClick ? 'auto' : 'none',
    cursor: onClick ? 'pointer' : undefined,
    zIndex,
    ...style,
  };

  const handleKeyDown = onClick
    ? (e: React.KeyboardEvent<HTMLDivElement>) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick();
        }
      }
    : undefined;

  return (
    <div
      ref={divRef}
      className={className}
      style={computedStyle}
      onClick={onClick}
      onKeyDown={handleKeyDown}
      role={onClick ? 'button' : ariaLabel ? 'img' : undefined}
      tabIndex={onClick ? 0 : undefined}
      aria-label={onClick ? (ariaLabel ?? 'Sprite') : ariaLabel}
    />
  );
}

export default Sprite;

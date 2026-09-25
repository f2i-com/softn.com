import React from 'react';
import { cssPaint } from '../utils/egress';

type Direction = 'up' | 'down' | 'left' | 'right';

interface DPadProps {
  onPress?: (direction: Direction) => void;
  onRelease?: (direction: Direction) => void;
  buttonSize?: number;
  color?: string;
  visible?: boolean;
  /** Accessible name for the pad as a whole */
  ariaLabel?: string;
  style?: React.CSSProperties;
}

const directions: { dir: Direction; row: number; col: number; symbol: string; label: string }[] = [
  { dir: 'up', row: 0, col: 1, symbol: '▲', label: 'Up' },
  { dir: 'left', row: 1, col: 0, symbol: '◀', label: 'Left' },
  { dir: 'right', row: 1, col: 2, symbol: '▶', label: 'Right' },
  { dir: 'down', row: 2, col: 1, symbol: '▼', label: 'Down' },
];

// A mid grey at partial opacity, and a white glyph with a dark halo: legible
// over a light page and over a dark game canvas alike.
const DEFAULT_PAINT = 'rgba(127,127,127,0.3)';

/**
 * An on-screen directional pad.
 *
 * Each direction is held, not clicked: `onPress` when a pointer or key goes
 * down, `onRelease` when it comes up. A release is sent once per press — and
 * also when the pointer is cancelled, leaves the button while pressed, the
 * button loses focus, or the pad unmounts — so a character is never left
 * walking. Enter and Space hold a focused direction like a pointer does.
 */
export function DPad({
  onPress,
  onRelease,
  buttonSize = 56,
  color = DEFAULT_PAINT,
  visible = true,
  ariaLabel = 'Directional pad',
  style,
}: DPadProps): React.ReactElement | null {
  const pressed = React.useRef(new Set<Direction>());
  const onReleaseRef = React.useRef(onRelease);
  onReleaseRef.current = onRelease;

  const press = React.useCallback(
    (dir: Direction) => {
      if (pressed.current.has(dir)) return;
      pressed.current.add(dir);
      onPress?.(dir);
    },
    [onPress]
  );

  const release = React.useCallback((dir: Direction) => {
    if (!pressed.current.delete(dir)) return;
    onReleaseRef.current?.(dir);
  }, []);

  // Anything still held when the pad goes away is let go.
  React.useEffect(
    () => () => {
      const held = [...pressed.current];
      pressed.current.clear();
      for (const dir of held) onReleaseRef.current?.(dir);
    },
    []
  );

  if (!visible) return null;
  // `background` would fetch a `url()`; a colour prop gets colours only.
  const paint = cssPaint(color) ?? DEFAULT_PAINT;

  const gridSize = buttonSize * 3 + 8; // 3 cells + small gaps

  return (
    <div
      role="group"
      aria-label={ariaLabel}
      style={{
        display: 'inline-grid',
        gridTemplateColumns: `${buttonSize}px ${buttonSize}px ${buttonSize}px`,
        gridTemplateRows: `${buttonSize}px ${buttonSize}px ${buttonSize}px`,
        gap: '4px',
        width: gridSize,
        touchAction: 'none',
        userSelect: 'none',
        WebkitUserSelect: 'none',
        ...style,
      }}
    >
      {directions.map(({ dir, row, col, symbol, label }) => (
        <button
          key={dir}
          type="button"
          aria-label={label}
          onPointerDown={(e) => {
            e.preventDefault();
            press(dir);
          }}
          onPointerUp={(e) => {
            e.preventDefault();
            release(dir);
          }}
          onPointerCancel={() => release(dir)}
          onPointerLeave={() => release(dir)}
          onKeyDown={(e) => {
            if (e.key !== 'Enter' && e.key !== ' ') return;
            e.preventDefault();
            if (!e.repeat) press(dir);
          }}
          onKeyUp={(e) => {
            if (e.key !== 'Enter' && e.key !== ' ') return;
            e.preventDefault();
            release(dir);
          }}
          onBlur={() => release(dir)}
          style={{
            gridRow: row + 1,
            gridColumn: col + 1,
            width: buttonSize,
            height: buttonSize,
            border: 'none',
            borderRadius: '12px',
            background: paint,
            color: 'rgba(255,255,255,0.9)',
            textShadow: '0 0 2px rgba(0,0,0,0.8)',
            fontSize: buttonSize * 0.36,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'pointer',
            touchAction: 'none',
            WebkitTapHighlightColor: 'transparent',
            padding: 0,
          }}
        >
          <span aria-hidden="true">{symbol}</span>
        </button>
      ))}
    </div>
  );
}

import React from 'react';
import { cssPaint } from '../utils/egress';
import { useHeldRecord } from './Controls';

type Direction = 'up' | 'down' | 'left' | 'right';

/** The record a bound pad keeps: each direction while it is held, and how often each was pressed. */
type DPadValue = { presses?: Record<string, number> } & Record<string, unknown>;

interface DPadProps {
  /** Called when a direction goes down, with `"up"`, `"down"`, `"left"` or `"right"` */
  onPress?: (direction: Direction) => void;
  /** Called when a direction is let go, with the direction */
  onRelease?: (direction: Direction) => void;
  /**
   * A record of what is held, the one a `<Controls>` keeps. Write
   * `:bind={pad}`: `pad.left`, `pad.right`, `pad.up` and `pad.down` are true
   * while that direction is held, and `pad.presses.left` counts its presses.
   * Bound to the same variable as a `<Controls>`, touch and keys are one
   * record to the game: a direction is held while a button here, a key or a
   * gamepad holds it, and a press is counted once however many of them go
   * down together.
   */
  value?: DPadValue | null;
  /** Called with the new record when a direction is pressed or let go; `:bind` writes it to the variable. */
  onChange?: (value: DPadValue) => void;
  /** The side of each button in pixels (default 56) */
  buttonSize?: number;
  /** The buttons' colour (default a translucent grey that shows over light and dark alike) */
  color?: string;
  /** Whether the pad is drawn (default true); hidden, whatever was held is let go */
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
 *
 * Bound with `:bind={pad}` it also keeps a record of what is held, the same
 * one a `<Controls>` keeps for keys and a gamepad. In that record a direction
 * is held while anything holds it: with the Left key still down, lifting the
 * finger from the pad's Left leaves `pad.left` true.
 */
export function DPad({
  onPress,
  onRelease,
  value,
  onChange,
  buttonSize = 56,
  color = DEFAULT_PAINT,
  visible = true,
  ariaLabel = 'Directional pad',
  style,
}: DPadProps): React.ReactElement | null {
  const pressed = React.useRef(new Set<Direction>());
  const onReleaseRef = React.useRef(onRelease);
  onReleaseRef.current = onRelease;
  const onChangeRef = React.useRef(onChange);
  onChangeRef.current = onChange;
  // The pad's part in the bound record, beside whatever else is bound to it
  // (a `<Controls>`): a direction a key is holding as well is not pressed
  // again from here, and not let go while the key is down.
  const hold = useHeldRecord(value);

  /** Write the bound record from the buttons held now, counting a press. */
  const record = React.useCallback(() => {
    if (!onChangeRef.current) return;
    const change = hold(pressed.current);
    if (change.record) onChangeRef.current(change.record);
  }, [hold]);

  const press = React.useCallback(
    (dir: Direction) => {
      if (pressed.current.has(dir)) return;
      pressed.current.add(dir);
      record();
      onPress?.(dir);
    },
    [onPress, record]
  );

  const release = React.useCallback(
    (dir: Direction) => {
      if (!pressed.current.delete(dir)) return;
      record();
      onReleaseRef.current?.(dir);
    },
    [record]
  );

  const releaseAll = React.useCallback(() => {
    const held = [...pressed.current];
    pressed.current.clear();
    record();
    for (const dir of held) onReleaseRef.current?.(dir);
  }, [record]);

  // Anything still held when the pad goes away is let go.
  React.useEffect(() => releaseAll, [releaseAll]);

  // And when it is hidden. `visible={false}` takes the buttons away under
  // the pointer or the key that held them, so no pointerup, keyup or blur
  // ever came for them, and the character held went on walking.
  React.useEffect(() => {
    if (!visible) releaseAll();
  }, [visible, releaseAll]);

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

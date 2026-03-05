import React from 'react';

type Direction = 'up' | 'down' | 'left' | 'right';

interface DPadProps {
  onPress?: (direction: Direction) => void;
  onRelease?: (direction: Direction) => void;
  buttonSize?: number;
  color?: string;
  visible?: boolean;
  style?: React.CSSProperties;
}

const directions: { dir: Direction; row: number; col: number; symbol: string }[] = [
  { dir: 'up', row: 0, col: 1, symbol: '\u25B2' },
  { dir: 'left', row: 1, col: 0, symbol: '\u25C0' },
  { dir: 'right', row: 1, col: 2, symbol: '\u25B6' },
  { dir: 'down', row: 2, col: 1, symbol: '\u25BC' },
];

export function DPad({
  onPress,
  onRelease,
  buttonSize = 56,
  color = 'rgba(255,255,255,0.15)',
  visible = true,
  style,
}: DPadProps): React.ReactElement | null {
  if (!visible) return null;

  const gridSize = buttonSize * 3 + 8; // 3 cells + small gaps

  return (
    <div
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
      {directions.map(({ dir, row, col, symbol }) => (
        <button
          key={dir}
          onPointerDown={(e) => {
            e.preventDefault();
            onPress?.(dir);
          }}
          onPointerUp={(e) => {
            e.preventDefault();
            onRelease?.(dir);
          }}
          onPointerLeave={(e) => {
            e.preventDefault();
            onRelease?.(dir);
          }}
          style={{
            gridRow: row + 1,
            gridColumn: col + 1,
            width: buttonSize,
            height: buttonSize,
            border: 'none',
            borderRadius: '12px',
            background: color,
            color: 'rgba(255,255,255,0.8)',
            fontSize: buttonSize * 0.36,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'pointer',
            touchAction: 'none',
            WebkitTapHighlightColor: 'transparent',
            outline: 'none',
            padding: 0,
          }}
        >
          {symbol}
        </button>
      ))}
    </div>
  );
}

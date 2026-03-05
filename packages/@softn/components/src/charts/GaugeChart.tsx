/**
 * GaugeChart Component
 *
 * SVG-based gauge/meter chart with semicircle, arc, and full circle variants.
 */

import * as React from 'react';

export interface GaugeThreshold {
  value: number;
  color: string;
}

export interface GaugeChartProps {
  value: number;
  min?: number;
  max?: number;
  label?: string;
  thresholds?: GaugeThreshold[];
  variant?: 'semicircle' | 'arc' | 'full';
  animated?: boolean;
  width?: number;
  height?: number;
  formatValue?: (v: number) => string;
  className?: string;
  style?: React.CSSProperties;
}

const DEFAULT_COLOR = '#6366f1';

/**
 * Returns the total arc angle in degrees for each variant.
 */
function getArcAngle(variant: 'semicircle' | 'arc' | 'full'): number {
  switch (variant) {
    case 'semicircle':
      return 180;
    case 'arc':
      return 270;
    case 'full':
      return 360;
  }
}

/**
 * Returns the start angle in degrees for each variant.
 * Angles are measured clockwise from the top (12 o'clock = 0 degrees).
 * The arc is centered symmetrically.
 */
function getStartAngle(variant: 'semicircle' | 'arc' | 'full'): number {
  switch (variant) {
    case 'semicircle':
      // Arc from 9 o'clock to 3 o'clock (left to right across the bottom)
      return -90;
    case 'arc':
      // Arc centered at bottom, spanning 270 degrees
      return -135;
    case 'full':
      // Full circle starting from the top
      return 0;
  }
}

/**
 * Converts a polar coordinate (angle in degrees from 12 o'clock, clockwise)
 * to Cartesian coordinates on a circle.
 */
function polarToCartesian(
  cx: number,
  cy: number,
  radius: number,
  angleDeg: number
): { x: number; y: number } {
  const rad = ((angleDeg - 90) * Math.PI) / 180;
  return {
    x: cx + radius * Math.cos(rad),
    y: cy + radius * Math.sin(rad),
  };
}

/**
 * Builds an SVG arc path descriptor using the arc command.
 * Used as the `d` attribute for the background/foreground track paths.
 */
function describeArcPath(
  cx: number,
  cy: number,
  radius: number,
  startAngleDeg: number,
  endAngleDeg: number
): string {
  const start = polarToCartesian(cx, cy, radius, startAngleDeg);
  const end = polarToCartesian(cx, cy, radius, endAngleDeg);
  const sweep = endAngleDeg - startAngleDeg;
  const largeArc = sweep > 180 ? 1 : 0;

  return `M ${start.x} ${start.y} A ${radius} ${radius} 0 ${largeArc} 1 ${end.x} ${end.y}`;
}

/**
 * Determines the fill color based on the current value and threshold definitions.
 * Picks the color of the highest threshold whose value is <= the current value.
 */
function getColorForValue(
  value: number,
  thresholds?: GaugeThreshold[]
): string {
  if (!thresholds || thresholds.length === 0) {
    return DEFAULT_COLOR;
  }

  // Sort ascending by threshold value
  const sorted = [...thresholds].sort((a, b) => a.value - b.value);

  let color = DEFAULT_COLOR;
  for (const t of sorted) {
    if (t.value <= value) {
      color = t.color;
    } else {
      break;
    }
  }

  return color;
}

export function GaugeChart({
  value,
  min = 0,
  max = 100,
  label,
  thresholds,
  variant = 'semicircle',
  animated = true,
  width = 200,
  height,
  formatValue = (v) => String(Math.round(v)),
  className = '',
  style,
}: GaugeChartProps) {
  // Derive height from variant if not provided
  const computedHeight =
    height ??
    (variant === 'semicircle'
      ? width * 0.65
      : variant === 'arc'
        ? width
        : width);

  const strokeWidth = width * 0.08;
  const padding = strokeWidth / 2 + 6;
  const radius = (width - strokeWidth) / 2 - 6;
  const cx = width / 2;
  const cy =
    variant === 'semicircle'
      ? computedHeight - padding
      : variant === 'arc'
        ? computedHeight * 0.55
        : computedHeight / 2;

  // Arc geometry
  const arcAngle = getArcAngle(variant);
  const startAngle = getStartAngle(variant);
  const endAngle = startAngle + arcAngle;

  // Clamp value to [min, max], default to min if undefined/NaN
  const safeValue = typeof value === 'number' && !isNaN(value) ? value : min;
  const clampedValue = Math.min(Math.max(safeValue, min), max);
  const fraction = (clampedValue - min) / (max - min || 1);

  // Arc circumference for dash calculations
  const circumference = (arcAngle / 360) * 2 * Math.PI * radius;

  // Animation state: start at 0 offset (empty), transition to filled
  const [animatedOffset, setAnimatedOffset] = React.useState(
    animated ? circumference : circumference * (1 - fraction)
  );

  React.useEffect(() => {
    if (animated) {
      // Use requestAnimationFrame to ensure the initial render with full offset
      // is painted before we transition to the target offset
      const raf = requestAnimationFrame(() => {
        setAnimatedOffset(circumference * (1 - fraction));
      });
      return () => cancelAnimationFrame(raf);
    } else {
      setAnimatedOffset(circumference * (1 - fraction));
    }
  }, [animated, circumference, fraction]);

  const fillColor = getColorForValue(clampedValue, thresholds);

  // Build the arc path for stroke-dasharray technique.
  // For the 'full' variant we use a circle element; for others, a path.
  const isFullCircle = variant === 'full';

  // Background and foreground arc path (for non-full variants)
  const arcPath = !isFullCircle
    ? describeArcPath(cx, cy, radius, startAngle, endAngle)
    : undefined;

  return (
    <div className={`softn-gauge-chart ${className}`} style={style}>
      <svg viewBox={`0 0 ${width} ${computedHeight}`} width="100%" preserveAspectRatio="xMidYMid meet">
        {isFullCircle ? (
          <>
            {/* Background track */}
            <circle
              cx={cx}
              cy={cy}
              r={radius}
              fill="none"
              stroke="#e4e4e7"
              strokeWidth={strokeWidth}
              opacity={0.3}
            />
            {/* Foreground value arc */}
            <circle
              cx={cx}
              cy={cy}
              r={radius}
              fill="none"
              stroke={fillColor}
              strokeWidth={strokeWidth}
              strokeLinecap="round"
              strokeDasharray={circumference}
              strokeDashoffset={animatedOffset}
              style={{
                transition: animated
                  ? 'stroke-dashoffset 1s cubic-bezier(0.4, 0, 0.2, 1)'
                  : 'none',
                // Rotate so the arc starts from the top
                transformOrigin: `${cx}px ${cy}px`,
                transform: 'rotate(-90deg)',
              }}
            />
          </>
        ) : (
          <>
            {/* Background track */}
            <path
              d={arcPath}
              fill="none"
              stroke="#e4e4e7"
              strokeWidth={strokeWidth}
              strokeLinecap="round"
              opacity={0.3}
            />
            {/* Foreground value arc */}
            <path
              d={arcPath}
              fill="none"
              stroke={fillColor}
              strokeWidth={strokeWidth}
              strokeLinecap="round"
              strokeDasharray={circumference}
              strokeDashoffset={animatedOffset}
              style={{
                transition: animated
                  ? 'stroke-dashoffset 1s cubic-bezier(0.4, 0, 0.2, 1)'
                  : 'none',
              }}
            />
          </>
        )}

        {/* Center value text */}
        <text
          x={cx}
          y={variant === 'semicircle' ? cy - radius * 0.15 : cy}
          textAnchor="middle"
          dominantBaseline="middle"
          fill="var(--color-text, #e4e4e7)"
          fontSize={width * 0.16}
          fontWeight="700"
          style={{ pointerEvents: 'none' }}
        >
          {formatValue(clampedValue)}
        </text>

        {/* Label text below value */}
        {label && (
          <text
            x={cx}
            y={
              variant === 'semicircle'
                ? cy - radius * 0.15 + width * 0.1
                : cy + width * 0.12
            }
            textAnchor="middle"
            dominantBaseline="middle"
            fill="var(--color-text-muted, #a1a1aa)"
            fontSize={width * 0.07}
            style={{ pointerEvents: 'none' }}
          >
            {label}
          </text>
        )}
      </svg>
    </div>
  );
}

export default GaugeChart;

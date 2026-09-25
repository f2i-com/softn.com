/**
 * PieChart Component
 *
 * SVG-based pie/donut chart with interactive hover pull-out effect,
 * donut center label, and CSS variable theming.
 */

import * as React from 'react';
import { describeChart, finiteNumber, normaliseArray } from './series';
import { chartPalette } from '../theme/chart-palette';

export interface PieDataPoint {
  label: string;
  value: number;
  color?: string;
}

export interface PieChartProps {
  data: PieDataPoint[];
  width?: number;
  height?: number;
  innerRadius?: number;
  showLabels?: boolean;
  showLegend?: boolean;
  showValues?: boolean;
  centerLabel?: string;
  formatValue?: (value: number) => string;
  formatPercent?: (value: number) => string;
  interactive?: boolean;
  /** Text alternative for the chart; a summary of its values by default */
  ariaLabel?: string;
  className?: string;
  style?: React.CSSProperties;
}

// The theme's series colours, as the other charts use them, so a dark theme
// is not drawn in the light palette.
const defaultColors = chartPalette();

interface Arc {
  data: PieDataPoint;
  startAngle: number;
  endAngle: number;
  color: string;
  percent: number;
}

function polarToCartesian(
  centerX: number,
  centerY: number,
  radius: number,
  angleInDegrees: number
): { x: number; y: number } {
  const angleInRadians = ((angleInDegrees - 90) * Math.PI) / 180;
  return {
    x: centerX + radius * Math.cos(angleInRadians),
    y: centerY + radius * Math.sin(angleInRadians),
  };
}

function describeArc(
  x: number,
  y: number,
  outerRadius: number,
  innerRadius: number,
  startAngle: number,
  endAngle: number
): string {
  // A slice that is the whole pie starts and ends at the same point, and SVG
  // draws nothing for an arc whose ends coincide: a one-category pie was
  // blank. Draw the full disc (or ring, with the hole cut out by the
  // even-odd fill rule) as two half circles instead.
  if (endAngle - startAngle >= 359.999) {
    const circle = (r: number) =>
      r > 0 ? `M ${x - r} ${y} A ${r} ${r} 0 1 0 ${x + r} ${y} A ${r} ${r} 0 1 0 ${x - r} ${y} Z` : '';
    return `${circle(outerRadius)} ${circle(innerRadius)}`.trim();
  }
  const outerStart = polarToCartesian(x, y, outerRadius, endAngle);
  const outerEnd = polarToCartesian(x, y, outerRadius, startAngle);
  const innerStart = polarToCartesian(x, y, innerRadius, endAngle);
  const innerEnd = polarToCartesian(x, y, innerRadius, startAngle);

  const largeArcFlag = endAngle - startAngle <= 180 ? '0' : '1';

  if (innerRadius === 0) {
    return [
      'M',
      outerStart.x,
      outerStart.y,
      'A',
      outerRadius,
      outerRadius,
      0,
      largeArcFlag,
      0,
      outerEnd.x,
      outerEnd.y,
      'L',
      x,
      y,
      'Z',
    ].join(' ');
  }

  return [
    'M',
    outerStart.x,
    outerStart.y,
    'A',
    outerRadius,
    outerRadius,
    0,
    largeArcFlag,
    0,
    outerEnd.x,
    outerEnd.y,
    'L',
    innerEnd.x,
    innerEnd.y,
    'A',
    innerRadius,
    innerRadius,
    0,
    largeArcFlag,
    1,
    innerStart.x,
    innerStart.y,
    'Z',
  ].join(' ');
}

export function PieChart({
  data: rawData,
  width = 300,
  height = 300,
  innerRadius = 0,
  showLabels = true,
  showLegend = true,
  showValues = false,
  centerLabel,
  formatValue = (v) => String(v),
  formatPercent = (v) => `${v.toFixed(1)}%`,
  interactive = false,
  ariaLabel,
  className = '',
  style,
}: PieChartProps) {
  // Data that has not arrived yet is an empty chart, not a throw.
  // A value that is not a number counts as nothing: a NaN would carry into
  // every later slice's angle.
  const data = React.useMemo(
    () =>
      normaliseArray(rawData)
        .filter((d): d is PieDataPoint => d !== null && typeof d === 'object')
        .map((d) => ({ ...d, label: String(d.label ?? ''), value: finiteNumber(d.value) ?? 0 })),
    [rawData]
  );
  const [hoveredIndex, setHoveredIndex] = React.useState<number | null>(null);
  const [tooltip, setTooltip] = React.useState<{ x: number; y: number; label: string; value: number; percent: number; color: string } | null>(null);

  const centerX = width / 2;
  const centerY = height / 2;
  const radius = Math.min(width, height) / 2 - 20;

  const total = data.reduce((sum, d) => sum + Math.max(0, d.value), 0) || 1;

  const arcs: Arc[] = [];
  let currentAngle = 0;

  data.forEach((d, idx) => {
    const safeValue = Math.max(0, d.value);
    const percent = (safeValue / total) * 100;
    const angle = (safeValue / total) * 360;
    arcs.push({
      data: d,
      startAngle: currentAngle,
      endAngle: currentAngle + angle,
      color: d.color || defaultColors[idx % defaultColors.length],
      percent,
    });
    currentAngle += angle;
  });

  // Pull-out offset for hovered slice
  const pullOutDistance = 6;

  return (
    <div className={`softn-pie-chart ${className}`} style={{ position: 'relative', ...style }}>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        width="100%"
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label={
          ariaLabel ??
          describeChart(innerRadius > 0 ? 'Donut chart' : 'Pie chart', [
            {
              name: centerLabel,
              values: arcs.map((arc) => `${arc.data.label} ${formatValue(arc.data.value)} (${formatPercent(arc.percent)})`),
            },
          ])
        }
      >
        {arcs.map((arc, arcIndex) => {
          const midAngle = (arc.startAngle + arc.endAngle) / 2;
          const labelRadius = innerRadius > 0 ? (radius + innerRadius) / 2 : radius * 0.65;
          const labelPos = polarToCartesian(centerX, centerY, labelRadius, midAngle);
          const isHovered = interactive && hoveredIndex === arcIndex;
          const isDimmed = interactive && hoveredIndex !== null && hoveredIndex !== arcIndex;

          // Pull-out offset for hovered slice
          const pullOffset = isHovered
            ? polarToCartesian(0, 0, pullOutDistance, midAngle)
            : { x: 0, y: 0 };
          // CSS transforms need units; `translate(3, 4)` is invalid and ignored.
          const translateStr = isHovered
            ? `translate(${pullOffset.x}px, ${pullOffset.y}px)`
            : 'translate(0px, 0px)';

          return (
            <g
              key={`${arcIndex}-${arc.data.label}`}
              opacity={isDimmed ? 0.4 : 1}
              style={{
                transition: 'opacity 0.2s ease, transform 0.2s ease',
                transform: translateStr,
              }}
            >
              <path
                d={describeArc(centerX, centerY, radius, innerRadius, arc.startAngle, arc.endAngle)}
                fill={arc.color}
                fillRule="evenodd"
                stroke="var(--color-bg, #18181b)"
                strokeWidth={2}
                style={{
                  cursor: interactive ? 'pointer' : undefined,
                  filter: isHovered ? 'brightness(1.15)' : undefined,
                  transition: 'filter 0.2s ease',
                }}
                onMouseEnter={interactive ? (e) => {
                  setHoveredIndex(arcIndex);
                  const svgRect = (e.currentTarget.closest('svg') as SVGSVGElement)?.getBoundingClientRect();
                  if (svgRect) {
                    setTooltip({
                      x: e.clientX - svgRect.left,
                      y: e.clientY - svgRect.top - 10,
                      label: arc.data.label,
                      value: arc.data.value,
                      percent: arc.percent,
                      color: arc.color,
                    });
                  }
                } : undefined}
                onMouseMove={interactive ? (e) => {
                  const svgRect = (e.currentTarget.closest('svg') as SVGSVGElement)?.getBoundingClientRect();
                  if (svgRect) {
                    setTooltip({
                      x: e.clientX - svgRect.left,
                      y: e.clientY - svgRect.top - 10,
                      label: arc.data.label,
                      value: arc.data.value,
                      percent: arc.percent,
                      color: arc.color,
                    });
                  }
                } : undefined}
                onMouseLeave={interactive ? () => {
                  setHoveredIndex(null);
                  setTooltip(null);
                } : undefined}
              >
                {!interactive && (
                  <title>
                    {arc.data.label}: {formatValue(arc.data.value)} ({formatPercent(arc.percent)})
                  </title>
                )}
              </path>
              {showLabels && arc.percent > 5 && (
                <text
                  x={labelPos.x}
                  y={labelPos.y}
                  textAnchor="middle"
                  dominantBaseline="middle"
                  fill="white"
                  fontSize="11"
                  fontWeight="600"
                  style={{ pointerEvents: 'none' }}
                >
                  {showValues ? formatValue(arc.data.value) : formatPercent(arc.percent)}
                </text>
              )}
            </g>
          );
        })}

        {/* Center label for donut charts */}
        {innerRadius > 0 && (
          <>
            {hoveredIndex !== null && arcs[hoveredIndex] ? (
              <>
                <text
                  x={centerX}
                  y={centerY - 6}
                  textAnchor="middle"
                  dominantBaseline="middle"
                  fill="var(--color-text, #e4e4e7)"
                  fontSize={innerRadius * 0.35}
                  fontWeight="700"
                  style={{ pointerEvents: 'none', transition: 'opacity 0.15s ease' }}
                >
                  {formatPercent(arcs[hoveredIndex].percent)}
                </text>
                <text
                  x={centerX}
                  y={centerY + innerRadius * 0.2}
                  textAnchor="middle"
                  dominantBaseline="middle"
                  fill="var(--color-text-muted, #a1a1aa)"
                  fontSize={innerRadius * 0.2}
                  style={{ pointerEvents: 'none' }}
                >
                  {arcs[hoveredIndex].data.label}
                </text>
              </>
            ) : centerLabel ? (
              <text
                x={centerX}
                y={centerY}
                textAnchor="middle"
                dominantBaseline="middle"
                fill="var(--color-text-muted, #a1a1aa)"
                fontSize={innerRadius * 0.25}
                style={{ pointerEvents: 'none' }}
              >
                {centerLabel}
              </text>
            ) : null}
          </>
        )}
      </svg>

      {interactive && tooltip && (
        <div
          style={{
            position: 'absolute',
            left: tooltip.x,
            top: tooltip.y,
            transform: 'translate(-50%, -100%)',
            backgroundColor: 'var(--color-surface, rgba(24, 24, 27, 0.95))',
            color: 'var(--color-text, #e4e4e7)',
            border: '1px solid var(--color-border, rgba(255, 255, 255, 0.1))',
            borderRadius: '8px',
            padding: '6px 10px',
            fontSize: '12px',
            whiteSpace: 'nowrap',
            pointerEvents: 'none',
            zIndex: 10,
            boxShadow: '0 4px 12px rgba(0, 0, 0, 0.4)',
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
          }}
        >
          <span
            style={{
              width: '8px',
              height: '8px',
              borderRadius: '50%',
              backgroundColor: tooltip.color,
              flexShrink: 0,
            }}
          />
          <span>
            <strong>{tooltip.label}</strong> — {formatValue(tooltip.value)} ({formatPercent(tooltip.percent)})
          </span>
        </div>
      )}

      {showLegend && (
        <div
          style={{
            display: 'flex',
            justifyContent: 'center',
            flexWrap: 'wrap',
            gap: '0.6rem 1rem',
            marginTop: '0.75rem',
            fontSize: '0.8rem',
          }}
        >
          {arcs.map((arc, idx) => {
            const isActive = hoveredIndex === null || hoveredIndex === idx;
            return (
              <div
                key={`${idx}-${arc.data.label}`}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.3rem',
                  opacity: isActive ? 1 : 0.4,
                  cursor: interactive ? 'pointer' : undefined,
                  transition: 'opacity 0.2s ease',
                }}
                onMouseEnter={interactive ? () => setHoveredIndex(idx) : undefined}
                onMouseLeave={interactive ? () => setHoveredIndex(null) : undefined}
              >
                <span
                  style={{
                    width: '10px',
                    height: '10px',
                    borderRadius: '50%',
                    backgroundColor: arc.color,
                  }}
                />
                <span style={{ color: 'var(--color-text, #e4e4e7)' }}>
                  {arc.data.label}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default PieChart;

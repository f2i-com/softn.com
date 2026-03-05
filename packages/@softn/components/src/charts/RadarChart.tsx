/**
 * RadarChart Component
 *
 * SVG-based radar/spider chart with multi-series support.
 */

import * as React from 'react';

export interface RadarDataPoint {
  axis: string;
  value: number;
}

export interface RadarChartSeries {
  name: string;
  data: RadarDataPoint[];
  color?: string;
}

export interface RadarChartProps {
  series: RadarChartSeries[];
  axes: string[];
  maxValue?: number;
  levels?: number;
  width?: number;
  height?: number;
  showLegend?: boolean;
  interactive?: boolean;
  className?: string;
  style?: React.CSSProperties;
}

const defaultColors = ['#6366f1', '#ef4444', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899'];

function getVertex(
  centerX: number,
  centerY: number,
  radius: number,
  index: number,
  total: number
): { x: number; y: number } {
  const angle = (2 * Math.PI * index) / total - Math.PI / 2;
  return {
    x: centerX + radius * Math.cos(angle),
    y: centerY + radius * Math.sin(angle),
  };
}

function polygonPoints(
  centerX: number,
  centerY: number,
  radius: number,
  numAxes: number
): string {
  return Array.from({ length: numAxes })
    .map((_, i) => {
      const v = getVertex(centerX, centerY, radius, i, numAxes);
      return `${v.x},${v.y}`;
    })
    .join(' ');
}

export function RadarChart({
  series,
  axes,
  maxValue: propMaxValue,
  levels = 5,
  width = 300,
  height = 300,
  showLegend = true,
  interactive = false,
  className = '',
  style,
}: RadarChartProps) {
  const [hoveredSeries, setHoveredSeries] = React.useState<string | null>(null);
  const [tooltip, setTooltip] = React.useState<{
    x: number;
    y: number;
    axis: string;
    value: number;
    seriesName: string;
  } | null>(null);

  const numAxes = axes.length;
  const centerX = width / 2;
  const centerY = height / 2;
  const chartRadius = Math.min(width, height) / 2 - 40;

  // Auto-compute maxValue from all data points if not provided
  const maxValue = React.useMemo(() => {
    if (propMaxValue != null) return propMaxValue;
    let max = 0;
    for (const s of series) {
      for (const d of s.data) {
        if (d.value > max) max = d.value;
      }
    }
    return max || 1;
  }, [propMaxValue, series]);

  // Build grid level polygons (concentric rings)
  const gridLevels: React.ReactNode[] = [];
  for (let level = 1; level <= levels; level++) {
    const levelRadius = (chartRadius / levels) * level;
    gridLevels.push(
      <polygon
        key={`level-${level}`}
        points={polygonPoints(centerX, centerY, levelRadius, numAxes)}
        fill="none"
        stroke="var(--color-border, rgba(255, 255, 255, 0.08))"
        strokeDasharray="4,4"
        strokeWidth={1}
      />
    );
  }

  // Build axis lines from center to each vertex
  const axisLines: React.ReactNode[] = [];
  const axisLabels: React.ReactNode[] = [];
  for (let i = 0; i < numAxes; i++) {
    const outerVertex = getVertex(centerX, centerY, chartRadius, i, numAxes);
    axisLines.push(
      <line
        key={`axis-${i}`}
        x1={centerX}
        y1={centerY}
        x2={outerVertex.x}
        y2={outerVertex.y}
        stroke="var(--color-border, rgba(255, 255, 255, 0.08))"
        strokeWidth={1}
      />
    );

    // Position labels slightly outside the outermost polygon
    const labelVertex = getVertex(centerX, centerY, chartRadius + 18, i, numAxes);
    // Determine text anchor based on position
    let textAnchor: 'start' | 'middle' | 'end' = 'middle';
    const dx = labelVertex.x - centerX;
    if (dx > 1) textAnchor = 'start';
    else if (dx < -1) textAnchor = 'end';

    let dominantBaseline: 'auto' | 'middle' | 'hanging' = 'middle';
    const dy = labelVertex.y - centerY;
    if (dy > 1) dominantBaseline = 'hanging';
    else if (dy < -1) dominantBaseline = 'auto';

    axisLabels.push(
      <text
        key={`label-${i}`}
        x={labelVertex.x}
        y={labelVertex.y}
        textAnchor={textAnchor}
        dominantBaseline={dominantBaseline}
        fontSize="11"
        fill="var(--color-text-muted, #a1a1aa)"
        style={{ pointerEvents: 'none' }}
      >
        {axes[i]}
      </text>
    );
  }

  // Build data polygons for each series
  const dataPolygons = series.map((s, seriesIndex) => {
    const color = s.color || defaultColors[seriesIndex % defaultColors.length];
    const isHovered = hoveredSeries === s.name;
    const isDimmed = hoveredSeries != null && !isHovered;
    const opacity = isDimmed ? 0.2 : 1;

    // Build polygon points from data values
    const dataMap = new Map(s.data.map((d) => [d.axis, d.value]));
    const points: { x: number; y: number; axis: string; value: number }[] = axes.map(
      (axis, i) => {
        const value = dataMap.get(axis) ?? 0;
        const ratio = value / maxValue;
        const vertex = getVertex(centerX, centerY, chartRadius * ratio, i, numAxes);
        return { ...vertex, axis, value };
      }
    );

    const polyStr = points.map((p) => `${p.x},${p.y}`).join(' ');

    return (
      <g key={s.name} opacity={opacity} style={{ transition: 'opacity 0.2s ease' }}>
        <polygon
          points={polyStr}
          fill={color}
          fillOpacity={0.2}
          stroke={color}
          strokeWidth={isHovered ? 2.5 : 1.5}
          strokeLinejoin="round"
          style={interactive ? { cursor: 'pointer' } : undefined}
          onMouseEnter={interactive ? () => setHoveredSeries(s.name) : undefined}
          onMouseLeave={interactive ? () => setHoveredSeries(null) : undefined}
        />
        {points.map((p, idx) => (
          <circle
            key={idx}
            cx={p.x}
            cy={p.y}
            r={isHovered ? 5 : 3.5}
            fill={color}
            stroke="#fff"
            strokeWidth={1}
            style={interactive ? { cursor: 'pointer' } : undefined}
            onMouseEnter={
              interactive
                ? (e) => {
                    setHoveredSeries(s.name);
                    const svgRect = (
                      e.currentTarget.closest('svg') as SVGSVGElement
                    )?.getBoundingClientRect();
                    if (svgRect) {
                      setTooltip({
                        x: e.clientX - svgRect.left,
                        y: e.clientY - svgRect.top - 10,
                        axis: p.axis,
                        value: p.value,
                        seriesName: s.name,
                      });
                    }
                  }
                : undefined
            }
            onMouseLeave={
              interactive
                ? () => {
                    setHoveredSeries(null);
                    setTooltip(null);
                  }
                : undefined
            }
          >
            {!interactive && (
              <title>
                {s.name} - {p.axis}: {p.value}
              </title>
            )}
          </circle>
        ))}
      </g>
    );
  });

  return (
    <div className={`softn-radar-chart ${className}`} style={{ position: 'relative', ...style }}>
      <svg viewBox={`0 0 ${width} ${height}`} width="100%" preserveAspectRatio="xMidYMid meet">
        {gridLevels}
        {axisLines}
        {axisLabels}
        {dataPolygons}
      </svg>

      {/* Tooltip */}
      {interactive && tooltip && (
        <div
          style={{
            position: 'absolute',
            left: tooltip.x,
            top: tooltip.y,
            transform: 'translate(-50%, -100%)',
            backgroundColor: 'var(--color-surface, #27272a)',
            color: 'var(--color-text, #e4e4e7)',
            border: '1px solid var(--color-border, rgba(255, 255, 255, 0.08))',
            borderRadius: '8px',
            padding: '6px 10px',
            fontSize: '12px',
            whiteSpace: 'nowrap',
            pointerEvents: 'none',
            zIndex: 10,
            boxShadow: '0 4px 12px rgba(0, 0, 0, 0.4)',
          }}
        >
          <strong>{tooltip.seriesName}</strong>
          <br />
          {tooltip.axis}: {tooltip.value}
        </div>
      )}

      {/* Legend */}
      {showLegend && series.length > 1 && (
        <div
          style={{
            display: 'flex',
            justifyContent: 'center',
            gap: '1rem',
            marginTop: '0.5rem',
            fontSize: '0.875rem',
          }}
        >
          {series.map((s, idx) => {
            const color = s.color || defaultColors[idx % defaultColors.length];
            return (
              <div
                key={s.name}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.25rem',
                  opacity: hoveredSeries != null && hoveredSeries !== s.name ? 0.4 : 1,
                  cursor: interactive ? 'pointer' : undefined,
                  transition: 'opacity 0.2s ease',
                }}
                onMouseEnter={interactive ? () => setHoveredSeries(s.name) : undefined}
                onMouseLeave={interactive ? () => setHoveredSeries(null) : undefined}
              >
                <span
                  style={{
                    width: '12px',
                    height: '12px',
                    borderRadius: '2px',
                    backgroundColor: color,
                  }}
                />
                <span style={{ color: 'var(--color-text, #e4e4e7)' }}>{s.name}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default RadarChart;

/**
 * BarChart Component
 *
 * SVG-based bar chart with grouped/stacked modes, interactive hover tooltips,
 * rounded corners, and CSS variable theming.
 */

import * as React from 'react';

export interface BarDataPoint {
  label: string;
  value: number;
  color?: string;
}

export interface BarChartSeries {
  name: string;
  data: BarDataPoint[];
  color?: string;
}

export interface BarChartProps {
  series: BarChartSeries[];
  width?: number;
  height?: number;
  padding?: { top: number; right: number; bottom: number; left: number };
  orientation?: 'vertical' | 'horizontal';
  grouped?: boolean;
  stacked?: boolean;
  barPadding?: number;
  groupPadding?: number;
  showGrid?: boolean;
  showValues?: boolean;
  showLegend?: boolean;
  formatValue?: (value: number) => string;
  interactive?: boolean;
  className?: string;
  style?: React.CSSProperties;
}

const defaultColors = ['#6366f1', '#ef4444', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899'];

export function BarChart({
  series,
  width = 600,
  height = 300,
  padding = { top: 20, right: 20, bottom: 50, left: 50 },
  orientation = 'vertical',
  grouped = true,
  stacked = false,
  barPadding = 0.1,
  groupPadding = 0.2,
  showGrid = true,
  showValues = false,
  showLegend = true,
  formatValue = (v: number) => {
    if (Math.abs(v) >= 1000) return `${(v / 1000).toFixed(v % 1000 === 0 ? 0 : 1)}k`;
    const rounded = Math.round(v * 100) / 100;
    return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
  },
  interactive = false,
  className = '',
  style,
}: BarChartProps) {
  const [hoveredBar, setHoveredBar] = React.useState<string | null>(null);
  const [tooltip, setTooltip] = React.useState<{ x: number; y: number; label: string; value: number; series: string; color: string } | null>(null);

  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;

  const allLabels = [...new Set(series.flatMap((s) => s.data.map((d) => d.label)))];

  const maxValue = (() => {
    let raw: number;
    if (stacked) {
      const labelTotals = allLabels.map((label) =>
        series.reduce((sum, s) => {
          const dp = s.data.find((d) => d.label === label);
          return sum + (dp ? dp.value : 0);
        }, 0)
      );
      raw = Math.max(...labelTotals, 0) * 1.1;
    } else {
      const allValues = series.flatMap((s) => s.data.map((d) => d.value));
      raw = Math.max(...allValues, 0) * 1.1;
    }
    if (raw <= 0) return 1;
    const step = Math.pow(10, Math.floor(Math.log10(raw / 5)));
    return Math.ceil(raw / step) * step || 1;
  })();

  const numGroups = allLabels.length;
  const numBarsPerGroup = stacked ? 1 : grouped ? series.length : 1;

  const groupWidth = (orientation === 'vertical' ? chartWidth : chartHeight) / numGroups;
  const groupGap = groupWidth * groupPadding;
  const availableGroupWidth = groupWidth - groupGap;
  const barWidth = Math.max(1, (availableGroupWidth / numBarsPerGroup) * (1 - barPadding));

  const scaleValue = (v: number): number => {
    return (v / maxValue) * (orientation === 'vertical' ? chartHeight : chartWidth);
  };

  const gridLines: React.ReactNode[] = [];
  const numGridLines = 5;
  for (let i = 0; i <= numGridLines; i++) {
    const value = (i / numGridLines) * maxValue;
    if (orientation === 'vertical') {
      const y = padding.top + chartHeight - scaleValue(value);
      gridLines.push(
        <g key={`grid-${i}`}>
          <line
            x1={padding.left}
            y1={y}
            x2={width - padding.right}
            y2={y}
            stroke="var(--color-border, rgba(255, 255, 255, 0.08))"
            strokeDasharray="3,3"
          />
          <text
            x={padding.left - 8}
            y={y}
            textAnchor="end"
            dominantBaseline="middle"
            fontSize="10"
            fill="var(--color-text-muted, #a1a1aa)"
          >
            {formatValue(value)}
          </text>
        </g>
      );
    } else {
      const x = padding.left + scaleValue(value);
      gridLines.push(
        <g key={`grid-${i}`}>
          <line
            x1={x}
            y1={padding.top}
            x2={x}
            y2={height - padding.bottom}
            stroke="var(--color-border, rgba(255, 255, 255, 0.08))"
            strokeDasharray="3,3"
          />
          <text
            x={x}
            y={height - padding.bottom + 15}
            textAnchor="middle"
            fontSize="10"
            fill="var(--color-text-muted, #a1a1aa)"
          >
            {formatValue(value)}
          </text>
        </g>
      );
    }
  }

  const bars: React.ReactNode[] = [];
  allLabels.forEach((label, groupIdx) => {
    let stackOffset = 0;

    series.forEach((s, seriesIdx) => {
      const dataPoint = s.data.find((d) => d.label === label);
      if (!dataPoint) return;

      const value = dataPoint.value;
      const color = dataPoint.color || s.color || defaultColors[seriesIdx % defaultColors.length];
      const barHeight = scaleValue(value);

      let x: number, y: number, w: number, h: number;

      if (stacked) {
        const stackedBarHeight = scaleValue(stackOffset);
        if (orientation === 'vertical') {
          const groupStart = padding.left + groupIdx * groupWidth + groupGap / 2;
          x = groupStart + (availableGroupWidth - barWidth) / 2;
          y = padding.top + chartHeight - stackedBarHeight - barHeight;
          w = barWidth;
          h = barHeight;
        } else {
          const groupStart = padding.top + groupIdx * groupWidth + groupGap / 2;
          x = padding.left + stackedBarHeight;
          y = groupStart + (availableGroupWidth - barWidth) / 2;
          w = barHeight;
          h = barWidth;
        }
        stackOffset += value;
      } else if (orientation === 'vertical') {
        const groupStart = padding.left + groupIdx * groupWidth + groupGap / 2;
        x = groupStart + seriesIdx * (barWidth + barWidth * barPadding);
        y = padding.top + chartHeight - barHeight;
        w = barWidth;
        h = barHeight;
      } else {
        const groupStart = padding.top + groupIdx * groupWidth + groupGap / 2;
        x = padding.left;
        y = groupStart + seriesIdx * (barWidth + barWidth * barPadding);
        w = barHeight;
        h = barWidth;
      }

      const barKey = `${label}-${s.name}`;
      const isHovered = interactive && hoveredBar === barKey;
      const isDimmed = interactive && hoveredBar !== null && !isHovered;

      bars.push(
        <g key={barKey} opacity={isDimmed ? 0.3 : 1} style={{ transition: 'opacity 0.15s ease' }}>
          <rect
            x={x}
            y={y}
            width={w}
            height={h}
            fill={color}
            rx={3}
            ry={3}
            style={{
              cursor: interactive ? 'pointer' : undefined,
              filter: isHovered ? 'brightness(1.2)' : undefined,
              transition: 'filter 0.15s ease',
            }}
            onMouseEnter={interactive ? (e) => {
              setHoveredBar(barKey);
              const svgRect = (e.currentTarget.closest('svg') as SVGSVGElement)?.getBoundingClientRect();
              if (svgRect) {
                setTooltip({
                  x: e.clientX - svgRect.left,
                  y: e.clientY - svgRect.top - 10,
                  label,
                  value,
                  series: s.name,
                  color,
                });
              }
            } : undefined}
            onMouseMove={interactive ? (e) => {
              const svgRect = (e.currentTarget.closest('svg') as SVGSVGElement)?.getBoundingClientRect();
              if (svgRect) {
                setTooltip({
                  x: e.clientX - svgRect.left,
                  y: e.clientY - svgRect.top - 10,
                  label,
                  value,
                  series: s.name,
                  color,
                });
              }
            } : undefined}
            onMouseLeave={interactive ? () => {
              setHoveredBar(null);
              setTooltip(null);
            } : undefined}
          >
            {!interactive && (
              <title>
                {s.name} — {label}: {formatValue(value)}
              </title>
            )}
          </rect>
          {showValues && (
            <text
              x={orientation === 'vertical' ? x + w / 2 : x + w + 5}
              y={orientation === 'vertical' ? y - 5 : y + h / 2}
              textAnchor={orientation === 'vertical' ? 'middle' : 'start'}
              dominantBaseline={orientation === 'vertical' ? 'auto' : 'middle'}
              fontSize="10"
              fill="var(--color-text, #e4e4e7)"
            >
              {formatValue(value)}
            </text>
          )}
        </g>
      );
    });
  });

  const labels: React.ReactNode[] = [];
  allLabels.forEach((label, idx) => {
    if (orientation === 'vertical') {
      const x = padding.left + idx * groupWidth + groupWidth / 2;
      labels.push(
        <text
          key={`label-${idx}`}
          x={x}
          y={height - padding.bottom + 20}
          textAnchor="middle"
          fontSize="11"
          fill="var(--color-text-muted, #a1a1aa)"
        >
          {label}
        </text>
      );
    } else {
      const y = padding.top + idx * groupWidth + groupWidth / 2;
      labels.push(
        <text
          key={`label-${idx}`}
          x={padding.left - 8}
          y={y}
          textAnchor="end"
          dominantBaseline="middle"
          fontSize="11"
          fill="var(--color-text-muted, #a1a1aa)"
        >
          {label}
        </text>
      );
    }
  });

  return (
    <div
      className={`softn-bar-chart ${className}`}
      style={{ position: 'relative', ...style }}
    >
      <svg viewBox={`0 0 ${width} ${height}`} width="100%" preserveAspectRatio="xMidYMid meet">
        {showGrid && gridLines}
        {bars}
        {labels}

        {/* Axes */}
        <line
          x1={padding.left}
          y1={padding.top}
          x2={padding.left}
          y2={height - padding.bottom}
          stroke="var(--color-border, rgba(255, 255, 255, 0.15))"
        />
        <line
          x1={padding.left}
          y1={height - padding.bottom}
          x2={width - padding.right}
          y2={height - padding.bottom}
          stroke="var(--color-border, rgba(255, 255, 255, 0.15))"
        />
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
              borderRadius: '2px',
              backgroundColor: tooltip.color,
              flexShrink: 0,
            }}
          />
          <span>
            <strong>{tooltip.series}</strong> — {tooltip.label}: {formatValue(tooltip.value)}
          </span>
        </div>
      )}

      {showLegend && series.length > 1 && (
        <div
          style={{
            display: 'flex',
            justifyContent: 'center',
            gap: '1rem',
            marginTop: '0.5rem',
            fontSize: '0.8rem',
          }}
        >
          {series.map((s, idx) => (
            <div
              key={s.name}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.3rem',
                opacity: interactive && hoveredBar !== null && !hoveredBar.endsWith(`-${s.name}`) ? 0.4 : 1,
                transition: 'opacity 0.2s ease',
              }}
            >
              <span
                style={{
                  width: '10px',
                  height: '10px',
                  borderRadius: '2px',
                  backgroundColor: s.color || defaultColors[idx % defaultColors.length],
                }}
              />
              <span style={{ color: 'var(--color-text, #e4e4e7)' }}>{s.name}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default BarChart;

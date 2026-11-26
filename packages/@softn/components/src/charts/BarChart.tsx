/**
 * BarChart Component
 *
 * SVG-based bar chart with grouped/stacked modes, interactive hover tooltips,
 * rounded corners, and CSS variable theming.
 */

import * as React from 'react';
import type { ChartPadding } from './series';
import { chartPadding, describeChart, extent, formatAxisValue, formatterOr, normaliseSeries, numericPoints, chartSize } from './series';
import { chartPalette } from '../theme/chart-palette';
import { safeSvgPaint } from '../utils/svgPaint';

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
  padding?: Partial<ChartPadding> | number;
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
  /** Text alternative for the chart; a summary of its values by default */
  ariaLabel?: string;
  className?: string;
  style?: React.CSSProperties;
}

// The theme's series colours (custom properties with the light values as
// fallbacks), so a dark theme is not drawn in a light palette.
const defaultColors = chartPalette();

export function BarChart({
  series: rawSeries,
  width: givenWidth,
  height: givenHeight,
  padding: givenPadding,
  orientation = 'vertical',
  grouped = true,
  stacked = false,
  barPadding = 0.1,
  groupPadding = 0.2,
  showGrid = true,
  showValues = false,
  showLegend = true,
  formatValue: givenFormatValue,
  interactive = false,
  ariaLabel,
  className = '',
  style,
}: BarChartProps) {
  // A size that is no positive number (`width="100%"`) is the chart's own: see chartSize.
  const width = chartSize(givenWidth, 600);
  const height = chartSize(givenHeight, 300);
  const padding = chartPadding(givenPadding, { top: 20, right: 20, bottom: 50, left: 50 });
  const formatValue = formatterOr<NonNullable<BarChartProps['formatValue']>>(givenFormatValue, formatAxisValue);
  // Data that has not arrived yet is an empty chart, not a throw.
  // A value that is not a number is left out; a numeric string ("42", as
  // JSON often has it) is a number, so a stacked total adds rather than
  // concatenates.
  const series = React.useMemo(
    () =>
      normaliseSeries(rawSeries).map((s) => ({
        ...s,
        data: numericPoints(s.data, 'value').map((d) => ({ ...d, label: String(d.label ?? '') })),
      })),
    [rawSeries]
  );
  const [hoveredBar, setHoveredBar] = React.useState<string | null>(null);
  const [tooltip, setTooltip] = React.useState<{ x: number; y: number; label: string; value: number; series: string; color: string } | null>(null);

  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;

  const allLabels = React.useMemo(() => [...new Set(series.flatMap((s) => s.data.map((d) => d.label)))], [series]);
  // Each series' point for each label, the first of any that share one. Found
  // with `.find` for each label of each series, a chart of a thousand bars
  // searched a million times, and again at every step of the pointer.
  const byLabel = React.useMemo(
    () =>
      series.map((s) => {
        const points = new Map<string, (typeof s.data)[number]>();
        for (const d of s.data) if (!points.has(d.label)) points.set(d.label, d);
        return points;
      }),
    [series]
  );

  // Signed value domain.
  //
  // This used to be `Math.max(...values, 0)`, so the domain never went below
  // zero and a negative value scaled to a negative bar height. SVG treats a
  // negative height as an error and skips the element, so a loss simply did
  // not appear — while its axis label still did, making it read as zero. That
  // is the worst possible failure for a chart: confidently wrong.
  //
  // Stacked, a column's gains run up from zero and its losses down from it
  // (see the bars below), so it reaches its gains' total above and its
  // losses' below. Sized for the net total, a gain taller than it ran out of
  // the top of the plot. Read in a loop: spread into Math.min, a long list
  // threw.
  const { minValue, maxValue } = (() => {
    const values = stacked
      ? allLabels.flatMap((label) => {
          let above = 0;
          let below = 0;
          for (const points of byLabel) {
            const value = points.get(label)?.value ?? 0;
            if (value < 0) below += value;
            else above += value;
          }
          return [above, below];
        })
      : series.flatMap((s) => s.data.map((d) => d.value));

    // Zero is always in the domain, so bars have a baseline to grow from.
    const range = extent(values);
    const lo = Math.min(0, range ? range.min : 0);
    const hi = Math.max(0, range ? range.max : 0);
    const paddedLo = lo < 0 ? lo * 1.1 : 0;
    const paddedHi = hi > 0 ? hi * 1.1 : 0;

    // No data, or all zeros.
    if (paddedHi <= paddedLo) return { minValue: 0, maxValue: 1 };

    // Round each end out to a whole tick, as before. An axis of losses only
    // ends at zero: `|| 1` here ended it at 1 (no data is the case above).
    const round = (v: number) => {
      if (v === 0) return 0;
      const step = Math.pow(10, Math.floor(Math.log10(Math.abs(v) / 5))) || 1;
      return v > 0 ? Math.ceil(v / step) * step : Math.floor(v / step) * step;
    };
    return { minValue: round(paddedLo), maxValue: round(paddedHi) };
  })();

  const valueSpan = maxValue - minValue || 1;

  const numGroups = allLabels.length;
  const numBarsPerGroup = stacked ? 1 : grouped ? series.length : 1;

  const groupWidth = (orientation === 'vertical' ? chartWidth : chartHeight) / numGroups;
  const groupGap = groupWidth * groupPadding;
  const availableGroupWidth = groupWidth - groupGap;
  const barWidth = Math.max(1, (availableGroupWidth / numBarsPerGroup) * (1 - barPadding));
  /**
   * A bar's place across its category. Grouped, side by side; not grouped,
   * one over another in the middle, as a stacked column is: each series was
   * still put a bar further along, into the next category and past the plot.
   */
  const barOffset = (seriesIdx: number): number =>
    grouped ? seriesIdx * (barWidth + barWidth * barPadding) : (availableGroupWidth - barWidth) / 2;

  const axisExtent = orientation === 'vertical' ? chartHeight : chartWidth;

  /** Pixels from the domain floor to a value. */
  const scaleValue = (v: number): number => ((v - minValue) / valueSpan) * axisExtent;

  /** Where zero sits, so bars can be drawn from it in either direction. */
  const zeroOffset = scaleValue(0);

  const gridLines: React.ReactNode[] = [];
  const numGridLines = 5;
  for (let i = 0; i <= numGridLines; i++) {
    const value = minValue + (i / numGridLines) * valueSpan;
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

  // The bars, made again when the data, the scale or the bar under the
  // pointer changes; not at each step of the pointer across a bar, which
  // only moves the tooltip.
  const bars = React.useMemo(() => {
  const drawn: React.ReactNode[] = [];
  allLabels.forEach((label, groupIdx) => {
    // A gain stands on the gains before it and a loss hangs from the losses
    // before it. Run as one total, a loss was drawn back over the gain
    // beneath it.
    let above = 0;
    let below = 0;

    series.forEach((s, seriesIdx) => {
      const dataPoint = byLabel[seriesIdx].get(label);
      if (!dataPoint) return;

      const value = dataPoint.value;
      const fallbackColor = defaultColors[seriesIdx % defaultColors.length];
      const color = safeSvgPaint(dataPoint.color || s.color, fallbackColor);

      // A bar runs between the zero baseline and its value, in whichever
      // direction that is. Taking the span between the two ends rather than
      // the raw scaled value is what keeps the geometry non-negative when the
      // value is.
      const tip = scaleValue(value);
      const near = Math.min(zeroOffset, tip);
      const far = Math.max(zeroOffset, tip);
      const barLength = far - near;

      let x: number, y: number, w: number, h: number;

      if (stacked) {
        // Stacked segments sit end to end from the running total of their sign.
        const base = value < 0 ? below : above;
        const from = scaleValue(base);
        const to = scaleValue(base + value);
        const segNear = Math.min(from, to);
        const segLength = Math.abs(to - from);

        if (orientation === 'vertical') {
          const groupStart = padding.left + groupIdx * groupWidth + groupGap / 2;
          x = groupStart + (availableGroupWidth - barWidth) / 2;
          y = padding.top + chartHeight - segNear - segLength;
          w = barWidth;
          h = segLength;
        } else {
          const groupStart = padding.top + groupIdx * groupWidth + groupGap / 2;
          x = padding.left + segNear;
          y = groupStart + (availableGroupWidth - barWidth) / 2;
          w = segLength;
          h = barWidth;
        }
        if (value < 0) below += value;
        else above += value;
      } else if (orientation === 'vertical') {
        const groupStart = padding.left + groupIdx * groupWidth + groupGap / 2;
        x = groupStart + barOffset(seriesIdx);
        y = padding.top + chartHeight - far;
        w = barWidth;
        h = barLength;
      } else {
        const groupStart = padding.top + groupIdx * groupWidth + groupGap / 2;
        x = padding.left + near;
        y = groupStart + barOffset(seriesIdx);
        w = barLength;
        h = barWidth;
      }

      const barKey = `${groupIdx}-${seriesIdx}`;
      const isHovered = interactive && hoveredBar === barKey;
      const isDimmed = interactive && hoveredBar !== null && !isHovered;

      drawn.push(
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
  return drawn;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allLabels, series, byLabel, stacked, grouped, orientation, padding.left, padding.top, chartWidth, chartHeight, minValue, maxValue, barPadding, groupPadding, interactive, hoveredBar, showValues, formatValue]);

  // A label for each category, made again only when they or the layout change.
  const labels = React.useMemo(() => {
  const drawn: React.ReactNode[] = [];
  allLabels.forEach((label, idx) => {
    if (orientation === 'vertical') {
      const x = padding.left + idx * groupWidth + groupWidth / 2;
      drawn.push(
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
      drawn.push(
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
  return drawn;
  }, [allLabels, orientation, padding.left, padding.top, padding.bottom, height, groupWidth]);

  // Every bar read out, so written again only when they or their format change.
  const summary = React.useMemo(
    () =>
      ariaLabel ??
      describeChart(
        stacked ? 'Stacked bar chart' : 'Bar chart',
        series.map((s) => ({ name: s.name, values: s.data.map((d) => `${d.label} ${formatValue(d.value)}`) }))
      ),
    [ariaLabel, stacked, series, formatValue]
  );

  return (
    <div
      className={`softn-bar-chart ${className}`}
      style={{ position: 'relative', ...style }}
    >
      <svg
        viewBox={`0 0 ${width} ${height}`}
        width="100%"
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label={summary}
      >
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
              key={`${idx}-${s.name}`}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.3rem',
                opacity: interactive && hoveredBar !== null && hoveredBar.split('-')[1] !== String(idx) ? 0.4 : 1,
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

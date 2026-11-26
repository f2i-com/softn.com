/**
 * LineChart Component
 *
 * SVG-based line chart with smooth curves, interactive crosshair tooltips,
 * hover animations, and CSS variable theming.
 */

import * as React from 'react';
import type { ChartPadding } from './series';
import { chartPadding, describeChart, extent, formatAxisValue, formatterOr, layoutX, normaliseSeries, numericPoints, chartSize } from './series';
import { chartPalette } from '../theme/chart-palette';
import { safeSvgPaint } from '../utils/svgPaint';

/** An x label as it is, when the page gives no formatter: one function, so what is built from it is not built again. */
const formatXValue = (value: number | string): string => String(value);

export interface DataPoint {
  x: number | string;
  y: number;
  label?: string;
}

export interface LineChartSeries {
  name: string;
  data: DataPoint[];
  color?: string;
  strokeWidth?: number;
  showDots?: boolean;
  dotSize?: number;
  fill?: boolean;
  fillOpacity?: number;
  smooth?: boolean;
}

export interface LineChartProps {
  series: LineChartSeries[];
  width?: number;
  height?: number;
  padding?: Partial<ChartPadding> | number;
  showGrid?: boolean;
  showXAxis?: boolean;
  showYAxis?: boolean;
  showLegend?: boolean;
  xAxisLabel?: string;
  yAxisLabel?: string;
  yMin?: number;
  yMax?: number;
  formatXLabel?: (value: number | string) => string;
  formatYLabel?: (value: number) => string;
  interactive?: boolean;
  /** Text alternative for the chart; a summary of its values by default */
  ariaLabel?: string;
  className?: string;
  style?: React.CSSProperties;
}

// The theme's series colours (custom properties with the light values as
// fallbacks), so a dark theme is not drawn in a light palette.
const defaultColors = chartPalette();

export function LineChart({
  series: rawSeries,
  width: givenWidth,
  height: givenHeight,
  padding: givenPadding,
  showGrid = true,
  showXAxis = true,
  showYAxis = true,
  showLegend = true,
  xAxisLabel,
  yAxisLabel,
  yMin: propYMin,
  yMax: propYMax,
  formatXLabel: givenFormatXLabel,
  formatYLabel: givenFormatYLabel,
  interactive = false,
  ariaLabel,
  className = '',
  style,
}: LineChartProps) {
  // A size that is no positive number (`width="100%"`) is the chart's own: see chartSize.
  const width = chartSize(givenWidth, 600);
  const height = chartSize(givenHeight, 300);
  const padding = chartPadding(givenPadding, { top: 20, right: 20, bottom: 40, left: 50 });
  const formatXLabel = formatterOr<NonNullable<LineChartProps['formatXLabel']>>(givenFormatXLabel, formatXValue);
  const formatYLabel = formatterOr<NonNullable<LineChartProps['formatYLabel']>>(givenFormatYLabel, formatAxisValue);
  // Data that has not arrived yet is an empty chart, not a throw.
  // A point whose y is not a number is left out rather than drawn at NaN.
  const series = React.useMemo(
    () => normaliseSeries(rawSeries).map((s) => ({ ...s, data: numericPoints(s.data, 'y') })),
    [rawSeries]
  );
  const xLayout = React.useMemo(() => layoutX(series), [series]);
  const [hoveredSeries, setHoveredSeries] = React.useState<number | null>(null);
  // The x under the pointer, as a position on the axis (XLayout). It was a
  // point's place in the first series, and the tooltip gave every other
  // series' point at that place, whatever x that point was at.
  const [hoveredX, setHoveredX] = React.useState<number | null>(null);
  const svgRef = React.useRef<SVGSVGElement>(null);

  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;

  // A chart is routinely bound to data that has not arrived yet. `Math.max()`
  // of nothing is -Infinity, which is truthy, so the `|| 1` guards below never
  // fired and the axis rendered "-Infinityk" above five NaN ticks.
  const yExtent = React.useMemo(() => extent(series.flatMap((s) => s.data.map((p) => p.y))), [series]);
  const { min: xMin, max: xMax } = xLayout;

  // Pad away from zero at each end, rather than scaling both ends by 1.1.
  //
  // Multiplying a negative maximum by 1.1 moves it *down*: an all-negative
  // series like [-100, -105] produced a max of -110 below its own min of -105,
  // so the top of the axis sat beneath the bottom and every point mapped off
  // the canvas — the axis read -110 at the top while the line was nowhere.
  const dataMin = yExtent ? yExtent.min : 0;
  const dataMax = yExtent ? yExtent.max : 0;
  const lo = Math.min(0, dataMin);
  const hi = Math.max(0, dataMax);
  const paddedMin = lo < 0 ? lo * 1.1 : lo;
  const paddedMax = hi > 0 ? hi * 1.1 : hi;

  // All zeros, or no data at all: a unit domain keeps the maths finite.
  const [rawYMin, rawYMax] = paddedMax > paddedMin ? [paddedMin, paddedMax] : [0, 1];
  const yRange = rawYMax - rawYMin || 1;
  const tickStep = Math.pow(10, Math.floor(Math.log10(yRange / 5))) * Math.ceil((yRange / 5) / Math.pow(10, Math.floor(Math.log10(yRange / 5)))) || 1;
  const yMin = propYMin ?? Math.floor(rawYMin / tickStep) * tickStep;
  // An axis of losses only ends at zero. With `|| 1` here (the unit domain
  // above already covers no data) it ended at 1, its ticks between at -23.2
  // and -47.4.
  const yMax = propYMax ?? Math.ceil(rawYMax / tickStep) * tickStep;

  const scaleX = (position: number): number => {
    return padding.left + ((position - xMin) / (xMax - xMin || 1)) * chartWidth;
  };
  const pointX = (seriesIndex: number, index: number): number => scaleX(xLayout.position(seriesIndex, index));

  const scaleY = (y: number): number => {
    return padding.top + chartHeight - ((y - yMin) / (yMax - yMin || 1)) * chartHeight;
  };

  const generatePath = (data: DataPoint[], seriesIndex: number, smooth = false): string => {
    if (data.length === 0) return '';
    const points = data.map((point, idx) => ({
      x: pointX(seriesIndex, idx),
      y: scaleY(point.y),
    }));

    if (!smooth || points.length < 3) {
      return points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ');
    }

    let path = `M ${points[0].x} ${points[0].y}`;
    for (let i = 0; i < points.length - 1; i++) {
      const p0 = points[Math.max(i - 1, 0)];
      const p1 = points[i];
      const p2 = points[i + 1];
      const p3 = points[Math.min(i + 2, points.length - 1)];

      const cp1x = p1.x + (p2.x - p0.x) / 6;
      const cp1y = p1.y + (p2.y - p0.y) / 6;
      const cp2x = p2.x - (p3.x - p1.x) / 6;
      const cp2y = p2.y - (p3.y - p1.y) / 6;

      path += ` C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${p2.x} ${p2.y}`;
    }
    return path;
  };

  const generateFillPath = (data: DataPoint[], seriesIndex: number, smooth = false): string => {
    if (data.length === 0) return '';
    const linePath = generatePath(data, seriesIndex, smooth);
    const lastX = pointX(seriesIndex, data.length - 1);
    const firstX = pointX(seriesIndex, 0);
    const baseline = scaleY(yMin);
    return `${linePath} L ${lastX} ${baseline} L ${firstX} ${baseline} Z`;
  };

  // The x nearest the pointer, of every x the series have between them.
  const findClosestX = React.useCallback(
    (mouseX: number): number | null => {
      let closest: number | null = null;
      let closestDist = Infinity;
      for (const { position } of xLayout.ticks) {
        const dist = Math.abs(scaleX(position) - mouseX);
        if (dist < closestDist) {
          closestDist = dist;
          closest = position;
        }
      }
      return closest;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [xLayout, padding.left, chartWidth]
  );

  const handleMouseMove = React.useCallback(
    (e: React.MouseEvent<SVGSVGElement>) => {
      if (!interactive) return;
      const svg = svgRef.current;
      if (!svg) return;
      const rect = svg.getBoundingClientRect();
      const scaleFactorX = width / rect.width;
      const mouseX = (e.clientX - rect.left) * scaleFactorX;
      setHoveredX(findClosestX(mouseX));
    },
    [interactive, findClosestX, width]
  );

  const handleMouseLeave = React.useCallback(() => {
    if (!interactive) return;
    setHoveredX(null);
    setHoveredSeries(null);
  }, [interactive]);

  // Each series' point at each x, to find the ones under the pointer.
  const indexAtX = React.useMemo(
    () =>
      series.map((s, seriesIndex) => {
        const at = new Map<number, number>();
        s.data.forEach((_point, idx) => {
          const position = xLayout.position(seriesIndex, idx);
          if (!at.has(position)) at.set(position, idx);
        });
        return at;
      }),
    [series, xLayout]
  );
  const hoveredTick = hoveredX === null ? undefined : xLayout.ticks.find((tick) => tick.position === hoveredX);
  const hoveredIndex = (seriesIndex: number): number | undefined =>
    hoveredTick ? indexAtX[seriesIndex]?.get(hoveredTick.position) : undefined;

  // The lines and their dots, made again only when the data or the scale
  // changes. Made in every render, each step of the pointer across the plot
  // built every path again and redrew every dot. The dot under the pointer
  // is drawn larger over its own.
  const plotted = React.useMemo(
    () =>
      series.map((s, seriesIndex) => {
        const color = safeSvgPaint(s.color, defaultColors[seriesIndex % defaultColors.length]);
        return {
          color,
          fill: s.fill ? generateFillPath(s.data, seriesIndex, s.smooth) : '',
          line: generatePath(s.data, seriesIndex, s.smooth),
          dots:
            (s.showDots ?? true) &&
            s.data.map((point, idx) => (
              <circle
                key={idx}
                cx={pointX(seriesIndex, idx)}
                cy={scaleY(point.y)}
                r={s.dotSize ?? 3}
                fill={color}
                stroke="none"
                strokeWidth={0}
                style={{
                  transition: 'r 0.15s ease, stroke-width 0.15s ease',
                  cursor: interactive ? 'pointer' : undefined,
                }}
                onMouseEnter={interactive ? () => setHoveredSeries(seriesIndex) : undefined}
                onMouseLeave={interactive ? () => setHoveredSeries(null) : undefined}
              >
                {!interactive && <title>{point.label ?? `${point.x}: ${point.y}`}</title>}
              </circle>
            )),
        };
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [series, xLayout, padding.left, padding.top, chartWidth, chartHeight, yMin, yMax, interactive]
  );

  const gridLines: React.ReactNode[] = [];
  const numGridLines = 5;
  for (let i = 0; i <= numGridLines; i++) {
    const y = padding.top + (i / numGridLines) * chartHeight;
    gridLines.push(
      <line
        key={`grid-${i}`}
        x1={padding.left}
        y1={y}
        x2={width - padding.right}
        y2={y}
        stroke="var(--color-border, rgba(255, 255, 255, 0.08))"
        strokeDasharray="3,3"
      />
    );
  }

  const yAxisLabels: React.ReactNode[] = [];
  for (let i = 0; i <= numGridLines; i++) {
    const value = yMax - (i / numGridLines) * (yMax - yMin);
    const y = padding.top + (i / numGridLines) * chartHeight;
    yAxisLabels.push(
      <text
        key={`y-label-${i}`}
        x={padding.left - 8}
        y={y}
        textAnchor="end"
        dominantBaseline="middle"
        fontSize="10"
        fill="var(--color-text-muted, #a1a1aa)"
      >
        {formatYLabel(value)}
      </text>
    );
  }

  const xAxisLabels: React.ReactNode[] = [];
  const maxLabels = Math.max(1, Math.floor(chartWidth / 60));
  const step = Math.max(1, Math.ceil(xLayout.ticks.length / maxLabels));
  xLayout.ticks.forEach(({ value: x, position }, idx) => {
    if (idx % step === 0) {
      const xPos = scaleX(position);
      xAxisLabels.push(
        <text
          key={`x-label-${idx}`}
          x={xPos}
          y={height - padding.bottom + 18}
          textAnchor="middle"
          fontSize="10"
          fill="var(--color-text-muted, #a1a1aa)"
        >
          {formatXLabel(x)}
        </text>
      );
    }
  });

  // Every point read out, so written again only when they or their formats change.
  const label = React.useMemo(
    () =>
      ariaLabel ??
      describeChart(
        'Line chart',
        series.map((s) => ({ name: s.name, values: s.data.map((p) => `${formatXLabel(p.x)} ${formatYLabel(p.y)}`) }))
      ),
    [ariaLabel, series, formatXLabel, formatYLabel]
  );

  // Crosshair vertical line at hovered point
  const crosshairX = hoveredTick ? scaleX(hoveredTick.position) : null;

  return (
    <div className={`softn-line-chart ${className}`} style={{ position: 'relative', ...style }}>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${width} ${height}`}
        width="100%"
        preserveAspectRatio="xMidYMid meet"
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
        role="img"
        aria-label={label}
      >
        {showGrid && gridLines}

        {showYAxis && (
          <>
            <line
              x1={padding.left}
              y1={padding.top}
              x2={padding.left}
              y2={height - padding.bottom}
              stroke="var(--color-border, rgba(255, 255, 255, 0.15))"
              strokeWidth={1}
            />
            {yAxisLabels}
            {yAxisLabel && (
              <text
                x={15}
                y={height / 2}
                textAnchor="middle"
                fontSize="11"
                fill="var(--color-text, #e4e4e7)"
                transform={`rotate(-90, 15, ${height / 2})`}
              >
                {yAxisLabel}
              </text>
            )}
          </>
        )}

        {showXAxis && (
          <>
            <line
              x1={padding.left}
              y1={height - padding.bottom}
              x2={width - padding.right}
              y2={height - padding.bottom}
              stroke="var(--color-border, rgba(255, 255, 255, 0.15))"
              strokeWidth={1}
            />
            {xAxisLabels}
            {xAxisLabel && (
              <text x={width / 2} y={height - 5} textAnchor="middle" fontSize="11" fill="var(--color-text, #e4e4e7)">
                {xAxisLabel}
              </text>
            )}
          </>
        )}

        {/* Crosshair vertical guideline */}
        {interactive && crosshairX !== null && (
          <line
            x1={crosshairX}
            y1={padding.top}
            x2={crosshairX}
            y2={height - padding.bottom}
            stroke="var(--color-text-muted, rgba(255, 255, 255, 0.25))"
            strokeWidth={1}
            strokeDasharray="4,4"
            style={{ pointerEvents: 'none' }}
          />
        )}

        {series.map((s, seriesIndex) => {
          const { color, fill, line, dots } = plotted[seriesIndex];
          const isDimmed = interactive && hoveredSeries !== null && hoveredSeries !== seriesIndex;
          const hoveredIdx = interactive ? hoveredIndex(seriesIndex) : undefined;
          const hoveredPoint = hoveredIdx === undefined ? undefined : s.data[hoveredIdx];
          return (
            <g
              key={`${seriesIndex}-${s.name}`}
              opacity={isDimmed ? 0.25 : 1}
              style={{ transition: 'opacity 0.2s ease' }}
            >
              {s.fill && <path d={fill} fill={color} fillOpacity={s.fillOpacity ?? 0.1} />}
              <path
                d={line}
                fill="none"
                stroke={color}
                strokeWidth={s.strokeWidth ?? 2}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              {dots}
              {dots && hoveredPoint && hoveredIdx !== undefined && (
                <circle
                  cx={pointX(seriesIndex, hoveredIdx)}
                  cy={scaleY(hoveredPoint.y)}
                  r={(s.dotSize ?? 3) + 2.5}
                  fill={color}
                  stroke="var(--color-bg, #18181b)"
                  strokeWidth={2}
                  style={{ pointerEvents: 'none' }}
                />
              )}
            </g>
          );
        })}
      </svg>

      {/* Crosshair tooltip */}
      {interactive && hoveredTick && crosshairX !== null && (
        <div
          style={{
            position: 'absolute',
            left: `${(crosshairX / width) * 100}%`,
            top: '0',
            transform: 'translateX(-50%)',
            backgroundColor: 'var(--color-surface, rgba(24, 24, 27, 0.95))',
            color: 'var(--color-text, #e4e4e7)',
            border: '1px solid var(--color-border, rgba(255, 255, 255, 0.1))',
            borderRadius: '8px',
            padding: '8px 12px',
            fontSize: '12px',
            whiteSpace: 'nowrap',
            pointerEvents: 'none',
            zIndex: 10,
            boxShadow: '0 4px 12px rgba(0, 0, 0, 0.4)',
            lineHeight: '1.5',
          }}
        >
          <div style={{ fontWeight: 600, marginBottom: '2px', color: 'var(--color-text-muted, #a1a1aa)', fontSize: '11px' }}>
            {formatXLabel(hoveredTick.value)}
          </div>
          {series.map((s, seriesIndex) => {
            const color = s.color || defaultColors[seriesIndex % defaultColors.length];
            const idx = hoveredIndex(seriesIndex);
            const point = idx === undefined ? undefined : s.data[idx];
            if (!point) return null;
            return (
              <div key={`${seriesIndex}-${s.name}`} style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <span
                  style={{
                    width: '8px',
                    height: '8px',
                    borderRadius: '50%',
                    backgroundColor: color,
                    flexShrink: 0,
                  }}
                />
                <span>{s.name}:</span>
                <span style={{ fontWeight: 600 }}>{formatYLabel(point.y)}</span>
              </div>
            );
          })}
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
          {series.map((s, idx) => {
            const color = s.color || defaultColors[idx % defaultColors.length];
            const isActive = hoveredSeries === null || hoveredSeries === idx;
            return (
              <div
                key={`${idx}-${s.name}`}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.3rem',
                  opacity: isActive ? 1 : 0.4,
                  cursor: interactive ? 'pointer' : undefined,
                  transition: 'opacity 0.2s ease',
                }}
                onMouseEnter={interactive ? () => setHoveredSeries(idx) : undefined}
                onMouseLeave={interactive ? () => setHoveredSeries(null) : undefined}
              >
                <span
                  style={{
                    width: '10px',
                    height: '3px',
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

export default LineChart;

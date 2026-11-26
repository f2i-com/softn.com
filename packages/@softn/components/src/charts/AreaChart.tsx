/**
 * AreaChart Component
 *
 * A LineChart variant with fill by default, stacked mode, and gradient fills.
 * Supports smooth Catmull-Rom curves, interactive crosshair tooltips, and CSS variable theming.
 */

import * as React from 'react';
import type { DataPoint } from './LineChart';
import type { ChartPadding } from './series';
import { chartPadding, describeChart, extent, formatAxisValue, formatterOr, layoutX, normaliseSeries, numericPoints, chartSize } from './series';
import { chartPalette } from '../theme/chart-palette';
import { safeSvgPaint } from '../utils/svgPaint';

/** An x label as it is, when the page gives no formatter: one function, so what is built from it is not built again. */
const formatXValue = (value: number | string): string => String(value);

export interface AreaChartSeries {
  name: string;
  data: DataPoint[];
  color?: string;
  strokeWidth?: number;
  fillOpacity?: number;
  smooth?: boolean;
}

export interface AreaChartProps {
  series: AreaChartSeries[];
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
  stacked?: boolean;
  gradient?: boolean;
  interactive?: boolean;
  /** Text alternative for the chart; a summary of its values by default */
  ariaLabel?: string;
  className?: string;
  style?: React.CSSProperties;
}

// The theme's series colours (custom properties with the light values as
// fallbacks), so a dark theme is not drawn in a light palette.
const defaultColors = chartPalette();

export function AreaChart({
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
  stacked = false,
  gradient = false,
  interactive = false,
  ariaLabel,
  className = '',
  style,
}: AreaChartProps) {
  // A size that is no positive number (`width="100%"`) is the chart's own: see chartSize.
  const width = chartSize(givenWidth, 600);
  const height = chartSize(givenHeight, 300);
  const padding = chartPadding(givenPadding, { top: 20, right: 20, bottom: 40, left: 50 });
  const formatXLabel = formatterOr<NonNullable<AreaChartProps['formatXLabel']>>(givenFormatXLabel, formatXValue);
  const formatYLabel = formatterOr<NonNullable<AreaChartProps['formatYLabel']>>(givenFormatYLabel, formatAxisValue);
  // Data that has not arrived yet is an empty chart, not a throw.
  // A point whose y is not a number is left out rather than drawn at NaN.
  const series = React.useMemo(
    () => normaliseSeries(rawSeries).map((s) => ({ ...s, data: numericPoints(s.data, 'y') })),
    [rawSeries]
  );
  const xLayout = React.useMemo(() => layoutX(series), [series]);
  const [hoveredIndex, setHoveredIndex] = React.useState<number | null>(null);
  // The x under the pointer, as a position on the axis: see LineChart.
  const [hoveredX, setHoveredX] = React.useState<number | null>(null);
  const chartId = React.useId();
  const svgRef = React.useRef<SVGSVGElement>(null);

  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;

  // Compute stacked data
  //
  // Each series stands on the ones before it at the same x, over every x any
  // of them has, in order along the axis; one with no point at an x adds
  // nothing there. Stacked by a point's place in its list, a series that
  // began a category late, or had a reading with no value (left out of its
  // points), stood on another x's column and was drawn at that x.
  const stackedData = React.useMemo(() => {
    if (!stacked) return null;

    const positions = [...new Set(series.flatMap((s, si) => s.data.map((_p, di) => xLayout.position(si, di))))].sort((a, b) => a - b);
    const below = new Map<number, number>();
    return series.map((s, si) => {
      const own = new Map<number, number>();
      s.data.forEach((point, di) => {
        const at = xLayout.position(si, di);
        if (!own.has(at)) own.set(at, point.y);
      });
      const top = new Map<number, number>();
      const points = positions.map((at) => {
        const y = (below.get(at) ?? 0) + (own.get(at) ?? 0);
        below.set(at, y);
        top.set(at, y);
        return { at, y };
      });
      return { points, top };
    });
  }, [series, stacked, xLayout]);

  const allYValues = React.useMemo(() => {
    if (stacked && stackedData) {
      return stackedData.flatMap((sd) => sd.points.map((p) => p.y));
    }
    return series.flatMap((s) => s.data.map((p) => p.y));
  }, [series, stacked, stackedData]);

  // Same reasoning as LineChart: `Math.max()` of nothing is -Infinity, and
  // scaling a negative maximum by 1.1 moves it below the minimum, inverting
  // the domain so every point maps off the canvas.
  const yExtent = React.useMemo(() => extent(allYValues), [allYValues]);
  const { min: xMin, max: xMax } = xLayout;

  const dataMin = yExtent ? yExtent.min : 0;
  const dataMax = yExtent ? yExtent.max : 0;
  const lo = Math.min(0, dataMin);
  const hi = Math.max(0, dataMax);
  const paddedMin = lo < 0 ? lo * 1.1 : lo;
  const paddedMax = hi > 0 ? hi * 1.1 : hi;

  const [rawYMin, rawYMax] = paddedMax > paddedMin ? [paddedMin, paddedMax] : [0, 1];
  const yRange = rawYMax - rawYMin || 1;
  const tickStep = Math.pow(10, Math.floor(Math.log10(yRange / 5))) * Math.ceil((yRange / 5) / Math.pow(10, Math.floor(Math.log10(yRange / 5)))) || 1;
  const yMin = propYMin ?? Math.floor(rawYMin / tickStep) * tickStep;
  // An axis of losses only ends at zero, not at 1: see LineChart.
  const yMax = propYMax ?? Math.ceil(rawYMax / tickStep) * tickStep;

  const scaleX = (position: number): number => {
    return padding.left + ((position - xMin) / (xMax - xMin || 1)) * chartWidth;
  };
  const pointX = (seriesIndex: number, index: number): number => scaleX(xLayout.position(seriesIndex, index));

  const scaleY = (y: number): number => {
    return padding.top + chartHeight - ((y - yMin) / (yMax - yMin || 1)) * chartHeight;
  };

  const generatePath = (
    points: { x: number; y: number }[],
    smooth = true
  ): string => {
    if (points.length === 0) return '';

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

  const generateFillPath = (
    topPoints: { x: number; y: number }[],
    bottomPoints: { x: number; y: number }[] | null,
    smooth = true
  ): string => {
    if (topPoints.length === 0) return '';

    const topPath = generatePath(topPoints, smooth);

    if (bottomPoints && bottomPoints.length > 0) {
      const reversedBottom = [...bottomPoints].reverse();
      const bottomPath = generatePath(reversedBottom, smooth);
      return `${topPath} L ${reversedBottom[0].x} ${reversedBottom[0].y} ${bottomPath.substring(bottomPath.indexOf(' ') + 1)} Z`;
    }

    const lastX = topPoints[topPoints.length - 1].x;
    const firstX = topPoints[0].x;
    const baseline = scaleY(yMin);
    return `${topPath} L ${lastX} ${baseline} L ${firstX} ${baseline} Z`;
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
    setHoveredIndex(null);
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
  const hoveredPointOf = (seriesIndex: number): number | undefined =>
    hoveredTick ? indexAtX[seriesIndex]?.get(hoveredTick.position) : undefined;
  /** Where a series' point is drawn: on the stack, when stacked. */
  const dotY = (seriesIndex: number, idx: number): number =>
    stackedData
      ? scaleY(stackedData[seriesIndex].top.get(xLayout.position(seriesIndex, idx)) ?? 0)
      : scaleY(series[seriesIndex].data[idx].y);

  // Grid lines
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

  // Y-axis labels
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

  // X-axis labels
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

  // Build gradient defs
  const gradientDefs = gradient
    ? series.map((s, seriesIndex) => {
        const color = safeSvgPaint(s.color, defaultColors[seriesIndex % defaultColors.length]);
        return (
          <linearGradient
            key={`gradient-${seriesIndex}`}
            id={`area-grad-${chartId}-${seriesIndex}`}
            x1="0"
            y1="0"
            x2="0"
            y2="1"
          >
            <stop offset="0%" stopColor={color} stopOpacity={s.fillOpacity ?? 0.6} />
            <stop offset="100%" stopColor={color} stopOpacity={0.02} />
          </linearGradient>
        );
      })
    : null;

  // Crosshair x position
  const crosshairX = hoveredTick ? scaleX(hoveredTick.position) : null;

  // The areas, lines and dots, made again only when the data or the scale
  // changes, not at each step of the pointer (see LineChart). The dot under
  // the pointer is drawn larger over its own.
  const plotted = React.useMemo(
    () =>
      series.map((s, seriesIndex) => {
        const color = safeSvgPaint(s.color, defaultColors[seriesIndex % defaultColors.length]);
        const smooth = s.smooth ?? true;
        let topPoints: { x: number; y: number }[];
        let bottomPoints: { x: number; y: number }[] | null = null;

        if (stackedData) {
          topPoints = stackedData[seriesIndex].points.map((p) => ({ x: scaleX(p.at), y: scaleY(p.y) }));
          if (seriesIndex > 0) {
            bottomPoints = stackedData[seriesIndex - 1].points.map((p) => ({ x: scaleX(p.at), y: scaleY(p.y) }));
          }
        } else {
          topPoints = s.data.map((point, idx) => ({
            x: pointX(seriesIndex, idx),
            y: scaleY(point.y),
          }));
        }

        return {
          color,
          line: generatePath(topPoints, smooth),
          fill: generateFillPath(topPoints, bottomPoints, smooth),
          dots: s.data.map((point, idx) => (
            <circle
              key={idx}
              cx={pointX(seriesIndex, idx)}
              cy={dotY(seriesIndex, idx)}
              r={3}
              fill={color}
              stroke="none"
              strokeWidth={0}
              style={{
                transition: 'r 0.15s ease, stroke-width 0.15s ease',
                cursor: interactive ? 'pointer' : undefined,
              }}
              onMouseEnter={interactive ? () => setHoveredIndex(seriesIndex) : undefined}
              onMouseLeave={interactive ? () => setHoveredIndex(null) : undefined}
            >
              <title>{point.label ?? `${s.name} - ${point.x}: ${point.y}`}</title>
            </circle>
          )),
        };
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [series, stackedData, xLayout, padding.left, padding.top, chartWidth, chartHeight, yMin, yMax, interactive]
  );

  // Render series
  const renderedSeries = series.map((s, seriesIndex) => {
    const { color, line, fill, dots } = plotted[seriesIndex];
    const fillOpacity = s.fillOpacity ?? 0.3;
    const isHovered = hoveredIndex === null || hoveredIndex === seriesIndex;
    const seriesOpacity = interactive && hoveredIndex !== null && !isHovered ? 0.25 : 1;
    const fillColor = gradient ? `url(#area-grad-${chartId}-${seriesIndex})` : color;
    const hoveredIdx = interactive ? hoveredPointOf(seriesIndex) : undefined;

    return (
      <g key={`${seriesIndex}-${s.name}`} opacity={seriesOpacity} style={{ transition: 'opacity 0.2s ease' }}>
        <path
          d={fill}
          fill={fillColor}
          fillOpacity={gradient ? 1 : fillOpacity}
        />
        <path
          d={line}
          fill="none"
          stroke={color}
          strokeWidth={s.strokeWidth ?? 2}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        {dots}
        {hoveredIdx !== undefined && (
          <circle
            cx={pointX(seriesIndex, hoveredIdx)}
            cy={dotY(seriesIndex, hoveredIdx)}
            r={5.5}
            fill={color}
            stroke="var(--color-bg, #18181b)"
            strokeWidth={2}
            style={{ pointerEvents: 'none' }}
          />
        )}
      </g>
    );
  });

  // Every point read out, so written again only when they or their formats change.
  const label = React.useMemo(
    () =>
      ariaLabel ??
      describeChart(
        stacked ? 'Stacked area chart' : 'Area chart',
        series.map((s) => ({ name: s.name, values: s.data.map((p) => `${formatXLabel(p.x)} ${formatYLabel(p.y)}`) }))
      ),
    [ariaLabel, stacked, series, formatXLabel, formatYLabel]
  );

  return (
    <div className={`softn-area-chart ${className}`} style={{ position: 'relative', ...style }}>
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
        {gradient && <defs>{gradientDefs}</defs>}

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

        {renderedSeries}
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
            // The colour its area is drawn in: `s.color` as given was another
            // colour wherever the area could not take it (safeSvgPaint).
            const { color } = plotted[seriesIndex];
            const idx = hoveredPointOf(seriesIndex);
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
            const { color } = plotted[idx];
            const isActive = hoveredIndex === null || hoveredIndex === idx;
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
                onMouseEnter={interactive ? () => setHoveredIndex(idx) : undefined}
                onMouseLeave={interactive ? () => setHoveredIndex(null) : undefined}
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

export default AreaChart;

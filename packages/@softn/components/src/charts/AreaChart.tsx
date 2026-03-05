/**
 * AreaChart Component
 *
 * A LineChart variant with fill by default, stacked mode, and gradient fills.
 * Supports smooth Catmull-Rom curves, interactive crosshair tooltips, and CSS variable theming.
 */

import * as React from 'react';
import type { DataPoint } from './LineChart';

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
  padding?: { top: number; right: number; bottom: number; left: number };
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
  className?: string;
  style?: React.CSSProperties;
}

const defaultColors = ['#6366f1', '#ef4444', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899'];

export function AreaChart({
  series,
  width = 600,
  height = 300,
  padding = { top: 20, right: 20, bottom: 40, left: 50 },
  showGrid = true,
  showXAxis = true,
  showYAxis = true,
  showLegend = true,
  xAxisLabel,
  yAxisLabel,
  yMin: propYMin,
  yMax: propYMax,
  formatXLabel = (v) => String(v),
  formatYLabel = (v: number) => {
    if (Math.abs(v) >= 1000) return `${(v / 1000).toFixed(v % 1000 === 0 ? 0 : 1)}k`;
    const rounded = Math.round(v * 100) / 100;
    return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
  },
  stacked = false,
  gradient = false,
  interactive = false,
  className = '',
  style,
}: AreaChartProps) {
  const [hoveredIndex, setHoveredIndex] = React.useState<number | null>(null);
  const [hoveredPointIndex, setHoveredPointIndex] = React.useState<number | null>(null);
  const chartId = React.useId();
  const svgRef = React.useRef<SVGSVGElement>(null);

  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;

  // Compute stacked data
  const stackedData = React.useMemo(() => {
    if (!stacked) return null;

    const result: { x: number | string; y: number; y0: number }[][] = [];
    // Use max length across all series to handle mismatched data lengths safely
    const dataLength = Math.max(...series.map((s) => s.data.length), 0);

    for (let si = 0; si < series.length; si++) {
      const seriesResult: { x: number | string; y: number; y0: number }[] = [];
      for (let di = 0; di < dataLength; di++) {
        const point = series[si].data[di] ?? { x: di, y: 0 };
        const baseline = si > 0 && result[si - 1]?.[di] ? result[si - 1][di].y : 0;
        seriesResult.push({
          x: point.x,
          y: baseline + point.y,
          y0: baseline,
        });
      }
      result.push(seriesResult);
    }

    return result;
  }, [series, stacked]);

  const allYValues = React.useMemo(() => {
    if (stacked && stackedData) {
      return stackedData.flatMap((sd) => sd.map((p) => p.y));
    }
    return series.flatMap((s) => s.data.map((p) => p.y));
  }, [series, stacked, stackedData]);

  const allPoints = series.flatMap((s) => s.data);
  const xValues = allPoints.map((p, idx) => (typeof p.x === 'number' ? p.x : idx));

  const xMin = Math.min(...xValues);
  const xMax = Math.max(...xValues);
  const rawYMin = Math.min(0, Math.min(...allYValues));
  const rawYMax = Math.max(...allYValues) * 1.1 || 1;
  const yRange = rawYMax - rawYMin || 1;
  const tickStep = Math.pow(10, Math.floor(Math.log10(yRange / 5))) * Math.ceil((yRange / 5) / Math.pow(10, Math.floor(Math.log10(yRange / 5)))) || 1;
  const yMin = propYMin ?? Math.floor(rawYMin / tickStep) * tickStep;
  const yMax = propYMax ?? (Math.ceil(rawYMax / tickStep) * tickStep || 1);

  const scaleX = (x: number | string, index: number = 0): number => {
    const numX = typeof x === 'number' ? x : index;
    return padding.left + ((numX - xMin) / (xMax - xMin || 1)) * chartWidth;
  };

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

  // Find closest data point index
  const findClosestPointIndex = React.useCallback(
    (mouseX: number): number | null => {
      if (series.length === 0 || series[0].data.length === 0) return null;
      const refSeries = series[0];
      let closestIdx = 0;
      let closestDist = Infinity;
      for (let i = 0; i < refSeries.data.length; i++) {
        const px = scaleX(refSeries.data[i].x, i);
        const dist = Math.abs(px - mouseX);
        if (dist < closestDist) {
          closestDist = dist;
          closestIdx = i;
        }
      }
      return closestIdx;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [series, padding, chartWidth, xMin, xMax]
  );

  const handleMouseMove = React.useCallback(
    (e: React.MouseEvent<SVGSVGElement>) => {
      if (!interactive) return;
      const svg = svgRef.current;
      if (!svg) return;
      const rect = svg.getBoundingClientRect();
      const scaleFactorX = width / rect.width;
      const mouseX = (e.clientX - rect.left) * scaleFactorX;
      const idx = findClosestPointIndex(mouseX);
      setHoveredPointIndex(idx);
    },
    [interactive, findClosestPointIndex, width]
  );

  const handleMouseLeave = React.useCallback(() => {
    if (!interactive) return;
    setHoveredPointIndex(null);
    setHoveredIndex(null);
  }, [interactive]);

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
  const uniqueXValues = [...new Set(allPoints.map((p) => p.x))];
  const maxLabels = Math.max(1, Math.floor(chartWidth / 60));
  const step = Math.max(1, Math.ceil(uniqueXValues.length / maxLabels));
  uniqueXValues.forEach((x, idx) => {
    if (idx % step === 0) {
      const xPos = scaleX(x, idx);
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
        const color = s.color || defaultColors[seriesIndex % defaultColors.length];
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
  const crosshairX = hoveredPointIndex !== null && series[0]?.data[hoveredPointIndex]
    ? scaleX(series[0].data[hoveredPointIndex].x, hoveredPointIndex)
    : null;

  // Render series
  const renderedSeries = series.map((s, seriesIndex) => {
    const color = s.color || defaultColors[seriesIndex % defaultColors.length];
    const smooth = s.smooth ?? true;
    const fillOpacity = s.fillOpacity ?? 0.3;
    const isHovered = hoveredIndex === null || hoveredIndex === seriesIndex;
    const seriesOpacity = interactive && hoveredIndex !== null && !isHovered ? 0.25 : 1;

    let topPoints: { x: number; y: number }[];
    let bottomPoints: { x: number; y: number }[] | null = null;

    if (stacked && stackedData) {
      topPoints = stackedData[seriesIndex].map((p, idx) => ({
        x: scaleX(p.x, idx),
        y: scaleY(p.y),
      }));
      if (seriesIndex > 0) {
        bottomPoints = stackedData[seriesIndex - 1].map((p, idx) => ({
          x: scaleX(p.x, idx),
          y: scaleY(p.y),
        }));
      }
    } else {
      topPoints = s.data.map((point, idx) => ({
        x: scaleX(point.x, idx),
        y: scaleY(point.y),
      }));
    }

    const linePath = generatePath(topPoints, smooth);
    const fillPath = generateFillPath(topPoints, bottomPoints, smooth);
    const fillColor = gradient ? `url(#area-grad-${chartId}-${seriesIndex})` : color;

    return (
      <g key={s.name} opacity={seriesOpacity} style={{ transition: 'opacity 0.2s ease' }}>
        <path
          d={fillPath}
          fill={fillColor}
          fillOpacity={gradient ? 1 : fillOpacity}
        />
        <path
          d={linePath}
          fill="none"
          stroke={color}
          strokeWidth={s.strokeWidth ?? 2}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        {s.data.map((point, idx) => {
          const cx = scaleX(point.x, idx);
          const cy = stacked && stackedData ? scaleY(stackedData[seriesIndex][idx].y) : scaleY(point.y);
          const isHoveredPoint = interactive && hoveredPointIndex === idx;
          return (
            <circle
              key={idx}
              cx={cx}
              cy={cy}
              r={isHoveredPoint ? 5.5 : 3}
              fill={color}
              stroke={isHoveredPoint ? 'var(--color-bg, #18181b)' : 'none'}
              strokeWidth={isHoveredPoint ? 2 : 0}
              style={{
                transition: 'r 0.15s ease, stroke-width 0.15s ease',
                cursor: interactive ? 'pointer' : undefined,
              }}
              onMouseEnter={interactive ? () => setHoveredIndex(seriesIndex) : undefined}
              onMouseLeave={interactive ? () => setHoveredIndex(null) : undefined}
            >
              <title>{point.label ?? `${s.name} - ${point.x}: ${point.y}`}</title>
            </circle>
          );
        })}
      </g>
    );
  });

  return (
    <div className={`softn-area-chart ${className}`} style={{ position: 'relative', ...style }}>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${width} ${height}`}
        width="100%"
        preserveAspectRatio="xMidYMid meet"
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
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
      {interactive && hoveredPointIndex !== null && crosshairX !== null && (
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
            {series[0]?.data[hoveredPointIndex]
              ? formatXLabel(series[0].data[hoveredPointIndex].x)
              : ''}
          </div>
          {series.map((s, seriesIndex) => {
            const color = s.color || defaultColors[seriesIndex % defaultColors.length];
            const point = s.data[hoveredPointIndex];
            if (!point) return null;
            return (
              <div key={s.name} style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
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
            const isActive = hoveredIndex === null || hoveredIndex === idx;
            return (
              <div
                key={s.name}
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

/**
 * LineChart Component
 *
 * SVG-based line chart with smooth curves, interactive crosshair tooltips,
 * hover animations, and CSS variable theming.
 */

import * as React from 'react';

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
  interactive?: boolean;
  className?: string;
  style?: React.CSSProperties;
}

const defaultColors = ['#6366f1', '#ef4444', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899'];

export function LineChart({
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
  interactive = false,
  className = '',
  style,
}: LineChartProps) {
  const [hoveredSeries, setHoveredSeries] = React.useState<number | null>(null);
  const [hoveredPointIndex, setHoveredPointIndex] = React.useState<number | null>(null);
  const svgRef = React.useRef<SVGSVGElement>(null);

  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;

  const allPoints = series.flatMap((s) => s.data);
  const xValues = allPoints.map((p, idx) => (typeof p.x === 'number' ? p.x : idx));
  const yValues = allPoints.map((p) => p.y);

  const xMin = Math.min(...xValues);
  const xMax = Math.max(...xValues);
  const rawYMin = Math.min(0, Math.min(...yValues));
  const rawYMax = Math.max(...yValues) * 1.1 || 1;
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

  const generatePath = (data: DataPoint[], smooth = false): string => {
    if (data.length === 0) return '';
    const points = data.map((point, idx) => ({
      x: scaleX(point.x, idx),
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

  const generateFillPath = (data: DataPoint[], smooth = false): string => {
    if (data.length === 0) return '';
    const linePath = generatePath(data, smooth);
    const lastX = scaleX(data[data.length - 1].x, data.length - 1);
    const firstX = scaleX(data[0].x, 0);
    const baseline = scaleY(yMin);
    return `${linePath} L ${lastX} ${baseline} L ${firstX} ${baseline} Z`;
  };

  // Find the closest data point index for a given x position
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
    setHoveredSeries(null);
  }, [interactive]);

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

  // Crosshair vertical line at hovered point
  const crosshairX = hoveredPointIndex !== null && series[0]?.data[hoveredPointIndex]
    ? scaleX(series[0].data[hoveredPointIndex].x, hoveredPointIndex)
    : null;

  return (
    <div className={`softn-line-chart ${className}`} style={{ position: 'relative', ...style }}>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${width} ${height}`}
        width="100%"
        preserveAspectRatio="xMidYMid meet"
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
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
          const color = s.color || defaultColors[seriesIndex % defaultColors.length];
          const isDimmed = interactive && hoveredSeries !== null && hoveredSeries !== seriesIndex;
          return (
            <g
              key={s.name}
              opacity={isDimmed ? 0.25 : 1}
              style={{ transition: 'opacity 0.2s ease' }}
            >
              {s.fill && (
                <path
                  d={generateFillPath(s.data, s.smooth)}
                  fill={color}
                  fillOpacity={s.fillOpacity ?? 0.1}
                />
              )}
              <path
                d={generatePath(s.data, s.smooth)}
                fill="none"
                stroke={color}
                strokeWidth={s.strokeWidth ?? 2}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              {(s.showDots ?? true) &&
                s.data.map((point, idx) => {
                  const isHoveredPoint = interactive && hoveredPointIndex === idx;
                  const baseSize = s.dotSize ?? 3;
                  const r = isHoveredPoint ? baseSize + 2.5 : baseSize;
                  return (
                    <circle
                      key={idx}
                      cx={scaleX(point.x, idx)}
                      cy={scaleY(point.y)}
                      r={r}
                      fill={isHoveredPoint ? color : color}
                      stroke={isHoveredPoint ? 'var(--color-bg, #18181b)' : 'none'}
                      strokeWidth={isHoveredPoint ? 2 : 0}
                      style={{
                        transition: 'r 0.15s ease, stroke-width 0.15s ease',
                        cursor: interactive ? 'pointer' : undefined,
                      }}
                      onMouseEnter={interactive ? () => setHoveredSeries(seriesIndex) : undefined}
                      onMouseLeave={interactive ? () => setHoveredSeries(null) : undefined}
                    >
                      {!interactive && <title>{point.label ?? `${point.x}: ${point.y}`}</title>}
                    </circle>
                  );
                })}
            </g>
          );
        })}
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
            const isActive = hoveredSeries === null || hoveredSeries === idx;
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

/**
 * SmartStats Component
 *
 * Display key metrics and KPIs in beautiful stat cards.
 * Automatically formats numbers, shows trends, and supports icons.
 *
 * Usage:
 * <SmartStats
 *   stats="appointments: 24, clients: 156, revenue: 4250, rating: 4.8"
 *   icons="calendar, users, dollar, star"
 *   trends="+12%, +5%, +18%, +0.2"
 * />
 */

import React from 'react';
import { cssColumnCount, cssPaint } from '../utils/egress';
import { choice } from '../utils/choice';
import { commaList, commaSlots, recordRows } from '../utils/rows';
import { outlineIcon } from '../utils/icons';

export interface StatItem {
  label: string;
  value: number | string;
  icon?: string;
  trend?: string | number;
  trendDirection?: 'up' | 'down' | 'neutral';
  color?: string;
  prefix?: string;
  suffix?: string;
}

export interface SmartStatsProps {
  /** Stats as comma-separated "label: value" pairs or array of StatItem */
  stats?: string | StatItem[];
  /** Comma-separated icon names for each stat */
  icons?: string;
  /** Comma-separated trend values (e.g., "+12%, -5%, +0%") */
  trends?: string;
  /** Layout style */
  layout?: 'grid' | 'row' | 'compact';
  /** Number of columns for grid layout */
  columns?: number | { sm?: number; md?: number; lg?: number };
  /** Card variant */
  variant?: 'default' | 'gradient' | 'outline' | 'minimal';
  /** Size */
  size?: 'sm' | 'md' | 'lg';
  /** Additional CSS class */
  className?: string;
  /** Inline styles */
  style?: React.CSSProperties;
}

// Trend arrow icons
const TrendUp = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <polyline points="23 6 13.5 15.5 8.5 10.5 1 18" />
    <polyline points="17 6 23 6 23 12" />
  </svg>
);

const TrendDown = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <polyline points="23 18 13.5 8.5 8.5 13.5 1 6" />
    <polyline points="17 18 23 18 23 12" />
  </svg>
);

// Format value for display
function formatValue(value: number | string, prefix?: string, suffix?: string): string {
  // A figure that has not arrived (`{ label: 'Users', value: stats.users }`,
  // undefined) is a dash, where `.toFixed` of it threw.
  if (value === null || value === undefined || (typeof value === 'number' && !Number.isFinite(value))) {
    return `${prefix || ''}\u2014${suffix || ''}`;
  }
  if (typeof value !== 'number') return `${prefix || ''}${String(value)}${suffix || ''}`;

  let formatted: string;
  if (value >= 1000000) {
    formatted = (value / 1000000).toFixed(1) + 'M';
  } else if (value >= 1000) {
    formatted = (value / 1000).toFixed(1) + 'K';
  } else if (value % 1 !== 0) {
    formatted = value.toFixed(1);
  } else {
    formatted = value.toLocaleString();
  }

  return `${prefix || ''}${formatted}${suffix || ''}`;
}

// Parse trend direction. A number is a change by that much: `12` is up, as
// "+12" is; it was called with `.trim()` and the stat failed to draw.
function parseTrend(trend: string | number): { value: string; direction: 'up' | 'down' | 'neutral' } {
  const trimmed = typeof trend === 'number' ? (trend > 0 ? `+${trend}` : String(trend)) : String(trend).trim();
  if (trimmed.startsWith('+') && trimmed !== '+0%' && trimmed !== '+0') {
    return { value: trimmed, direction: 'up' };
  } else if (trimmed.startsWith('-') && trimmed !== '-0%' && trimmed !== '-0') {
    return { value: trimmed, direction: 'down' };
  }
  return { value: trimmed, direction: 'neutral' };
}

// Humanize label
function humanize(str: string): string {
  return str
    .replace(/([A-Z])/g, ' $1')
    .replace(/_/g, ' ')
    .replace(/^./, (s) => s.toUpperCase())
    .trim();
}

// Parse stats from string
function parseStats(statsStr: string): StatItem[] {
  return commaList(statsStr).map((stat) => {
    // "Users" with its figure still to be typed has no value, and
    // `parseFloat(undefined)` left one that could not be formatted.
    const [label, value = ''] = stat.split(':').map((s) => s.trim());
    const numValue = parseFloat(value);
    return {
      label: humanize(label),
      value: isNaN(numValue) ? value : numValue,
    };
  });
}

// Gradient colors
const gradientColors = [
  { from: '#6366f1', to: '#4f46e5' },
  { from: '#0891b2', to: '#0d9488' },
  { from: '#7c3aed', to: '#4f46e5' },
  { from: '#ea580c', to: '#dc2626' },
  { from: '#059669', to: '#0d9488' },
  { from: '#4f46e5', to: '#7c3aed' },
];

export function SmartStats({
  stats,
  icons,
  trends,
  layout = 'grid',
  columns = 4,
  variant = 'default',
  size = 'md',
  className,
  style,
}: SmartStatsProps): React.ReactElement {
  // Parse stats
  const parsedStats: StatItem[] = Array.isArray(stats) ? recordRows<StatItem>(stats) : typeof stats === 'string' ? parseStats(stats) : [];

  // Parse icons
  const iconList = commaSlots(icons);

  // Parse trends
  const trendList = commaSlots(trends).map((t) => parseTrend(t));

  // Size styles
  const sizeStyles = {
    sm: { padding: '0.75rem', valueSize: '1.25rem', labelSize: '0.7rem', iconSize: '1.25rem' },
    md: { padding: '1.25rem', valueSize: '1.75rem', labelSize: '0.75rem', iconSize: '1.5rem' },
    lg: { padding: '1.5rem', valueSize: '2.25rem', labelSize: '0.875rem', iconSize: '2rem' },
  };

  const sizeStyle = choice(sizeStyles, size, 'md');

  // Grid columns
  // `columns={null}` threw here (null is an object with no `lg`), and
  // `columns="3"`, as an attribute is written, was read as the default four.
  const getGridColumns = () => {
    const wide = columns !== null && typeof columns === 'object' ? columns.lg : columns;
    return `repeat(${cssColumnCount(wide, 4)}, 1fr)`;
  };

  // Container styles
  const containerStyle: React.CSSProperties = {
    display: layout === 'row' ? 'flex' : 'grid',
    gridTemplateColumns: layout === 'grid' ? getGridColumns() : undefined,
    gap: layout === 'compact' ? '0.5rem' : '1rem',
    flexWrap: layout === 'row' ? 'wrap' : undefined,
    ...style,
  };

  return (
    <div className={`softn-smart-stats ${className || ''}`} style={containerStyle}>
      {parsedStats.map((stat, index) => {
        const icon = stat.icon || iconList[index];
        // A stat's `check` has always been the ticked circle, the table's `success`.
        const statIcon = outlineIcon(icon === 'check' ? 'success' : icon, 24);
        const trend = stat.trend !== undefined && stat.trend !== null && stat.trend !== '' ? parseTrend(stat.trend) : trendList[index];
        const gradient = gradientColors[index % gradientColors.length];

        const isGradient = variant === 'gradient';
        // A stat's colour comes from the bundle's data and lands in
        // `background`, where a `url()` would be fetched.
        const tint = cssPaint(stat.color) || gradient.from;
        const isOutline = variant === 'outline';
        const isMinimal = variant === 'minimal';

        const cardStyle: React.CSSProperties = {
          padding: sizeStyle.padding,
          borderRadius: 'var(--radius-lg, 0.75rem)',
          background: isGradient
            ? `linear-gradient(135deg, ${tint}, ${gradient.to})`
            : isMinimal
              ? 'transparent'
              : 'var(--color-surface, #16161a)',
          border: isOutline
            ? '1px solid var(--color-border, rgba(255, 255, 255, 0.08))'
            : isMinimal
              ? 'none'
              : '1px solid var(--color-border, rgba(255, 255, 255, 0.08))',
          display: 'flex',
          flexDirection: layout === 'compact' ? 'row' : 'column',
          alignItems: layout === 'compact' ? 'center' : 'flex-start',
          gap: layout === 'compact' ? '0.75rem' : '0.5rem',
          flex: layout === 'row' ? '1 1 200px' : undefined,
          minWidth: layout === 'row' ? '200px' : undefined,
        };

        const iconContainerStyle: React.CSSProperties = {
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: size === 'lg' ? '3rem' : '2.5rem',
          height: size === 'lg' ? '3rem' : '2.5rem',
          borderRadius: 'var(--radius-md, 0.5rem)',
          // The tint at an eighth of its strength. Written as `${tint}20` it
          // was a colour only for a six-digit hex: a theme variable or a
          // colour's name drew no square at all.
          background: isGradient ? 'rgba(255, 255, 255, 0.2)' : `color-mix(in srgb, ${tint} 12.5%, transparent)`,
          color: isGradient ? 'var(--color-surface, #16161a)' : tint,
          flexShrink: 0,
        };

        const labelStyle: React.CSSProperties = {
          fontSize: sizeStyle.labelSize,
          fontWeight: 500,
          color: isGradient ? 'rgba(255, 255, 255, 0.8)' : 'var(--color-text-muted, #a1a1aa)',
          textTransform: 'uppercase' as const,
          letterSpacing: '0.05em',
        };

        const valueStyle: React.CSSProperties = {
          fontSize: sizeStyle.valueSize,
          fontWeight: 700,
          color: isGradient ? 'var(--color-surface, #16161a)' : 'var(--color-text, #f5f5f5)',
          lineHeight: 1.2,
        };

        const trendStyle: React.CSSProperties = {
          display: 'inline-flex',
          alignItems: 'center',
          gap: '0.25rem',
          fontSize: '0.75rem',
          fontWeight: 500,
          color:
            trend?.direction === 'up'
              ? 'var(--color-success-500, #22c55e)'
              : trend?.direction === 'down'
                ? 'var(--color-error-500, #ef4444)'
                : 'var(--color-text-muted, #a1a1aa)',
          padding: '0.125rem 0.375rem',
          borderRadius: 'var(--radius-sm, 0.25rem)',
          background:
            trend?.direction === 'up'
              ? 'rgba(34, 197, 94, 0.1)'
              : trend?.direction === 'down'
                ? 'rgba(239, 68, 68, 0.1)'
                : 'transparent',
        };

        return (
          <div key={index} style={cardStyle}>
            {statIcon && <div style={iconContainerStyle}>{statIcon}</div>}
            <div style={{ flex: 1 }}>
              <div style={labelStyle}>{stat.label}</div>
              <div
                style={{ display: 'flex', alignItems: 'baseline', gap: '0.5rem', flexWrap: 'wrap' }}
              >
                <span style={valueStyle}>{formatValue(stat.value, stat.prefix, stat.suffix)}</span>
                {trend && (
                  <span style={trendStyle}>
                    {trend.direction === 'up' && <TrendUp />}
                    {trend.direction === 'down' && <TrendDown />}
                    {trend.value}
                  </span>
                )}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

export default SmartStats;

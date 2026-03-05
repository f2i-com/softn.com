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

export interface StatItem {
  label: string;
  value: number | string;
  icon?: string;
  trend?: string;
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

// Icon components
const iconMap: Record<string, React.ReactNode> = {
  calendar: (
    <svg
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
      <line x1="16" y1="2" x2="16" y2="6" />
      <line x1="8" y1="2" x2="8" y2="6" />
      <line x1="3" y1="10" x2="21" y2="10" />
    </svg>
  ),
  users: (
    <svg
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  ),
  dollar: (
    <svg
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      <line x1="12" y1="1" x2="12" y2="23" />
      <path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
    </svg>
  ),
  star: (
    <svg
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
    </svg>
  ),
  chart: (
    <svg
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      <line x1="18" y1="20" x2="18" y2="10" />
      <line x1="12" y1="20" x2="12" y2="4" />
      <line x1="6" y1="20" x2="6" y2="14" />
    </svg>
  ),
  clock: (
    <svg
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </svg>
  ),
  check: (
    <svg
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
      <polyline points="22 4 12 14.01 9 11.01" />
    </svg>
  ),
  trending: (
    <svg
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      <polyline points="23 6 13.5 15.5 8.5 10.5 1 18" />
      <polyline points="17 6 23 6 23 12" />
    </svg>
  ),
  cart: (
    <svg
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      <circle cx="9" cy="21" r="1" />
      <circle cx="20" cy="21" r="1" />
      <path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6" />
    </svg>
  ),
  inbox: (
    <svg
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      <polyline points="22 12 16 12 14 15 10 15 8 12 2 12" />
      <path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
    </svg>
  ),
};

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
  if (typeof value === 'string') return `${prefix || ''}${value}${suffix || ''}`;

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

// Parse trend direction
function parseTrend(trend: string): { value: string; direction: 'up' | 'down' | 'neutral' } {
  const trimmed = trend.trim();
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
  return statsStr.split(',').map((stat) => {
    const [label, value] = stat.split(':').map((s) => s.trim());
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
  const parsedStats: StatItem[] = Array.isArray(stats) ? stats : stats ? parseStats(stats) : [];

  // Parse icons
  const iconList = icons?.split(',').map((i) => i.trim()) || [];

  // Parse trends
  const trendList = trends?.split(',').map((t) => parseTrend(t)) || [];

  // Size styles
  const sizeStyles = {
    sm: { padding: '0.75rem', valueSize: '1.25rem', labelSize: '0.7rem', iconSize: '1.25rem' },
    md: { padding: '1.25rem', valueSize: '1.75rem', labelSize: '0.75rem', iconSize: '1.5rem' },
    lg: { padding: '1.5rem', valueSize: '2.25rem', labelSize: '0.875rem', iconSize: '2rem' },
  };

  const sizeStyle = sizeStyles[size];

  // Grid columns
  const getGridColumns = () => {
    if (typeof columns === 'number') {
      return `repeat(${columns}, 1fr)`;
    }
    return `repeat(${columns.lg || 4}, 1fr)`;
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
        const trend = stat.trend ? parseTrend(stat.trend) : trendList[index];
        const gradient = gradientColors[index % gradientColors.length];

        const isGradient = variant === 'gradient';
        const isOutline = variant === 'outline';
        const isMinimal = variant === 'minimal';

        const cardStyle: React.CSSProperties = {
          padding: sizeStyle.padding,
          borderRadius: 'var(--radius-lg, 0.75rem)',
          background: isGradient
            ? `linear-gradient(135deg, ${stat.color || gradient.from}, ${gradient.to})`
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
          background: isGradient ? 'rgba(255, 255, 255, 0.2)' : `${stat.color || gradient.from}20`,
          color: isGradient ? 'var(--color-surface, #16161a)' : stat.color || gradient.from,
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
            {icon && iconMap[icon] && <div style={iconContainerStyle}>{iconMap[icon]}</div>}
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

/**
 * Progress Component
 *
 * A progress bar indicator.
 * Uses CSS variables for theming support.
 */

import React from 'react';

export interface ProgressProps {
  /** Progress value (0-100) */
  value?: number;
  /** Maximum value */
  max?: number;
  /** Size */
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl';
  /** Color variant */
  variant?: 'primary' | 'success' | 'warning' | 'danger' | 'info';
  /** Custom color (overrides variant) */
  color?: string;
  /** Background color */
  backgroundColor?: string;
  /** Show percentage label */
  showLabel?: boolean;
  /** Label position */
  labelPosition?: 'inside' | 'outside' | 'top';
  /** Custom label formatter */
  formatLabel?: (value: number, max: number) => string;
  /** Indeterminate (loading) state */
  indeterminate?: boolean;
  /** Striped style */
  striped?: boolean;
  /** Animated stripes */
  animated?: boolean;
  /** Border radius */
  borderRadius?: 'none' | 'sm' | 'md' | 'lg' | 'full';
  /** Additional CSS class */
  className?: string;
  /** Inline styles */
  style?: React.CSSProperties;
}

const sizeValues: Record<string, { height: string; fontSize: string }> = {
  xs: { height: '0.25rem', fontSize: '0.5rem' },
  sm: { height: '0.375rem', fontSize: '0.625rem' },
  md: { height: '0.5rem', fontSize: '0.75rem' },
  lg: { height: '0.75rem', fontSize: '0.75rem' },
  xl: { height: '1rem', fontSize: '0.875rem' },
};

interface ColorConfig {
  color: string;
  gradient: string;
  glow: string;
}

const colorValues: Record<string, ColorConfig> = {
  primary: {
    color: 'var(--color-primary-500, #6366f1)',
    gradient:
      'linear-gradient(to right, var(--color-primary-400, #818cf8), var(--color-primary-500, #6366f1), var(--color-primary-600, #4f46e5))',
    glow: 'rgba(59, 130, 246, 0.4)',
  },
  success: {
    color: 'var(--color-success-500, #22c55e)',
    gradient:
      'linear-gradient(to right, var(--color-success-400, #4ade80), var(--color-success-500, #22c55e), var(--color-success-600, #16a34a))',
    glow: 'rgba(34, 197, 94, 0.4)',
  },
  warning: {
    color: 'var(--color-warning-500, #f59e0b)',
    gradient:
      'linear-gradient(to right, var(--color-warning-400, #fbbf24), var(--color-warning-500, #f59e0b), var(--color-warning-600, #d97706))',
    glow: 'rgba(245, 158, 11, 0.4)',
  },
  danger: {
    color: 'var(--color-error-500, #ef4444)',
    gradient:
      'linear-gradient(to right, var(--color-error-400, #f87171), var(--color-error-500, #ef4444), var(--color-error-600, #dc2626))',
    glow: 'rgba(239, 68, 68, 0.4)',
  },
  info: {
    color: 'var(--color-info-500, #3b82f6)',
    gradient:
      'linear-gradient(to right, var(--color-info-400, #60a5fa), var(--color-info-500, #3b82f6), var(--color-info-600, #2563eb))',
    glow: 'rgba(59, 130, 246, 0.4)',
  },
};

const radiusValues: Record<string, string> = {
  none: '0',
  sm: 'var(--radius-sm, 0.125rem)',
  md: 'var(--radius-md, 0.25rem)',
  lg: 'var(--radius-lg, 0.5rem)',
  full: 'var(--radius-full, 9999px)',
};

export function Progress({
  value = 0,
  max = 100,
  size = 'md',
  variant = 'primary',
  color,
  backgroundColor,
  showLabel = false,
  labelPosition = 'inside',
  formatLabel,
  indeterminate = false,
  striped = false,
  animated = false,
  borderRadius = 'full',
  className,
  style,
}: ProgressProps): React.ReactElement {
  const percentage = Math.min(100, Math.max(0, (value / max) * 100));
  const colorConfig = colorValues[variant];
  const barColor = color ?? colorConfig.color;
  const barGradient = color ? undefined : colorConfig.gradient;
  const barGlow = color ? undefined : colorConfig.glow;
  const bgColor = backgroundColor ?? 'var(--color-gray-200, #3f3f46)';
  const radius = radiusValues[borderRadius];
  const sizeConfig = sizeValues[size];

  const defaultLabel = formatLabel ? formatLabel(value, max) : `${Math.round(percentage)}%`;

  const wrapperStyle: React.CSSProperties = {
    width: '100%',
    ...(labelPosition === 'top' && {
      display: 'flex',
      flexDirection: 'column',
      gap: '0.25rem',
    }),
    ...style,
  };

  const containerStyle: React.CSSProperties = {
    position: 'relative',
    width: '100%',
    height: sizeConfig.height,
    backgroundColor: bgColor,
    borderRadius: radius,
    overflow: 'hidden',
    boxShadow: 'inset 0 1px 2px rgba(0, 0, 0, 0.1)',
  };

  const barStyle: React.CSSProperties = {
    height: '100%',
    width: indeterminate ? '40%' : `${percentage}%`,
    backgroundColor: barColor,
    background: barGradient ?? barColor,
    borderRadius: radius,
    boxShadow: barGlow
      ? `0 1px 2px rgba(0, 0, 0, 0.15), inset 0 1px 0 rgba(255, 255, 255, 0.25), 0 0 8px ${barGlow}`
      : '0 1px 2px rgba(0, 0, 0, 0.15), inset 0 1px 0 rgba(255, 255, 255, 0.25)',
    transition: indeterminate
      ? 'none'
      : 'width var(--duration-normal, 300ms) cubic-bezier(0.16, 1, 0.3, 1)',
    ...(indeterminate && {
      animation: 'softn-progress-indeterminate 1.5s infinite linear',
    }),
    ...((striped || animated) && {
      backgroundImage: `linear-gradient(
        45deg,
        rgba(255, 255, 255, 0.15) 25%,
        transparent 25%,
        transparent 50%,
        rgba(255, 255, 255, 0.15) 50%,
        rgba(255, 255, 255, 0.15) 75%,
        transparent 75%,
        transparent
      )`,
      backgroundSize: '1rem 1rem',
      ...(animated && {
        animation: 'softn-progress-stripes 1s linear infinite',
      }),
    }),
  };

  const insideLabelStyle: React.CSSProperties = {
    position: 'absolute',
    top: '50%',
    left: '50%',
    transform: 'translate(-50%, -50%)',
    fontSize: sizeConfig.fontSize,
    fontWeight: 600,
    color: percentage > 50 ? 'var(--color-white, #ffffff)' : 'var(--color-text, #e4e4e7)',
    lineHeight: 1,
    whiteSpace: 'nowrap',
    textShadow: percentage > 50 ? '0 1px 1px rgba(0, 0, 0, 0.2)' : 'none',
    letterSpacing: '0.01em',
  };

  const outsideLabelStyle: React.CSSProperties = {
    marginLeft: '0.75rem',
    fontSize: 'var(--text-sm, 0.875rem)',
    fontWeight: 600,
    color: 'var(--color-text, #e4e4e7)',
    lineHeight: 1,
    whiteSpace: 'nowrap',
    letterSpacing: '0.01em',
  };

  const topLabelStyle: React.CSSProperties = {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    fontSize: 'var(--text-sm, 0.875rem)',
    fontWeight: 500,
    color: 'var(--color-text-muted, #6b7280)',
    marginBottom: '0.375rem',
  };

  const showInsideLabel =
    showLabel && labelPosition === 'inside' && !indeterminate && size !== 'xs' && size !== 'sm';
  const showOutsideLabel = showLabel && labelPosition === 'outside' && !indeterminate;
  const showTopLabel = showLabel && labelPosition === 'top' && !indeterminate;

  return (
    <>
      <style>{`
        @keyframes softn-progress-indeterminate {
          0% { transform: translateX(-100%); }
          100% { transform: translateX(350%); }
        }
        @keyframes softn-progress-stripes {
          0% { background-position: 1rem 0; }
          100% { background-position: 0 0; }
        }
        @media (prefers-reduced-motion: reduce) {
          .softn-progress-bar { animation: none !important; }
        }
      `}</style>
      <div className={className} style={wrapperStyle}>
        {showTopLabel && (
          <div style={topLabelStyle}>
            <span>Progress</span>
            <span>{defaultLabel}</span>
          </div>
        )}
        <div style={{ display: 'flex', alignItems: 'center' }}>
          <div style={containerStyle}>
            <div
              style={barStyle}
              role="progressbar"
              aria-valuenow={value}
              aria-valuemin={0}
              aria-valuemax={max}
            />
            {showInsideLabel && <span style={insideLabelStyle}>{defaultLabel}</span>}
          </div>
          {showOutsideLabel && <span style={outsideLabelStyle}>{defaultLabel}</span>}
        </div>
      </div>
    </>
  );
}

export default Progress;

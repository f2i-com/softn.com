/**
 * SmartView Component
 *
 * An opinionated data display component that automatically formats and renders objects.
 * Just pass data and it shows it nicely - the power is in the engine, not the syntax.
 *
 * Usage:
 * <SmartView data={employee} fields="name, email, department" layout="card" />
 */

import React from 'react';

export interface SmartViewProps {
  /** Data object to display */
  data: Record<string, unknown> | null | undefined;
  /** Comma-separated field names to display, or show all if not provided */
  fields?: string;
  /** Layout style */
  layout?: 'card' | 'list' | 'inline' | 'grid';
  /** Number of columns for grid layout */
  gridColumns?: number;
  /** Show labels */
  showLabels?: boolean;
  /** Label position */
  labelPosition?: 'top' | 'left' | 'inline';
  /** Title for the view */
  title?: string;
  /** Show empty values */
  showEmpty?: boolean;
  /** Custom formatters */
  formatters?: Record<string, (value: unknown) => React.ReactNode>;
  /** Hide specific fields */
  hideFields?: string[];
  /** Additional CSS class */
  className?: string;
  /** Inline styles */
  style?: React.CSSProperties;
}

// Status badge colors
const statusColors: Record<string, { bg: string; text: string }> = {
  online: { bg: 'rgba(34, 197, 94, 0.15)', text: '#22c55e' },
  active: { bg: 'rgba(34, 197, 94, 0.15)', text: '#22c55e' },
  completed: { bg: 'rgba(34, 197, 94, 0.15)', text: '#22c55e' },
  busy: { bg: 'rgba(251, 191, 36, 0.15)', text: '#fbbf24' },
  'in-progress': { bg: 'rgba(59, 130, 246, 0.15)', text: '#3b82f6' },
  pending: { bg: 'rgba(251, 191, 36, 0.15)', text: '#fbbf24' },
  scheduled: { bg: 'rgba(139, 92, 246, 0.15)', text: '#8b5cf6' },
  away: { bg: 'rgba(156, 163, 175, 0.15)', text: '#9ca3af' },
  offline: { bg: 'rgba(156, 163, 175, 0.15)', text: '#9ca3af' },
  cancelled: { bg: 'rgba(239, 68, 68, 0.15)', text: '#ef4444' },
  error: { bg: 'rgba(239, 68, 68, 0.15)', text: '#ef4444' },
};

// Utility to capitalize and humanize field names
function humanize(str: string): string {
  return str
    .replace(/([A-Z])/g, ' $1')
    .replace(/_/g, ' ')
    .replace(/^./, (s) => s.toUpperCase())
    .trim();
}

// Check if field is a status/badge field
function isStatusField(key: string): boolean {
  return ['status', 'state', 'badge', 'type'].includes(key.toLowerCase());
}

// Format currency
function formatCurrency(num: number): string {
  return (
    '$' + num.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })
  );
}

// Check if it looks like a currency field
function isCurrencyField(key: string): boolean {
  const lower = key.toLowerCase();
  return (
    lower.includes('price') ||
    lower.includes('cost') ||
    lower.includes('spent') ||
    lower.includes('revenue') ||
    lower.includes('salary') ||
    lower.includes('amount') ||
    lower.includes('total') ||
    lower.includes('fee')
  );
}

// Detect value type
function detectType(
  value: unknown
): 'string' | 'number' | 'boolean' | 'date' | 'array' | 'object' | 'null' {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number') return 'number';
  if (value instanceof Date) return 'date';
  if (typeof value === 'object') return 'object';
  if (typeof value === 'string') {
    if (/^\d{4}-\d{2}-\d{2}/.test(value)) return 'date';
    if (/^https?:\/\//.test(value)) return 'string';
  }
  return 'string';
}

// Format value for display
function formatValue(
  value: unknown,
  type: ReturnType<typeof detectType>,
  key: string
): React.ReactNode {
  switch (type) {
    case 'null':
      return (
        <span style={{ color: 'var(--color-text-muted, #71717a)', fontStyle: 'italic' }}>—</span>
      );
    case 'boolean':
      return value ? (
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '0.375rem',
            padding: '0.25rem 0.625rem',
            borderRadius: '9999px',
            background: 'rgba(34, 197, 94, 0.15)',
            color: '#22c55e',
            fontSize: '0.8125rem',
            fontWeight: 500,
          }}
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="3"
          >
            <path d="M20 6L9 17l-5-5" />
          </svg>
          Yes
        </span>
      ) : (
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '0.375rem',
            padding: '0.25rem 0.625rem',
            borderRadius: '9999px',
            background: 'rgba(156, 163, 175, 0.15)',
            color: '#9ca3af',
            fontSize: '0.8125rem',
            fontWeight: 500,
          }}
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
          No
        </span>
      );
    case 'date':
      try {
        const date = new Date(value as string | number | Date);
        return (
          <span style={{ fontVariantNumeric: 'tabular-nums', color: 'var(--color-text, #1a1a2e)' }}>
            {date.toLocaleDateString(undefined, {
              year: 'numeric',
              month: 'long',
              day: 'numeric',
            })}
          </span>
        );
      } catch {
        return String(value);
      }
    case 'number': {
      const num = value as number;
      if (isCurrencyField(key)) {
        return (
          <span
            style={{
              fontVariantNumeric: 'tabular-nums',
              fontWeight: 600,
              color: '#22c55e',
              fontSize: '1rem',
            }}
          >
            {formatCurrency(num)}
          </span>
        );
      }
      if (key.toLowerCase().includes('rating')) {
        return (
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '0.25rem',
              color: '#fbbf24',
              fontWeight: 600,
            }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
              <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
            </svg>
            {num.toFixed(1)}
          </span>
        );
      }
      return (
        <span style={{ fontVariantNumeric: 'tabular-nums', color: 'var(--color-text, #1a1a2e)' }}>
          {num.toLocaleString()}
        </span>
      );
    }
    case 'array': {
      const arr = value as unknown[];
      if (arr.length === 0) {
        return (
          <span style={{ color: 'var(--color-text-muted, #71717a)', fontStyle: 'italic' }}>
            Empty
          </span>
        );
      }
      return (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.375rem' }}>
          {arr.slice(0, 5).map((item, i) => (
            <span
              key={i}
              style={{
                display: 'inline-block',
                padding: '0.25rem 0.625rem',
                background: 'var(--color-gray-100, #e8e8ee)',
                borderRadius: '9999px',
                fontSize: '0.8125rem',
                color: 'var(--color-text, #1a1a2e)',
              }}
            >
              {String(item)}
            </span>
          ))}
          {arr.length > 5 && (
            <span
              style={{
                color: 'var(--color-text-muted, #71717a)',
                fontSize: '0.8125rem',
                alignSelf: 'center',
              }}
            >
              +{arr.length - 5} more
            </span>
          )}
        </div>
      );
    }
    case 'object':
      return (
        <span style={{ color: 'var(--color-text-muted, #71717a)', fontStyle: 'italic' }}>
          [Object]
        </span>
      );
    default: {
      const str = String(value);

      // Check for status values
      if (isStatusField(key)) {
        const colors = statusColors[str.toLowerCase()] || {
          bg: 'var(--color-gray-100, #e8e8ee)',
          text: 'var(--color-gray-600, #4a4a5e)',
        };
        return (
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '0.375rem',
              padding: '0.25rem 0.625rem',
              borderRadius: '9999px',
              background: colors.bg,
              color: colors.text,
              fontSize: '0.8125rem',
              fontWeight: 500,
              textTransform: 'capitalize',
            }}
          >
            {(str.toLowerCase() === 'online' || str.toLowerCase() === 'active') && (
              <span
                style={{
                  width: '0.5rem',
                  height: '0.5rem',
                  borderRadius: '50%',
                  background: colors.text,
                }}
              />
            )}
            {str}
          </span>
        );
      }

      // Check for URLs
      if (/^https?:\/\//.test(str)) {
        return (
          <a
            href={str}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              color: 'var(--color-primary, #6366f1)',
              textDecoration: 'none',
            }}
          >
            {str.length > 50 ? str.slice(0, 50) + '...' : str}
          </a>
        );
      }
      // Check for email
      if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(str)) {
        return (
          <a
            href={`mailto:${str}`}
            style={{
              color: 'var(--color-primary, #6366f1)',
              textDecoration: 'none',
            }}
          >
            {str}
          </a>
        );
      }
      // Check for phone (must start with + or digit, contain at least some digits)
      if (/^[+\d][\d\s\-()]{6,}$/.test(str) && (str.match(/\d/g) || []).length >= 7) {
        return (
          <a
            href={`tel:${str.replace(/\D/g, '')}`}
            style={{
              color: 'var(--color-primary, #6366f1)',
              textDecoration: 'none',
            }}
          >
            {str}
          </a>
        );
      }
      return <span style={{ color: 'var(--color-text, #1a1a2e)' }}>{str}</span>;
    }
  }
}

export function SmartView({
  data,
  fields: fieldsProp,
  layout = 'card',
  gridColumns = 2,
  showLabels = true,
  labelPosition = 'top',
  title,
  showEmpty = true,
  formatters = {},
  hideFields = ['id', '_id', 'password', 'token'],
  className,
  style,
}: SmartViewProps): React.ReactElement {
  // Handle null/undefined data
  if (!data) {
    return (
      <div
        className={className}
        style={{
          padding: '2rem',
          textAlign: 'center',
          color: 'var(--color-text-muted, #71717a)',
          background: 'var(--color-surface, #ffffff)',
          borderRadius: 'var(--radius-lg, 0.75rem)',
          border: '1px dashed var(--color-border, rgba(0, 0, 0, 0.08))',
          ...style,
        }}
      >
        No data to display
      </div>
    );
  }

  // Determine which fields to show
  const fields = fieldsProp
    ? fieldsProp.split(',').map((f) => f.trim())
    : Object.keys(data).filter((key) => !hideFields.includes(key));

  // Filter out empty values if needed
  const visibleFields = showEmpty
    ? fields
    : fields.filter((key) => data[key] != null && data[key] !== '');

  // Styles
  const containerStyle: React.CSSProperties = {
    ...(layout === 'card' && {
      background: 'var(--color-surface, #ffffff)',
      borderRadius: 'var(--radius-lg, 0.75rem)',
      border: '1px solid var(--color-border, rgba(0, 0, 0, 0.08))',
      padding: '1.5rem',
    }),
    ...style,
  };

  const titleStyle: React.CSSProperties = {
    margin: '0 0 1.25rem',
    fontSize: '1.125rem',
    fontWeight: 600,
    color: 'var(--color-text, #1a1a2e)',
    paddingBottom: '1rem',
    borderBottom: '1px solid var(--color-border, rgba(0, 0, 0, 0.08))',
  };

  const getGridStyle = (): React.CSSProperties => {
    switch (layout) {
      case 'grid':
        return {
          display: 'grid',
          gridTemplateColumns: `repeat(${gridColumns}, 1fr)`,
          gap: '1.25rem',
        };
      case 'inline':
        return {
          display: 'flex',
          flexWrap: 'wrap',
          gap: '1rem 2rem',
        };
      case 'list':
      case 'card':
      default:
        return {
          display: 'flex',
          flexDirection: 'column',
          gap: '1rem',
        };
    }
  };

  const getFieldStyle = (): React.CSSProperties => {
    if (labelPosition === 'left') {
      return {
        display: 'flex',
        alignItems: 'flex-start',
        gap: '1rem',
      };
    }
    if (labelPosition === 'inline') {
      return {
        display: 'flex',
        alignItems: 'baseline',
        gap: '0.5rem',
      };
    }
    return {
      display: 'flex',
      flexDirection: 'column',
      gap: '0.375rem',
    };
  };

  const labelStyle: React.CSSProperties = {
    fontSize: '0.75rem',
    fontWeight: 500,
    color: 'var(--color-text-muted, #71717a)',
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
    ...(labelPosition === 'left' && {
      minWidth: 'min(140px, 30%)',
      flexShrink: 0,
    }),
    ...(labelPosition === 'inline' && {
      textTransform: 'none',
      letterSpacing: 'normal',
      fontWeight: 400,
    }),
  };

  const valueStyle: React.CSSProperties = {
    fontSize: '0.9375rem',
    color: 'var(--color-text, #1a1a2e)',
    lineHeight: 1.5,
    wordBreak: 'break-word',
    ...(labelPosition === 'inline' && {
      fontWeight: 500,
    }),
  };

  return (
    <div className={`softn-smart-view ${className || ''}`} style={containerStyle}>
      {title && <h3 style={titleStyle}>{title}</h3>}
      <div style={getGridStyle()}>
        {visibleFields.map((key) => {
          const value = data[key];
          const type = detectType(value);

          // Use custom formatter if provided
          const formattedValue = formatters[key]
            ? formatters[key](value)
            : formatValue(value, type, key);

          return (
            <div key={key} style={getFieldStyle()}>
              {showLabels && (
                <span style={labelStyle}>
                  {labelPosition === 'inline' ? `${humanize(key)}:` : humanize(key)}
                </span>
              )}
              <span style={valueStyle}>{formattedValue}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default SmartView;

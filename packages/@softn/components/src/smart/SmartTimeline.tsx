/**
 * SmartTimeline Component
 *
 * Display events/activities in a vertical timeline format.
 * Great for activity logs, order history, status updates, etc.
 *
 * Usage:
 * <SmartTimeline
 *   data={activities}
 *   title="action"
 *   description="details"
 *   time="timestamp"
 *   status="type"
 * />
 */

import React from 'react';

/**
 * Get field value from item, handling both flat objects and XDB record format
 * XDB records have structure: { id, collection, data: {...}, createdAt, updatedAt }
 */
function getFieldValue<T>(item: T, field: string): unknown {
  if (!item || !field) return undefined;
  const obj = item as Record<string, unknown>;
  // First try direct access
  if (field in obj) return obj[field];
  // Then try nested data property (XDB record format)
  if (obj.data && typeof obj.data === 'object' && field in (obj.data as Record<string, unknown>)) {
    return (obj.data as Record<string, unknown>)[field];
  }
  return undefined;
}

export interface SmartTimelineProps<T = Record<string, unknown>> {
  /** Data array to display */
  data: T[];
  /** Field for event title/action */
  title?: string;
  /** Field for event description */
  description?: string;
  /** Field for timestamp */
  time?: string;
  /** Field for status/type (determines icon/color) */
  status?: string;
  /** Field for user/actor */
  actor?: string;
  /** Variant style */
  variant?: 'default' | 'compact' | 'card';
  /** Show connecting lines */
  showLine?: boolean;
  /** Click handler */
  onSelect?: (item: T) => void;
  /** Max items to show */
  maxItems?: number;
  /** Empty state message */
  emptyMessage?: string;
  /** Additional CSS class */
  className?: string;
  /** Inline styles */
  style?: React.CSSProperties;
}

// Status/type to icon and color mapping
const statusConfig: Record<string, { icon: React.ReactNode; color: string; bg: string }> = {
  completed: {
    icon: (
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="3"
      >
        <polyline points="20 6 9 17 4 12" />
      </svg>
    ),
    color: '#22c55e',
    bg: 'rgba(34, 197, 94, 0.15)',
  },
  success: {
    icon: (
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="3"
      >
        <polyline points="20 6 9 17 4 12" />
      </svg>
    ),
    color: '#22c55e',
    bg: 'rgba(34, 197, 94, 0.15)',
  },
  'in-progress': {
    icon: (
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      >
        <circle cx="12" cy="12" r="10" />
        <polyline points="12 6 12 12 16 14" />
      </svg>
    ),
    color: '#3b82f6',
    bg: 'rgba(59, 130, 246, 0.15)',
  },
  pending: {
    icon: (
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      >
        <circle cx="12" cy="12" r="10" />
        <polyline points="12 6 12 12 16 14" />
      </svg>
    ),
    color: '#fbbf24',
    bg: 'rgba(251, 191, 36, 0.15)',
  },
  scheduled: {
    icon: (
      <svg
        width="14"
        height="14"
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
    color: '#8b5cf6',
    bg: 'rgba(139, 92, 246, 0.15)',
  },
  cancelled: {
    icon: (
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      >
        <circle cx="12" cy="12" r="10" />
        <line x1="15" y1="9" x2="9" y2="15" />
        <line x1="9" y1="9" x2="15" y2="15" />
      </svg>
    ),
    color: '#ef4444',
    bg: 'rgba(239, 68, 68, 0.15)',
  },
  error: {
    icon: (
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      >
        <circle cx="12" cy="12" r="10" />
        <line x1="15" y1="9" x2="9" y2="15" />
        <line x1="9" y1="9" x2="15" y2="15" />
      </svg>
    ),
    color: '#ef4444',
    bg: 'rgba(239, 68, 68, 0.15)',
  },
  payment: {
    icon: (
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      >
        <line x1="12" y1="1" x2="12" y2="23" />
        <path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
      </svg>
    ),
    color: '#10b981',
    bg: 'rgba(16, 185, 129, 0.15)',
  },
  message: {
    icon: (
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      >
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      </svg>
    ),
    color: '#0ea5e9',
    bg: 'rgba(14, 165, 233, 0.15)',
  },
  user: {
    icon: (
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      >
        <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
        <circle cx="12" cy="7" r="4" />
      </svg>
    ),
    color: '#6366f1',
    bg: 'rgba(99, 102, 241, 0.15)',
  },
  default: {
    icon: (
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      >
        <circle cx="12" cy="12" r="4" />
      </svg>
    ),
    color: '#a1a1aa',
    bg: 'rgba(161, 161, 170, 0.15)',
  },
};

// Format timestamp
function formatTime(value: unknown): string {
  if (!value) return '';

  if (typeof value === 'string') {
    // Check if it's a date string
    if (/^\d{4}-\d{2}-\d{2}/.test(value)) {
      const date = new Date(value);
      return date.toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
    }
    return value;
  }

  if (typeof value === 'number') {
    const date = new Date(value);
    return date.toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  return String(value);
}

// Get initials from name
function getInitials(name: string): string {
  return name
    .split(' ')
    .map((n) => n[0])
    .join('')
    .toUpperCase()
    .slice(0, 2);
}

export function SmartTimeline<T extends Record<string, unknown>>({
  data,
  title = 'title',
  description,
  time = 'time',
  status = 'status',
  actor,
  variant = 'default',
  showLine = true,
  onSelect,
  maxItems,
  emptyMessage = 'No activity to display',
  className,
  style,
}: SmartTimelineProps<T>): React.ReactElement {
  // Ensure data is array
  const safeData = Array.isArray(data) ? data : [];

  // Limit items if maxItems set
  const displayData = maxItems ? safeData.slice(0, maxItems) : safeData;

  // Container styles
  const containerStyle: React.CSSProperties = {
    background: variant === 'card' ? 'var(--color-surface, #ffffff)' : 'transparent',
    border: variant === 'card' ? '1px solid var(--color-border, rgba(0, 0, 0, 0.08))' : 'none',
    borderRadius: variant === 'card' ? 'var(--radius-lg, 0.75rem)' : undefined,
    padding: variant === 'card' ? '1rem' : undefined,
    ...style,
  };

  const emptyStyle: React.CSSProperties = {
    textAlign: 'center',
    padding: '2rem',
    color: 'var(--color-text-muted, #6b6b80)',
    fontSize: '0.875rem',
  };

  if (displayData.length === 0) {
    return (
      <div className={`softn-smart-timeline ${className || ''}`} style={containerStyle}>
        <div style={emptyStyle}>{emptyMessage}</div>
      </div>
    );
  }

  return (
    <div className={`softn-smart-timeline ${className || ''}`} style={containerStyle}>
      {displayData.map((item, index) => {
        const itemKey = (item as Record<string, unknown>).id != null
          ? String((item as Record<string, unknown>).id)
          : index;
        const titleValue = getFieldValue(item, title);
        const descValue = description ? getFieldValue(item, description) : null;
        const timeValue = getFieldValue(item, time);
        const statusValue = status
          ? String(getFieldValue(item, status) || '').toLowerCase()
          : 'default';
        const actorValue = actor ? getFieldValue(item, actor) : null;

        const config = statusConfig[statusValue] || statusConfig.default;
        const isLast = index === displayData.length - 1;

        return (
          <div
            key={itemKey}
            style={{
              display: 'flex',
              gap: '1rem',
              cursor: onSelect ? 'pointer' : 'default',
              paddingBottom: isLast ? 0 : '1.25rem',
              transition: 'all 200ms cubic-bezier(0.16, 1, 0.3, 1)',
            }}
            onClick={() => onSelect?.(item)}
          >
            {/* Timeline indicator */}
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                flexShrink: 0,
              }}
            >
              {/* Icon circle */}
              <div
                style={{
                  width: variant === 'compact' ? '1.75rem' : '2rem',
                  height: variant === 'compact' ? '1.75rem' : '2rem',
                  borderRadius: 'var(--radius-full, 9999px)',
                  background: config.bg,
                  color: config.color,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flexShrink: 0,
                  border: `2px solid ${config.color}`,
                }}
              >
                {config.icon}
              </div>

              {/* Connecting line */}
              {showLine && !isLast && (
                <div
                  style={{
                    width: '2px',
                    flex: 1,
                    minHeight: '1.5rem',
                    background: 'var(--color-border, rgba(0, 0, 0, 0.08))',
                    marginTop: '0.5rem',
                  }}
                />
              )}
            </div>

            {/* Content */}
            <div style={{ flex: 1, paddingTop: '0.125rem' }}>
              {/* Header with title and time */}
              <div
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  justifyContent: 'space-between',
                  gap: '1rem',
                  marginBottom: descValue != null || actorValue != null ? '0.375rem' : 0,
                }}
              >
                <span
                  style={{
                    fontSize: variant === 'compact' ? '0.8125rem' : '0.875rem',
                    fontWeight: 500,
                    color: 'var(--color-text, #1a1a2e)',
                  }}
                >
                  {titleValue ? String(titleValue) : ''}
                </span>
                {timeValue != null && (
                  <span
                    style={{
                      fontSize: '0.75rem',
                      color: 'var(--color-text-muted, #6b6b80)',
                      whiteSpace: 'nowrap',
                      flexShrink: 0,
                    }}
                  >
                    {formatTime(timeValue)}
                  </span>
                )}
              </div>

              {/* Description */}
              {descValue != null && (
                <p
                  style={{
                    fontSize: variant === 'compact' ? '0.75rem' : '0.8125rem',
                    color: 'var(--color-text-muted, #6b6b80)',
                    margin: 0,
                    lineHeight: 1.5,
                  }}
                >
                  {String(descValue)}
                </p>
              )}

              {/* Actor */}
              {actorValue != null && (
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.375rem',
                    marginTop: '0.375rem',
                  }}
                >
                  <div
                    style={{
                      width: '1.25rem',
                      height: '1.25rem',
                      borderRadius: 'var(--radius-full, 9999px)',
                      background: 'linear-gradient(135deg, var(--color-primary, #6366f1), var(--color-primary-600, #4f46e5))',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      color: 'white',
                      fontSize: '0.5rem',
                      fontWeight: 600,
                    }}
                  >
                    {getInitials(String(actorValue))}
                  </div>
                  <span style={{ fontSize: '0.75rem', color: 'var(--color-text-muted, #6b6b80)' }}>
                    {String(actorValue)}
                  </span>
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export default SmartTimeline;

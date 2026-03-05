/**
 * SmartList Component
 *
 * Display data as a compact list with avatars, icons, and actions.
 * Great for activity feeds, recent items, notifications, etc.
 *
 * Usage:
 * <SmartList
 *   data={appointments}
 *   primary="client"
 *   secondary="service"
 *   tertiary="time"
 *   badge="status"
 *   avatar="client"
 * />
 */

import React, { useState, useMemo } from 'react';

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

export interface SmartListProps<T = Record<string, unknown>> {
  /** Data array to display */
  data: T[];
  /** Primary text field (main content) */
  primary?: string;
  /** Secondary text field (subtitle) */
  secondary?: string;
  /** Tertiary text field (timestamp, etc.) */
  tertiary?: string;
  /** Field for badge/status */
  badge?: string;
  /** Field to use for avatar (name for initials, or image URL) */
  avatar?: string;
  /** Field for left icon */
  icon?: string;
  /** Show dividers between items */
  dividers?: boolean;
  /** Variant style */
  variant?: 'default' | 'compact' | 'card';
  /** Enable selection */
  selectable?: boolean;
  /** Click handler */
  onSelect?: (item: T) => void;
  /** Max items to show (for preview lists) */
  maxItems?: number;
  /** Show "View All" link when truncated */
  showViewAll?: boolean;
  /** View all click handler */
  onViewAll?: () => void;
  /** Empty state message */
  emptyMessage?: string;
  /** Additional CSS class */
  className?: string;
  /** Inline styles */
  style?: React.CSSProperties;
}

// Status colors
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

// Icon map for common icons
const iconMap: Record<string, React.ReactNode> = {
  calendar: (
    <svg
      width="18"
      height="18"
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
  user: (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
      <circle cx="12" cy="7" r="4" />
    </svg>
  ),
  check: (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      <polyline points="20 6 9 17 4 12" />
    </svg>
  ),
  clock: (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </svg>
  ),
  star: (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
    </svg>
  ),
  bell: (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.73 21a2 2 0 0 1-3.46 0" />
    </svg>
  ),
  mail: (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" />
      <polyline points="22,6 12,13 2,6" />
    </svg>
  ),
  scissors: (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      <circle cx="6" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <line x1="20" y1="4" x2="8.12" y2="15.88" />
      <line x1="14.47" y1="14.48" x2="20" y2="20" />
      <line x1="8.12" y1="8.12" x2="12" y2="12" />
    </svg>
  ),
  dollar: (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      <line x1="12" y1="1" x2="12" y2="23" />
      <path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
    </svg>
  ),
};

// Get initials from name
function getInitials(name: string): string {
  return name
    .split(' ')
    .map((n) => n[0])
    .join('')
    .toUpperCase()
    .slice(0, 2);
}

// Gradient colors for avatars (warm luxury palette)
const avatarGradients = [
  'linear-gradient(135deg, var(--color-primary, #6366f1), var(--color-primary-600, #4f46e5))',
  'linear-gradient(135deg, #8b5cf6, #7c3aed)',
  'linear-gradient(135deg, #06b6d4, #0891b2)',
  'linear-gradient(135deg, #f59e0b, #d97706)',
  'linear-gradient(135deg, #10b981, #059669)',
];

export function SmartList<T extends Record<string, unknown>>({
  data,
  primary = 'name',
  secondary,
  tertiary,
  badge,
  avatar,
  icon,
  dividers = true,
  variant = 'default',
  selectable = true,
  onSelect,
  maxItems,
  showViewAll = true,
  onViewAll,
  emptyMessage = 'No items to display',
  className,
  style,
}: SmartListProps<T>): React.ReactElement {
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);

  // Ensure data is array
  const safeData = Array.isArray(data) ? data : [];

  // Limit items if maxItems set
  const displayData = useMemo(() => {
    if (maxItems && safeData.length > maxItems) {
      return safeData.slice(0, maxItems);
    }
    return safeData;
  }, [safeData, maxItems]);

  const hasMore = maxItems ? safeData.length > maxItems : false;

  // Container styles
  const containerStyle: React.CSSProperties = {
    background: variant === 'card' ? 'var(--color-surface, #16161a)' : 'transparent',
    border: variant === 'card' ? '1px solid var(--color-border, rgba(255, 255, 255, 0.08))' : 'none',
    borderRadius: variant === 'card' ? 'var(--radius-lg, 0.75rem)' : undefined,
    overflow: 'hidden',
    ...style,
  };

  const getItemStyle = (index: number): React.CSSProperties => ({
    display: 'flex',
    alignItems: 'center',
    gap: '0.75rem',
    padding: variant === 'compact' ? '0.5rem' : '0.75rem 1rem',
    background: hoveredIndex === index ? 'var(--color-gray-50, #1e1e23)' : 'transparent',
    cursor: selectable || onSelect ? 'pointer' : 'default',
    transition: 'all 200ms cubic-bezier(0.16, 1, 0.3, 1)',
    transform: hoveredIndex === index ? 'translateX(4px)' : 'none',
    borderBottom:
      dividers && index < displayData.length - 1
        ? '1px solid var(--color-border, rgba(255, 255, 255, 0.08))'
        : 'none',
    borderRadius: hoveredIndex === index ? '0.375rem' : '0',
  });

  const emptyStyle: React.CSSProperties = {
    textAlign: 'center',
    padding: '2rem',
    color: 'var(--color-text-muted, #a1a1aa)',
    fontSize: '0.875rem',
  };

  const viewAllStyle: React.CSSProperties = {
    display: 'flex',
    justifyContent: 'center',
    padding: '0.75rem',
    borderTop: '1px solid var(--color-border, rgba(255, 255, 255, 0.08))',
    background: 'var(--color-gray-50, #1e1e23)',
  };

  return (
    <div className={`softn-smart-list ${className || ''}`} style={containerStyle}>
      {displayData.length === 0 ? (
        <div style={emptyStyle}>{emptyMessage}</div>
      ) : (
        <>
          {displayData.map((item, index) => {
            const itemKey = (item as Record<string, unknown>).id != null
              ? String((item as Record<string, unknown>).id)
              : index;
            const primaryValue = getFieldValue(item, primary);
            const secondaryValue = secondary ? getFieldValue(item, secondary) : null;
            const tertiaryValue = tertiary ? getFieldValue(item, tertiary) : null;
            const badgeValue = badge ? getFieldValue(item, badge) : null;
            const avatarValue = avatar ? getFieldValue(item, avatar) : null;
            const iconValue = icon ? getFieldValue(item, icon) : icon;

            const strBadge = badgeValue ? String(badgeValue).toLowerCase() : '';
            const badgeColors = statusColors[strBadge] || {
              bg: 'var(--color-gray-700, #3f3f46)',
              text: 'var(--color-text-muted, #a1a1aa)',
            };

            return (
              <div
                key={itemKey}
                style={getItemStyle(index)}
                onMouseEnter={() => setHoveredIndex(index)}
                onMouseLeave={() => setHoveredIndex(null)}
                onClick={() => onSelect?.(item)}
              >
                {/* Icon or Avatar */}
                {(iconValue != null || avatarValue != null || avatar) && (
                  <div
                    style={{
                      width: variant === 'compact' ? '2rem' : '2.5rem',
                      height: variant === 'compact' ? '2rem' : '2.5rem',
                      borderRadius:
                        iconValue && iconMap[iconValue as string]
                          ? 'var(--radius-md, 0.5rem)'
                          : 'var(--radius-full, 9999px)',
                      background:
                        iconValue && iconMap[iconValue as string]
                          ? 'var(--color-gray-700, #3f3f46)'
                          : avatarGradients[index % avatarGradients.length],
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      color:
                        iconValue && iconMap[iconValue as string]
                          ? 'var(--color-text-muted, #a1a1aa)'
                          : 'white',
                      fontWeight: 600,
                      fontSize: variant === 'compact' ? '0.75rem' : '0.875rem',
                      flexShrink: 0,
                    }}
                  >
                    {iconValue != null && iconMap[iconValue as string]
                      ? iconMap[iconValue as string]
                      : avatarValue != null
                        ? getInitials(String(avatarValue))
                        : primaryValue != null
                          ? getInitials(String(primaryValue))
                          : null}
                  </div>
                )}

                {/* Content */}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <span
                      style={{
                        fontSize: variant === 'compact' ? '0.8125rem' : '0.875rem',
                        fontWeight: 500,
                        color: 'var(--color-text, #f5f5f5)',
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                      }}
                    >
                      {primaryValue != null ? String(primaryValue) : ''}
                    </span>
                    {badgeValue != null && (
                      <span
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: '0.25rem',
                          padding: '0.125rem 0.375rem',
                          borderRadius: 'var(--radius-full, 9999px)',
                          background: badgeColors.bg,
                          color: badgeColors.text,
                          fontSize: '0.625rem',
                          fontWeight: 500,
                          textTransform: 'capitalize',
                          flexShrink: 0,
                        }}
                      >
                        {strBadge === 'online' || strBadge === 'active' ? (
                          <span
                            style={{
                              width: '0.375rem',
                              height: '0.375rem',
                              borderRadius: '50%',
                              background: badgeColors.text,
                            }}
                          />
                        ) : null}
                        {String(badgeValue)}
                      </span>
                    )}
                  </div>
                  {secondaryValue != null && (
                    <div
                      style={{
                        fontSize: variant === 'compact' ? '0.6875rem' : '0.75rem',
                        color: 'var(--color-text-muted, #a1a1aa)',
                        marginTop: '0.125rem',
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                      }}
                    >
                      {String(secondaryValue)}
                    </div>
                  )}
                </div>

                {/* Tertiary (time, etc.) */}
                {tertiaryValue != null && (
                  <div
                    style={{
                      fontSize: '0.75rem',
                      color: 'var(--color-text-muted, #a1a1aa)',
                      whiteSpace: 'nowrap',
                      flexShrink: 0,
                    }}
                  >
                    {String(tertiaryValue)}
                  </div>
                )}
              </div>
            );
          })}

          {/* View All */}
          {hasMore && showViewAll && onViewAll && (
            <div style={viewAllStyle}>
              <button
                onClick={onViewAll}
                style={{
                  background: 'none',
                  border: 'none',
                  color: 'var(--color-primary, #6366f1)',
                  fontSize: '0.8125rem',
                  fontWeight: 500,
                  cursor: 'pointer',
                  padding: '0.25rem 0.5rem',
                }}
              >
                View all {safeData.length} items →
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

export default SmartList;

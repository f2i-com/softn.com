/**
 * SmartCards Component
 *
 * Display data as beautiful cards in a responsive grid.
 * Each card shows key fields with smart formatting.
 *
 * Usage:
 * <SmartCards
 *   data={staff}
 *   title="name"
 *   subtitle="role"
 *   image="avatar"
 *   badges="status"
 *   meta="rating, appointments"
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

export interface SmartCardsProps<T = Record<string, unknown>> {
  /** Data array to display */
  data: T[];
  /** Field to use as card title */
  title?: string;
  /** Field to use as card subtitle */
  subtitle?: string;
  /** Field to use as card description */
  description?: string;
  /** Field to use as card image/avatar */
  image?: string;
  /** Comma-separated fields to show as badges */
  badges?: string;
  /** Comma-separated fields to show as metadata */
  meta?: string;
  /** Number of columns */
  columns?: number | { sm?: number; md?: number; lg?: number };
  /** Card variant */
  variant?: 'default' | 'elevated' | 'outline' | 'compact';
  /** Enable search */
  searchable?: boolean;
  /** Enable selection */
  selectable?: boolean;
  /** Click handler */
  onSelect?: (item: T) => void;
  /** Custom render for card content */
  renderCard?: (item: T, index: number) => React.ReactNode;
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

// Humanize field name
function humanize(str: string): string {
  return str
    .replace(/([A-Z])/g, ' $1')
    .replace(/_/g, ' ')
    .replace(/^./, (s) => s.toUpperCase())
    .trim();
}

// Format value
function formatValue(value: unknown, field: string): string {
  if (value === null || value === undefined) return '';

  if (typeof value === 'boolean') {
    return value ? 'Yes' : 'No';
  }

  if (typeof value === 'number') {
    // Check if it looks like currency
    if (
      field.toLowerCase().includes('price') ||
      field.toLowerCase().includes('spent') ||
      field.toLowerCase().includes('revenue') ||
      field.toLowerCase().includes('salary')
    ) {
      return '$' + value.toLocaleString();
    }
    // Check if it's a rating
    if (field.toLowerCase().includes('rating')) {
      return '★ ' + value.toFixed(1);
    }
    return value.toLocaleString();
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

// Search icon
const SearchIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <circle cx="11" cy="11" r="8" />
    <path d="M21 21l-4.35-4.35" />
  </svg>
);

export function SmartCards<T extends Record<string, unknown>>({
  data,
  title = 'name',
  subtitle,
  description,
  image,
  badges,
  meta,
  columns = 3,
  variant = 'default',
  searchable = false,
  selectable = true,
  onSelect,
  renderCard,
  emptyMessage = 'No items to display',
  className,
  style,
}: SmartCardsProps<T>): React.ReactElement {
  const [searchQuery, setSearchQuery] = useState('');
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);

  // Ensure data is array
  const safeData = Array.isArray(data) ? data : [];

  // Parse field lists
  const badgeFields = badges?.split(',').map((b) => b.trim()) || [];
  const metaFields = meta?.split(',').map((m) => m.trim()) || [];

  // Filter data by search
  const filteredData = useMemo(() => {
    if (!searchQuery) return safeData;
    const query = searchQuery.toLowerCase();
    return safeData.filter((item) => {
      const titleVal = getFieldValue(item, title);
      const subtitleVal = subtitle ? getFieldValue(item, subtitle) : null;
      return (
        (titleVal && String(titleVal).toLowerCase().includes(query)) ||
        (subtitleVal && String(subtitleVal).toLowerCase().includes(query))
      );
    });
  }, [safeData, searchQuery, title, subtitle]);

  // Grid columns - handle responsive object or static number
  const colCount = typeof columns === 'number' ? columns : (columns.lg || 3);
  const colCountSm = typeof columns === 'object' ? (columns.sm || 1) : undefined;
  const colCountMd = typeof columns === 'object' ? (columns.md || 2) : undefined;

  // Container style
  const containerStyle: React.CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    gap: '1rem',
    ...style,
  };

  const searchWrapperStyle: React.CSSProperties = {
    position: 'relative',
    maxWidth: '320px',
  };

  const searchInputStyle: React.CSSProperties = {
    width: '100%',
    padding: '0.5rem 0.75rem 0.5rem 2.25rem',
    borderRadius: 'var(--radius-md, 0.5rem)',
    border: '1px solid var(--color-border, rgba(255, 255, 255, 0.08))',
    background: 'var(--color-surface, #16161a)',
    color: 'var(--color-text, #f5f5f5)',
    fontSize: '0.875rem',
    outline: 'none',
  };

  const searchIconStyle: React.CSSProperties = {
    position: 'absolute',
    left: '0.75rem',
    top: '50%',
    transform: 'translateY(-50%)',
    color: 'var(--color-gray-400, #a1a1aa)',
    pointerEvents: 'none',
  };

  // Generate a unique class for responsive grid
  const gridClassName = `softn-cards-grid-${colCount}`;
  const gridStyle: React.CSSProperties = {
    display: 'grid',
    gridTemplateColumns: `repeat(${colCount}, 1fr)`,
    gap: variant === 'compact' ? '0.75rem' : '1rem',
  };

  const getCardStyle = (index: number): React.CSSProperties => ({
    background: variant === 'outline' ? 'transparent' : 'var(--color-surface, #16161a)',
    border: `1px solid ${hoveredIndex === index ? 'var(--color-border-hover, rgba(255, 255, 255, 0.14))' : 'var(--color-border, rgba(255, 255, 255, 0.08))'}`,
    borderRadius: 'var(--radius-lg, 0.75rem)',
    padding: variant === 'compact' ? '1rem' : '1.25rem',
    cursor: selectable || onSelect ? 'pointer' : 'default',
    transition: 'all 250ms cubic-bezier(0.16, 1, 0.3, 1)',
    transform: hoveredIndex === index ? 'translateY(-3px)' : 'none',
    boxShadow: hoveredIndex === index
      ? '0 8px 24px rgba(0, 0, 0, 0.2), 0 2px 8px rgba(0, 0, 0, 0.1)'
      : variant === 'elevated'
        ? '0 4px 12px rgba(0, 0, 0, 0.15)'
        : 'none',
  });

  const emptyStyle: React.CSSProperties = {
    gridColumn: '1 / -1',
    textAlign: 'center',
    padding: '3rem',
    color: 'var(--color-text-muted, #a1a1aa)',
  };

  // Build responsive CSS if columns is an object
  const responsiveCss = typeof columns === 'object' ? `
    @media (max-width: 640px) {
      .${gridClassName} { grid-template-columns: repeat(${colCountSm}, 1fr) !important; }
    }
    @media (min-width: 641px) and (max-width: 1024px) {
      .${gridClassName} { grid-template-columns: repeat(${colCountMd}, 1fr) !important; }
    }
  ` : `
    @media (max-width: 640px) {
      .${gridClassName} { grid-template-columns: 1fr !important; }
    }
    @media (min-width: 641px) and (max-width: 1024px) {
      .${gridClassName} { grid-template-columns: repeat(${Math.min(colCount, 2)}, 1fr) !important; }
    }
  `;

  return (
    <div className={`softn-smart-cards ${className || ''}`} style={containerStyle}>
      <style>{responsiveCss}</style>
      {searchable && (
        <div style={searchWrapperStyle}>
          <span style={searchIconStyle}>
            <SearchIcon />
          </span>
          <input
            type="text"
            placeholder="Search..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            style={searchInputStyle}
          />
        </div>
      )}

      <div className={gridClassName} style={gridStyle}>
        {filteredData.length === 0 ? (
          <div style={emptyStyle}>{emptyMessage}</div>
        ) : (
          filteredData.map((item, index) => {
            const itemKey = (item as Record<string, unknown>).id != null
              ? String((item as Record<string, unknown>).id)
              : index;
            // Custom render
            if (renderCard) {
              return (
                <div
                  key={itemKey}
                  style={getCardStyle(index)}
                  onMouseEnter={() => setHoveredIndex(index)}
                  onMouseLeave={() => setHoveredIndex(null)}
                  onClick={async () => {
                    if (onSelect) {
                      try {
                        await onSelect(item);
                      } catch (err) {
                        console.error('[SmartCards] onSelect error:', err);
                      }
                    }
                  }}
                >
                  {renderCard(item, index)}
                </div>
              );
            }

            const titleValue = getFieldValue(item, title);
            const subtitleValue = subtitle ? getFieldValue(item, subtitle) : null;
            const descValue = description ? getFieldValue(item, description) : null;
            const imageValue = image ? getFieldValue(item, image) : null;

            return (
              <div
                key={itemKey}
                style={getCardStyle(index)}
                onMouseEnter={() => setHoveredIndex(index)}
                onMouseLeave={() => setHoveredIndex(null)}
                onClick={() => onSelect?.(item)}
              >
                {/* Header with image/avatar */}
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: '0.75rem',
                    marginBottom: '0.75rem',
                  }}
                >
                  {/* Avatar/Image */}
                  {(image || titleValue != null) && (
                    <div
                      style={{
                        width: '2.5rem',
                        height: '2.5rem',
                        borderRadius: 'var(--radius-full, 9999px)',
                        background: imageValue
                          ? `url(${imageValue}) center/cover`
                          : 'linear-gradient(135deg, var(--color-primary, #6366f1), var(--color-primary-600, #4f46e5))',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        color: 'white',
                        fontWeight: 600,
                        fontSize: '0.875rem',
                        flexShrink: 0,
                      }}
                    >
                      {!imageValue && titleValue ? getInitials(String(titleValue)) : null}
                    </div>
                  )}

                  {/* Title & Subtitle */}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    {titleValue != null && (
                      <div
                        style={{
                          fontSize: '0.9375rem',
                          fontWeight: 600,
                          color: 'var(--color-text, #f5f5f5)',
                          whiteSpace: 'nowrap',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                        }}
                      >
                        {String(titleValue)}
                      </div>
                    )}
                    {subtitleValue != null && (
                      <div
                        style={{
                          fontSize: '0.8125rem',
                          color: 'var(--color-text-muted, #a1a1aa)',
                          marginTop: '0.125rem',
                        }}
                      >
                        {String(subtitleValue)}
                      </div>
                    )}
                  </div>
                </div>

                {/* Description */}
                {descValue != null && (
                  <p
                    style={{
                      fontSize: '0.8125rem',
                      color: 'var(--color-text-muted, #a1a1aa)',
                      lineHeight: 1.5,
                      marginBottom: '0.75rem',
                      display: '-webkit-box',
                      WebkitLineClamp: 2,
                      WebkitBoxOrient: 'vertical',
                      overflow: 'hidden',
                    }}
                  >
                    {String(descValue)}
                  </p>
                )}

                {/* Badges */}
                {badgeFields.length > 0 && (
                  <div
                    style={{
                      display: 'flex',
                      flexWrap: 'wrap',
                      gap: '0.375rem',
                      marginBottom: '0.75rem',
                    }}
                  >
                    {badgeFields.map((field) => {
                      const value = getFieldValue(item, field);
                      if (value === null || value === undefined) return null;
                      const strValue = String(value).toLowerCase();
                      const colors = statusColors[strValue] || {
                        bg: 'var(--color-gray-700, #3f3f46)',
                        text: 'var(--color-text-muted, #a1a1aa)',
                      };
                      return (
                        <span
                          key={field}
                          style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: '0.25rem',
                            padding: '0.25rem 0.5rem',
                            borderRadius: 'var(--radius-full, 9999px)',
                            background: colors.bg,
                            color: colors.text,
                            fontSize: '0.6875rem',
                            fontWeight: 500,
                            textTransform: 'capitalize',
                          }}
                        >
                          {strValue === 'online' || strValue === 'active' ? (
                            <span
                              style={{
                                width: '0.375rem',
                                height: '0.375rem',
                                borderRadius: '50%',
                                background: colors.text,
                              }}
                            />
                          ) : null}
                          {String(value)}
                        </span>
                      );
                    })}
                  </div>
                )}

                {/* Meta fields */}
                {metaFields.length > 0 && (
                  <div
                    style={{
                      display: 'flex',
                      flexWrap: 'wrap',
                      gap: '1rem',
                      paddingTop: '0.75rem',
                      borderTop: '1px solid var(--color-border, rgba(255, 255, 255, 0.08))',
                    }}
                  >
                    {metaFields.map((field) => {
                      const value = getFieldValue(item, field);
                      if (value === null || value === undefined) return null;
                      return (
                        <div
                          key={field}
                          style={{ display: 'flex', flexDirection: 'column', gap: '0.125rem' }}
                        >
                          <span
                            style={{
                              fontSize: '0.6875rem',
                              color: 'var(--color-text-muted, #a1a1aa)',
                              textTransform: 'uppercase',
                              letterSpacing: '0.05em',
                            }}
                          >
                            {humanize(field)}
                          </span>
                          <span
                            style={{
                              fontSize: '0.875rem',
                              fontWeight: 600,
                              color: 'var(--color-text, #f5f5f5)',
                            }}
                          >
                            {formatValue(value, field)}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

export default SmartCards;

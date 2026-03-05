/**
 * Breadcrumb Component
 *
 * A navigation breadcrumb trail.
 */

import React from 'react';

export interface BreadcrumbItem {
  /** Item label */
  label: string;
  /** Link href */
  href?: string;
  /** Click handler */
  onClick?: () => void;
  /** Icon */
  icon?: React.ReactNode;
}

export interface BreadcrumbProps {
  /** Breadcrumb items */
  items: BreadcrumbItem[];
  /** Separator character or element */
  separator?: React.ReactNode;
  /** Size */
  size?: 'sm' | 'md' | 'lg';
  /** Additional CSS class */
  className?: string;
  /** Inline styles */
  style?: React.CSSProperties;
}

const sizeStyles: Record<string, { fontSize: string; gap: string }> = {
  sm: { fontSize: '0.75rem', gap: '0.375rem' },
  md: { fontSize: '0.875rem', gap: '0.5rem' },
  lg: { fontSize: '1rem', gap: '0.625rem' },
};

export function Breadcrumb({
  items,
  separator = '/',
  size = 'md',
  className,
  style,
}: BreadcrumbProps): React.ReactElement {
  const sizes = sizeStyles[size];

  const containerStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: sizes.gap,
    fontSize: sizes.fontSize,
    ...style,
  };

  const separatorStyle: React.CSSProperties = {
    color: 'var(--color-text-muted, #a1a1aa)',
    userSelect: 'none',
  };

  const getLinkStyle = (isLast: boolean): React.CSSProperties => ({
    display: 'inline-flex',
    alignItems: 'center',
    gap: '0.25rem',
    color: isLast ? 'var(--color-text, #e4e4e7)' : 'var(--color-text-muted, #a1a1aa)',
    textDecoration: 'none',
    fontWeight: isLast ? 500 : 400,
    cursor: isLast ? 'default' : 'pointer',
  });

  return (
    <nav aria-label="Breadcrumb" className={className} style={containerStyle}>
      {items.map((item, index) => {
        const isLast = index === items.length - 1;
        const linkStyle = getLinkStyle(isLast);

        return (
          <React.Fragment key={index}>
            {index > 0 && <span style={separatorStyle}>{separator}</span>}
            {item.href && !isLast ? (
              <a
                href={item.href}
                onClick={(e) => {
                  if (item.onClick) {
                    e.preventDefault();
                    item.onClick();
                  }
                }}
                style={linkStyle}
              >
                {item.icon}
                {item.label}
              </a>
            ) : (
              <span
                onClick={!isLast ? item.onClick : undefined}
                style={linkStyle}
                aria-current={isLast ? 'page' : undefined}
              >
                {item.icon}
                {item.label}
              </span>
            )}
          </React.Fragment>
        );
      })}
    </nav>
  );
}

export default Breadcrumb;

/**
 * Breadcrumb Component
 *
 * A navigation breadcrumb trail.
 */

import React from 'react';
import { isSafeUrl } from '@softn/core';

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

const LINK_RESET: React.CSSProperties = {
  padding: 0,
  margin: 0,
  border: 'none',
  background: 'none',
  font: 'inherit',
  textAlign: 'inherit',
};

export function Breadcrumb({
  items,
  separator = '/',
  size = 'md',
  className,
  style,
}: BreadcrumbProps): React.ReactElement {
  const sizes = sizeStyles[size] ?? sizeStyles.md;
  const trail = Array.isArray(items) ? items.filter(Boolean) : [];

  const containerStyle: React.CSSProperties = {
    fontSize: sizes.fontSize,
    ...style,
  };

  // An ordered list, as the pattern asks: a screen reader announces how many
  // steps the trail has and where in it each one is.
  const listStyle: React.CSSProperties = {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: sizes.gap,
    listStyle: 'none',
    margin: 0,
    padding: 0,
  };

  const itemStyle: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: sizes.gap,
    minWidth: 0,
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
    overflowWrap: 'anywhere',
  });

  return (
    <nav aria-label="Breadcrumb" className={className} style={containerStyle}>
      <ol style={listStyle}>
        {trail.map((item, index) => {
          const isLast = index === trail.length - 1;
          const linkStyle = getLinkStyle(isLast);
          // A trail is bundle-supplied data, so `href` is whatever the bundle
          // put there. React only warns about `javascript:` and emits it
          // anyway, and one click then runs bundle code on the host origin. An
          // item that fails the check still renders, keeping its label and its
          // `onClick`.
          const href = item.href && isSafeUrl(item.href) ? item.href : undefined;
          const icon = item.icon ? (
            <span aria-hidden="true" style={{ display: 'inline-flex' }}>
              {item.icon}
            </span>
          ) : null;

          let content: React.ReactNode;
          if (href && !isLast) {
            content = (
              <a
                href={href}
                onClick={(e) => {
                  if (item.onClick) {
                    e.preventDefault();
                    item.onClick();
                  }
                }}
                style={linkStyle}
              >
                {icon}
                {item.label}
              </a>
            );
          } else if (item.onClick && !isLast) {
            // A step with a handler and no link was a <span onClick>: no tab
            // stop, nothing for Enter to press. A button is both.
            content = (
              <button type="button" onClick={item.onClick} style={{ ...LINK_RESET, ...linkStyle }}>
                {icon}
                {item.label}
              </button>
            );
          } else {
            content = (
              <span style={linkStyle} aria-current={isLast ? 'page' : undefined}>
                {icon}
                {item.label}
              </span>
            );
          }

          return (
            <li key={index} style={itemStyle}>
              {index > 0 && (
                <span aria-hidden="true" style={separatorStyle}>
                  {separator}
                </span>
              )}
              {content}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

export default Breadcrumb;

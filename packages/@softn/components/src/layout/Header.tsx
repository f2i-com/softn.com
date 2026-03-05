/**
 * Header Component
 *
 * Page header with title and actions.
 */

import React from 'react';

export interface HeaderProps {
  /** Header content */
  children?: React.ReactNode;
  /** Header title (shorthand) */
  title?: string;
  /** Background color */
  background?: string;
  /** Border color */
  borderColor?: string;
  /** Sticky header */
  sticky?: boolean;
  /** Additional CSS class */
  className?: string;
  /** Inline styles */
  style?: React.CSSProperties;
}

export function Header({
  children,
  title,
  background = 'var(--color-surface, #16161a)',
  borderColor = 'var(--color-border, rgba(255, 255, 255, 0.08))',
  sticky = false,
  className,
  style,
}: HeaderProps): React.ReactElement {
  const containerStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '1rem 1.5rem',
    background,
    borderBottom: `1px solid ${borderColor}`,
    ...(sticky && {
      position: 'sticky',
      top: 0,
      zIndex: 100,
    }),
    ...style,
  };

  const titleStyle: React.CSSProperties = {
    margin: 0,
    fontSize: '1.25rem',
    fontWeight: 600,
    color: 'var(--color-text, #f5f5f5)',
  };

  return (
    <header className={`softn-header ${className || ''}`} style={containerStyle}>
      {title && <h1 style={titleStyle}>{title}</h1>}
      {children}
    </header>
  );
}

export default Header;

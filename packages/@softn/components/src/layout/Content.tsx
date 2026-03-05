/**
 * Content Component
 *
 * Main content area that fills available space.
 */

import React from 'react';

export interface ContentProps {
  /** Content */
  children?: React.ReactNode;
  /** Route name (for conditional rendering) */
  route?: string;
  /** Padding */
  padding?: 'none' | 'sm' | 'md' | 'lg' | 'xl' | string;
  /** Background color */
  background?: string;
  /** Additional CSS class */
  className?: string;
  /** Inline styles */
  style?: React.CSSProperties;
}

const paddingMap: Record<string, string> = {
  none: '0',
  sm: '0.5rem',
  md: '1rem',
  lg: '1.5rem',
  xl: '2rem',
};

export function Content({
  children,
  route,
  padding = 'none',
  background = 'var(--color-bg, #0f0f0f)',
  className,
  style,
}: ContentProps): React.ReactElement {
  const paddingValue = paddingMap[padding] || padding;

  const containerStyle: React.CSSProperties = {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    padding: paddingValue,
    background,
    overflow: 'auto',
    minHeight: 0, // Allow flex shrinking vertically
    minWidth: 0, // Allow flex shrinking horizontally
    ...style,
  };

  return (
    <main className={`softn-content ${className || ''}`} style={containerStyle} data-route={route}>
      {children}
    </main>
  );
}

export default Content;

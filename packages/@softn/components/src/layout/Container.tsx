/**
 * Container Component
 *
 * A max-width container with responsive breakpoints.
 */

import React from 'react';

export interface ContainerProps {
  /** Max width size */
  size?: 'sm' | 'md' | 'lg' | 'xl' | '2xl' | 'full';
  /** Center the container */
  centered?: boolean;
  /** Padding */
  padding?: 'none' | 'xs' | 'sm' | 'md' | 'lg' | 'xl' | string;
  /** Additional CSS class */
  className?: string;
  /** Inline styles */
  style?: React.CSSProperties;
  /** Children */
  children?: React.ReactNode;
}

const maxWidthValues: Record<string, string> = {
  sm: '640px',
  md: '768px',
  lg: '1024px',
  xl: '1280px',
  '2xl': '1536px',
  full: '100%',
};

const paddingValues: Record<string, string> = {
  none: '0',
  xs: '0.5rem',
  sm: '1rem',
  md: '1.5rem',
  lg: '2rem',
  xl: '3rem',
};

export function Container({
  size = 'lg',
  centered = true,
  padding = 'md',
  className,
  style,
  children,
}: ContainerProps): React.ReactElement {
  const computedStyle: React.CSSProperties = {
    maxWidth: maxWidthValues[size] ?? size,
    width: '100%',
    marginLeft: centered ? 'auto' : undefined,
    marginRight: centered ? 'auto' : undefined,
    paddingLeft: paddingValues[padding] ?? padding,
    paddingRight: paddingValues[padding] ?? padding,
    ...style,
  };

  return (
    <div className={className} style={computedStyle}>
      {children}
    </div>
  );
}

export default Container;

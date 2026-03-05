/**
 * Center Component
 *
 * Centers content horizontally and vertically.
 */

import React from 'react';

export interface CenterProps {
  /** Whether to center inline (horizontal only) */
  inline?: boolean;
  /** Width */
  width?: string;
  /** Height */
  height?: string;
  /** Padding */
  padding?: 'none' | 'xs' | 'sm' | 'md' | 'lg' | 'xl' | string;
  /** Additional CSS class */
  className?: string;
  /** Inline styles */
  style?: React.CSSProperties;
  /** Children */
  children?: React.ReactNode;
}

const paddingValues: Record<string, string> = {
  none: '0',
  xs: '0.25rem',
  sm: '0.5rem',
  md: '1rem',
  lg: '1.5rem',
  xl: '2rem',
};

export function Center({
  inline = false,
  width,
  height,
  padding = 'none',
  className,
  style,
  children,
}: CenterProps): React.ReactElement {
  const computedStyle: React.CSSProperties = inline
    ? {
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width,
        height,
        padding: paddingValues[padding] ?? padding,
        ...style,
      }
    : {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: width ?? '100%',
        height: height ?? '100%',
        padding: paddingValues[padding] ?? padding,
        ...style,
      };

  return (
    <div className={className} style={computedStyle}>
      {children}
    </div>
  );
}

export default Center;

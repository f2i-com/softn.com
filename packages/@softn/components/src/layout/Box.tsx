/**
 * Box Component
 *
 * A generic container with styling props.
 */

import React from 'react';

export interface BoxProps {
  /** Padding */
  padding?: 'none' | 'xs' | 'sm' | 'md' | 'lg' | 'xl' | string;
  /** Margin */
  margin?: 'none' | 'xs' | 'sm' | 'md' | 'lg' | 'xl' | string;
  /** Background color */
  background?: string;
  /** Border radius */
  borderRadius?: 'none' | 'sm' | 'md' | 'lg' | 'full' | string;
  /** Border */
  border?: string;
  /** Shadow */
  shadow?: 'none' | 'sm' | 'md' | 'lg' | 'xl' | string;
  /** Flex value */
  flex?: number | string;
  /** Overflow */
  overflow?: 'visible' | 'hidden' | 'scroll' | 'auto';
  /** Width */
  width?: string;
  /** Height */
  height?: string;
  /** Min width */
  minWidth?: string;
  /** Min height */
  minHeight?: string;
  /** Max width */
  maxWidth?: string;
  /** Max height */
  maxHeight?: string;
  /** Click handler */
  onClick?: (event: React.MouseEvent<HTMLDivElement>) => void;
  /** Additional CSS class */
  className?: string;
  /** Inline styles */
  style?: React.CSSProperties;
  /** Children */
  children?: React.ReactNode;
}

const spacingValues: Record<string, string> = {
  none: '0',
  xs: '0.25rem',
  sm: '0.5rem',
  md: '1rem',
  lg: '1.5rem',
  xl: '2rem',
};

const radiusValues: Record<string, string> = {
  none: '0',
  sm: '0.25rem',
  md: '0.5rem',
  lg: '1rem',
  full: '9999px',
};

const shadowValues: Record<string, string> = {
  none: 'none',
  sm: '0 1px 2px 0 rgba(0, 0, 0, 0.05)',
  md: '0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06)',
  lg: '0 10px 15px -3px rgba(0, 0, 0, 0.1), 0 4px 6px -2px rgba(0, 0, 0, 0.05)',
  xl: '0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 10px 10px -5px rgba(0, 0, 0, 0.04)',
};

export function Box({
  padding = 'none',
  margin = 'none',
  background,
  borderRadius = 'none',
  border,
  shadow = 'none',
  flex,
  overflow,
  width,
  height,
  minWidth,
  minHeight,
  maxWidth,
  maxHeight,
  onClick,
  className,
  style,
  children,
}: BoxProps): React.ReactElement {
  const computedStyle: React.CSSProperties = {
    padding: padding === 'none' ? undefined : (spacingValues[padding] ?? padding),
    margin: margin === 'none' ? undefined : (spacingValues[margin] ?? margin),
    background,
    borderRadius: radiusValues[borderRadius] ?? borderRadius,
    border,
    boxShadow: shadowValues[shadow] ?? shadow,
    flex: flex ?? undefined,
    overflow,
    width,
    height,
    minWidth,
    minHeight,
    maxWidth,
    maxHeight,
    ...style,
  };

  return (
    <div
      className={className}
      style={computedStyle}
      onClick={onClick}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
    >
      {children}
    </div>
  );
}

export default Box;

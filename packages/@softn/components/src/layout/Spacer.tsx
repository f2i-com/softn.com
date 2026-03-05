/**
 * Spacer Component
 *
 * A flexible space for pushing content apart.
 */

import React from 'react';

export interface SpacerProps {
  /** Fixed size (overrides flex) */
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl' | string;
  /** Flex grow value */
  flex?: number;
  /** Additional CSS class */
  className?: string;
  /** Inline styles */
  style?: React.CSSProperties;
}

const sizeValues: Record<string, string> = {
  xs: '0.5rem',
  sm: '1rem',
  md: '1.5rem',
  lg: '2rem',
  xl: '3rem',
};

export function Spacer({ size, flex = 1, className, style }: SpacerProps): React.ReactElement {
  const computedStyle: React.CSSProperties = size
    ? {
        flexShrink: 0,
        width: sizeValues[size] ?? size,
        height: sizeValues[size] ?? size,
        ...style,
      }
    : {
        flex,
        ...style,
      };

  return <div className={className} style={computedStyle} aria-hidden="true" />;
}

export default Spacer;

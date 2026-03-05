/**
 * Divider Component
 *
 * A visual separator line.
 */

import React from 'react';

export interface DividerProps {
  /** Direction of the divider */
  direction?: 'horizontal' | 'vertical';
  /** Thickness of the line */
  thickness?: string;
  /** Color of the line */
  color?: string;
  /** Margin around the divider */
  margin?: 'none' | 'xs' | 'sm' | 'md' | 'lg' | 'xl' | string;
  /** Label in the middle */
  label?: string;
  /** Additional CSS class */
  className?: string;
  /** Inline styles */
  style?: React.CSSProperties;
}

const marginValues: Record<string, string> = {
  none: '0',
  xs: '0.25rem',
  sm: '0.5rem',
  md: '1rem',
  lg: '1.5rem',
  xl: '2rem',
};

export function Divider({
  direction = 'horizontal',
  thickness = '1px',
  color = 'var(--color-border, #3f3f46)',
  margin = 'md',
  label,
  className,
  style,
}: DividerProps): React.ReactElement {
  const marginValue = marginValues[margin] ?? margin;

  if (label) {
    return (
      <div
        className={className}
        style={{
          display: 'flex',
          alignItems: 'center',
          margin: direction === 'horizontal' ? `${marginValue} 0` : `0 ${marginValue}`,
          ...style,
        }}
      >
        <div
          style={{
            flex: 1,
            height: direction === 'horizontal' ? thickness : '100%',
            width: direction === 'vertical' ? thickness : '100%',
            backgroundColor: color,
          }}
        />
        <span
          style={{
            padding: '0 0.75rem',
            color: 'var(--color-text-muted, #a1a1aa)',
            fontSize: '0.875rem',
          }}
        >
          {label}
        </span>
        <div
          style={{
            flex: 1,
            height: direction === 'horizontal' ? thickness : '100%',
            width: direction === 'vertical' ? thickness : '100%',
            backgroundColor: color,
          }}
        />
      </div>
    );
  }

  const computedStyle: React.CSSProperties = {
    backgroundColor: color,
    border: 'none',
    ...(direction === 'horizontal'
      ? {
          height: thickness,
          width: '100%',
          margin: `${marginValue} 0`,
        }
      : {
          width: thickness,
          height: '100%',
          margin: `0 ${marginValue}`,
        }),
    ...style,
  };

  return <hr className={className} style={computedStyle} />;
}

export default Divider;

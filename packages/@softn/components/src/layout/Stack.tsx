/**
 * Stack Component
 *
 * A flexbox container for stacking children vertically or horizontally.
 * Supports responsive direction changes and mobile-friendly defaults.
 */

import React, { useId } from 'react';

export interface StackProps {
  /** Direction of the stack */
  direction?: 'horizontal' | 'vertical';
  /** Gap between children */
  gap?: 'none' | 'xs' | 'sm' | 'md' | 'lg' | 'xl' | string;
  /** Alignment of children on the cross axis */
  align?: 'start' | 'center' | 'end' | 'stretch' | 'baseline';
  /** Justify content on the main axis */
  justify?: 'start' | 'center' | 'end' | 'between' | 'around' | 'evenly';
  /** Whether to wrap children */
  wrap?: boolean;
  /** Flex value */
  flex?: number | string;
  /** Padding */
  padding?: 'none' | 'xs' | 'sm' | 'md' | 'lg' | 'xl' | string;
  /** Height */
  height?: string;
  /** Width */
  width?: string;
  /** Max width - useful for centering content */
  maxWidth?: string;
  /** Margin - e.g., '0 auto' to center */
  margin?: string;
  /** Padding top */
  paddingTop?: string;
  /** Switch to vertical on mobile (< 768px) */
  mobileVertical?: boolean;
  /** Switch to horizontal on mobile */
  mobileHorizontal?: boolean;
  /** Reverse direction on mobile */
  mobileReverse?: boolean;
  /** Additional CSS class */
  className?: string;
  /** Inline styles */
  style?: React.CSSProperties;
  /** Children */
  children?: React.ReactNode;
}

const gapValues: Record<string, string> = {
  none: '0',
  xs: '0.25rem',
  sm: '0.5rem',
  md: '1rem',
  lg: '1.5rem',
  xl: '2rem',
  '2xl': '2.5rem',
  '3xl': '3rem',
};

const paddingValues: Record<string, string> = {
  none: '0',
  xs: '0.25rem',
  sm: '0.5rem',
  md: '1rem',
  lg: '1.5rem',
  xl: '2rem',
};

const alignValues: Record<string, string> = {
  start: 'flex-start',
  center: 'center',
  end: 'flex-end',
  stretch: 'stretch',
  baseline: 'baseline',
};

const justifyValues: Record<string, string> = {
  start: 'flex-start',
  center: 'center',
  end: 'flex-end',
  between: 'space-between',
  around: 'space-around',
  evenly: 'space-evenly',
};

export function Stack({
  direction = 'vertical',
  gap = 'none',
  align = 'stretch',
  justify = 'start',
  wrap = false,
  flex,
  padding = 'none',
  height,
  width,
  maxWidth,
  margin,
  paddingTop,
  mobileVertical = false,
  mobileHorizontal = false,
  mobileReverse = false,
  className,
  style,
  children,
}: StackProps): React.ReactElement {
  const uniqueId = useId();
  const stackId = `softn-stack-${uniqueId.replace(/:/g, '')}`;

  // Check if we need responsive CSS
  const needsResponsiveCSS = mobileVertical || mobileHorizontal || mobileReverse;

  // Generate responsive CSS
  let responsiveCSS = '';
  if (needsResponsiveCSS) {
    const desktopDirection = direction === 'horizontal' ? 'row' : 'column';
    let mobileDirection = desktopDirection;

    if (mobileVertical) {
      mobileDirection = 'column';
    } else if (mobileHorizontal) {
      mobileDirection = 'row';
    }

    if (mobileReverse) {
      mobileDirection = mobileDirection === 'row' ? 'row-reverse' : 'column-reverse';
    }

    responsiveCSS = `
      @media (max-width: 767px) {
        #${stackId} { flex-direction: ${mobileDirection}; }
      }
    `;
  }

  const computedStyle: React.CSSProperties = {
    display: 'flex',
    flexDirection: direction === 'horizontal' ? 'row' : 'column',
    gap: gapValues[gap] ?? gap,
    alignItems: alignValues[align] ?? align,
    justifyContent: justifyValues[justify] ?? justify,
    flexWrap: wrap ? 'wrap' : 'nowrap',
    flex: flex ?? undefined,
    padding: paddingValues[padding] ?? padding,
    height,
    width,
    maxWidth,
    margin,
    paddingTop,
    ...style,
  };

  return (
    <>
      {responsiveCSS && <style>{responsiveCSS}</style>}
      <div id={stackId} className={className} style={computedStyle}>
        {children}
      </div>
    </>
  );
}

export default Stack;

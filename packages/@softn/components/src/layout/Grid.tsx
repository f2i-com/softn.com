/**
 * Grid Component
 *
 * A CSS Grid layout container with responsive support.
 * Uses CSS variables for theming and automatic responsive behavior.
 */

import React, { useId } from 'react';

export interface ResponsiveColumns {
  /** Columns on mobile (< 640px) */
  sm?: number;
  /** Columns on tablet (>= 640px) */
  md?: number;
  /** Columns on desktop (>= 1024px) */
  lg?: number;
  /** Columns on large desktop (>= 1280px) */
  xl?: number;
}

export interface GridProps {
  /** Number of columns - can be number, string, or responsive object */
  columns?: number | string | ResponsiveColumns;
  /** Number of rows */
  rows?: number | string;
  /** Gap between items */
  gap?: 'none' | 'xs' | 'sm' | 'md' | 'lg' | 'xl' | string;
  /** Column gap */
  columnGap?: 'none' | 'xs' | 'sm' | 'md' | 'lg' | 'xl' | string;
  /** Row gap */
  rowGap?: 'none' | 'xs' | 'sm' | 'md' | 'lg' | 'xl' | string;
  /** Align items */
  alignItems?: 'start' | 'center' | 'end' | 'stretch';
  /** Justify items */
  justifyItems?: 'start' | 'center' | 'end' | 'stretch';
  /** Padding */
  padding?: 'none' | 'xs' | 'sm' | 'md' | 'lg' | 'xl' | string;
  /** Min column width for auto-fit (enables responsive grid) */
  minColumnWidth?: string;
  /** Enable automatic responsive behavior (1 col on mobile, scales up) */
  responsive?: boolean;
  /** Collapse to single column on mobile */
  collapseOnMobile?: boolean;
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

// Check if columns is a responsive object
function isResponsiveColumns(columns: any): columns is ResponsiveColumns {
  return (
    typeof columns === 'object' &&
    columns !== null &&
    ('sm' in columns || 'md' in columns || 'lg' in columns || 'xl' in columns)
  );
}

export function Grid({
  columns,
  rows,
  gap = 'md',
  columnGap,
  rowGap,
  alignItems,
  justifyItems,
  padding = 'none',
  minColumnWidth,
  responsive = false,
  collapseOnMobile = false,
  className,
  style,
  children,
}: GridProps): React.ReactElement {
  const uniqueId = useId();
  const gridId = `softn-grid-${uniqueId.replace(/:/g, '')}`;

  // Generate grid template columns
  let gridTemplateColumns: string | undefined;
  let responsiveCSS = '';

  if (minColumnWidth) {
    // Auto-fit with minimum width - automatically responsive
    gridTemplateColumns = `repeat(auto-fit, minmax(min(${minColumnWidth}, 100%), 1fr))`;
  } else if (isResponsiveColumns(columns)) {
    // Responsive columns object - generate media queries
    const sm = columns.sm || 1;
    const md = columns.md || sm;
    const lg = columns.lg || md;
    const xl = columns.xl || lg;

    gridTemplateColumns = `repeat(${sm}, 1fr)`;
    responsiveCSS = `
      @media (min-width: 640px) {
        #${gridId} { grid-template-columns: repeat(${md}, 1fr); }
      }
      @media (min-width: 1024px) {
        #${gridId} { grid-template-columns: repeat(${lg}, 1fr); }
      }
      @media (min-width: 1280px) {
        #${gridId} { grid-template-columns: repeat(${xl}, 1fr); }
      }
    `;
  } else if (responsive && typeof columns === 'number') {
    // Auto-responsive based on column count
    const colCount = columns;
    gridTemplateColumns = '1fr';
    responsiveCSS = `
      @media (min-width: 640px) {
        #${gridId} { grid-template-columns: repeat(${Math.min(2, colCount)}, 1fr); }
      }
      @media (min-width: 768px) {
        #${gridId} { grid-template-columns: repeat(${Math.min(3, colCount)}, 1fr); }
      }
      @media (min-width: 1024px) {
        #${gridId} { grid-template-columns: repeat(${colCount}, 1fr); }
      }
    `;
  } else if (collapseOnMobile && typeof columns === 'number') {
    // Simple collapse: full columns on desktop, 1 on mobile
    gridTemplateColumns = '1fr';
    responsiveCSS = `
      @media (min-width: 768px) {
        #${gridId} { grid-template-columns: repeat(${columns}, 1fr); }
      }
    `;
  } else if (typeof columns === 'number') {
    gridTemplateColumns = `repeat(${columns}, 1fr)`;
  } else if (columns) {
    gridTemplateColumns = columns as string;
  }

  const computedStyle: React.CSSProperties = {
    display: 'grid',
    gridTemplateColumns,
    gridTemplateRows: typeof rows === 'number' ? `repeat(${rows}, 1fr)` : rows,
    gap: gapValues[gap] ?? gap,
    columnGap: columnGap ? (gapValues[columnGap] ?? columnGap) : undefined,
    rowGap: rowGap ? (gapValues[rowGap] ?? rowGap) : undefined,
    alignItems,
    justifyItems,
    padding: paddingValues[padding] ?? padding,
    ...style,
  };

  return (
    <>
      {responsiveCSS && <style>{responsiveCSS}</style>}
      <div id={gridId} className={className} style={computedStyle}>
        {children}
      </div>
    </>
  );
}

export default Grid;

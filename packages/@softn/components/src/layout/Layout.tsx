/**
 * Layout Component
 *
 * Main layout container with sidebar + content structure.
 * Responsive: horizontal layouts stack vertically on mobile.
 */

import React from 'react';

const layoutStyles = `
  .softn-layout {
    overflow: hidden;
  }
  @media (max-width: 768px) {
    .softn-layout.softn-layout-horizontal {
      flex-direction: column !important;
    }
    .softn-layout.softn-layout-horizontal > .softn-sidebar {
      display: none;
    }
  }
`;

export interface LayoutProps {
  /** Layout content (sidebar, header, content) */
  children?: React.ReactNode;
  /** Layout direction */
  direction?: 'horizontal' | 'vertical';
  /** Additional CSS class */
  className?: string;
  /** Inline styles */
  style?: React.CSSProperties;
}

export function Layout({
  children,
  direction = 'horizontal',
  className,
  style,
}: LayoutProps): React.ReactElement {
  const containerStyle: React.CSSProperties = {
    display: 'flex',
    flexDirection: direction === 'horizontal' ? 'row' : 'column',
    height: 'calc(100vh - var(--softn-tab-bar-height, 0px))',
    width: '100%',
    ...style,
  };

  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: layoutStyles }} />
      <div
        className={`softn-layout softn-layout-${direction} ${className || ''}`}
        style={containerStyle}
      >
        {children}
      </div>
    </>
  );
}

export default Layout;

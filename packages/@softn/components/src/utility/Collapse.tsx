/**
 * Collapse Component
 *
 * A collapsible content panel.
 */

import React from 'react';

export interface CollapseProps {
  /** Whether content is visible */
  isOpen: boolean;
  /** Collapse duration in ms */
  duration?: number;
  /** Additional CSS class */
  className?: string;
  /** Inline styles */
  style?: React.CSSProperties;
  /** Content */
  children?: React.ReactNode;
}

export function Collapse({
  isOpen,
  duration = 300,
  className,
  style,
  children,
}: CollapseProps): React.ReactElement {
  const contentRef = React.useRef<HTMLDivElement>(null);
  const [height, setHeight] = React.useState<number | 'auto'>(isOpen ? 'auto' : 0);

  React.useEffect(() => {
    if (isOpen) {
      const contentHeight = contentRef.current?.scrollHeight ?? 0;
      setHeight(contentHeight);

      const timer = setTimeout(() => {
        setHeight('auto');
      }, duration);

      return () => clearTimeout(timer);
    } else {
      const contentHeight = contentRef.current?.scrollHeight ?? 0;
      setHeight(contentHeight);

      // Two frames: the first commits the measured height so the second has
      // something to transition from. Both are cancelled on cleanup, or a
      // reopen (or unmount) inside those frames still collapsed to 0.
      let inner: number | undefined;
      const outer = requestAnimationFrame(() => {
        inner = requestAnimationFrame(() => {
          setHeight(0);
        });
      });
      return () => {
        cancelAnimationFrame(outer);
        if (inner !== undefined) cancelAnimationFrame(inner);
      };
    }
  }, [isOpen, duration]);

  const containerStyle: React.CSSProperties = {
    overflow: 'hidden',
    height: typeof height === 'number' ? `${height}px` : height,
    transition: `height ${duration}ms cubic-bezier(0.16, 1, 0.3, 1)`,
    ...style,
  };

  return (
    <div className={className} style={containerStyle}>
      <div ref={contentRef}>{children}</div>
    </div>
  );
}

export default Collapse;

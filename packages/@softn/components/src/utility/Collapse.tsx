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

      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          setHeight(0);
        });
      });
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

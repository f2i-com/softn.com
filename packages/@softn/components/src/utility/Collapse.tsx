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
  // The effect animates *changes* of `isOpen`. Run on mount it animated a
  // panel that started closed from its full height down to 0: a visible
  // open-and-shut bounce on every page load.
  const shownOpen = React.useRef<boolean | null>(isOpen);

  React.useEffect(() => {
    if (shownOpen.current === isOpen) return;
    shownOpen.current = isOpen;
    if (isOpen) {
      const contentHeight = contentRef.current?.scrollHeight ?? 0;
      setHeight(contentHeight);

      const timer = setTimeout(() => {
        setHeight('auto');
      }, duration);

      return () => {
        clearTimeout(timer);
        // Interrupted (a StrictMode re-run, a changed duration): let the next
        // run finish the job rather than skip it as already shown.
        shownOpen.current = null;
      };
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
        shownOpen.current = null;
      };
    }
  }, [isOpen, duration]);

  const containerStyle: React.CSSProperties = {
    overflow: 'hidden',
    height: typeof height === 'number' ? `${height}px` : height,
    // Closed content is height 0 but still there: its links and fields stayed
    // in the tab order and a screen reader read it. `visibility: hidden` takes
    // it out of both; transitioning visibility keeps it visible until the
    // collapse has finished, and makes it visible at once on the way open.
    visibility: isOpen ? 'visible' : 'hidden',
    transition: `height ${duration}ms cubic-bezier(0.16, 1, 0.3, 1), visibility ${duration}ms`,
    ...style,
  };

  return (
    <div className={className} style={containerStyle} aria-hidden={isOpen ? undefined : true}>
      <div ref={contentRef}>{children}</div>
    </div>
  );
}

export default Collapse;

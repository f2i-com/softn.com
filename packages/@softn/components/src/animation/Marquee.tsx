/**
 * Marquee Component
 *
 * Continuously scrolls content in a specified direction.
 * Content is duplicated to create a seamless loop.
 */

import * as React from 'react';

export interface MarqueeProps {
  /** Scroll speed in pixels per second */
  speed?: number;
  /** Scroll direction */
  direction?: 'left' | 'right' | 'up' | 'down';
  /** Whether to pause the animation on hover */
  pauseOnHover?: boolean;
  /** Gap between repeated content in pixels */
  gap?: number;
  /** Content to scroll */
  children: React.ReactNode;
  /** Additional CSS class */
  className?: string;
  /** Inline styles */
  style?: React.CSSProperties;
}

export function Marquee({
  speed = 50,
  direction = 'left',
  pauseOnHover = true,
  gap = 24,
  children,
  className,
  style,
}: MarqueeProps): React.ReactElement {
  const [contentSize, setContentSize] = React.useState(0);
  const [isPaused, setIsPaused] = React.useState(false);
  const contentRef = React.useRef<HTMLDivElement>(null);
  const styleIdRef = React.useRef<string>(`marquee-${Math.random().toString(36).slice(2, 9)}`);

  const isHorizontal = direction === 'left' || direction === 'right';

  // Measure content size using ResizeObserver
  React.useEffect(() => {
    const el = contentRef.current;
    if (!el) return;

    const measure = () => {
      if (isHorizontal) {
        setContentSize(el.scrollWidth);
      } else {
        setContentSize(el.scrollHeight);
      }
    };

    measure();

    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [isHorizontal, children]);

  // Calculate animation duration from content size and speed
  const totalDistance = contentSize + gap;
  const animationDuration = totalDistance > 0 ? totalDistance / speed : 0;

  // Determine the keyframes animation name and transform
  const animationName = styleIdRef.current;

  let transformFrom: string;
  let transformTo: string;

  switch (direction) {
    case 'left':
      transformFrom = 'translateX(0)';
      transformTo = `translateX(calc(-50% - ${gap / 2}px))`;
      break;
    case 'right':
      transformFrom = `translateX(calc(-50% - ${gap / 2}px))`;
      transformTo = 'translateX(0)';
      break;
    case 'up':
      transformFrom = 'translateY(0)';
      transformTo = `translateY(calc(-50% - ${gap / 2}px))`;
      break;
    case 'down':
      transformFrom = `translateY(calc(-50% - ${gap / 2}px))`;
      transformTo = 'translateY(0)';
      break;
  }

  // Inject keyframes into document head
  React.useEffect(() => {
    const styleEl = document.createElement('style');
    styleEl.textContent = `
      @keyframes ${animationName} {
        from { transform: ${transformFrom}; }
        to { transform: ${transformTo}; }
      }
    `;
    document.head.appendChild(styleEl);
    return () => {
      if (styleEl.parentNode) {
        styleEl.parentNode.removeChild(styleEl);
      }
    };
  }, [animationName, transformFrom, transformTo]);

  const handleMouseEnter = React.useCallback(() => {
    if (pauseOnHover) setIsPaused(true);
  }, [pauseOnHover]);

  const handleMouseLeave = React.useCallback(() => {
    if (pauseOnHover) setIsPaused(false);
  }, [pauseOnHover]);

  const outerStyle: React.CSSProperties = {
    overflow: 'hidden',
    width: '100%',
    ...style,
  };

  const innerStyle: React.CSSProperties = {
    display: 'flex',
    flexDirection: isHorizontal ? 'row' : 'column',
    gap: `${gap}px`,
    width: isHorizontal ? 'max-content' : '100%',
    animationName: animationDuration > 0 ? animationName : 'none',
    animationDuration: animationDuration > 0 ? `${animationDuration}s` : '0s',
    animationTimingFunction: 'linear',
    animationIterationCount: 'infinite',
    animationPlayState: isPaused ? 'paused' : 'running',
  };

  return (
    <div
      className={className}
      style={outerStyle}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      <div style={innerStyle}>
        <div
          ref={contentRef}
          style={{
            display: 'flex',
            flexDirection: isHorizontal ? 'row' : 'column',
            flexShrink: 0,
          }}
        >
          {children}
        </div>
        <div
          aria-hidden="true"
          style={{
            display: 'flex',
            flexDirection: isHorizontal ? 'row' : 'column',
            flexShrink: 0,
          }}
        >
          {children}
        </div>
      </div>
    </div>
  );
}

export default Marquee;

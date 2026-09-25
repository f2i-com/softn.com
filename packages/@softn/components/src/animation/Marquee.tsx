/**
 * Marquee Component
 *
 * Continuously scrolls content in a specified direction.
 * Content is duplicated to create a seamless loop.
 *
 * The copy is decorative: hidden from assistive technology and inert, so a
 * link inside it is not a second, invisible tab stop. Keyboard focus inside
 * the marquee pauses it like hovering does, and with reduced motion
 * requested it does not move at all: the content is shown once, in place.
 */

import * as React from 'react';
import { usePrefersReducedMotion } from '../utils/motion';

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
  const [isHovered, setIsHovered] = React.useState(false);
  const [hasFocus, setHasFocus] = React.useState(false);
  const isPaused = isHovered || hasFocus;
  const reducedMotion = usePrefersReducedMotion();
  const contentRef = React.useRef<HTMLDivElement>(null);
  const copyRef = React.useRef<HTMLDivElement>(null);
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
  // A speed of zero, a negative one or not a number at all stands still,
  // rather than asking for an `Infinitys` or negative duration.
  const totalDistance = contentSize + gap;
  const pxPerSecond = typeof speed === 'number' && Number.isFinite(speed) && speed > 0 ? speed : 0;
  const animationDuration =
    totalDistance > 0 && pxPerSecond > 0 && !reducedMotion ? totalDistance / pxPerSecond : 0;

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

  // React 18 does not know `inert`, and React 19 reads it as a boolean; the
  // attribute is set directly so both leave the copy out of the tab order.
  React.useEffect(() => {
    copyRef.current?.setAttribute('inert', '');
  });

  const handleMouseEnter = React.useCallback(() => {
    if (pauseOnHover) setIsHovered(true);
  }, [pauseOnHover]);

  const handleMouseLeave = React.useCallback(() => {
    setIsHovered(false);
  }, []);

  const handleFocus = React.useCallback(() => setHasFocus(true), []);
  const handleBlur = React.useCallback((e: React.FocusEvent<HTMLDivElement>) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setHasFocus(false);
  }, []);

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
      onFocus={handleFocus}
      onBlur={handleBlur}
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
        {animationDuration > 0 && (
          <div
            ref={copyRef}
            aria-hidden="true"
            style={{
              display: 'flex',
              flexDirection: isHorizontal ? 'row' : 'column',
              flexShrink: 0,
            }}
          >
            {children}
          </div>
        )}
      </div>
    </div>
  );
}

export default Marquee;

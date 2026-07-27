/**
 * AnimatedNumber Component
 *
 * Animates a numeric value from its previous value to its new value
 * using requestAnimationFrame with ease-out quadratic easing.
 */

import * as React from 'react';

export interface AnimatedNumberProps {
  /** The target number to animate towards */
  value: number;
  /** Duration of the animation in milliseconds */
  duration?: number;
  /** Text to display before the number */
  prefix?: string;
  /** Text to display after the number */
  suffix?: string;
  /** Number of decimal places */
  decimals?: number;
  /** Whether to add thousand separators */
  separator?: boolean;
  /** What triggers the animation to start */
  trigger?: 'mount' | 'visible';
  /** Additional CSS class */
  className?: string;
  /** Inline styles */
  style?: React.CSSProperties;
}

function formatNumber(value: number, decimals: number, separator: boolean): string {
  const safeValue = typeof value === 'number' && !isNaN(value) ? value : 0;
  const fixed = safeValue.toFixed(decimals);

  if (!separator) return fixed;

  const [intPart, decPart] = fixed.split('.');
  const withSeparators = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');

  return decPart !== undefined ? `${withSeparators}.${decPart}` : withSeparators;
}

export function AnimatedNumber({
  value,
  duration = 1000,
  prefix = '',
  suffix = '',
  decimals = 0,
  separator = true,
  trigger = 'mount',
  className,
  style,
}: AnimatedNumberProps): React.ReactElement {
  const [displayValue, setDisplayValue] = React.useState(trigger === 'mount' ? 0 : 0);
  const previousValueRef = React.useRef<number>(trigger === 'mount' ? 0 : 0);
  const animationFrameRef = React.useRef<number | null>(null);
  const hasStartedRef = React.useRef(false);
  const elementRef = React.useRef<HTMLSpanElement>(null);

  const animate = React.useCallback(
    (from: number, to: number) => {
      from = typeof from === 'number' && !isNaN(from) ? from : 0;
      to = typeof to === 'number' && !isNaN(to) ? to : 0;
      if (animationFrameRef.current !== null) {
        cancelAnimationFrame(animationFrameRef.current);
      }

      const startTime = performance.now();

      const tick = () => {
        // Measured against the same clock the start was taken from, rather
        // than the timestamp the callback is handed. Those are only guaranteed
        // to share a timeline by specification; where they do not, `elapsed`
        // comes out hugely negative and the eased value with it — a count-up
        // from 0 to 100 rendering -587 before climbing.
        const elapsed = performance.now() - startTime;
        const progress = Math.max(0, Math.min(elapsed / duration, 1));

        // Ease-out quadratic: t * (2 - t)
        const eased = progress * (2 - progress);
        const current = from + (to - from) * eased;

        setDisplayValue(current);
        // Track the value actually on screen, not just the settled one.
        //
        // This used to be written only on completion, so an update arriving
        // mid-animation restarted from the last *finished* value. A counter fed
        // by sync or a dashboard poll faster than the animation lasts snapped
        // back toward the old number on every tick and never settled.
        previousValueRef.current = current;

        if (progress < 1) {
          animationFrameRef.current = requestAnimationFrame(tick);
        } else {
          setDisplayValue(to);
          previousValueRef.current = to;
          animationFrameRef.current = null;
        }
      };

      animationFrameRef.current = requestAnimationFrame(tick);
    },
    [duration]
  );

  // trigger="visible": start animation when element enters viewport
  React.useEffect(() => {
    if (trigger !== 'visible') return;

    const el = elementRef.current;
    if (!el) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting && !hasStartedRef.current) {
          hasStartedRef.current = true;
          animate(0, value);
          observer.unobserve(el);
        }
      },
      { threshold: 0.1 }
    );

    observer.observe(el);
    return () => observer.disconnect();
  }, [trigger, value, animate]);

  // trigger="mount": animate on mount and on value changes
  React.useEffect(() => {
    if (trigger !== 'mount') return;

    const from = previousValueRef.current;
    animate(from, value);

    return () => {
      if (animationFrameRef.current !== null) {
        cancelAnimationFrame(animationFrameRef.current);
      }
    };
  }, [value, trigger, animate]);

  // When value changes and trigger="visible" and already started, re-animate
  React.useEffect(() => {
    if (trigger === 'visible' && hasStartedRef.current) {
      const from = previousValueRef.current;
      animate(from, value);
    }
  }, [value, trigger, animate]);

  // Cleanup on unmount
  React.useEffect(() => {
    return () => {
      if (animationFrameRef.current !== null) {
        cancelAnimationFrame(animationFrameRef.current);
      }
    };
  }, []);

  const formatted = formatNumber(displayValue, decimals, separator);

  return (
    <span ref={elementRef} className={className} style={style}>
      {prefix}
      {formatted}
      {suffix}
    </span>
  );
}

export default AnimatedNumber;

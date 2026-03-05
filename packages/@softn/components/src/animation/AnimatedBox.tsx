/**
 * AnimatedBox Component
 *
 * A container that applies CSS-based entrance/exit animations
 * driven by configurable presets and triggers.
 *
 * Uses direct DOM manipulation via refs for reliable animation
 * timing, bypassing React's batched state updates.
 */

import * as React from 'react';

export type AnimationPreset =
  | 'fadeIn'
  | 'fadeUp'
  | 'fadeDown'
  | 'fadeLeft'
  | 'fadeRight'
  | 'scaleIn'
  | 'slideUp'
  | 'slideDown'
  | 'bounceIn';

export type AnimationTrigger = 'mount' | 'visible' | 'hover' | 'state';

export interface AnimatedBoxProps {
  /** The animation preset to apply */
  animation: AnimationPreset;
  /** What triggers the animation */
  trigger?: AnimationTrigger;
  /** When trigger="state", controls whether the animation is active */
  isActive?: boolean;
  /** Duration of the animation in milliseconds */
  duration?: number;
  /** Delay before the animation starts in milliseconds */
  delay?: number;
  /** CSS easing function */
  easing?: string;
  /** Content to animate */
  children: React.ReactNode;
  /** Additional CSS class */
  className?: string;
  /** Inline styles */
  style?: React.CSSProperties;
}

interface StylePair {
  from: Record<string, string>;
  to: Record<string, string>;
}

// Entrance presets: from hidden → to visible
const ENTRANCE_PRESETS: Record<string, StylePair> = {
  fadeIn: {
    from: { opacity: '0' },
    to: { opacity: '1' },
  },
  fadeUp: {
    from: { opacity: '0', transform: 'translateY(20px)' },
    to: { opacity: '1', transform: 'translateY(0)' },
  },
  fadeDown: {
    from: { opacity: '0', transform: 'translateY(-20px)' },
    to: { opacity: '1', transform: 'translateY(0)' },
  },
  fadeLeft: {
    from: { opacity: '0', transform: 'translateX(20px)' },
    to: { opacity: '1', transform: 'translateX(0)' },
  },
  fadeRight: {
    from: { opacity: '0', transform: 'translateX(-20px)' },
    to: { opacity: '1', transform: 'translateX(0)' },
  },
  scaleIn: {
    from: { opacity: '0', transform: 'scale(0.8)' },
    to: { opacity: '1', transform: 'scale(1)' },
  },
  slideUp: {
    from: { opacity: '0', transform: 'translateY(30px)' },
    to: { opacity: '1', transform: 'translateY(0)' },
  },
  slideDown: {
    from: { opacity: '0', transform: 'translateY(-30px)' },
    to: { opacity: '1', transform: 'translateY(0)' },
  },
  bounceIn: {
    from: { opacity: '0', transform: 'scale(0.3)' },
    to: { opacity: '1', transform: 'scale(1)' },
  },
};

// Hover presets: elements always visible, subtle effect on hover
const HOVER_PRESETS: Record<string, StylePair> = {
  fadeIn: {
    from: { opacity: '0.85' },
    to: { opacity: '1' },
  },
  fadeUp: {
    from: { transform: 'translateY(0)' },
    to: { transform: 'translateY(-4px)' },
  },
  fadeDown: {
    from: { transform: 'translateY(0)' },
    to: { transform: 'translateY(4px)' },
  },
  fadeLeft: {
    from: { transform: 'translateX(0)' },
    to: { transform: 'translateX(-4px)' },
  },
  fadeRight: {
    from: { transform: 'translateX(0)' },
    to: { transform: 'translateX(4px)' },
  },
  scaleIn: {
    from: { transform: 'scale(1)' },
    to: { transform: 'scale(1.05)' },
  },
  slideUp: {
    from: { transform: 'translateY(0)' },
    to: { transform: 'translateY(-6px)' },
  },
  slideDown: {
    from: { transform: 'translateY(0)' },
    to: { transform: 'translateY(6px)' },
  },
  bounceIn: {
    from: { transform: 'scale(1)' },
    to: { transform: 'scale(1.08)' },
  },
};

function applyStyles(el: HTMLElement, styles: Record<string, string>) {
  for (const [key, value] of Object.entries(styles)) {
    el.style.setProperty(
      key.replace(/([A-Z])/g, '-$1').toLowerCase(),
      value
    );
  }
}

export function AnimatedBox({
  animation = 'fadeIn',
  trigger = 'mount',
  isActive,
  duration = 500,
  delay = 0,
  easing = 'cubic-bezier(0.4, 0, 0.2, 1)',
  children,
  className,
  style,
}: AnimatedBoxProps): React.ReactElement {
  const elementRef = React.useRef<HTMLDivElement>(null);
  const hasAnimatedRef = React.useRef(false);

  const isHover = trigger === 'hover';
  const presets = isHover ? HOVER_PRESETS : ENTRANCE_PRESETS;
  const preset = presets[animation] || presets.fadeIn;

  // Build the transition CSS value
  const bounceEasing = 'cubic-bezier(0.175, 0.885, 0.32, 1.275)';
  const transitionEasing = animation === 'bounceIn' ? bounceEasing : easing;
  const transitionValue = `opacity ${duration}ms ${transitionEasing} ${delay}ms, transform ${duration}ms ${transitionEasing} ${delay}ms`;

  // Entrance animation: mount or visible trigger
  React.useEffect(() => {
    if (isHover || trigger === 'state') return;

    const el = elementRef.current;
    if (!el) return;

    // Apply "from" styles immediately via DOM
    applyStyles(el, preset.from);
    el.style.transition = 'none'; // no transition for initial state
    el.style.willChange = 'opacity, transform';

    const doAnimate = () => {
      if (hasAnimatedRef.current) return;
      hasAnimatedRef.current = true;

      // Force a reflow so the browser registers the "from" styles
      void el.offsetHeight;

      // Now enable transition and apply "to" styles
      el.style.transition = transitionValue;
      applyStyles(el, preset.to);
    };

    if (trigger === 'mount') {
      // Small delay to ensure "from" state is painted
      const rafId = requestAnimationFrame(() => doAnimate());
      return () => cancelAnimationFrame(rafId);
    } else if (trigger === 'visible') {
      const observer = new IntersectionObserver(
        ([entry]) => {
          if (entry.isIntersecting) {
            doAnimate();
            observer.unobserve(el);
          }
        },
        { threshold: 0.05 }
      );
      observer.observe(el);
      return () => observer.disconnect();
    }
  }, [trigger, animation, isHover, transitionValue, preset]);

  // State trigger
  React.useEffect(() => {
    if (trigger !== 'state') return;

    const el = elementRef.current;
    if (!el) return;

    el.style.transition = transitionValue;
    el.style.willChange = 'opacity, transform';
    applyStyles(el, isActive ? preset.to : preset.from);
  }, [trigger, isActive, transitionValue, preset]);

  // Hover handlers — manipulate DOM directly, no state needed
  const handleMouseEnter = React.useCallback(() => {
    if (!isHover) return;
    const el = elementRef.current;
    if (!el) return;
    el.style.transition = transitionValue;
    applyStyles(el, preset.to);
  }, [isHover, transitionValue, preset]);

  const handleMouseLeave = React.useCallback(() => {
    if (!isHover) return;
    const el = elementRef.current;
    if (!el) return;
    el.style.transition = transitionValue;
    applyStyles(el, preset.from);
  }, [isHover, transitionValue, preset]);

  // Initial inline styles for first render
  const initialStyle: React.CSSProperties = {
    willChange: 'opacity, transform',
    ...style,
  };

  // For hover trigger, start visible (apply "from" which is the resting state)
  if (isHover) {
    const fromEntries = Object.entries(preset.from);
    for (const [key, value] of fromEntries) {
      (initialStyle as Record<string, string>)[key] = value;
    }
    initialStyle.transition = transitionValue;
  }

  return (
    <div
      ref={elementRef}
      className={className}
      style={initialStyle}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      {children}
    </div>
  );
}

export default AnimatedBox;

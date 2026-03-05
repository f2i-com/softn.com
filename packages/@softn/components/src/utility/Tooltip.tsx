/**
 * Tooltip Component
 *
 * A customizable tooltip with multiple trigger modes,
 * animations, and positioning options.
 */

import React, { useState, useRef, useEffect, useCallback } from 'react';

export interface TooltipProps {
  /** Tooltip content */
  content: React.ReactNode;
  /** Title (rendered above content) */
  title?: React.ReactNode;
  /** Placement */
  placement?:
    | 'top'
    | 'bottom'
    | 'left'
    | 'right'
    | 'top-start'
    | 'top-end'
    | 'bottom-start'
    | 'bottom-end';
  /** Trigger mode */
  trigger?: 'hover' | 'click' | 'focus' | 'manual' | ('hover' | 'click' | 'focus')[];
  /** Animation type */
  animation?: 'fade' | 'scale' | 'shift';
  /** Animation duration (ms) */
  animationDuration?: number;
  /** Delay before showing (ms) */
  showDelay?: number;
  /** Delay before hiding (ms) */
  hideDelay?: number;
  /** Whether tooltip is disabled */
  disabled?: boolean;
  /** Controlled visibility */
  open?: boolean;
  /** Default visibility (uncontrolled) */
  defaultOpen?: boolean;
  /** Arrow visibility */
  arrow?: boolean;
  /** Allow hover on tooltip (keeps it open) */
  interactive?: boolean;
  /** Max width before wrapping */
  maxWidth?: number | string;
  /** Offset from trigger element */
  offset?: number;
  /** Color variant */
  variant?: 'dark' | 'light' | 'primary' | 'success' | 'warning' | 'danger';
  /** Size */
  size?: 'sm' | 'md' | 'lg';
  /** Visibility change handler */
  onOpenChange?: (open: boolean) => void;
  /** Additional CSS class for tooltip */
  tooltipClassName?: string;
  /** Additional CSS class for container */
  className?: string;
  /** Inline styles for tooltip */
  tooltipStyle?: React.CSSProperties;
  /** Inline styles for container */
  style?: React.CSSProperties;
  /** Trigger element */
  children: React.ReactNode;
}

const variantStyles: Record<string, { bg: string; text: string; border?: string }> = {
  dark: {
    bg: 'var(--color-gray-800, #1f2937)',
    text: 'var(--color-white, #fafafa)',
  },
  light: {
    bg: 'var(--color-surface, #16161a)',
    text: 'var(--color-text, #ececf0)',
    border: 'var(--color-border, rgba(255, 255, 255, 0.08))',
  },
  primary: {
    bg: 'var(--color-primary-600, #4f46e5)',
    text: 'var(--color-white, #fafafa)',
  },
  success: {
    bg: 'var(--color-success-600, #16a34a)',
    text: 'var(--color-white, #fafafa)',
  },
  warning: {
    bg: 'var(--color-warning-600, #d97706)',
    text: 'var(--color-white, #fafafa)',
  },
  danger: {
    bg: 'var(--color-error-600, #dc2626)',
    text: 'var(--color-white, #fafafa)',
  },
};

const sizeConfig = {
  sm: { padding: '0.375rem 0.625rem', fontSize: '0.75rem', titleSize: '0.8125rem' },
  md: { padding: '0.5rem 0.875rem', fontSize: '0.8125rem', titleSize: '0.875rem' },
  lg: { padding: '0.75rem 1rem', fontSize: '0.875rem', titleSize: '1rem' },
};

export function Tooltip({
  content,
  title,
  placement = 'top',
  trigger = 'hover',
  animation = 'fade',
  animationDuration = 150,
  showDelay = 0,
  hideDelay = 0,
  disabled = false,
  open: controlledOpen,
  defaultOpen = false,
  arrow = true,
  interactive = false,
  maxWidth = 300,
  offset = 8,
  variant = 'dark',
  size = 'md',
  onOpenChange,
  tooltipClassName,
  className,
  tooltipStyle,
  style,
  children,
}: TooltipProps): React.ReactElement {
  const [internalOpen, setInternalOpen] = useState(defaultOpen);
  const [isAnimating, setIsAnimating] = useState(false);
  const showTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hideTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const animationTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);

  const isOpen = controlledOpen !== undefined ? controlledOpen : internalOpen;
  const triggers = Array.isArray(trigger) ? trigger : [trigger];
  const variantStyle = variantStyles[variant];
  const sizeStyle = sizeConfig[size];

  // Clear all timeouts
  const clearTimeouts = useCallback(() => {
    if (showTimeoutRef.current) {
      clearTimeout(showTimeoutRef.current);
      showTimeoutRef.current = null;
    }
    if (hideTimeoutRef.current) {
      clearTimeout(hideTimeoutRef.current);
      hideTimeoutRef.current = null;
    }
    if (animationTimeoutRef.current) {
      clearTimeout(animationTimeoutRef.current);
      animationTimeoutRef.current = null;
    }
  }, []);

  // Show tooltip
  const show = useCallback(() => {
    if (disabled || trigger === 'manual') return;

    clearTimeouts();

    if (showDelay > 0) {
      showTimeoutRef.current = setTimeout(() => {
        setIsAnimating(true);
        if (controlledOpen === undefined) {
          setInternalOpen(true);
        }
        onOpenChange?.(true);
      }, showDelay);
    } else {
      setIsAnimating(true);
      if (controlledOpen === undefined) {
        setInternalOpen(true);
      }
      onOpenChange?.(true);
    }
  }, [disabled, trigger, showDelay, controlledOpen, onOpenChange, clearTimeouts]);

  // Hide tooltip
  const hide = useCallback(() => {
    if (trigger === 'manual') return;

    clearTimeouts();

    if (hideDelay > 0) {
      hideTimeoutRef.current = setTimeout(() => {
        if (controlledOpen === undefined) {
          setInternalOpen(false);
        }
        onOpenChange?.(false);
        // Keep animating state for exit animation
        animationTimeoutRef.current = setTimeout(() => setIsAnimating(false), animationDuration);
      }, hideDelay);
    } else {
      if (controlledOpen === undefined) {
        setInternalOpen(false);
      }
      onOpenChange?.(false);
      animationTimeoutRef.current = setTimeout(() => setIsAnimating(false), animationDuration);
    }
  }, [trigger, hideDelay, controlledOpen, onOpenChange, animationDuration, clearTimeouts]);

  // Toggle for click trigger
  const toggle = useCallback(() => {
    if (isOpen) {
      hide();
    } else {
      show();
    }
  }, [isOpen, show, hide]);

  // Event handlers
  const handleMouseEnter = useCallback(() => {
    if (triggers.includes('hover')) {
      show();
    }
  }, [triggers, show]);

  const handleMouseLeave = useCallback(() => {
    if (triggers.includes('hover')) {
      // If interactive, don't hide immediately when moving to tooltip
      if (interactive) {
        hideTimeoutRef.current = setTimeout(() => {
          if (!tooltipRef.current?.matches(':hover') && !containerRef.current?.matches(':hover')) {
            hide();
          }
        }, 100);
      } else {
        hide();
      }
    }
  }, [triggers, interactive, hide]);

  const handleClick = useCallback(() => {
    if (triggers.includes('click')) {
      toggle();
    }
  }, [triggers, toggle]);

  const handleFocus = useCallback(() => {
    if (triggers.includes('focus')) {
      show();
    }
  }, [triggers, show]);

  const handleBlur = useCallback(() => {
    if (triggers.includes('focus')) {
      hide();
    }
  }, [triggers, hide]);

  // Close on outside click for click trigger
  useEffect(() => {
    if (!triggers.includes('click') || !isOpen) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node) &&
        tooltipRef.current &&
        !tooltipRef.current.contains(e.target as Node)
      ) {
        hide();
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [triggers, isOpen, hide]);

  // Close on escape
  useEffect(() => {
    if (!isOpen) return;

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        hide();
      }
    };

    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [isOpen, hide]);

  // Cleanup timeouts on unmount
  useEffect(() => {
    return clearTimeouts;
  }, [clearTimeouts]);

  // Container styles
  const containerStyle: React.CSSProperties = {
    position: 'relative',
    display: 'inline-flex',
    ...style,
  };

  // Get tooltip position styles
  const getPositionStyle = (): React.CSSProperties => {
    const basePosition: React.CSSProperties = {
      position: 'absolute',
      zIndex: 9999,
    };

    switch (placement) {
      case 'top':
        return {
          ...basePosition,
          bottom: '100%',
          left: '50%',
          transform: 'translateX(-50%)',
          marginBottom: offset,
        };
      case 'top-start':
        return { ...basePosition, bottom: '100%', left: 0, marginBottom: offset };
      case 'top-end':
        return { ...basePosition, bottom: '100%', right: 0, marginBottom: offset };
      case 'bottom':
        return {
          ...basePosition,
          top: '100%',
          left: '50%',
          transform: 'translateX(-50%)',
          marginTop: offset,
        };
      case 'bottom-start':
        return { ...basePosition, top: '100%', left: 0, marginTop: offset };
      case 'bottom-end':
        return { ...basePosition, top: '100%', right: 0, marginTop: offset };
      case 'left':
        return {
          ...basePosition,
          right: '100%',
          top: '50%',
          transform: 'translateY(-50%)',
          marginRight: offset,
        };
      case 'right':
        return {
          ...basePosition,
          left: '100%',
          top: '50%',
          transform: 'translateY(-50%)',
          marginLeft: offset,
        };
      default:
        return basePosition;
    }
  };

  // Get animation styles
  const getAnimationStyle = (): React.CSSProperties => {
    const duration = `${animationDuration}ms`;

    if (!isOpen && !isAnimating) {
      return { opacity: 0, visibility: 'hidden' as const };
    }

    const baseAnimation: React.CSSProperties = {
      transition: `opacity ${duration} cubic-bezier(0.16, 1, 0.3, 1), transform ${duration} cubic-bezier(0.16, 1, 0.3, 1), visibility ${duration}`,
    };

    switch (animation) {
      case 'scale':
        return {
          ...baseAnimation,
          opacity: isOpen ? 1 : 0,
          visibility: isOpen ? 'visible' : 'hidden',
          transform: isOpen
            ? (getPositionStyle().transform ?? 'none')
            : `${getPositionStyle().transform ?? ''} scale(0.95)`.trim(),
        };
      case 'shift': {
        const shiftAmount = '4px';
        let shiftTransform = getPositionStyle().transform ?? '';
        if (!isOpen) {
          if (placement.startsWith('top')) {
            shiftTransform += ` translateY(${shiftAmount})`;
          } else if (placement.startsWith('bottom')) {
            shiftTransform += ` translateY(-${shiftAmount})`;
          } else if (placement === 'left') {
            shiftTransform += ` translateX(${shiftAmount})`;
          } else if (placement === 'right') {
            shiftTransform += ` translateX(-${shiftAmount})`;
          }
        }
        return {
          ...baseAnimation,
          opacity: isOpen ? 1 : 0,
          visibility: isOpen ? 'visible' : 'hidden',
          transform: shiftTransform.trim() || 'none',
        };
      }
      case 'fade':
      default:
        return {
          ...baseAnimation,
          opacity: isOpen ? 1 : 0,
          visibility: isOpen ? 'visible' : 'hidden',
        };
    }
  };

  // Get arrow styles
  const getArrowStyle = (): React.CSSProperties => {
    const base: React.CSSProperties = {
      position: 'absolute',
      width: 0,
      height: 0,
      border: '6px solid transparent',
    };

    const arrowColor = variantStyle.bg;

    switch (placement) {
      case 'top':
      case 'top-start':
      case 'top-end':
        return {
          ...base,
          bottom: -12,
          left: placement === 'top' ? '50%' : placement === 'top-start' ? 12 : undefined,
          right: placement === 'top-end' ? 12 : undefined,
          transform: placement === 'top' ? 'translateX(-50%)' : undefined,
          borderTopColor: arrowColor,
        };
      case 'bottom':
      case 'bottom-start':
      case 'bottom-end':
        return {
          ...base,
          top: -12,
          left: placement === 'bottom' ? '50%' : placement === 'bottom-start' ? 12 : undefined,
          right: placement === 'bottom-end' ? 12 : undefined,
          transform: placement === 'bottom' ? 'translateX(-50%)' : undefined,
          borderBottomColor: arrowColor,
        };
      case 'left':
        return {
          ...base,
          right: -12,
          top: '50%',
          transform: 'translateY(-50%)',
          borderLeftColor: arrowColor,
        };
      case 'right':
        return {
          ...base,
          left: -12,
          top: '50%',
          transform: 'translateY(-50%)',
          borderRightColor: arrowColor,
        };
      default:
        return base;
    }
  };

  // Tooltip content styles
  const tooltipContentStyle: React.CSSProperties = {
    ...getPositionStyle(),
    ...getAnimationStyle(),
    padding: sizeStyle.padding,
    fontSize: sizeStyle.fontSize,
    fontWeight: 500,
    lineHeight: 1.5,
    letterSpacing: '0.01em',
    color: variantStyle.text,
    backgroundColor: variantStyle.bg,
    borderRadius: 'var(--radius-lg, 0.5rem)',
    boxShadow:
      variant === 'light'
        ? '0 4px 12px rgba(0, 0, 0, 0.08), 0 2px 6px rgba(0, 0, 0, 0.04)'
        : '0 8px 16px rgba(0, 0, 0, 0.15), 0 2px 6px rgba(0, 0, 0, 0.1)',
    maxWidth: typeof maxWidth === 'number' ? `${maxWidth}px` : maxWidth,
    whiteSpace: maxWidth ? 'normal' : 'nowrap',
    wordWrap: 'break-word',
    pointerEvents: interactive && isOpen ? 'auto' : 'none',
    border: variantStyle.border ? `1px solid ${variantStyle.border}` : undefined,
    backdropFilter: variant === 'light' ? 'blur(8px)' : undefined,
    ...tooltipStyle,
  };

  const titleStyle: React.CSSProperties = {
    fontSize: sizeStyle.titleSize,
    fontWeight: 600,
    marginBottom: '0.375rem',
    lineHeight: 1.3,
  };

  // Handle tooltip mouse events for interactive mode
  const handleTooltipMouseEnter = useCallback(() => {
    if (interactive && triggers.includes('hover')) {
      clearTimeouts();
    }
  }, [interactive, triggers, clearTimeouts]);

  const handleTooltipMouseLeave = useCallback(() => {
    if (interactive && triggers.includes('hover')) {
      hide();
    }
  }, [interactive, triggers, hide]);

  return (
    <div
      ref={containerRef}
      className={className}
      style={containerStyle}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      onClick={handleClick}
      onFocus={handleFocus}
      onBlur={handleBlur}
    >
      {children}
      <div
        ref={tooltipRef}
        className={tooltipClassName}
        style={tooltipContentStyle}
        role="tooltip"
        aria-hidden={!isOpen}
        onMouseEnter={handleTooltipMouseEnter}
        onMouseLeave={handleTooltipMouseLeave}
      >
        {title && <div style={titleStyle}>{title}</div>}
        {content}
        {arrow && <div style={getArrowStyle()} />}
      </div>
    </div>
  );
}

/**
 * TooltipTrigger - Explicit trigger component for more control
 */
export interface TooltipTriggerProps {
  /** Tooltip content */
  content: React.ReactNode;
  /** Other tooltip props */
  tooltipProps?: Omit<TooltipProps, 'content' | 'children'>;
  /** Children render function receives show/hide functions */
  children: (props: {
    show: () => void;
    hide: () => void;
    toggle: () => void;
    isOpen: boolean;
    triggerProps: {
      onMouseEnter: () => void;
      onMouseLeave: () => void;
      onClick: () => void;
      onFocus: () => void;
      onBlur: () => void;
    };
  }) => React.ReactNode;
}

export function TooltipTrigger({
  content,
  tooltipProps = {},
  children,
}: TooltipTriggerProps): React.ReactElement {
  const [isOpen, setIsOpen] = useState(false);

  const show = useCallback(() => setIsOpen(true), []);
  const hide = useCallback(() => setIsOpen(false), []);
  const toggle = useCallback(() => setIsOpen((prev) => !prev), []);

  const triggerProps = {
    onMouseEnter: show,
    onMouseLeave: hide,
    onClick: toggle,
    onFocus: show,
    onBlur: hide,
  };

  return (
    <Tooltip
      content={content}
      trigger="manual"
      open={isOpen}
      onOpenChange={setIsOpen}
      {...tooltipProps}
    >
      {children({ show, hide, toggle, isOpen, triggerProps })}
    </Tooltip>
  );
}

export default Tooltip;

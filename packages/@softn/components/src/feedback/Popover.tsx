/**
 * Popover Component
 *
 * A popup content container that appears near a trigger element.
 */

import React, { useState, useRef, useEffect, useCallback, useId } from 'react';
import { tabbableWithin } from './layer-stack';

/** How long the pointer may spend crossing the gap to a hover popover. */
const HOVER_CLOSE_DELAY = 120;

export interface PopoverProps {
  /** Trigger element */
  trigger: React.ReactNode;
  /** Popover content */
  children?: React.ReactNode;
  /** Placement of the popover */
  placement?: 'top' | 'bottom' | 'left' | 'right';
  /** Whether popover is controlled */
  open?: boolean;
  /** Default open state */
  defaultOpen?: boolean;
  /** Callback when open state changes */
  onOpenChange?: (open: boolean) => void;
  /** How to trigger the popover */
  triggerMode?: 'click' | 'hover';
  /** Offset from trigger in pixels */
  offset?: number;
  /** Show arrow */
  showArrow?: boolean;
  /** Close when clicking outside */
  closeOnOutsideClick?: boolean;
  /** Accessible name for the popup */
  ariaLabel?: string;
  /** Additional CSS class */
  className?: string;
  /** Inline styles */
  style?: React.CSSProperties;
}

export function Popover({
  trigger,
  children,
  placement = 'bottom',
  open: controlledOpen,
  defaultOpen = false,
  onOpenChange,
  triggerMode = 'click',
  offset = 8,
  showArrow = true,
  closeOnOutsideClick = true,
  ariaLabel,
  className,
  style,
}: PopoverProps): React.ReactElement {
  const [internalOpen, setInternalOpen] = useState(defaultOpen);
  const containerRef = useRef<HTMLSpanElement>(null);
  const triggerRef = useRef<HTMLSpanElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Set when the user opened it, so focus follows into the popup. */
  const focusOnOpenRef = useRef(false);
  const popoverId = useId();
  // Whether the trigger content brings its own focusable control (a Button,
  // a link). When it does not (plain text, an icon) the wrapper becomes the
  // button, so the popover can be reached and opened from the keyboard.
  const [wrapperIsButton, setWrapperIsButton] = useState(false);

  const isOpen = controlledOpen !== undefined ? controlledOpen : internalOpen;

  const setOpen = useCallback(
    (newOpen: boolean) => {
      if (controlledOpen === undefined) {
        setInternalOpen(newOpen);
      }
      onOpenChange?.(newOpen);
    },
    [controlledOpen, onOpenChange]
  );

  const clearCloseTimer = useCallback(() => {
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }, []);
  useEffect(() => clearCloseTimer, [clearCloseTimer]);

  /** The element that carries the trigger's state: the inner control, or the wrapper. */
  const triggerTarget = useCallback((): HTMLElement | null => {
    const wrapper = triggerRef.current;
    if (!wrapper) return null;
    return tabbableWithin(wrapper).find((el) => el !== wrapper) ?? wrapper;
  }, []);

  useEffect(() => {
    const wrapper = triggerRef.current;
    if (!wrapper) return;
    setWrapperIsButton(tabbableWithin(wrapper).filter((el) => el !== wrapper).length === 0);
  }, [trigger]);

  // The trigger control announces what it opens and whether it is open.
  useEffect(() => {
    const target = triggerTarget();
    if (!target || target === triggerRef.current) return;
    target.setAttribute('aria-haspopup', 'dialog');
    target.setAttribute('aria-expanded', String(isOpen));
    if (isOpen) target.setAttribute('aria-controls', popoverId);
    else target.removeAttribute('aria-controls');
    return () => {
      target.removeAttribute('aria-haspopup');
      target.removeAttribute('aria-expanded');
      target.removeAttribute('aria-controls');
    };
  }, [isOpen, popoverId, triggerTarget, wrapperIsButton]);

  // Focus the popup's first control when the user opened it.
  useEffect(() => {
    if (!isOpen || !focusOnOpenRef.current) return;
    focusOnOpenRef.current = false;
    const popup = popoverRef.current;
    if (popup) tabbableWithin(popup)[0]?.focus();
  }, [isOpen]);

  const close = useCallback(
    (returnFocus: boolean) => {
      clearCloseTimer();
      const focusWasInside = !!popoverRef.current?.contains(document.activeElement);
      setOpen(false);
      if (returnFocus || focusWasInside) triggerTarget()?.focus();
    },
    [clearCloseTimer, setOpen, triggerTarget]
  );

  // Handle click outside
  useEffect(() => {
    if (!isOpen || !closeOnOutsideClick) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen, closeOnOutsideClick, setOpen]);

  // Escape while focus is somewhere else on the page (a hover popover the
  // pointer opened). With focus inside, the container's own handler answers
  // first and marks the key handled, so a Modal around it stays open.
  useEffect(() => {
    if (!isOpen) return;
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      e.preventDefault();
      close(false);
    };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [isOpen, close]);

  const handleContainerKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) {
        e.preventDefault();
        e.stopPropagation();
        close(true);
        return;
      }
      if (
        triggerMode === 'click' &&
        wrapperIsButton &&
        e.target === triggerRef.current &&
        (e.key === 'Enter' || e.key === ' ')
      ) {
        e.preventDefault();
        focusOnOpenRef.current = !isOpen;
        setOpen(!isOpen);
      }
    },
    [isOpen, close, triggerMode, wrapperIsButton, setOpen]
  );

  const handleTriggerClick = useCallback(() => {
    if (triggerMode === 'click') {
      focusOnOpenRef.current = !isOpen;
      setOpen(!isOpen);
    }
  }, [triggerMode, isOpen, setOpen]);

  // Hover mode listens on the container, which holds both the trigger and the
  // popup, and closes after a short delay: the popup sits `offset` px away,
  // and closing the instant the pointer left the trigger meant it could never
  // be reached.
  const handleEnter = useCallback(() => {
    if (triggerMode !== 'hover') return;
    clearCloseTimer();
    if (!isOpen) setOpen(true);
  }, [triggerMode, clearCloseTimer, isOpen, setOpen]);

  const handleLeave = useCallback(() => {
    if (triggerMode !== 'hover') return;
    clearCloseTimer();
    closeTimerRef.current = setTimeout(() => {
      closeTimerRef.current = null;
      setOpen(false);
    }, HOVER_CLOSE_DELAY);
  }, [triggerMode, clearCloseTimer, setOpen]);

  const handleFocus = useCallback(() => {
    if (triggerMode === 'hover') handleEnter();
  }, [triggerMode, handleEnter]);

  const handleBlur = useCallback(
    (e: React.FocusEvent) => {
      const next = e.relatedTarget as Node | null;
      if (next && containerRef.current?.contains(next)) return;
      if (triggerMode === 'hover') handleLeave();
      else if (isOpen && next) setOpen(false); // Tabbed away from a click popover.
    },
    [triggerMode, handleLeave, isOpen, setOpen]
  );

  // Calculate position styles
  const getPositionStyles = (): React.CSSProperties => {
    const base: React.CSSProperties = {
      position: 'absolute',
      zIndex: 1000,
    };

    switch (placement) {
      case 'top':
        return {
          ...base,
          bottom: '100%',
          left: '50%',
          transform: 'translateX(-50%)',
          marginBottom: `${offset}px`,
        };
      case 'bottom':
        return {
          ...base,
          top: '100%',
          left: '50%',
          transform: 'translateX(-50%)',
          marginTop: `${offset}px`,
        };
      case 'left':
        return {
          ...base,
          right: '100%',
          top: '50%',
          transform: 'translateY(-50%)',
          marginRight: `${offset}px`,
        };
      case 'right':
        return {
          ...base,
          left: '100%',
          top: '50%',
          transform: 'translateY(-50%)',
          marginLeft: `${offset}px`,
        };
      default:
        return base;
    }
  };

  const getArrowStyles = (): React.CSSProperties => {
    const size = 8;
    const base: React.CSSProperties = {
      position: 'absolute',
      width: 0,
      height: 0,
      borderStyle: 'solid',
    };

    switch (placement) {
      case 'top':
        return {
          ...base,
          bottom: -size,
          left: '50%',
          transform: 'translateX(-50%)',
          borderWidth: `${size}px ${size}px 0`,
          borderColor: 'var(--color-surface, #16161a) transparent transparent transparent',
        };
      case 'bottom':
        return {
          ...base,
          top: -size,
          left: '50%',
          transform: 'translateX(-50%)',
          borderWidth: `0 ${size}px ${size}px`,
          borderColor: 'transparent transparent var(--color-surface, #16161a) transparent',
        };
      case 'left':
        return {
          ...base,
          right: -size,
          top: '50%',
          transform: 'translateY(-50%)',
          borderWidth: `${size}px 0 ${size}px ${size}px`,
          borderColor: 'transparent transparent transparent var(--color-surface, #16161a)',
        };
      case 'right':
        return {
          ...base,
          left: -size,
          top: '50%',
          transform: 'translateY(-50%)',
          borderWidth: `${size}px ${size}px ${size}px 0`,
          borderColor: 'transparent var(--color-surface, #16161a) transparent transparent',
        };
      default:
        return base;
    }
  };

  const containerStyle: React.CSSProperties = {
    position: 'relative',
    display: 'inline-block',
  };

  const popoverStyle: React.CSSProperties = {
    ...getPositionStyles(),
    background: 'var(--color-surface, #16161a)',
    borderRadius: 'var(--radius-lg, 0.5rem)',
    boxShadow: '0 8px 24px rgba(0, 0, 0, 0.4), 0 0 0 1px var(--color-border, rgba(255, 255, 255, 0.08))',
    padding: '0.75rem 1rem',
    minWidth: '120px',
    maxWidth: '320px',
    // One keyframe per placement: a single shared name was redefined by every
    // open popover, so two with different placements overwrote each other's
    // final transform.
    animation: `softn-popover-in-${placement} 180ms cubic-bezier(0.16, 1, 0.3, 1) both`,
    ...style,
  };

  const offsetFrom =
    placement === 'top'
      ? 'translateX(-50%) translateY(4px)'
      : placement === 'bottom'
        ? 'translateX(-50%) translateY(-4px)'
        : placement === 'left'
          ? 'translateY(-50%) translateX(4px)'
          : 'translateY(-50%) translateX(-4px)';
  const offsetTo =
    placement === 'top' || placement === 'bottom'
      ? 'translateX(-50%) translateY(0)'
      : 'translateY(-50%) translateX(0)';

  return (
    <span
      ref={containerRef}
      style={containerStyle}
      onKeyDown={handleContainerKeyDown}
      onMouseEnter={handleEnter}
      onMouseLeave={handleLeave}
      onFocus={handleFocus}
      onBlur={handleBlur}
    >
      {isOpen && (
        <style>{`
          @keyframes softn-popover-in-${placement} {
            from { opacity: 0; transform: ${offsetFrom}; }
            to { opacity: 1; transform: ${offsetTo}; }
          }
          @media (prefers-reduced-motion: reduce) {
            .softn-popover { animation: none !important; }
          }
        `}</style>
      )}
      <span
        ref={triggerRef}
        onClick={handleTriggerClick}
        style={{ display: 'inline-block', cursor: triggerMode === 'click' ? 'pointer' : 'default' }}
        {...(wrapperIsButton
          ? {
              role: 'button',
              tabIndex: 0,
              'aria-haspopup': 'dialog' as const,
              'aria-expanded': isOpen,
              'aria-controls': isOpen ? popoverId : undefined,
            }
          : {})}
      >
        {trigger}
      </span>
      {isOpen && (
        <div
          ref={popoverRef}
          id={popoverId}
          role="dialog"
          aria-label={ariaLabel}
          className={className ? `softn-popover ${className}` : 'softn-popover'}
          style={popoverStyle}
        >
          {showArrow && <div aria-hidden="true" style={getArrowStyles()} />}
          {children}
        </div>
      )}
    </span>
  );
}

export default Popover;

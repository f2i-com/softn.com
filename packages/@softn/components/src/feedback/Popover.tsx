/**
 * Popover Component
 *
 * A popup content container that appears near a trigger element.
 */

import React, { useState, useRef, useEffect, useCallback } from 'react';

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
  className,
  style,
}: PopoverProps): React.ReactElement {
  const [internalOpen, setInternalOpen] = useState(defaultOpen);
  const triggerRef = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

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

  // Handle click outside
  useEffect(() => {
    if (!isOpen || !closeOnOutsideClick) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (
        triggerRef.current &&
        popoverRef.current &&
        !triggerRef.current.contains(e.target as Node) &&
        !popoverRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen, closeOnOutsideClick, setOpen]);

  const handleTriggerClick = useCallback(() => {
    if (triggerMode === 'click') {
      setOpen(!isOpen);
    }
  }, [triggerMode, isOpen, setOpen]);

  const handleTriggerEnter = useCallback(() => {
    if (triggerMode === 'hover') {
      setOpen(true);
    }
  }, [triggerMode, setOpen]);

  const handleTriggerLeave = useCallback(() => {
    if (triggerMode === 'hover') {
      setOpen(false);
    }
  }, [triggerMode, setOpen]);

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
    animation: 'softn-popover-in 180ms cubic-bezier(0.16, 1, 0.3, 1) both',
    ...style,
  };

  return (
    <div style={containerStyle}>
      {isOpen && (
        <style>{`
          @keyframes softn-popover-in {
            from { opacity: 0; transform: ${placement === 'top' ? 'translateX(-50%) translateY(4px)' : placement === 'bottom' ? 'translateX(-50%) translateY(-4px)' : placement === 'left' ? 'translateY(-50%) translateX(4px)' : 'translateY(-50%) translateX(-4px)'}; }
            to { opacity: 1; transform: ${placement === 'top' || placement === 'bottom' ? 'translateX(-50%) translateY(0)' : 'translateY(-50%) translateX(0)'}; }
          }
        `}</style>
      )}
      <div
        ref={triggerRef}
        onClick={handleTriggerClick}
        onMouseEnter={handleTriggerEnter}
        onMouseLeave={handleTriggerLeave}
        style={{ display: 'inline-block', cursor: triggerMode === 'click' ? 'pointer' : 'default' }}
      >
        {trigger}
      </div>
      {isOpen && (
        <div
          ref={popoverRef}
          className={className}
          style={popoverStyle}
          onMouseEnter={handleTriggerEnter}
          onMouseLeave={handleTriggerLeave}
        >
          {showArrow && <div style={getArrowStyles()} />}
          {children}
        </div>
      )}
    </div>
  );
}

export default Popover;

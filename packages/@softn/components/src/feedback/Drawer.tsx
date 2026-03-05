/**
 * Drawer Component
 *
 * A slide-in side panel component.
 */

import React, { useEffect, useCallback, useRef } from 'react';

export interface DrawerProps {
  /** Whether the drawer is open */
  open: boolean;
  /** Callback when drawer should close */
  onClose: () => void;
  /** Drawer content */
  children?: React.ReactNode;
  /** Which side the drawer slides from */
  position?: 'left' | 'right' | 'top' | 'bottom';
  /** Size of the drawer */
  size?: string;
  /** Title shown in header */
  title?: string;
  /** Show close button */
  showClose?: boolean;
  /** Show overlay backdrop */
  showOverlay?: boolean;
  /** Close on overlay click */
  closeOnOverlay?: boolean;
  /** Close on Escape key */
  closeOnEscape?: boolean;
  /** Additional CSS class */
  className?: string;
  /** Inline styles */
  style?: React.CSSProperties;
}

export function Drawer({
  open,
  onClose,
  children,
  position = 'right',
  size = '320px',
  title,
  showClose = true,
  showOverlay = true,
  closeOnOverlay = true,
  closeOnEscape = true,
  className,
  style,
}: DrawerProps): React.ReactElement | null {
  const drawerRef = useRef<HTMLDivElement>(null);

  // Handle escape key
  useEffect(() => {
    if (!open || !closeOnEscape) return;

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };

    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [open, closeOnEscape, onClose]);

  // Lock body scroll when open
  useEffect(() => {
    if (open) {
      const originalOverflow = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
      return () => {
        document.body.style.overflow = originalOverflow;
      };
    }
  }, [open]);

  // Focus trap and restore focus on close
  useEffect(() => {
    if (!open) return;

    const previouslyFocused = document.activeElement as HTMLElement;

    // Focus the drawer
    if (drawerRef.current) {
      drawerRef.current.focus();
    }

    // Focus trap: keep focus within drawer
    const handleTabKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab' || !drawerRef.current) return;

      const focusableElements = drawerRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      );

      if (focusableElements.length === 0) return;

      const firstElement = focusableElements[0];
      const lastElement = focusableElements[focusableElements.length - 1];

      if (e.shiftKey) {
        if (document.activeElement === firstElement) {
          e.preventDefault();
          lastElement.focus();
        }
      } else {
        if (document.activeElement === lastElement) {
          e.preventDefault();
          firstElement.focus();
        }
      }
    };

    document.addEventListener('keydown', handleTabKey);

    return () => {
      document.removeEventListener('keydown', handleTabKey);
      // Restore focus to previously focused element
      previouslyFocused?.focus?.();
    };
  }, [open]);

  const handleOverlayClick = useCallback(() => {
    if (closeOnOverlay) {
      onClose();
    }
  }, [closeOnOverlay, onClose]);

  if (!open) return null;

  const isHorizontal = position === 'left' || position === 'right';

  const overlayStyle: React.CSSProperties = {
    position: 'fixed',
    inset: 0,
    background: 'rgba(0, 0, 0, 0.5)',
    backdropFilter: 'blur(4px)',
    WebkitBackdropFilter: 'blur(4px)',
    zIndex: 1000,
    opacity: showOverlay ? 1 : 0,
    transition: 'opacity 250ms cubic-bezier(0.16, 1, 0.3, 1)',
  };

  const drawerStyle: React.CSSProperties = {
    position: 'fixed',
    [position]: 0,
    top: isHorizontal ? 0 : undefined,
    bottom: isHorizontal ? 0 : undefined,
    left: !isHorizontal ? 0 : undefined,
    right: !isHorizontal ? 0 : undefined,
    [isHorizontal ? 'width' : 'height']: size,
    [isHorizontal ? 'height' : 'width']: '100%',
    background: 'var(--color-surface, #16161a)',
    boxShadow: '-4px 0 24px rgba(0, 0, 0, 0.4), 0 0 0 1px rgba(255, 255, 255, 0.04)',
    zIndex: 1001,
    display: 'flex',
    flexDirection: 'column',
    outline: 'none',
    animation: `slideIn${capitalize(position)} 0.25s cubic-bezier(0.16, 1, 0.3, 1)`,
    ...style,
  };

  const headerStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '1rem 1.25rem',
    borderBottom: '1px solid var(--color-border, rgba(255, 255, 255, 0.08))',
    minHeight: '56px',
  };

  const titleStyle: React.CSSProperties = {
    fontSize: '1.125rem',
    fontWeight: 600,
    color: 'var(--color-text, #ececf0)',
    margin: 0,
  };

  const closeButtonStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '32px',
    height: '32px',
    border: 'none',
    background: 'transparent',
    cursor: 'pointer',
    borderRadius: '6px',
    color: 'var(--color-text-muted, #a1a1aa)',
    fontSize: '20px',
    padding: 0,
    transition: 'all 180ms cubic-bezier(0.16, 1, 0.3, 1)',
  };

  const contentStyle: React.CSSProperties = {
    flex: 1,
    overflow: 'auto',
    padding: '1.25rem',
  };

  return (
    <>
      <style>{`
        .softn-drawer-close:hover {
          background: var(--color-gray-700, rgba(255, 255, 255, 0.08)) !important;
          color: var(--color-gray-200, #e4e4e7) !important;
        }
        .softn-drawer-close:active {
          transform: scale(0.9);
        }
        @keyframes slideInleft {
          from { transform: translateX(-100%); }
          to { transform: translateX(0); }
        }
        @keyframes slideInright {
          from { transform: translateX(100%); }
          to { transform: translateX(0); }
        }
        @keyframes slideIntop {
          from { transform: translateY(-100%); }
          to { transform: translateY(0); }
        }
        @keyframes slideInbottom {
          from { transform: translateY(100%); }
          to { transform: translateY(0); }
        }
      `}</style>
      <div style={overlayStyle} onClick={handleOverlayClick} />
      <div
        ref={drawerRef}
        className={className}
        style={drawerStyle}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
      >
        {(title || showClose) && (
          <div style={headerStyle}>
            {title && <h2 style={titleStyle}>{title}</h2>}
            {!title && <span />}
            {showClose && (
              <button
                type="button"
                className="softn-drawer-close"
                onClick={onClose}
                style={closeButtonStyle}
                aria-label="Close drawer"
              >
                &times;
              </button>
            )}
          </div>
        )}
        <div style={contentStyle}>{children}</div>
      </div>
    </>
  );
}

function capitalize(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

export default Drawer;

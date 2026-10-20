/**
 * Drawer Component
 *
 * A slide-in side panel component.
 */

import React, { useEffect, useCallback, useRef, useId } from 'react';
import { lockBodyScroll } from './body-scroll-lock';
import { useModalLayer } from './layer-stack';

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
  /** Accessible name for the drawer when it has no `title` */
  ariaLabel?: string;
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
  position: givenPosition,
  size = '320px',
  title,
  ariaLabel,
  showClose = true,
  showOverlay = true,
  closeOnOverlay = true,
  closeOnEscape = true,
  className,
  style,
}: DrawerProps): React.ReactElement | null {
  // A side that is not one of the four is the usual one: "center" opened a sheet from the top.
  const position = givenPosition === 'left' || givenPosition === 'top' || givenPosition === 'bottom' ? givenPosition : 'right';
  const drawerRef = useRef<HTMLDivElement>(null);

  const titleId = useId();

  // Focus in, Tab trapped, Escape for the topmost layer only (a Modal opened
  // from inside the drawer closes alone), focus back on close.
  useModalLayer(open, drawerRef, { onEscape: closeOnEscape ? onClose : undefined });

  // Lock body scroll when open. The lock is the one Modal uses, counted per
  // body: a drawer that saved `overflow` on its own and put it back on close
  // fought a modal opened from inside it, and the page was left unscrollable
  // once both had closed.
  useEffect(() => {
    if (!open) return;
    return lockBodyScroll(document.body);
  }, [open]);

  const handleOverlayClick = useCallback(() => {
    // A page may give no close handler (see Modal).
    if (closeOnOverlay) {
      onClose?.();
    }
  }, [closeOnOverlay, onClose]);

  if (!open) return null;

  const isHorizontal = position === 'left' || position === 'right';

  const overlayStyle: React.CSSProperties = {
    position: 'fixed',
    inset: 0,
    background: 'var(--color-overlay, rgba(0, 0, 0, 0.5))',
    backdropFilter: 'blur(4px)',
    WebkitBackdropFilter: 'blur(4px)',
    zIndex: 1000,
    opacity: showOverlay ? 1 : 0,
    transition: 'opacity 250ms cubic-bezier(0.16, 1, 0.3, 1)',
  };

  // Held to the edge it names and the two beside it. These were written as
  // `[position]: 0` followed by all four sides, the two across it set to
  // `undefined`, and a later key wins: the named side was lost, and the
  // drawer was drawn wherever it sat in the page.
  const edges: React.CSSProperties = isHorizontal
    ? { top: 0, bottom: 0, [position]: 0 }
    : { left: 0, right: 0, [position]: 0 };

  const drawerStyle: React.CSSProperties = {
    position: 'fixed',
    ...edges,
    [isHorizontal ? 'width' : 'height']: size,
    [isHorizontal ? 'height' : 'width']: '100%',
    // A size wider than a phone (or taller than a short window) is cut to
    // the screen, so the close button in its far corner stays on it.
    [isHorizontal ? 'maxWidth' : 'maxHeight']: isHorizontal ? '100vw' : '100vh',
    background: 'var(--color-surface, #16161a)',
    boxShadow: '-4px 0 24px rgba(0, 0, 0, 0.4), 0 0 0 1px rgba(255, 255, 255, 0.04)',
    zIndex: 1001,
    display: 'flex',
    flexDirection: 'column',
    outline: 'none',
    // The keyframes are named per side below. This used to ask for
    // `slideInRight` while the stylesheet defined `slideInright` — animation
    // names are case-sensitive, so the drawer never slid in.
    animation: `softn-drawer-in-${position} 0.25s cubic-bezier(0.16, 1, 0.3, 1)`,
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
    overflowWrap: 'anywhere',
    minWidth: 0,
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
          background: var(--color-surface-hover, rgba(255, 255, 255, 0.08)) !important;
          color: var(--color-text, #e4e4e7) !important;
        }
        .softn-drawer-close:active {
          transform: scale(0.9);
        }
        @keyframes softn-drawer-in-left {
          from { transform: translateX(-100%); }
          to { transform: translateX(0); }
        }
        @keyframes softn-drawer-in-right {
          from { transform: translateX(100%); }
          to { transform: translateX(0); }
        }
        @keyframes softn-drawer-in-top {
          from { transform: translateY(-100%); }
          to { transform: translateY(0); }
        }
        @keyframes softn-drawer-in-bottom {
          from { transform: translateY(100%); }
          to { transform: translateY(0); }
        }
        @media (prefers-reduced-motion: reduce) {
          .softn-drawer-panel { animation: none !important; }
        }
      `}</style>
      {/*
        Only render the backdrop when it is meant to be there. With
        `showOverlay={false}` it was still in the tree at opacity 0 — fixed,
        inset 0, z-index 1000, with a click handler — so the entire page behind
        the drawer became unclickable with nothing on screen to explain why.
      */}
      {showOverlay && <div style={overlayStyle} onClick={handleOverlayClick} />}
      <div
        ref={drawerRef}
        className={className ? `softn-drawer-panel ${className}` : 'softn-drawer-panel'}
        style={drawerStyle}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        aria-label={title ? undefined : ariaLabel}
        tabIndex={-1}
      >
        {(title || showClose) && (
          <div style={headerStyle}>
            {title && (
              <h2 id={titleId} style={titleStyle}>
                {title}
              </h2>
            )}
            {!title && <span />}
            {showClose && (
              <button
                type="button"
                className="softn-drawer-close"
                onClick={onClose}
                style={closeButtonStyle}
                aria-label="Close drawer"
              >
                <span aria-hidden="true">&times;</span>
              </button>
            )}
          </div>
        )}
        <div style={contentStyle}>{children}</div>
      </div>
    </>
  );
}

export default Drawer;

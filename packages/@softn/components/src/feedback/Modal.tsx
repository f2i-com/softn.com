/**
 * Modal Component
 *
 * A dialog overlay for focused interactions.
 * Features smooth animations, loading state, and keyboard navigation.
 * Uses CSS variables for theming support.
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';

export interface ModalProps {
  /** Whether the modal is open */
  isOpen?: boolean;
  /** Alias for isOpen (for softn compatibility) */
  open?: boolean;
  /** Callback when modal should close */
  onClose: () => void;
  /** Modal title */
  title?: string;
  /** Modal size */
  size?: 'sm' | 'md' | 'lg' | 'xl' | 'full';
  /** Close on overlay click */
  closeOnOverlayClick?: boolean;
  /** Close on Escape key */
  closeOnEscape?: boolean;
  /** Show close button */
  showCloseButton?: boolean;
  /** Center modal vertically */
  centered?: boolean;
  /** Loading state - shows spinner overlay */
  loading?: boolean;
  /** Loading text to display */
  loadingText?: string;
  /** Prevent closing while loading */
  preventCloseOnLoading?: boolean;
  /** Disable animations */
  disableAnimation?: boolean;
  /** Custom overlay color */
  overlayColor?: string;
  /** Additional CSS class */
  className?: string;
  /** Inline styles */
  style?: React.CSSProperties;
  /** Modal content */
  children?: React.ReactNode;
  /** Footer content */
  footer?: React.ReactNode;
  /** Header extra content (right side, before close button) */
  headerExtra?: React.ReactNode;
}

const sizeValues: Record<string, string> = {
  sm: '24rem',
  md: '32rem',
  lg: '42rem',
  xl: '56rem',
  full: '100%',
};

// Spinner component
const Spinner = ({ size = 24 }: { size?: number }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    style={{ animation: 'softn-modal-spin 1s linear infinite' }}
  >
    <circle
      cx="12"
      cy="12"
      r="10"
      stroke="currentColor"
      strokeWidth="3"
      strokeLinecap="round"
      opacity="0.25"
    />
    <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
  </svg>
);

export function Modal({
  isOpen,
  open,
  onClose,
  title,
  size = 'md',
  closeOnOverlayClick = true,
  closeOnEscape = true,
  showCloseButton = true,
  centered = true,
  loading = false,
  loadingText,
  preventCloseOnLoading = true,
  disableAnimation = false,
  overlayColor,
  className,
  style,
  children,
  footer,
  headerExtra,
}: ModalProps): React.ReactElement | null {
  // Support both isOpen and open props
  const isModalOpen = isOpen ?? open ?? false;

  const modalRef = useRef<HTMLDivElement>(null);
  const [isVisible, setIsVisible] = useState(false);
  const [isAnimating, setIsAnimating] = useState(false);

  // Handle open/close with animation
  useEffect(() => {
    if (isModalOpen) {
      setIsVisible(true);
      // Small delay to trigger animation
      requestAnimationFrame(() => {
        setIsAnimating(true);
      });
    } else {
      setIsAnimating(false);
      if (!disableAnimation) {
        const timer = setTimeout(() => {
          setIsVisible(false);
        }, 200);
        return () => clearTimeout(timer);
      } else {
        setIsVisible(false);
      }
    }
  }, [isModalOpen, disableAnimation]);

  // Handle escape key
  useEffect(() => {
    if (!isVisible) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && closeOnEscape) {
        if (loading && preventCloseOnLoading) return;
        onClose();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    document.body.style.overflow = 'hidden';

    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = '';
    };
  }, [isVisible, closeOnEscape, onClose, loading, preventCloseOnLoading]);

  // Focus trap and restore focus on close
  useEffect(() => {
    if (!isModalOpen) return;

    const previouslyFocused = document.activeElement as HTMLElement;

    // Focus the modal
    if (modalRef.current) {
      modalRef.current.focus();
    }

    // Focus trap: keep focus within modal
    const handleTabKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab' || !modalRef.current) return;

      const focusableElements = modalRef.current.querySelectorAll<HTMLElement>(
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
  }, [isModalOpen]);

  const handleClose = useCallback(() => {
    if (loading && preventCloseOnLoading) return;
    onClose();
  }, [loading, preventCloseOnLoading, onClose]);

  const handleOverlayClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === e.currentTarget && closeOnOverlayClick) {
        handleClose();
      }
    },
    [closeOnOverlayClick, handleClose]
  );

  if (!isVisible) return null;

  const animationDuration = disableAnimation ? '0ms' : '200ms';

  const overlayStyle: React.CSSProperties = {
    position: 'fixed',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: overlayColor || 'var(--color-overlay, rgba(0, 0, 0, 0.6))',
    backdropFilter: isAnimating ? 'blur(8px) saturate(0.8)' : 'blur(0px)',
    WebkitBackdropFilter: isAnimating ? 'blur(8px) saturate(0.8)' : 'blur(0px)',
    display: 'flex',
    alignItems: centered ? 'center' : 'flex-start',
    justifyContent: 'center',
    padding: centered ? '1.5rem' : '4rem 1.5rem',
    zIndex: 1000,
    overflow: 'auto',
    opacity: isAnimating ? 1 : 0,
    transition: `opacity ${animationDuration} cubic-bezier(0.16, 1, 0.3, 1), backdrop-filter ${animationDuration} cubic-bezier(0.16, 1, 0.3, 1)`,
  };

  const modalStyle: React.CSSProperties = {
    position: 'relative',
    width: '100%',
    maxWidth: sizeValues[size],
    maxHeight: size === 'full' ? '100%' : 'calc(100dvh - 6rem)',
    backgroundColor: 'var(--color-surface, #16161a)',
    borderRadius: size === 'full' ? 0 : 'var(--radius-xl, 1rem)',
    boxShadow: 'var(--shadow-xl, 0 20px 60px rgba(0, 0, 0, 0.5)), 0 0 0 1px var(--color-border, rgba(255, 255, 255, 0.08))',
    display: 'flex',
    flexDirection: 'column',
    outline: 'none',
    transform: isAnimating ? 'scale(1) translateY(0)' : 'scale(0.96) translateY(8px)',
    opacity: isAnimating ? 1 : 0,
    transition: `transform 250ms cubic-bezier(0.16, 1, 0.3, 1), opacity 200ms cubic-bezier(0.16, 1, 0.3, 1)`,
    ...style,
  };

  const headerStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '1.25rem 1.5rem',
    borderBottom: '1px solid var(--color-border, rgba(255, 255, 255, 0.08))',
    flexShrink: 0,
  };

  const titleStyle: React.CSSProperties = {
    margin: 0,
    fontSize: '1.0625rem',
    fontWeight: 600,
    color: 'var(--color-text, #ececf0)',
    letterSpacing: '-0.02em',
  };

  const headerActionsStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: '0.5rem',
  };

  const closeButtonStyle: React.CSSProperties = {
    padding: '0.5rem',
    background: 'transparent',
    border: 'none',
    cursor: loading && preventCloseOnLoading ? 'not-allowed' : 'pointer',
    color: 'var(--color-gray-400, #9ca3af)',
    borderRadius: 'var(--radius-md, 0.375rem)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    transition: 'all var(--duration-fast, 120ms) cubic-bezier(0.16, 1, 0.3, 1)',
    opacity: loading && preventCloseOnLoading ? 0.5 : 1,
  };

  const bodyStyle: React.CSSProperties = {
    flex: 1,
    padding: '1.5rem',
    overflow: 'auto',
    position: 'relative',
  };

  const footerStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: '0.75rem',
    padding: '1.25rem 1.5rem',
    borderTop: '1px solid var(--color-border, rgba(255, 255, 255, 0.08))',
    background: 'var(--color-gray-50, #1e1e23)',
    borderRadius: '0 0 var(--radius-xl, 1rem) var(--radius-xl, 1rem)',
    flexShrink: 0,
  };

  const loadingOverlayStyle: React.CSSProperties = {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'var(--color-surface, rgba(26, 26, 26, 0.95))',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '0.75rem',
    zIndex: 10,
    borderRadius: 'inherit',
  };

  const loadingTextStyle: React.CSSProperties = {
    fontSize: 'var(--text-sm, 0.875rem)',
    color: 'var(--color-text-muted, #a1a1aa)',
    fontWeight: 500,
  };

  return (
    <>
      <style>{`
        @keyframes softn-modal-spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
        .softn-modal-close:hover:not(:disabled) {
          background-color: var(--color-gray-700, #3f3f46) !important;
          color: var(--color-gray-200, #e4e4e7) !important;
        }
        .softn-modal-close:active:not(:disabled) {
          transform: scale(0.95);
        }
      `}</style>
      <div style={overlayStyle} onClick={handleOverlayClick}>
        <div
          ref={modalRef}
          className={className}
          style={modalStyle}
          role="dialog"
          aria-modal="true"
          aria-labelledby={title ? 'modal-title' : undefined}
          aria-busy={loading}
          tabIndex={-1}
        >
          {/* Loading overlay */}
          {loading && (
            <div style={loadingOverlayStyle}>
              <Spinner size={32} />
              {loadingText && <span style={loadingTextStyle}>{loadingText}</span>}
            </div>
          )}

          {/* Header */}
          {(title || showCloseButton || headerExtra) && (
            <div style={headerStyle}>
              {title && (
                <h2 id="modal-title" style={titleStyle}>
                  {title}
                </h2>
              )}
              <div style={headerActionsStyle}>
                {headerExtra}
                {showCloseButton && (
                  <button
                    type="button"
                    className="softn-modal-close"
                    onClick={handleClose}
                    style={closeButtonStyle}
                    aria-label="Close"
                    disabled={loading && preventCloseOnLoading}
                  >
                    <svg
                      width="20"
                      height="20"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                    >
                      <line x1="18" y1="6" x2="6" y2="18" />
                      <line x1="6" y1="6" x2="18" y2="18" />
                    </svg>
                  </button>
                )}
              </div>
            </div>
          )}

          {/* Body */}
          <div style={bodyStyle}>{children}</div>

          {/* Footer */}
          {footer && <div style={footerStyle}>{footer}</div>}
        </div>
      </div>
    </>
  );
}

export default Modal;

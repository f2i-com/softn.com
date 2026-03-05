/**
 * Toast Component
 *
 * A temporary notification message with progress bar and pause on hover.
 * Uses CSS variables for theming support.
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';

export interface ToastProps {
  /** Toast variant */
  variant?: 'info' | 'success' | 'warning' | 'error';
  /** Toast title */
  title?: string;
  /** Toast message */
  message?: string;
  /** Duration in milliseconds (0 for persistent) */
  duration?: number;
  /** Position on screen */
  position?:
    | 'top-right'
    | 'top-left'
    | 'top-center'
    | 'bottom-right'
    | 'bottom-left'
    | 'bottom-center';
  /** Whether to show close button */
  showClose?: boolean;
  /** Whether to show progress bar */
  showProgress?: boolean;
  /** Pause countdown on hover */
  pauseOnHover?: boolean;
  /** Callback when toast is closed */
  onClose?: () => void;
  /** Whether toast is visible */
  isVisible?: boolean;
  /** Additional CSS class */
  className?: string;
  /** Inline styles */
  style?: React.CSSProperties;
}

const variantStyles: Record<
  string,
  { bg: string; border: string; icon: string; progressBg: string }
> = {
  info: {
    bg: 'var(--color-surface, #16161a)',
    border: 'var(--color-info-500, #3b82f6)',
    icon: 'var(--color-info-500, #3b82f6)',
    progressBg: 'var(--color-info-500, #3b82f6)',
  },
  success: {
    bg: 'var(--color-surface, #16161a)',
    border: 'var(--color-success-500, #10b981)',
    icon: 'var(--color-success-500, #10b981)',
    progressBg: 'var(--color-success-500, #10b981)',
  },
  warning: {
    bg: 'var(--color-surface, #16161a)',
    border: 'var(--color-warning-500, #f59e0b)',
    icon: 'var(--color-warning-500, #f59e0b)',
    progressBg: 'var(--color-warning-500, #f59e0b)',
  },
  error: {
    bg: 'var(--color-surface, #16161a)',
    border: 'var(--color-error-500, #ef4444)',
    icon: 'var(--color-error-500, #ef4444)',
    progressBg: 'var(--color-error-500, #ef4444)',
  },
};

const icons: Record<string, React.ReactNode> = {
  info: (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="16" x2="12" y2="12" />
      <line x1="12" y1="8" x2="12.01" y2="8" />
    </svg>
  ),
  success: (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
      <polyline points="22 4 12 14.01 9 11.01" />
    </svg>
  ),
  warning: (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  ),
  error: (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      <circle cx="12" cy="12" r="10" />
      <line x1="15" y1="9" x2="9" y2="15" />
      <line x1="9" y1="9" x2="15" y2="15" />
    </svg>
  ),
};

const positionStyles: Record<string, React.CSSProperties> = {
  'top-right': { top: '1rem', right: '1rem' },
  'top-left': { top: '1rem', left: '1rem' },
  'top-center': { top: '1rem', left: '50%', transform: 'translateX(-50%)' },
  'bottom-right': { bottom: '1rem', right: '1rem' },
  'bottom-left': { bottom: '1rem', left: '1rem' },
  'bottom-center': { bottom: '1rem', left: '50%', transform: 'translateX(-50%)' },
};

export function Toast({
  variant = 'info',
  title,
  message,
  duration = 5000,
  position = 'top-right',
  showClose = true,
  showProgress = true,
  pauseOnHover = true,
  onClose,
  isVisible = true,
  className,
  style,
}: ToastProps): React.ReactElement | null {
  const [visible, setVisible] = useState(isVisible);
  const [isPaused, setIsPaused] = useState(false);
  const [progress, setProgress] = useState(100);
  const [isHovered, setIsHovered] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startTimeRef = useRef<number>(0);
  const remainingTimeRef = useRef<number>(duration);
  const styles = variantStyles[variant];

  useEffect(() => {
    setVisible(isVisible);
    if (isVisible) {
      setProgress(100);
      remainingTimeRef.current = duration;
    }
  }, [isVisible, duration]);

  // Handle countdown and progress
  useEffect(() => {
    if (!visible || duration === 0) return;

    const startTimer = () => {
      startTimeRef.current = Date.now();

      timerRef.current = setInterval(() => {
        const elapsed = Date.now() - startTimeRef.current;
        const newRemaining = remainingTimeRef.current - elapsed;

        if (newRemaining <= 0) {
          setVisible(false);
          onClose?.();
          if (timerRef.current) clearInterval(timerRef.current);
        } else {
          const newProgress = (newRemaining / duration) * 100;
          setProgress(Math.max(0, newProgress));
        }
      }, 50);
    };

    if (!isPaused) {
      startTimer();
    }

    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        // Save remaining time when pausing
        if (isPaused) {
          const elapsed = Date.now() - startTimeRef.current;
          remainingTimeRef.current = Math.max(0, remainingTimeRef.current - elapsed);
        }
      }
    };
  }, [visible, duration, isPaused, onClose]);

  const handleMouseEnter = useCallback(() => {
    setIsHovered(true);
    if (pauseOnHover && duration > 0) {
      // Save remaining time before pausing
      if (timerRef.current) {
        const elapsed = Date.now() - startTimeRef.current;
        remainingTimeRef.current = Math.max(0, remainingTimeRef.current - elapsed);
      }
      setIsPaused(true);
    }
  }, [pauseOnHover, duration]);

  const handleMouseLeave = useCallback(() => {
    setIsHovered(false);
    if (pauseOnHover && duration > 0) {
      setIsPaused(false);
    }
  }, [pauseOnHover, duration]);

  const handleClose = useCallback(() => {
    setVisible(false);
    if (timerRef.current) clearInterval(timerRef.current);
    onClose?.();
  }, [onClose]);

  if (!visible) return null;

  const containerStyle: React.CSSProperties = {
    position: 'fixed',
    zIndex: 1100,
    ...positionStyles[position],
  };

  const toastStyle: React.CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    backgroundColor: styles.bg,
    borderLeft: `4px solid ${styles.border}`,
    borderRadius: 'var(--radius-lg, 0.5rem)',
    boxShadow: isHovered
      ? '0 20px 25px -5px rgba(0, 0, 0, 0.15), 0 8px 10px -5px rgba(0, 0, 0, 0.08)'
      : '0 10px 15px -3px rgba(0, 0, 0, 0.1), 0 4px 6px -2px rgba(0, 0, 0, 0.05)',
    minWidth: '300px',
    maxWidth: '420px',
    animation: 'toast-slide-in 0.3s cubic-bezier(0.16, 1, 0.3, 1)',
    overflow: 'hidden',
    transition: 'all 200ms cubic-bezier(0.16, 1, 0.3, 1)',
    transform: isHovered ? 'scale(1.02)' : 'scale(1)',
    ...style,
  };

  const toastContentStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'flex-start',
    gap: '0.75rem',
    padding: '1rem',
  };

  const iconStyle: React.CSSProperties = {
    flexShrink: 0,
    color: styles.icon,
  };

  const contentStyle: React.CSSProperties = {
    flex: 1,
    minWidth: 0,
  };

  const titleStyle: React.CSSProperties = {
    fontWeight: 600,
    fontSize: 'var(--text-sm, 0.875rem)',
    color: 'var(--color-text, #ececf0)',
    marginBottom: message ? '0.25rem' : 0,
    lineHeight: 1.4,
  };

  const messageStyle: React.CSSProperties = {
    fontSize: 'var(--text-sm, 0.875rem)',
    color: 'var(--color-text-muted, #6b7280)',
    lineHeight: 1.5,
  };

  const closeStyle: React.CSSProperties = {
    flexShrink: 0,
    padding: '0.375rem',
    background: 'none',
    border: 'none',
    cursor: 'pointer',
    color: 'var(--color-gray-400, #9ca3af)',
    borderRadius: 'var(--radius-md, 0.375rem)',
    transition: 'all 180ms cubic-bezier(0.16, 1, 0.3, 1)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  };

  const progressContainerStyle: React.CSSProperties = {
    height: '3px',
    backgroundColor: 'var(--color-gray-100, rgba(255, 255, 255, 0.06))',
    overflow: 'hidden',
  };

  const progressBarStyle: React.CSSProperties = {
    height: '100%',
    width: `${progress}%`,
    backgroundColor: styles.progressBg,
    transition: isPaused ? 'none' : 'width 50ms linear',
  };

  return (
    <div style={containerStyle}>
      <style>
        {`
          @keyframes toast-slide-in {
            from {
              opacity: 0;
              transform: translateX(100%) scale(0.95);
            }
            to {
              opacity: 1;
              transform: translateX(0) scale(1);
            }
          }
          .softn-toast-close:hover {
            background-color: var(--color-gray-700, rgba(255, 255, 255, 0.08)) !important;
            color: var(--color-gray-200, #3f3f46) !important;
          }
          .softn-toast-close:active {
            transform: scale(0.9);
          }
        `}
      </style>
      <div
        className={className}
        style={toastStyle}
        role="alert"
        aria-live={variant === 'error' ? 'assertive' : 'polite'}
        aria-atomic="true"
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
      >
        <div style={toastContentStyle}>
          <span style={iconStyle}>{icons[variant]}</span>
          <div style={contentStyle}>
            {title && <div style={titleStyle}>{title}</div>}
            {message && <div style={messageStyle}>{message}</div>}
          </div>
          {showClose && (
            <button
              type="button"
              className="softn-toast-close"
              onClick={handleClose}
              style={closeStyle}
              aria-label="Close"
            >
              <svg
                width="16"
                height="16"
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
        {showProgress && duration > 0 && (
          <div style={progressContainerStyle}>
            <div style={progressBarStyle} />
          </div>
        )}
      </div>
    </div>
  );
}

export default Toast;

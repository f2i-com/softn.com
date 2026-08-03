/**
 * Slider Component
 *
 * A range input slider with customizable appearance.
 * Supports single value and range selection.
 */

import React, { useState, useRef, useCallback, useEffect } from 'react';

export interface SliderProps {
  /** Current value */
  value?: number;
  /** Default value (uncontrolled) */
  defaultValue?: number;
  /** Minimum value */
  min?: number;
  /** Maximum value */
  max?: number;
  /** Step increment */
  step?: number;
  /** Disable the slider */
  disabled?: boolean;
  /** Show value tooltip on hover/drag */
  showTooltip?: boolean;
  /** Tooltip always visible */
  tooltipAlwaysVisible?: boolean;
  /** Format tooltip value */
  formatTooltip?: (value: number) => string;
  /** Accessible name for the slider */
  ariaLabel?: string;
  /** Show marks at intervals */
  marks?: boolean | { value: number; label?: string }[];
  /** Size variant */
  size?: 'sm' | 'md' | 'lg';
  /** Color variant */
  variant?: 'primary' | 'secondary' | 'success' | 'warning' | 'danger';
  /** Track color */
  trackColor?: string;
  /** Fill color */
  fillColor?: string;
  /** Thumb color */
  thumbColor?: string;
  /** Change handler */
  onChange?: (value: number) => void;
  /** Change end handler (on mouse up) */
  onChangeEnd?: (value: number) => void;
  /** Additional CSS class */
  className?: string;
  /** Inline styles */
  style?: React.CSSProperties;
}

const sizeConfig = {
  sm: { track: 4, thumb: 12, fontSize: '0.75rem' },
  md: { track: 6, thumb: 16, fontSize: '0.875rem' },
  lg: { track: 8, thumb: 20, fontSize: '1rem' },
};

const variantColors: Record<string, string> = {
  primary: 'var(--color-primary-500, #6366f1)',
  secondary: 'var(--color-gray-500, #6b7280)',
  success: 'var(--color-success-500, #22c55e)',
  warning: 'var(--color-warning-500, #f59e0b)',
  danger: 'var(--color-error-500, #ef4444)',
};

function decimalPlaces(value: number): number {
  const text = String(value).toLowerCase();
  if (text.includes('e-')) {
    const [coefficient, exponent] = text.split('e-');
    return Number(exponent) + (coefficient.split('.')[1]?.length ?? 0);
  }
  return text.split('.')[1]?.length ?? 0;
}

/** Match native range inputs: steps are anchored to `min`, not zero. */
function settleValue(value: number, min: number, max: number, step: number): number {
  if (!Number.isFinite(value) || max <= min) return min;
  const safeStep = Number.isFinite(step) && step > 0 ? step : 1;
  const stepped = min + Math.round((value - min) / safeStep) * safeStep;
  const clamped = Math.min(max, Math.max(min, stepped));
  const precision = Math.min(12, Math.max(decimalPlaces(min), decimalPlaces(safeStep)));
  return Number(clamped.toFixed(precision));
}

export function Slider({
  value: controlledValue,
  defaultValue = 0,
  min = 0,
  max = 100,
  step = 1,
  disabled = false,
  showTooltip = true,
  tooltipAlwaysVisible = false,
  formatTooltip,
  ariaLabel = 'Value',
  marks = false,
  size = 'md',
  variant = 'primary',
  trackColor,
  fillColor,
  thumbColor,
  onChange,
  onChangeEnd,
  className,
  style,
}: SliderProps): React.ReactElement {
  const [internalValue, setInternalValue] = useState(defaultValue);
  const [isDragging, setIsDragging] = useState(false);
  const [isHovering, setIsHovering] = useState(false);
  const trackRef = useRef<HTMLDivElement>(null);
  const dragValueRef = useRef(defaultValue);
  const activePointerIdRef = useRef<number | null>(null);
  const captureTargetRef = useRef<HTMLDivElement | null>(null);

  const requestedValue = controlledValue !== undefined ? controlledValue : internalValue;
  const value = settleValue(requestedValue, min, max, step);
  const percentage = max > min ? ((value - min) / (max - min)) * 100 : 0;

  const config = sizeConfig[size];
  const activeColor = fillColor ?? variantColors[variant];
  const inactiveColor = trackColor ?? 'var(--color-gray-200, rgba(255, 255, 255, 0.1))';
  const thumbActiveColor = thumbColor ?? activeColor;

  const getValueFromPosition = useCallback(
    (clientX: number) => {
      if (!trackRef.current) return value;
      const rect = trackRef.current.getBoundingClientRect();
      if (rect.width <= 0) return value;
      const percent = (clientX - rect.left) / rect.width;
      return settleValue(min + percent * (max - min), min, max, step);
    },
    [min, max, step, value]
  );

  /** Commit a value through the same clamp/step path the pointer uses. */
  const commit = (next: number) => {
    const settled = settleValue(next, min, max, step);
    if (settled === value) return;
    if (controlledValue === undefined) setInternalValue(settled);
    onChange?.(settled);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (disabled) return;
    // A page jump of ten steps, which is what every native range input does.
    const page = step * 10;
    const moves: Record<string, number | undefined> = {
      ArrowRight: step,
      ArrowUp: step,
      ArrowLeft: -step,
      ArrowDown: -step,
      PageUp: page,
      PageDown: -page,
    };
    if (e.key === 'Home') {
      e.preventDefault();
      commit(min);
      return;
    }
    if (e.key === 'End') {
      e.preventDefault();
      commit(max);
      return;
    }
    const delta = moves[e.key];
    if (delta === undefined) return;
    e.preventDefault();
    commit(value + delta);
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (disabled || e.button !== 0 || activePointerIdRef.current !== null) return;
    e.preventDefault();
    activePointerIdRef.current = e.pointerId;
    captureTargetRef.current = e.currentTarget;
    try {
      e.currentTarget.setPointerCapture?.(e.pointerId);
    } catch {
      // Pointer capture may be unavailable or already released by the browser.
    }
    trackRef.current?.querySelector<HTMLElement>('[role="slider"]')?.focus();
    setIsDragging(true);
    const newValue = getValueFromPosition(e.clientX);
    dragValueRef.current = newValue;
    if (controlledValue === undefined) {
      setInternalValue(newValue);
    }
    onChange?.(newValue);
  };

  const finishPointer = useCallback(
    (pointerId: number) => {
      if (pointerId !== activePointerIdRef.current) return;
      const track = captureTargetRef.current ?? trackRef.current;
      // Clear ownership before releasing capture because release can dispatch
      // lostpointercapture synchronously in some browsers.
      activePointerIdRef.current = null;
      try {
        if (track?.hasPointerCapture?.(pointerId)) {
          track.releasePointerCapture(pointerId);
        }
      } catch {
        // The browser may release capture before dispatching pointercancel.
      }
      captureTargetRef.current = null;
      setIsDragging(false);
      onChangeEnd?.(dragValueRef.current);
    },
    [onChangeEnd]
  );

  useEffect(
    () => () => {
      const pointerId = activePointerIdRef.current;
      if (pointerId === null) return;
      // Unmount is cancellation, not a committed value change. Drop ownership
      // before releasing so a synchronous lostpointercapture cannot notify the
      // consumer or schedule state on an unmounted component.
      activePointerIdRef.current = null;
      const track = captureTargetRef.current ?? trackRef.current;
      try {
        if (track?.hasPointerCapture?.(pointerId)) {
          track.releasePointerCapture(pointerId);
        }
      } catch {
        // Removing the captured element may already have released the pointer.
      }
      captureTargetRef.current = null;
    },
    []
  );

  useEffect(() => {
    if (!isDragging) return;

    const handlePointerMove = (e: PointerEvent) => {
      if (e.pointerId !== activePointerIdRef.current) return;
      const newValue = getValueFromPosition(e.clientX);
      dragValueRef.current = newValue;
      if (controlledValue === undefined) {
        setInternalValue(newValue);
      }
      onChange?.(newValue);
    };

    const handlePointerFinish = (e: PointerEvent) => finishPointer(e.pointerId);

    document.addEventListener('pointermove', handlePointerMove);
    document.addEventListener('pointerup', handlePointerFinish);
    document.addEventListener('pointercancel', handlePointerFinish);

    return () => {
      document.removeEventListener('pointermove', handlePointerMove);
      document.removeEventListener('pointerup', handlePointerFinish);
      document.removeEventListener('pointercancel', handlePointerFinish);
    };
  }, [isDragging, getValueFromPosition, onChange, controlledValue, finishPointer]);

  useEffect(() => {
    if (disabled && activePointerIdRef.current !== null) {
      finishPointer(activePointerIdRef.current);
    }
  }, [disabled, finishPointer]);

  const showTooltipNow = showTooltip && (tooltipAlwaysVisible || isDragging || isHovering);

  // Generate marks array
  const markItems: { value: number; label?: string }[] = [];
  if (marks === true) {
    // Auto-generate marks at 25% intervals
    for (let i = 0; i <= 4; i++) {
      const markValue = min + ((max - min) * i) / 4;
      markItems.push({ value: markValue, label: String(Math.round(markValue)) });
    }
  } else if (Array.isArray(marks)) {
    markItems.push(...marks);
  }

  const containerStyle: React.CSSProperties = {
    position: 'relative',
    width: '100%',
    paddingTop: showTooltipNow ? config.thumb + 8 : 0,
    paddingBottom: markItems.length > 0 ? 20 : 0,
    opacity: disabled ? 0.5 : 1,
    cursor: disabled ? 'not-allowed' : 'pointer',
    touchAction: 'none',
    ...style,
  };

  const trackStyle: React.CSSProperties = {
    position: 'relative',
    width: '100%',
    height: config.track,
    backgroundColor: inactiveColor,
    borderRadius: config.track / 2,
    cursor: disabled ? 'not-allowed' : 'pointer',
  };

  const fillStyle: React.CSSProperties = {
    position: 'absolute',
    top: 0,
    left: 0,
    height: '100%',
    width: `${percentage}%`,
    backgroundColor: activeColor,
    borderRadius: config.track / 2,
    transition: isDragging ? 'none' : 'width 150ms cubic-bezier(0.16, 1, 0.3, 1)',
  };

  const thumbStyle: React.CSSProperties = {
    position: 'absolute',
    top: '50%',
    left: `${percentage}%`,
    transform: 'translate(-50%, -50%)',
    width: config.thumb,
    height: config.thumb,
    backgroundColor: thumbActiveColor,
    borderRadius: '50%',
    border: '2px solid var(--color-surface, #16161a)',
    boxShadow: '0 2px 6px rgba(0, 0, 0, 0.3), 0 0 0 1px rgba(255, 255, 255, 0.06)',
    cursor: disabled ? 'not-allowed' : 'grab',
    transition: isDragging
      ? 'none'
      : 'left 150ms cubic-bezier(0.16, 1, 0.3, 1), transform 180ms cubic-bezier(0.16, 1, 0.3, 1), box-shadow 180ms cubic-bezier(0.16, 1, 0.3, 1)',
  };

  const thumbHoverStyle: React.CSSProperties = {
    ...thumbStyle,
    transform: 'translate(-50%, -50%) scale(1.15)',
    boxShadow: `0 0 0 4px ${activeColor}33, 0 2px 8px rgba(0, 0, 0, 0.3)`,
  };

  const tooltipStyle: React.CSSProperties = {
    position: 'absolute',
    bottom: '100%',
    left: `${percentage}%`,
    transform: 'translateX(-50%)',
    marginBottom: 8,
    padding: '4px 8px',
    backgroundColor: 'var(--color-gray-800, #1f2937)',
    color: 'white',
    fontSize: '0.75rem',
    fontWeight: 500,
    borderRadius: 4,
    whiteSpace: 'nowrap',
    opacity: showTooltipNow ? 1 : 0,
    transition: 'opacity 180ms cubic-bezier(0.16, 1, 0.3, 1)',
    pointerEvents: 'none',
  };

  const tooltipArrowStyle: React.CSSProperties = {
    position: 'absolute',
    top: '100%',
    left: '50%',
    transform: 'translateX(-50%)',
    borderLeft: '4px solid transparent',
    borderRight: '4px solid transparent',
    borderTop: '4px solid var(--color-gray-800, #1f2937)',
  };

  const formatValue = formatTooltip ?? ((v) => String(v));

  return (
    <div
      className={className}
      style={containerStyle}
      onMouseEnter={() => setIsHovering(true)}
      onMouseLeave={() => setIsHovering(false)}
    >
      <div
        ref={trackRef}
        style={trackStyle}
        onPointerDown={handlePointerDown}
        onLostPointerCapture={(event) => finishPointer(event.pointerId)}
      >
        <div style={fillStyle} />
        {/* A registered form control that only listened for mousedown: no
            tabIndex, no role, no key handling, so a keyboard or screen-reader
            user was skipped straight past it and could not set the value at
            all — on a form that may require it. */}
        <div
          role="slider"
          tabIndex={disabled ? -1 : 0}
          aria-valuemin={min}
          aria-valuemax={max}
          aria-valuenow={value}
          aria-valuetext={formatValue(value)}
          aria-label={ariaLabel}
          aria-disabled={disabled || undefined}
          aria-orientation="horizontal"
          style={isDragging || isHovering ? thumbHoverStyle : thumbStyle}
          onKeyDown={handleKeyDown}
        />
        {showTooltip && (
          <div style={tooltipStyle}>
            {formatValue(value)}
            <div style={tooltipArrowStyle} />
          </div>
        )}
      </div>
      {markItems.length > 0 && (
        <div style={{ position: 'relative', marginTop: 8 }}>
          {markItems.map((mark, index) => {
            const markPercent = max > min ? ((mark.value - min) / (max - min)) * 100 : 0;
            return (
              <div
                key={index}
                style={{
                  position: 'absolute',
                  left: `${markPercent}%`,
                  transform: 'translateX(-50%)',
                  textAlign: 'center',
                }}
              >
                <div
                  style={{
                    width: 2,
                    height: 6,
                    backgroundColor: mark.value <= value ? activeColor : inactiveColor,
                    margin: '0 auto 4px',
                  }}
                />
                {mark.label && (
                  <span
                    style={{
                      fontSize: config.fontSize,
                      color: 'var(--color-gray-500, #6b7280)',
                    }}
                  >
                    {mark.label}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default Slider;

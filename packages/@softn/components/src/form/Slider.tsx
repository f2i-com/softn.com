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

  const value = controlledValue !== undefined ? controlledValue : internalValue;
  const percentage = ((value - min) / (max - min)) * 100;

  const config = sizeConfig[size];
  const activeColor = fillColor ?? variantColors[variant];
  const inactiveColor = trackColor ?? 'var(--color-gray-200, rgba(255, 255, 255, 0.1))';
  const thumbActiveColor = thumbColor ?? activeColor;

  const clamp = (val: number) => Math.min(max, Math.max(min, val));
  const roundToStep = (val: number) => Math.round(val / step) * step;

  const getValueFromPosition = useCallback(
    (clientX: number) => {
      if (!trackRef.current) return value;
      const rect = trackRef.current.getBoundingClientRect();
      const percent = (clientX - rect.left) / rect.width;
      return clamp(roundToStep(min + percent * (max - min)));
    },
    [min, max, step, value]
  );

  const handleMouseDown = (e: React.MouseEvent) => {
    if (disabled) return;
    e.preventDefault();
    setIsDragging(true);
    const newValue = getValueFromPosition(e.clientX);
    if (controlledValue === undefined) {
      setInternalValue(newValue);
    }
    onChange?.(newValue);
  };

  useEffect(() => {
    if (!isDragging) return;

    const handleMouseMove = (e: MouseEvent) => {
      const newValue = getValueFromPosition(e.clientX);
      if (controlledValue === undefined) {
        setInternalValue(newValue);
      }
      onChange?.(newValue);
    };

    const handleMouseUp = () => {
      setIsDragging(false);
      onChangeEnd?.(value);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDragging, getValueFromPosition, onChange, onChangeEnd, value, controlledValue]);

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
    transition: isDragging ? 'none' : 'left 150ms cubic-bezier(0.16, 1, 0.3, 1), transform 180ms cubic-bezier(0.16, 1, 0.3, 1), box-shadow 180ms cubic-bezier(0.16, 1, 0.3, 1)',
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
      <div ref={trackRef} style={trackStyle} onMouseDown={handleMouseDown}>
        <div style={fillStyle} />
        <div
          style={isDragging || isHovering ? thumbHoverStyle : thumbStyle}
          onMouseDown={handleMouseDown}
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
            const markPercent = ((mark.value - min) / (max - min)) * 100;
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

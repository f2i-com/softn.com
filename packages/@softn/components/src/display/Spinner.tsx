/**
 * Spinner Component
 *
 * A loading spinner indicator with multiple variants.
 * Uses CSS variables for theming support.
 */

import React from 'react';

export interface SpinnerProps {
  /** Spinner variant */
  variant?: 'ring' | 'dots' | 'bars' | 'pulse';
  /** Spinner size */
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl' | string;
  /** Spinner color */
  color?: 'primary' | 'secondary' | 'success' | 'warning' | 'danger' | 'white' | string;
  /** Spinner thickness (for ring variant) */
  thickness?: number;
  /** Speed in seconds */
  speed?: number;
  /** Label for accessibility */
  label?: string;
  /** Show glow effect */
  glow?: boolean;
  /** Additional CSS class */
  className?: string;
  /** Inline styles */
  style?: React.CSSProperties;
}

const sizeValues: Record<string, string> = {
  xs: '0.75rem',
  sm: '1rem',
  md: '1.5rem',
  lg: '2rem',
  xl: '3rem',
};

interface ColorConfig {
  color: string;
  gradient: string;
  glowColor: string;
}

const colorConfigs: Record<string, ColorConfig> = {
  primary: {
    color: 'var(--color-primary-500, #6366f1)',
    gradient:
      'conic-gradient(from 0deg, transparent 0deg, var(--color-primary-400, #818cf8) 90deg, var(--color-primary-500, #6366f1) 180deg, var(--color-primary-600, #4f46e5) 270deg, transparent 360deg)',
    glowColor: 'rgba(59, 130, 246, 0.5)',
  },
  secondary: {
    color: 'var(--color-gray-500, #6b7280)',
    gradient:
      'conic-gradient(from 0deg, transparent 0deg, var(--color-gray-400, #9ca3af) 90deg, var(--color-gray-500, #6b7280) 180deg, var(--color-gray-600, #4b5563) 270deg, transparent 360deg)',
    glowColor: 'rgba(107, 114, 128, 0.4)',
  },
  success: {
    color: 'var(--color-success-500, #22c55e)',
    gradient:
      'conic-gradient(from 0deg, transparent 0deg, var(--color-success-400, #4ade80) 90deg, var(--color-success-500, #22c55e) 180deg, var(--color-success-600, #16a34a) 270deg, transparent 360deg)',
    glowColor: 'rgba(34, 197, 94, 0.5)',
  },
  warning: {
    color: 'var(--color-warning-500, #f59e0b)',
    gradient:
      'conic-gradient(from 0deg, transparent 0deg, var(--color-warning-400, #fbbf24) 90deg, var(--color-warning-500, #f59e0b) 180deg, var(--color-warning-600, #d97706) 270deg, transparent 360deg)',
    glowColor: 'rgba(245, 158, 11, 0.5)',
  },
  danger: {
    color: 'var(--color-error-500, #ef4444)',
    gradient:
      'conic-gradient(from 0deg, transparent 0deg, var(--color-error-400, #f87171) 90deg, var(--color-error-500, #ef4444) 180deg, var(--color-error-600, #dc2626) 270deg, transparent 360deg)',
    glowColor: 'rgba(239, 68, 68, 0.5)',
  },
  white: {
    color: '#ffffff',
    gradient:
      'conic-gradient(from 0deg, transparent 0deg, rgba(255,255,255,0.6) 90deg, rgba(255,255,255,0.8) 180deg, #ffffff 270deg, transparent 360deg)',
    glowColor: 'rgba(255, 255, 255, 0.4)',
  },
};

function RingSpinner({
  sizeValue,
  colorConfig,
  thickness,
  speed,
  glow,
}: {
  sizeValue: string;
  colorConfig: ColorConfig;
  thickness: number;
  speed: number;
  glow: boolean;
}): React.ReactElement {
  const spinnerStyle: React.CSSProperties = {
    width: sizeValue,
    height: sizeValue,
    borderRadius: '50%',
    background: colorConfig.gradient,
    mask: `radial-gradient(farthest-side, transparent calc(100% - ${thickness}px), #fff calc(100% - ${thickness}px + 1px))`,
    WebkitMask: `radial-gradient(farthest-side, transparent calc(100% - ${thickness}px), #fff calc(100% - ${thickness}px + 1px))`,
    animation: `softn-spinner-rotate ${speed}s linear infinite`,
    boxShadow: glow ? `0 0 16px ${colorConfig.glowColor}` : undefined,
  };

  return <div style={spinnerStyle} />;
}

function DotsSpinner({
  sizeValue,
  colorConfig,
  speed,
  glow,
}: {
  sizeValue: string;
  colorConfig: ColorConfig;
  speed: number;
  glow: boolean;
}): React.ReactElement {
  const sizeNum = parseFloat(sizeValue);
  const unit = sizeValue.replace(String(sizeNum), '');
  const dotSize = sizeNum / 3;

  const containerStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: `${dotSize / 2}${unit}`,
    height: sizeValue,
  };

  const dotStyle = (delay: number): React.CSSProperties => ({
    width: `${dotSize}${unit}`,
    height: `${dotSize}${unit}`,
    borderRadius: '50%',
    background: `linear-gradient(135deg, ${colorConfig.color}, ${colorConfig.color})`,
    boxShadow: glow ? `0 0 8px ${colorConfig.glowColor}` : undefined,
    animation: `softn-spinner-bounce ${speed}s cubic-bezier(0.16, 1, 0.3, 1) infinite`,
    animationDelay: `${delay}s`,
  });

  return (
    <div style={containerStyle}>
      <div style={dotStyle(0)} />
      <div style={dotStyle(speed / 6)} />
      <div style={dotStyle(speed / 3)} />
    </div>
  );
}

function BarsSpinner({
  sizeValue,
  colorConfig,
  speed,
  glow,
}: {
  sizeValue: string;
  colorConfig: ColorConfig;
  speed: number;
  glow: boolean;
}): React.ReactElement {
  const sizeNum = parseFloat(sizeValue);
  const unit = sizeValue.replace(String(sizeNum), '');
  const barWidth = sizeNum / 5;
  const barHeight = sizeNum;

  const containerStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: `${barWidth / 2}${unit}`,
    height: sizeValue,
  };

  const barStyle = (delay: number): React.CSSProperties => ({
    width: `${barWidth}${unit}`,
    height: `${barHeight}${unit}`,
    borderRadius: `${barWidth / 2}${unit}`,
    background: `linear-gradient(180deg, ${colorConfig.color}, ${colorConfig.color})`,
    boxShadow: glow ? `0 0 8px ${colorConfig.glowColor}` : undefined,
    animation: `softn-spinner-bars ${speed}s cubic-bezier(0.16, 1, 0.3, 1) infinite`,
    animationDelay: `${delay}s`,
  });

  return (
    <div style={containerStyle}>
      <div style={barStyle(0)} />
      <div style={barStyle(speed / 8)} />
      <div style={barStyle(speed / 4)} />
      <div style={barStyle((speed / 8) * 3)} />
    </div>
  );
}

function PulseSpinner({
  sizeValue,
  colorConfig,
  speed,
  glow,
}: {
  sizeValue: string;
  colorConfig: ColorConfig;
  speed: number;
  glow: boolean;
}): React.ReactElement {
  const containerStyle: React.CSSProperties = {
    position: 'relative',
    width: sizeValue,
    height: sizeValue,
  };

  const ringStyle = (index: number): React.CSSProperties => ({
    position: 'absolute',
    top: 0,
    left: 0,
    width: '100%',
    height: '100%',
    borderRadius: '50%',
    border: `2px solid ${colorConfig.color}`,
    opacity: 1 - index * 0.3,
    animation: `softn-spinner-pulse ${speed}s cubic-bezier(0.4, 0, 0.6, 1) infinite`,
    animationDelay: `${(index * speed) / 3}s`,
    boxShadow: glow ? `0 0 8px ${colorConfig.glowColor}` : undefined,
  });

  return (
    <div style={containerStyle}>
      <div style={ringStyle(0)} />
      <div style={ringStyle(1)} />
      <div style={ringStyle(2)} />
    </div>
  );
}

export function Spinner({
  variant = 'ring',
  size = 'md',
  color = 'primary',
  thickness = 3,
  speed = 0.8,
  label = 'Loading...',
  glow = false,
  className,
  style,
}: SpinnerProps): React.ReactElement {
  const sizeValue = sizeValues[size] ?? size;
  const colorConfig = colorConfigs[color] ?? {
    color: color,
    gradient: `conic-gradient(from 0deg, transparent 0deg, ${color} 180deg, transparent 360deg)`,
    glowColor: color,
  };

  const containerStyle: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    ...style,
  };

  const renderSpinner = () => {
    switch (variant) {
      case 'dots':
        return (
          <DotsSpinner sizeValue={sizeValue} colorConfig={colorConfig} speed={speed} glow={glow} />
        );
      case 'bars':
        return (
          <BarsSpinner sizeValue={sizeValue} colorConfig={colorConfig} speed={speed} glow={glow} />
        );
      case 'pulse':
        return (
          <PulseSpinner
            sizeValue={sizeValue}
            colorConfig={colorConfig}
            speed={speed * 1.5}
            glow={glow}
          />
        );
      case 'ring':
      default:
        return (
          <RingSpinner
            sizeValue={sizeValue}
            colorConfig={colorConfig}
            thickness={thickness}
            speed={speed}
            glow={glow}
          />
        );
    }
  };

  return (
    <div className={className} style={containerStyle} role="status" aria-label={label}>
      <style>
        {`
          @keyframes softn-spinner-rotate {
            0% { transform: rotate(0deg); }
            100% { transform: rotate(360deg); }
          }
          @keyframes softn-spinner-bounce {
            0%, 100% { transform: translateY(0) scale(1); opacity: 1; }
            50% { transform: translateY(-50%) scale(0.8); opacity: 0.6; }
          }
          @keyframes softn-spinner-bars {
            0%, 100% { transform: scaleY(0.4); opacity: 0.5; }
            50% { transform: scaleY(1); opacity: 1; }
          }
          @keyframes softn-spinner-pulse {
            0% { transform: scale(0.5); opacity: 1; }
            100% { transform: scale(1.2); opacity: 0; }
          }
          @media (prefers-reduced-motion: reduce) {
            .softn-spinner-animated { animation: none !important; }
          }
        `}
      </style>
      {renderSpinner()}
      <span
        style={{
          position: 'absolute',
          width: '1px',
          height: '1px',
          padding: 0,
          margin: '-1px',
          overflow: 'hidden',
          clip: 'rect(0, 0, 0, 0)',
          whiteSpace: 'nowrap',
          border: 0,
        }}
      >
        {label}
      </span>
    </div>
  );
}

export default Spinner;

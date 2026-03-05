/**
 * Skeleton Component
 *
 * A loading placeholder that mimics content structure.
 * Uses CSS animations for a shimmer effect.
 * Supports theme-aware colors via CSS variables.
 */

import React from 'react';

export interface SkeletonProps {
  /** Variant of skeleton */
  variant?: 'text' | 'circular' | 'rectangular' | 'rounded';
  /** Width (CSS value or number for pixels) */
  width?: string | number;
  /** Height (CSS value or number for pixels) */
  height?: string | number;
  /** Animation type */
  animation?: 'pulse' | 'wave' | 'none';
  /** Animation speed */
  speed?: 'slow' | 'normal' | 'fast';
  /** Number of text lines (only for text variant) */
  lines?: number;
  /** Line spacing for multi-line text */
  lineSpacing?: string;
  /** Border radius (overrides variant default) */
  borderRadius?: string | number;
  /** Base color (supports CSS variables) */
  baseColor?: string;
  /** Highlight color for shimmer (supports CSS variables) */
  highlightColor?: string;
  /** Additional CSS class */
  className?: string;
  /** Inline styles */
  style?: React.CSSProperties;
  /** Children to show when loading is false */
  children?: React.ReactNode;
  /** Whether content is still loading */
  loading?: boolean;
}

const defaultHeights: Record<string, string> = {
  text: '1em',
  circular: '40px',
  rectangular: '100px',
  rounded: '100px',
};

const defaultRadii: Record<string, string> = {
  text: 'var(--radius-sm, 4px)',
  circular: '50%',
  rectangular: '0',
  rounded: 'var(--radius-md, 8px)',
};

const speedDurations = {
  slow: '2s',
  normal: '1.5s',
  fast: '1s',
};

export function Skeleton({
  variant = 'text',
  width,
  height,
  animation = 'wave',
  speed = 'normal',
  lines = 1,
  lineSpacing = '0.5em',
  borderRadius,
  baseColor,
  highlightColor,
  className,
  style,
  children,
  loading = true,
}: SkeletonProps): React.ReactElement {
  // If not loading, show children
  if (!loading && children) {
    return <>{children}</>;
  }

  const computedWidth = typeof width === 'number' ? `${width}px` : width;
  const computedHeight =
    typeof height === 'number' ? `${height}px` : height || defaultHeights[variant];
  const computedRadius = borderRadius
    ? typeof borderRadius === 'number'
      ? `${borderRadius}px`
      : borderRadius
    : defaultRadii[variant];

  // For circular, make width equal height if not specified
  const finalWidth = variant === 'circular' && !width ? computedHeight : computedWidth;

  const duration = speedDurations[speed];
  const bgColor = baseColor || 'var(--color-skeleton-base, var(--color-gray-200, #3f3f46))';
  const hlColor = highlightColor || 'var(--color-skeleton-highlight, rgba(255, 255, 255, 0.5))';

  const baseStyle: React.CSSProperties = {
    display: 'block',
    backgroundColor: bgColor,
    width: finalWidth || '100%',
    height: computedHeight,
    borderRadius: computedRadius,
    position: 'relative',
    overflow: 'hidden',
    boxShadow: 'inset 0 1px 2px rgba(0, 0, 0, 0.04)',
    ...style,
  };

  const pulseAnimation = `
    @keyframes softn-skeleton-pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.5; }
    }
  `;

  const waveAnimation = `
    @keyframes softn-skeleton-wave {
      0% { transform: translateX(-100%); }
      100% { transform: translateX(100%); }
    }
  `;

  const animationStyle: React.CSSProperties =
    animation === 'pulse'
      ? { animation: `softn-skeleton-pulse ${duration} ease-in-out infinite` }
      : animation === 'wave'
        ? {}
        : {};

  const shimmerOverlay =
    animation === 'wave' ? (
      <span
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          background: `linear-gradient(90deg, transparent 0%, ${hlColor} 50%, transparent 100%)`,
          animation: `softn-skeleton-wave ${duration} ease-in-out infinite`,
        }}
      />
    ) : null;

  // Render multiple lines for text variant
  if (variant === 'text' && lines > 1) {
    return (
      <>
        <style>
          {pulseAnimation}
          {waveAnimation}
        </style>
        <div
          className={className}
          style={{ display: 'flex', flexDirection: 'column', gap: lineSpacing }}
        >
          {Array.from({ length: lines }, (_, i) => (
            <span
              key={i}
              style={{
                ...baseStyle,
                ...animationStyle,
                // Make last line shorter for natural appearance
                width: i === lines - 1 ? '80%' : finalWidth || '100%',
              }}
            >
              {shimmerOverlay}
            </span>
          ))}
        </div>
      </>
    );
  }

  return (
    <>
      <style>
        {pulseAnimation}
        {waveAnimation}
      </style>
      <span className={className} style={{ ...baseStyle, ...animationStyle }}>
        {shimmerOverlay}
      </span>
    </>
  );
}

/**
 * SkeletonText - Preset for text loading
 */
export function SkeletonText({
  lines = 3,
  ...props
}: Omit<SkeletonProps, 'variant'> & { lines?: number }): React.ReactElement {
  return <Skeleton variant="text" lines={lines} {...props} />;
}

/**
 * SkeletonCircle - Preset for circular avatars
 */
export function SkeletonCircle({
  size = 40,
  ...props
}: Omit<SkeletonProps, 'variant' | 'width' | 'height'> & { size?: number }): React.ReactElement {
  return <Skeleton variant="circular" width={size} height={size} {...props} />;
}

/**
 * SkeletonCard - Preset for card loading
 */
export function SkeletonCard({
  width = '100%',
  height = 200,
  ...props
}: Omit<SkeletonProps, 'variant'>): React.ReactElement {
  return <Skeleton variant="rounded" width={width} height={height} {...props} />;
}

export default Skeleton;

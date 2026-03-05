/**
 * Image Component
 *
 * A responsive image with loading and error states.
 */

import React from 'react';

export interface ImageProps {
  /** Image source URL */
  src: string;
  /** Alt text */
  alt: string;
  /** Image width */
  width?: string | number;
  /** Image height */
  height?: string | number;
  /** Object fit */
  objectFit?: 'contain' | 'cover' | 'fill' | 'none' | 'scale-down';
  /** Object position */
  objectPosition?: string;
  /** Border radius */
  borderRadius?: 'none' | 'sm' | 'md' | 'lg' | 'full' | string;
  /** Fallback source on error */
  fallbackSrc?: string;
  /** Loading strategy */
  loading?: 'lazy' | 'eager';
  /** Show loading placeholder */
  showPlaceholder?: boolean;
  /** Placeholder color */
  placeholderColor?: string;
  /** Click handler */
  onClick?: () => void;
  /** Additional CSS class */
  className?: string;
  /** Inline styles */
  style?: React.CSSProperties;
}

const radiusValues: Record<string, string> = {
  none: '0',
  sm: '0.125rem',
  md: '0.375rem',
  lg: '0.5rem',
  full: '9999px',
};

export function Image({
  src,
  alt,
  width,
  height,
  objectFit = 'cover',
  objectPosition = 'center',
  borderRadius = 'none',
  fallbackSrc,
  loading = 'lazy',
  showPlaceholder = true,
  placeholderColor = '#3f3f46',
  onClick,
  className,
  style,
}: ImageProps): React.ReactElement {
  // Data URLs and SVGs load synchronously — skip loading state entirely
  const isInstantSrc = (s: string) => s?.startsWith('data:') || s?.endsWith('.svg');
  const [isLoading, setIsLoading] = React.useState(() => !isInstantSrc(src));
  const [hasError, setHasError] = React.useState(false);
  const [currentSrc, setCurrentSrc] = React.useState(src);

  React.useEffect(() => {
    setCurrentSrc(src);
    setIsLoading(!isInstantSrc(src));
    setHasError(false);
  }, [src]);

  const radius = radiusValues[borderRadius] ?? borderRadius;

  const containerStyle: React.CSSProperties = {
    position: 'relative',
    display: 'inline-block',
    width: typeof width === 'number' ? `${width}px` : width,
    height: typeof height === 'number' ? `${height}px` : height,
    borderRadius: radius,
    overflow: 'hidden',
    backgroundColor: showPlaceholder && isLoading ? placeholderColor : undefined,
    cursor: onClick ? 'pointer' : undefined,
    ...style,
  };

  const imgStyle: React.CSSProperties = {
    display: 'block',
    width: '100%',
    height: '100%',
    objectFit,
    objectPosition,
    opacity: isLoading ? 0 : 1,
    transition: 'opacity 0.3s cubic-bezier(0.16, 1, 0.3, 1)',
  };

  const handleLoad = () => {
    setIsLoading(false);
  };

  const handleError = () => {
    setIsLoading(false);
    setHasError(true);
    if (fallbackSrc && currentSrc !== fallbackSrc) {
      setCurrentSrc(fallbackSrc);
      setIsLoading(true);
      setHasError(false);
    }
  };

  const errorStyle: React.CSSProperties = {
    position: 'absolute',
    top: '50%',
    left: '50%',
    transform: 'translate(-50%, -50%)',
    color: '#9ca3af',
    fontSize: '0.875rem',
    textAlign: 'center',
  };

  return (
    <div className={className} style={containerStyle} onClick={onClick}>
      {hasError && !fallbackSrc ? (
        <div style={errorStyle}>
          <svg
            width="24"
            height="24"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            style={{ marginBottom: '0.25rem' }}
          >
            <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
            <circle cx="8.5" cy="8.5" r="1.5" />
            <polyline points="21 15 16 10 5 21" />
          </svg>
          <div>Failed to load</div>
        </div>
      ) : (
        <img
          src={currentSrc}
          alt={alt}
          loading={loading}
          style={imgStyle}
          onLoad={handleLoad}
          onError={handleError}
        />
      )}
    </div>
  );
}

export default Image;

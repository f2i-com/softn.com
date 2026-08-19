/**
 * Image Component
 *
 * A responsive image with loading and error states.
 */

import React from 'react';
import { isSafeUrl, useConsentPending } from '@softn/core';

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
  // Both sources are bundle-supplied — usually read out of the record being
  // displayed — so neither can be handed to the DOM unchecked. A rejected URL
  // becomes undefined and renders the same "Failed to load" panel a broken
  // image does.
  const safeSrc = src && isSafeUrl(src) ? src : undefined;
  const safeFallbackSrc = fallbackSrc && isSafeUrl(fallbackSrc) ? fallbackSrc : undefined;

  // The withholding itself is the renderer's: it strips a remote src from
  // every URL-bearing prop before any component is constructed, which is the
  // only place that also covers a raw <img> in the markup and the 90 other
  // components. What arrives here is therefore already undefined, and all this
  // does is stop the panel below blaming the bundle for it — "Failed to load"
  // for an image the runtime chose not to request is a lie about whose fault
  // it is, and points nowhere. The moment the user allows, the src is passed
  // through again and the image loads on that render, with no reload.
  const consentPending = useConsentPending();

  // Data URLs and SVGs load synchronously — skip loading state entirely
  const isInstantSrc = (s: string | undefined) => s?.startsWith('data:') || s?.endsWith('.svg');
  const [isLoading, setIsLoading] = React.useState(() => !isInstantSrc(safeSrc));
  const [hasError, setHasError] = React.useState(false);
  const [currentSrc, setCurrentSrc] = React.useState(safeSrc);

  React.useEffect(() => {
    setCurrentSrc(safeSrc);
    setIsLoading(!isInstantSrc(safeSrc));
    setHasError(false);
  }, [safeSrc]);

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
    if (safeFallbackSrc && currentSrc !== safeFallbackSrc) {
      setCurrentSrc(safeFallbackSrc);
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
      {!currentSrc && consentPending ? (
        <div style={{ ...errorStyle, width: '100%', padding: '0 0.25rem', fontSize: '0.75rem' }}>
          Images load once you choose Allow in the permission bar.
        </div>
      ) : !currentSrc || (hasError && !safeFallbackSrc) ? (
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

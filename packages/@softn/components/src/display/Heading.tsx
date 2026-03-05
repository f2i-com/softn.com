/**
 * Heading Component
 *
 * A heading element (h1-h6) with styling options.
 * Uses CSS variables for theming support.
 */

import React from 'react';

export interface HeadingProps {
  /** Heading level (1-6) */
  level?: 1 | 2 | 3 | 4 | 5 | 6;
  /** Text content */
  content?: string;
  /** Text color variant */
  variant?: 'default' | 'muted' | 'primary' | 'gradient';
  /** Custom text color (overrides variant) */
  color?: string;
  /** Text alignment */
  align?: 'left' | 'center' | 'right';
  /** Whether to truncate with ellipsis */
  truncate?: boolean;
  /** Maximum number of lines (with ellipsis) */
  lineClamp?: number;
  /** Text transform */
  transform?: 'none' | 'uppercase' | 'lowercase' | 'capitalize';
  /** Letter spacing */
  letterSpacing?: 'tight' | 'normal' | 'wide';
  /** Decorative underline */
  underline?: boolean;
  /** Additional CSS class */
  className?: string;
  /** Inline styles */
  style?: React.CSSProperties;
  /** Children */
  children?: React.ReactNode;
}

interface LevelStyle {
  fontSize: string;
  fontWeight: number;
  lineHeight: number;
  letterSpacing: string;
}

const levelStyles: Record<number, LevelStyle> = {
  1: {
    fontSize: 'var(--text-4xl, 2.25rem)',
    fontWeight: 800,
    lineHeight: 1.1,
    letterSpacing: '-0.025em',
  },
  2: {
    fontSize: 'var(--text-3xl, 1.875rem)',
    fontWeight: 700,
    lineHeight: 1.2,
    letterSpacing: '-0.02em',
  },
  3: {
    fontSize: 'var(--text-2xl, 1.5rem)',
    fontWeight: 600,
    lineHeight: 1.25,
    letterSpacing: '-0.015em',
  },
  4: {
    fontSize: 'var(--text-xl, 1.25rem)',
    fontWeight: 600,
    lineHeight: 1.3,
    letterSpacing: '-0.01em',
  },
  5: {
    fontSize: 'var(--text-lg, 1.125rem)',
    fontWeight: 600,
    lineHeight: 1.4,
    letterSpacing: '0',
  },
  6: {
    fontSize: 'var(--text-base, 1rem)',
    fontWeight: 600,
    lineHeight: 1.5,
    letterSpacing: '0',
  },
};

const variantColors: Record<string, string | undefined> = {
  default: 'var(--color-text, #fafafa)',
  muted: 'var(--color-text-muted, #a1a1aa)',
  primary: 'var(--color-primary-500, #6366f1)',
  gradient: undefined, // Special handling
};

const letterSpacingValues: Record<string, string> = {
  tight: '-0.05em',
  normal: '0',
  wide: '0.05em',
};

export function Heading({
  level = 1,
  content,
  variant = 'default',
  color,
  align,
  truncate = false,
  lineClamp,
  transform,
  letterSpacing,
  underline = false,
  className,
  style,
  children,
}: HeadingProps): React.ReactElement {
  const Tag = `h${level}` as keyof JSX.IntrinsicElements;
  const levelStyle = levelStyles[level];

  const isGradient = variant === 'gradient' && !color;

  const computedStyle: React.CSSProperties = {
    fontSize: levelStyle.fontSize,
    fontWeight: levelStyle.fontWeight,
    lineHeight: levelStyle.lineHeight,
    letterSpacing: letterSpacing ? letterSpacingValues[letterSpacing] : levelStyle.letterSpacing,
    color: isGradient ? 'transparent' : (color ?? variantColors[variant]),
    textAlign: align,
    textTransform: transform,
    margin: 0,
    fontFamily: 'var(--font-heading, inherit)',
    transition: 'color var(--duration-fast, 150ms) var(--easing-inOut, cubic-bezier(0.16, 1, 0.3, 1))',
    ...(isGradient
      ? {
          background:
            'linear-gradient(135deg, var(--color-primary-500, #6366f1) 0%, var(--color-primary-700, #4338ca) 100%)',
          WebkitBackgroundClip: 'text',
          backgroundClip: 'text',
        }
      : {}),
    ...(truncate
      ? {
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }
      : {}),
    ...(lineClamp
      ? {
          display: '-webkit-box',
          WebkitLineClamp: lineClamp,
          WebkitBoxOrient: 'vertical',
          overflow: 'hidden',
        }
      : {}),
    ...style,
  };

  const underlineStyle: React.CSSProperties = {
    position: 'relative',
    display: 'inline-block',
    paddingBottom: '0.5rem',
  };

  const underlineAfter: React.CSSProperties = {
    content: '""',
    position: 'absolute',
    bottom: 0,
    left: 0,
    width: '3rem',
    height: '3px',
    background: 'var(--color-primary-500, #6366f1)',
    borderRadius: '2px',
  };

  if (underline) {
    return (
      <Tag className={className} style={{ ...computedStyle, ...underlineStyle }}>
        {content ?? children}
        <span style={underlineAfter} aria-hidden="true" />
      </Tag>
    );
  }

  return (
    <Tag className={className} style={computedStyle}>
      {content ?? children}
    </Tag>
  );
}

export default Heading;

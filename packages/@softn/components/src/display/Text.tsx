/**
 * Text Component
 *
 * A text display component with styling options.
 * Uses CSS variables for theming support.
 */

import React from 'react';

export interface TextProps {
  /** Text content */
  content?: string;
  /** Text size */
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl' | '2xl' | '3xl';
  /** Font weight */
  weight?: 'light' | 'normal' | 'medium' | 'semibold' | 'bold';
  /** Text color variant */
  variant?: 'default' | 'muted' | 'primary' | 'secondary' | 'success' | 'warning' | 'error';
  /** Custom text color (overrides variant) */
  color?: string;
  /** Text alignment */
  align?: 'left' | 'center' | 'right' | 'justify';
  /** Whether to truncate with ellipsis */
  truncate?: boolean;
  /** Maximum number of lines (with ellipsis) */
  lineClamp?: number;
  /** Line height */
  lineHeight?: 'tight' | 'normal' | 'relaxed' | 'loose';
  /** Letter spacing */
  letterSpacing?: 'tight' | 'normal' | 'wide';
  /** Text transform */
  transform?: 'none' | 'uppercase' | 'lowercase' | 'capitalize';
  /** Font style */
  italic?: boolean;
  /** Text decoration */
  decoration?: 'none' | 'underline' | 'line-through';
  /** Display as block element */
  block?: boolean;
  /** Flex */
  flex?: number | string;
  /** Additional CSS class */
  className?: string;
  /** Inline styles */
  style?: React.CSSProperties;
  /** Children */
  children?: React.ReactNode;
  /** HTML element to render */
  as?: 'span' | 'p' | 'div' | 'label';
}

const sizeValues: Record<string, string> = {
  xs: 'var(--text-xs, 0.75rem)',
  sm: 'var(--text-sm, 0.875rem)',
  md: 'var(--text-base, 1rem)',
  lg: 'var(--text-lg, 1.125rem)',
  xl: 'var(--text-xl, 1.25rem)',
  '2xl': 'var(--text-2xl, 1.5rem)',
  '3xl': 'var(--text-3xl, 1.875rem)',
};

const weightValues: Record<string, number> = {
  light: 300,
  normal: 400,
  medium: 500,
  semibold: 600,
  bold: 700,
};

const variantColors: Record<string, string> = {
  default: 'var(--color-text, #fafafa)',
  muted: 'var(--color-text-muted, #a1a1aa)',
  primary: 'var(--color-primary-500, #6366f1)',
  secondary: 'var(--color-gray-400, #a1a1aa)',
  success: 'var(--color-success-500, #22c55e)',
  warning: 'var(--color-warning-500, #f59e0b)',
  error: 'var(--color-error-500, #ef4444)',
  info: 'var(--color-info-500, #3b82f6)',
  white: '#ffffff',
  inherit: 'inherit',
};

const lineHeightValues: Record<string, number> = {
  tight: 1.25,
  normal: 1.5,
  relaxed: 1.625,
  loose: 2,
};

const letterSpacingValues: Record<string, string> = {
  tight: '-0.025em',
  normal: '0',
  wide: '0.05em',
};

export function Text({
  content,
  size = 'md',
  weight = 'normal',
  variant = 'default',
  color,
  align,
  truncate = false,
  lineClamp,
  lineHeight = 'normal',
  letterSpacing = 'normal',
  transform,
  italic = false,
  decoration,
  block = false,
  flex,
  className,
  style,
  children,
  as = 'span',
}: TextProps): React.ReactElement {
  const Tag = as;

  const computedStyle: React.CSSProperties = {
    fontSize: sizeValues[size] ?? size,
    fontWeight: weightValues[weight] ?? weight,
    color: color ?? variantColors[variant],
    textAlign: align,
    lineHeight: lineHeightValues[lineHeight],
    letterSpacing: letterSpacingValues[letterSpacing],
    textTransform: transform,
    fontStyle: italic ? 'italic' : undefined,
    textDecoration: decoration,
    display: block ? 'block' : undefined,
    flex: flex ?? undefined,
    margin: 0,
    transition: 'color var(--duration-fast, 150ms) var(--easing-inOut, cubic-bezier(0.16, 1, 0.3, 1))',
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

  return (
    <Tag className={className} style={computedStyle}>
      {content ?? children}
    </Tag>
  );
}

export default Text;

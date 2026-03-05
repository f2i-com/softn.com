/**
 * Shared Color Variants
 *
 * Centralized color configurations used across Badge, Tag, Alert, and other components.
 * Uses CSS variables for theming support with fallback values.
 */

/**
 * Basic variant colors used by Badge and Tag components
 */
export interface VariantColors {
  bg: string;
  bgSubtle: string;
  text: string;
  textSubtle: string;
  border: string;
  gradient?: string;
  glowColor?: string;
}

/**
 * Standard variant color palette
 */
export const variantColors: Record<string, VariantColors> = {
  default: {
    bg: 'var(--color-gray-600, #52525b)',
    bgSubtle: 'var(--color-gray-800, #1e1e23)',
    text: 'var(--color-white, #fafafa)',
    textSubtle: 'var(--color-gray-300, #52525b)',
    border: 'var(--color-gray-600, #52525b)',
    gradient:
      'linear-gradient(135deg, var(--color-gray-500, #71717a), var(--color-gray-600, #52525b), var(--color-gray-700, #3f3f46))',
    glowColor: 'rgba(107, 114, 128, 0.4)',
  },
  primary: {
    bg: 'var(--color-primary-500, #6366f1)',
    bgSubtle: 'rgba(99, 102, 241, 0.15)',
    text: 'var(--color-white, #fafafa)',
    textSubtle: 'var(--color-primary-400, #818cf8)',
    border: 'var(--color-primary-500, #6366f1)',
    gradient:
      'linear-gradient(135deg, var(--color-primary-400, #818cf8), var(--color-primary-500, #6366f1), var(--color-primary-600, #4f46e5))',
    glowColor: 'rgba(99, 102, 241, 0.5)',
  },
  secondary: {
    bg: 'var(--color-gray-700, #3f3f46)',
    bgSubtle: 'var(--color-gray-800, #1e1e23)',
    text: 'var(--color-gray-200, #3f3f46)',
    textSubtle: 'var(--color-gray-300, #52525b)',
    border: 'var(--color-gray-600, #52525b)',
    gradient:
      'linear-gradient(135deg, var(--color-gray-600, #52525b), var(--color-gray-700, #3f3f46))',
    glowColor: 'rgba(156, 163, 175, 0.3)',
  },
  success: {
    bg: 'var(--color-success-500, #22c55e)',
    bgSubtle: 'rgba(34, 197, 94, 0.15)',
    text: 'var(--color-white, #fafafa)',
    textSubtle: 'var(--color-success-400, #4ade80)',
    border: 'var(--color-success-500, #22c55e)',
    gradient:
      'linear-gradient(135deg, var(--color-success-400, #4ade80), var(--color-success-500, #22c55e), var(--color-success-600, #16a34a))',
    glowColor: 'rgba(34, 197, 94, 0.5)',
  },
  warning: {
    bg: 'var(--color-warning-500, #f59e0b)',
    bgSubtle: 'rgba(245, 158, 11, 0.15)',
    text: 'var(--color-white, #fafafa)',
    textSubtle: 'var(--color-warning-400, #fbbf24)',
    border: 'var(--color-warning-500, #f59e0b)',
    gradient:
      'linear-gradient(135deg, var(--color-warning-400, #fbbf24), var(--color-warning-500, #f59e0b), var(--color-warning-600, #d97706))',
    glowColor: 'rgba(245, 158, 11, 0.5)',
  },
  danger: {
    bg: 'var(--color-error-500, #ef4444)',
    bgSubtle: 'rgba(239, 68, 68, 0.15)',
    text: 'var(--color-white, #fafafa)',
    textSubtle: 'var(--color-error-400, #f87171)',
    border: 'var(--color-error-500, #ef4444)',
    gradient:
      'linear-gradient(135deg, var(--color-error-400, #f87171), var(--color-error-500, #ef4444), var(--color-error-600, #dc2626))',
    glowColor: 'rgba(239, 68, 68, 0.5)',
  },
  info: {
    bg: 'var(--color-info-500, #3b82f6)',
    bgSubtle: 'rgba(59, 130, 246, 0.15)',
    text: 'var(--color-white, #fafafa)',
    textSubtle: 'var(--color-info-400, #60a5fa)',
    border: 'var(--color-info-500, #3b82f6)',
    gradient:
      'linear-gradient(135deg, var(--color-info-400, #60a5fa), var(--color-info-500, #3b82f6), var(--color-info-600, #2563eb))',
    glowColor: 'rgba(59, 130, 246, 0.5)',
  },
};

/**
 * Get styles based on component style type (solid, subtle, outline)
 */
export function getStyleForVariantStyle(
  styleType: 'solid' | 'subtle' | 'outline' | string,
  colors: VariantColors
): React.CSSProperties {
  switch (styleType) {
    case 'outline':
      return {
        backgroundColor: 'transparent',
        color: colors.textSubtle,
        borderWidth: '1px',
        borderStyle: 'solid',
        borderColor: colors.border,
      };
    case 'subtle':
      return {
        backgroundColor: colors.bgSubtle,
        color: colors.textSubtle,
      };
    case 'solid':
    default:
      return {
        backgroundColor: colors.bg,
        color: colors.text,
      };
  }
}

/**
 * Get variant colors with fallback to default
 */
export function getVariantColors(variant: string): VariantColors {
  return variantColors[variant] ?? variantColors.default;
}

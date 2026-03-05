/**
 * Shared Size Configurations
 *
 * Centralized size configurations used across Badge, Tag, Button, and other components.
 */

/**
 * Badge size configuration
 */
export interface BadgeSizeConfig {
  padding: string;
  fontSize: string;
  height: string;
  dotSize: string;
  iconSize: string;
}

/**
 * Badge sizes
 */
export const badgeSizeConfig: Record<string, BadgeSizeConfig> = {
  xs: {
    padding: '0 0.375rem',
    fontSize: 'var(--text-xs, 0.625rem)',
    height: '1rem',
    dotSize: '0.375rem',
    iconSize: '0.625rem',
  },
  sm: {
    padding: '0 0.5rem',
    fontSize: 'var(--text-xs, 0.75rem)',
    height: '1.25rem',
    dotSize: '0.5rem',
    iconSize: '0.75rem',
  },
  md: {
    padding: '0 0.625rem',
    fontSize: 'var(--text-sm, 0.875rem)',
    height: '1.5rem',
    dotSize: '0.625rem',
    iconSize: '0.875rem',
  },
  lg: {
    padding: '0 0.75rem',
    fontSize: 'var(--text-sm, 0.875rem)',
    height: '1.75rem',
    dotSize: '0.75rem',
    iconSize: '1rem',
  },
};

/**
 * Tag size configuration
 */
export interface TagSizeConfig {
  padding: string;
  fontSize: string;
  iconSize: number;
  gap: string;
}

/**
 * Tag sizes
 */
export const tagSizeConfig: Record<string, TagSizeConfig> = {
  sm: { padding: '0.125rem 0.5rem', fontSize: '0.75rem', iconSize: 12, gap: '0.25rem' },
  md: { padding: '0.25rem 0.625rem', fontSize: '0.8125rem', iconSize: 14, gap: '0.375rem' },
  lg: { padding: '0.375rem 0.75rem', fontSize: '0.875rem', iconSize: 16, gap: '0.5rem' },
};

/**
 * Button size configuration
 */
export interface ButtonSizeConfig {
  padding: string;
  fontSize: string;
  height: string;
  iconSize: string;
}

/**
 * Button sizes
 */
export const buttonSizeConfig: Record<string, ButtonSizeConfig> = {
  xs: {
    padding: '0.25rem 0.5rem',
    fontSize: 'var(--text-xs, 0.75rem)',
    height: '1.75rem',
    iconSize: '0.875rem',
  },
  sm: {
    padding: '0.375rem 0.75rem',
    fontSize: 'var(--text-sm, 0.875rem)',
    height: '2rem',
    iconSize: '1rem',
  },
  md: {
    padding: '0.5rem 1rem',
    fontSize: 'var(--text-sm, 0.875rem)',
    height: '2.5rem',
    iconSize: '1.125rem',
  },
  lg: {
    padding: '0.625rem 1.5rem',
    fontSize: 'var(--text-base, 1rem)',
    height: '2.75rem',
    iconSize: '1.25rem',
  },
  xl: {
    padding: '0.75rem 2rem',
    fontSize: 'var(--text-lg, 1.125rem)',
    height: '3rem',
    iconSize: '1.5rem',
  },
};

/**
 * Gap values for spacing
 */
export const gapValues: Record<string, string> = {
  xs: '0.125rem',
  sm: '0.25rem',
  md: '0.5rem',
  lg: '0.75rem',
  xl: '1rem',
  '2xl': '1.5rem',
};

/**
 * Get gap value with fallback
 */
export function getGapValue(gap: string): string {
  return gapValues[gap] ?? gap;
}

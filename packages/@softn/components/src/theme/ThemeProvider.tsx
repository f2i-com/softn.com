/**
 * SoftN Theme Provider
 *
 * Provides theme context and injects CSS custom properties.
 */

import React, { createContext, useContext, useMemo, useEffect, useState, useCallback } from 'react';
import { Theme, lightTheme, darkTheme, ColorScale } from './tokens';

export interface ThemeContextValue {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  toggleDarkMode: () => void;
  isDarkMode: boolean;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export interface ThemeProviderProps {
  /** Initial theme */
  theme?: Theme;
  /** Default to dark mode */
  defaultDarkMode?: boolean;
  /** Follow system preference */
  followSystem?: boolean;
  /** Children */
  children: React.ReactNode;
}

/**
 * Convert theme to CSS custom properties
 */
function themeToCssVariables(theme: Theme): Record<string, string> {
  const vars: Record<string, string> = {};

  // Helper to add color scale
  const addColorScale = (prefix: string, scale: ColorScale) => {
    Object.entries(scale).forEach(([key, value]) => {
      vars[`--${prefix}-${key}`] = value;
    });
  };

  // Colors
  addColorScale('color-primary', theme.colors.primary);
  addColorScale('color-secondary', theme.colors.secondary);
  addColorScale('color-success', theme.colors.success);
  addColorScale('color-warning', theme.colors.warning);
  addColorScale('color-error', theme.colors.error);
  addColorScale('color-info', theme.colors.info);
  addColorScale('color-gray', theme.colors.gray);

  // Semantic colors
  vars['--color-bg'] = theme.colors.background;
  vars['--color-surface'] = theme.colors.surface;
  vars['--color-surface-hover'] = theme.colors.surfaceHover;
  vars['--color-border'] = theme.colors.border;
  vars['--color-border-hover'] = theme.colors.borderHover;
  vars['--color-text'] = theme.colors.text;
  vars['--color-text-muted'] = theme.colors.textMuted;
  vars['--color-text-disabled'] = theme.colors.textDisabled;
  vars['--color-white'] = theme.colors.white;
  vars['--color-black'] = theme.colors.black;

  // Typography
  vars['--font-sans'] = theme.typography.fontFamily.sans;
  vars['--font-serif'] = theme.typography.fontFamily.serif;
  vars['--font-mono'] = theme.typography.fontFamily.mono;

  Object.entries(theme.typography.fontSize).forEach(([key, value]) => {
    vars[`--text-${key}`] = value;
  });

  Object.entries(theme.typography.fontWeight).forEach(([key, value]) => {
    vars[`--font-${key}`] = String(value);
  });

  // Spacing
  Object.entries(theme.spacing).forEach(([key, value]) => {
    vars[`--space-${key.replace('.', '_')}`] = value;
  });

  // Radii
  Object.entries(theme.radii).forEach(([key, value]) => {
    vars[`--radius-${key}`] = value;
  });

  // Shadows
  Object.entries(theme.shadows).forEach(([key, value]) => {
    vars[`--shadow-${key}`] = value;
  });

  // Transitions
  Object.entries(theme.transitions.duration).forEach(([key, value]) => {
    vars[`--duration-${key}`] = value;
  });

  Object.entries(theme.transitions.easing).forEach(([key, value]) => {
    vars[`--easing-${key}`] = value;
  });

  // Breakpoints
  Object.entries(theme.breakpoints).forEach(([key, value]) => {
    vars[`--breakpoint-${key}`] = value;
  });

  return vars;
}

/**
 * Generate CSS string from variables
 */
function generateCss(vars: Record<string, string>): string {
  const rules = Object.entries(vars)
    .map(([key, value]) => `  ${key}: ${value};`)
    .join('\n');

  return `:root {\n${rules}\n}`;
}

/**
 * Global styles for consistent appearance
 */
const globalStyles = `
  *, *::before, *::after {
    box-sizing: border-box;
  }

  body {
    margin: 0;
    padding: 0;
    font-family: var(--font-sans);
    font-size: var(--text-base);
    line-height: 1.5;
    color: var(--color-text);
    background-color: var(--color-bg);
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
  }

  a {
    color: var(--color-primary-600);
    text-decoration: none;
  }

  a:hover {
    color: var(--color-primary-700);
    text-decoration: underline;
  }

  ::selection {
    background-color: var(--color-primary-200);
    color: var(--color-primary-900);
  }

  :focus-visible {
    outline: 2px solid var(--color-primary-500);
    outline-offset: 2px;
  }

  button, input, select, textarea {
    font-family: inherit;
    font-size: inherit;
  }

  /* Responsive utility classes */
  .softn-mobile-only { display: none !important; }
  .softn-desktop-only { display: flex; }

  /* Responsive: Tablet (768px) */
  @media (max-width: 768px) {
    .softn-sidebar {
      display: none !important;
    }
    .softn-app-sidebar {
      display: none !important;
    }
    .softn-layout.softn-layout-horizontal {
      flex-direction: column !important;
    }
    .softn-mobile-only {
      display: flex !important;
    }
    .softn-desktop-only {
      display: none !important;
    }
    .softn-page-content {
      padding-bottom: 4.25rem !important;
    }
    .softn-mobile-stack {
      flex-direction: column !important;
    }
    .softn-mobile-hide {
      display: none !important;
    }
    .softn-mobile-gap-sm {
      gap: 0.75rem !important;
    }
    .softn-mobile-text-sm {
      font-size: 0.75rem !important;
    }
  }

  /* Responsive: Mobile (640px) */
  @media (max-width: 640px) {
    .softn-content {
      padding: 0.75rem !important;
    }
    .softn-page-content {
      padding: 0.75rem !important;
      padding-bottom: 4.25rem !important;
    }
    .softn-mobile-pad-sm {
      padding: 0.75rem !important;
    }
  }
`;

export function ThemeProvider({
  theme: initialTheme,
  defaultDarkMode = false,
  followSystem = false,
  children,
}: ThemeProviderProps): React.ReactElement {
  const [isDark, setIsDark] = useState(() => {
    // Check localStorage first for user's explicit preference
    if (typeof window !== 'undefined') {
      const stored = localStorage.getItem('softn-theme-preference');
      if (stored === 'dark') return true;
      if (stored === 'light') return false;
    }
    // Fall back to system preference
    if (followSystem && typeof window !== 'undefined') {
      return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? defaultDarkMode;
    }
    return defaultDarkMode;
  });

  const [customTheme, setCustomTheme] = useState<Theme | null>(initialTheme ?? null);

  // Listen for system preference changes
  useEffect(() => {
    if (!followSystem || typeof window === 'undefined') return;

    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = (e: MediaQueryListEvent) => setIsDark(e.matches);

    mediaQuery.addEventListener('change', handler);
    return () => mediaQuery.removeEventListener('change', handler);
  }, [followSystem]);

  const theme = useMemo(() => {
    if (customTheme) return customTheme;
    return isDark ? darkTheme : lightTheme;
  }, [customTheme, isDark]);

  const cssVariables = useMemo(() => themeToCssVariables(theme), [theme]);
  const cssString = useMemo(() => generateCss(cssVariables), [cssVariables]);

  const toggleDarkMode = useCallback(() => {
    setIsDark((prev) => {
      const next = !prev;
      try {
        localStorage.setItem('softn-theme-preference', next ? 'dark' : 'light');
      } catch {
        // localStorage may be unavailable in restricted contexts
      }
      return next;
    });
    setCustomTheme(null); // Reset custom theme when toggling
  }, []);

  const setTheme = useCallback((newTheme: Theme) => {
    setCustomTheme(newTheme);
  }, []);

  const contextValue = useMemo<ThemeContextValue>(
    () => ({
      theme,
      setTheme,
      toggleDarkMode,
      isDarkMode: isDark,
    }),
    [theme, setTheme, toggleDarkMode, isDark]
  );

  return (
    <ThemeContext.Provider value={contextValue}>
      <style dangerouslySetInnerHTML={{ __html: cssString + globalStyles }} />
      {children}
    </ThemeContext.Provider>
  );
}

/**
 * Hook to access theme context
 */
export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext);
  if (!context) {
    // Return default values if not wrapped in provider
    return {
      theme: lightTheme,
      setTheme: () => {},
      toggleDarkMode: () => {},
      isDarkMode: false,
    };
  }
  return context;
}

/**
 * Hook to get specific theme values
 */
export function useThemeValue<K extends keyof Theme>(key: K): Theme[K] {
  const { theme } = useTheme();
  return theme[key];
}

export default ThemeProvider;

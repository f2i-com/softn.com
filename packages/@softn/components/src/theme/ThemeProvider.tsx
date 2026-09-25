/**
 * SoftN Theme Provider
 *
 * Provides theme context and injects CSS custom properties.
 */

import React, { createContext, useContext, useMemo, useEffect, useState, useCallback } from 'react';
import { Theme, lightTheme, darkTheme } from './tokens';
import { CHART_PALETTE_LIGHT, chartColorVariable } from './chart-palette';
import { CODE_PALETTE_LIGHT } from './code-palette';
import { cssThemeKey, cssThemeValue } from '../utils/css-values';

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
  /** Controlled appearance, used by editor previews without restarting the app. */
  darkMode?: boolean;
  /** Follow the host document's data-theme, including its live theme switch. */
  followHost?: boolean;
  /** Follow system preference */
  followSystem?: boolean;
  /** Children */
  children: React.ReactNode;
}

/** The entries of a theme section, or none when a partial theme left it out. */
function entriesOf(section: unknown): Array<[string, unknown]> {
  return section && typeof section === 'object' ? Object.entries(section as Record<string, unknown>) : [];
}

/**
 * Convert a theme to CSS custom properties, unchecked. Only ever called on
 * a theme this module defines, or through {@link themeToCssVariables}.
 */
function rawCssVariables(theme: Theme): Record<string, unknown> {
  const vars: Record<string, unknown> = {};
  const colors = (theme?.colors ?? {}) as Partial<Theme['colors']>;
  const typography = (theme?.typography ?? {}) as Partial<Theme['typography']>;
  const transitions = (theme?.transitions ?? {}) as Partial<Theme['transitions']>;

  const addScale = (prefix: string, scale: unknown) => {
    for (const [key, value] of entriesOf(scale)) vars[`--${prefix}-${key}`] = value;
  };

  // Colors
  addScale('color-primary', colors.primary);
  addScale('color-secondary', colors.secondary);
  addScale('color-success', colors.success);
  addScale('color-warning', colors.warning);
  addScale('color-error', colors.error);
  addScale('color-info', colors.info);
  addScale('color-gray', colors.gray);

  // Semantic colors
  vars['--color-bg'] = colors.background;
  vars['--color-surface'] = colors.surface;
  vars['--color-surface-hover'] = colors.surfaceHover;
  vars['--color-border'] = colors.border;
  vars['--color-border-hover'] = colors.borderHover;
  vars['--color-text'] = colors.text;
  vars['--color-text-muted'] = colors.textMuted;
  vars['--color-text-disabled'] = colors.textDisabled;
  vars['--color-white'] = colors.white;
  vars['--color-black'] = colors.black;

  // Chart series colours (see chart-palette.ts)
  const chart = Array.isArray(colors.chart) ? colors.chart : CHART_PALETTE_LIGHT;
  chart.slice(0, 32).forEach((color, index) => {
    vars[chartColorVariable(index + 1)] = color;
  });

  // Code editor syntax colours (see code-palette.ts)
  for (const [kind, color] of entriesOf({ ...CODE_PALETTE_LIGHT, ...(colors.code ?? {}) })) {
    vars[`--color-code-${kind}`] = color;
  }

  // Typography
  for (const [key, value] of entriesOf(typography.fontFamily)) vars[`--font-${key}`] = value;
  for (const [key, value] of entriesOf(typography.fontSize)) vars[`--text-${key}`] = value;
  for (const [key, value] of entriesOf(typography.fontWeight)) vars[`--font-${key}`] = value;

  // Spacing
  for (const [key, value] of entriesOf(theme?.spacing)) vars[`--space-${key.replace('.', '_')}`] = value;
  // Radii, shadows, transitions, breakpoints
  for (const [key, value] of entriesOf(theme?.radii)) vars[`--radius-${key}`] = value;
  for (const [key, value] of entriesOf(theme?.shadows)) vars[`--shadow-${key}`] = value;
  for (const [key, value] of entriesOf(transitions.duration)) vars[`--duration-${key}`] = value;
  for (const [key, value] of entriesOf(transitions.easing)) vars[`--easing-${key}`] = value;
  for (const [key, value] of entriesOf(theme?.breakpoints)) vars[`--breakpoint-${key}`] = value;

  return vars;
}

/** The light theme's own variables: what a refused value falls back to. */
const DEFAULT_VARIABLES = rawCssVariables(lightTheme) as Record<string, string>;

/**
 * Convert a theme to CSS custom properties that are safe to write into
 * `<style>` text.
 *
 * A theme is data the host — or an app, through `setTheme` — hands over, and
 * each name and value lands inside a stylesheet, where a value such as
 * `red; } body { background: url(https://…) } x {` would close the
 * declaration and add a rule of its own, and `</style>` would close the
 * element. Every name must be a plain identifier and every value pass
 * {@link cssThemeValue}; a value that does not is replaced by the light
 * theme's value for the same variable (or dropped when there is none), so
 * the stylesheet stays complete. A theme missing whole sections renders with
 * what it has instead of throwing.
 */
export function themeToCssVariables(theme: Theme): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const [name, value] of Object.entries(rawCssVariables(theme))) {
    if (!cssThemeKey(name.slice(2))) continue;
    const safe = cssThemeValue(value) ?? DEFAULT_VARIABLES[name];
    if (safe !== undefined) vars[name] = safe;
  }
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

  /* Someone who has asked for less motion gets none from a stylesheet:
     animations and transitions finish at once. Components that animate from
     JavaScript ask the same question (utils/motion.ts). */
  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after {
      animation-duration: 0.01ms !important;
      animation-iteration-count: 1 !important;
      animation-delay: 0ms !important;
      transition-duration: 0.01ms !important;
      transition-delay: 0ms !important;
      scroll-behavior: auto !important;
    }
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
  darkMode,
  followHost = false,
  followSystem = false,
  children,
}: ThemeProviderProps): React.ReactElement {
  const readDarkMode = useCallback(() => {
    if (followHost && typeof document !== 'undefined') {
      const hostTheme = document.documentElement.getAttribute('data-theme');
      if (hostTheme === 'dark' || hostTheme === 'light') return hostTheme === 'dark';
    }
    // Check localStorage first for user's explicit preference
    if (typeof window !== 'undefined') {
      try {
        const stored = localStorage.getItem('softn-theme-preference');
        if (stored === 'dark') return true;
        if (stored === 'light') return false;
      } catch { /* Sandboxed frames use the host's default theme. */ }
    }
    // Fall back to system preference
    if (followSystem && typeof window !== 'undefined') {
      return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? defaultDarkMode;
    }
    return defaultDarkMode;
  }, [followHost, followSystem, defaultDarkMode]);
  const [preferredDark, setIsDark] = useState(readDarkMode);
  const isDark = darkMode ?? preferredDark;

  const [customTheme, setCustomTheme] = useState<Theme | null>(initialTheme ?? null);
  // A new `theme` from the host replaces the one in use; it was only ever read
  // on mount, so a host switching brand themes saw no change until a remount.
  const [seenTheme, setSeenTheme] = useState(initialTheme);
  if (initialTheme !== seenTheme) {
    setSeenTheme(initialTheme);
    setCustomTheme(initialTheme ?? null);
  }

  // A host's explicit choice wins over the OS. Observe it instead of remounting
  // the renderer, which would discard app state and unfinished form input.
  useEffect(() => {
    if (darkMode !== undefined || typeof window === 'undefined') return;
    const update = () => setIsDark(readDarkMode());
    const observer = followHost ? new MutationObserver(update) : null;
    observer?.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    const mediaQuery = followSystem ? window.matchMedia?.('(prefers-color-scheme: dark)') : null;
    mediaQuery?.addEventListener('change', update);
    const onStorage = (event: StorageEvent) => {
      if (event.key === 'softn-theme-preference' || event.key === null) update();
    };
    window.addEventListener('storage', onStorage);
    update();
    return () => {
      observer?.disconnect();
      mediaQuery?.removeEventListener('change', update);
      window.removeEventListener('storage', onStorage);
    };
  }, [darkMode, followHost, followSystem, readDarkMode]);

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

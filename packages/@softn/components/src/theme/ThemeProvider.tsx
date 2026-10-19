/**
 * SoftN Theme Provider
 *
 * Provides theme context and injects CSS custom properties.
 */

import React, { createContext, useContext, useMemo, useEffect, useRef, useState, useCallback } from 'react';
import { Theme, lightTheme, darkTheme } from './tokens';
import { CHART_PALETTE_LIGHT, chartColorVariable } from './chart-palette';
import { CODE_PALETTE_LIGHT } from './code-palette';
import { resolveAppTheme, themeSide, type ThemeSide } from './app-theme';
import { cssThemeKey, cssThemeValue } from '../utils/css-values';

export interface ThemeContextValue {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  toggleDarkMode: () => void;
  /** The side of the tokens, as the rule in app-theme.ts comes to it. */
  isDarkMode: boolean;
  /**
   * For `<App>`: says what the page's own `theme` is, so the tokens can go
   * with a page that pins a side in a project that declares one (the rule's
   * 2a). Returns the undo, for when the page goes or its theme changes.
   * Absent where there is no provider.
   */
  pinPage?: (theme: unknown) => () => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

/** The stored preference the provider has always read: one key for the whole origin. */
const PREFERENCE_KEY = 'softn-theme-preference';

/**
 * The attribute a host puts on the element an app is drawn in, with the
 * name it gives the provider as `box`.
 */
export const THEME_BOX_ATTRIBUTE = 'data-softn-theme-box';

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
  /**
   * The side the app's project declares: its manifest's `config.theme.mode`,
   * handed over as the manifest has it. "light" and "dark" win over the
   * host's theme, the stored preference and the device; "system", nothing
   * and anything else leave the provider doing what it did. A page's own
   * `<App theme="light|dark">` still wins over it. See app-theme.ts.
   */
  declaredMode?: unknown;
  /**
   * For a host that draws its app in an element of its own, and above all
   * for one that keeps several apps in one document: the name on that
   * element's `data-softn-theme-box`. An app whose side is not the host's
   * then has its tokens written on its own box, with a ground and a text
   * colour from them, and the document keeps the host's side. Without it a
   * declared side is written on the document, where the provider has always
   * written, and where two apps that disagree would overwrite each other.
   */
  box?: string;
  /** Children */
  children: React.ReactNode;
}

/** What the host has to say about the side, read as it stands. */
interface Surroundings {
  host?: unknown;
  stored?: unknown;
  device?: unknown;
}

function sameSurroundings(a: Surroundings, b: Surroundings): boolean {
  return a.host === b.host && a.stored === b.stored && a.device === b.device;
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
function generateCss(vars: Record<string, string>, selector = ':root', more: string[] = []): string {
  const rules = [...Object.entries(vars).map(([key, value]) => `  ${key}: ${value};`), ...more.map((line) => `  ${line}`)].join('\n');

  return `${selector} {\n${rules}\n}`;
}

/**
 * A box name as it may be written into a selector: letters, digits, `-` and
 * `_`. The name lands in `<style>` text, where anything else could close the
 * selector and open a rule of its own.
 */
function boxName(box: unknown): string | undefined {
  return typeof box === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(box) ? box : undefined;
}

/**
 * What an app's own box is given besides the tokens when its side is not the
 * host's: the tokens' ground and text colour, and the side for the browser's
 * own controls. An app with no `<App>` and no background of its own is drawn
 * straight onto the host's page, in the host's text colour; in dark tokens on
 * a light host it would be light text on a light page.
 */
function groundOf(side: ThemeSide): string[] {
  return ['background-color: var(--color-bg);', 'color: var(--color-text);', `color-scheme: ${side};`];
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
  declaredMode,
  box,
  children,
}: ThemeProviderProps): React.ReactElement {
  // What the host has to say, read as it stands: its document's theme where
  // that is followed, the stored preference, the device where that is
  // followed. Which of them decides, and whether any does, is the rule's.
  const readSurroundings = useCallback((): Surroundings => {
    const surroundings: Surroundings = {};
    if (followHost && typeof document !== 'undefined') {
      surroundings.host = document.documentElement.getAttribute('data-theme');
    }
    if (typeof window !== 'undefined') {
      try {
        surroundings.stored = localStorage.getItem(PREFERENCE_KEY);
      } catch { /* Sandboxed frames use the host's default theme. */ }
      if (followSystem) {
        const dark = window.matchMedia?.('(prefers-color-scheme: dark)').matches;
        if (typeof dark === 'boolean') surroundings.device = dark ? 'dark' : 'light';
      }
    }
    return surroundings;
  }, [followHost, followSystem]);
  const [surroundings, setSurroundings] = useState(readSurroundings);
  // The page's own `<App theme>`, as the page reports it (see pinPage).
  const [pagePin, setPagePin] = useState<ThemeSide | undefined>(undefined);
  const fallback: ThemeSide = defaultDarkMode ? 'dark' : 'light';
  const resolved = resolveAppTheme({
    manifest: declaredMode,
    page: pagePin,
    control: darkMode === undefined ? undefined : darkMode ? 'dark' : 'light',
    ...surroundings,
    fallback,
  });
  const isDark = resolved.tokens === 'dark';
  const ambientDark = resolved.ambient === 'dark';

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
    // The same object while nothing has changed, so an event that changes
    // nothing redraws nothing.
    const update = () => setSurroundings((was) => {
      const now = readSurroundings();
      return sameSurroundings(was, now) ? was : now;
    });
    const observer = followHost ? new MutationObserver(update) : null;
    observer?.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    const mediaQuery = followSystem ? window.matchMedia?.('(prefers-color-scheme: dark)') : null;
    mediaQuery?.addEventListener('change', update);
    const onStorage = (event: StorageEvent) => {
      if (event.key === PREFERENCE_KEY || event.key === null) update();
    };
    window.addEventListener('storage', onStorage);
    update();
    return () => {
      observer?.disconnect();
      mediaQuery?.removeEventListener('change', update);
      window.removeEventListener('storage', onStorage);
    };
  }, [darkMode, followHost, followSystem, readSurroundings]);

  const theme = useMemo(() => {
    if (customTheme) return customTheme;
    return isDark ? darkTheme : lightTheme;
  }, [customTheme, isDark]);

  // Where the tokens are written. An app that is on the host's side, a host
  // that named no box and a theme the host brought itself are all written on
  // the document, as they always were. Only an app that the rule has put on
  // the other side from its host, in a box the host named, is written on
  // that box, and then the document keeps the host's side: what is drawn
  // around the app, and any other app in the same document, is not moved.
  const named = boxName(box);
  const apart = named !== undefined && !customTheme && isDark !== ambientDark;
  // With its side, for the browser's own controls. The brand's tokens say
  // `color-scheme: dark` on `:root` unless the host stamps `data-theme`, which
  // the standalone page does not: a light app was drawn on a white page with
  // dark text fields, checkboxes and select menus.
  const cssString = useMemo(() => {
    if (!apart) return generateCss(themeToCssVariables(theme), ':root', [`color-scheme: ${isDark ? 'dark' : 'light'};`]);
    return generateCss(themeToCssVariables(ambientDark ? darkTheme : lightTheme), ':root', [
      `color-scheme: ${ambientDark ? 'dark' : 'light'};`,
    ]);
  }, [apart, theme, ambientDark, isDark]);
  const boxCss = useMemo(
    () =>
      apart
        ? '\n' + generateCss(themeToCssVariables(theme), `[${THEME_BOX_ATTRIBUTE}="${named}"]`, groundOf(isDark ? 'dark' : 'light'))
        : '',
    [apart, theme, named, isDark]
  );

  const toggleDarkMode = useCallback(() => {
    setSurroundings((was) => {
      // What the host alone comes to, turned over. Kept as a stored
      // preference with nothing above it until the host's theme, the device
      // or the store next changes, which is how long the old switch held.
      const next: ThemeSide = resolveAppTheme({ ...was, fallback }).ambient === 'dark' ? 'light' : 'dark';
      try {
        localStorage.setItem(PREFERENCE_KEY, next);
      } catch {
        // localStorage may be unavailable in restricted contexts
      }
      return { stored: next };
    });
    setCustomTheme(null); // Reset custom theme when toggling
  }, [fallback]);

  const setTheme = useCallback((newTheme: Theme) => {
    setCustomTheme(newTheme);
  }, []);

  // The pages that have said what their `theme` is. One, in an app; the
  // last to say so where a document draws two side by side.
  const pins = useRef(new Map<object, ThemeSide | undefined>());
  const pinPage = useCallback((pageTheme: unknown) => {
    const page = {};
    const settle = () => setPagePin([...pins.current.values()].pop());
    pins.current.set(page, themeSide(pageTheme));
    settle();
    return () => {
      pins.current.delete(page);
      settle();
    };
  }, []);

  const contextValue = useMemo<ThemeContextValue>(
    () => ({
      theme,
      setTheme,
      toggleDarkMode,
      isDarkMode: isDark,
      pinPage,
    }),
    [theme, setTheme, toggleDarkMode, isDark, pinPage]
  );

  return (
    <ThemeContext.Provider value={contextValue}>
      <style dangerouslySetInnerHTML={{ __html: cssString + globalStyles + boxCss }} />
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

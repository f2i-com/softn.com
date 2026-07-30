/**
 * Which theme the page is in, and who decided.
 *
 * Three choices, two outcomes: `system` follows the OS and keeps following it as
 * it changes, `light` and `dark` are the reader overruling it. The stored value
 * is the *choice*, never the resolved theme — storing "dark" when someone's
 * machine simply happened to be dark at the time would silently pin them to it.
 *
 * The key and the resolution rule are duplicated by the inline script in
 * index.html, which runs before first paint so the page never flashes the wrong
 * ground. If either changes, change both.
 */
export type ThemeChoice = 'system' | 'light' | 'dark';
export type Theme = 'light' | 'dark';

export const THEME_KEY = 'softn.site.theme';

const THEME_COLOR: Record<Theme, string> = { dark: '#101317', light: '#f4f6f9' };

function lightMedia(): MediaQueryList | null {
  return typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-color-scheme: light)') : null;
}

export function readChoice(): ThemeChoice {
  try {
    const stored = localStorage.getItem(THEME_KEY);
    if (stored === 'light' || stored === 'dark' || stored === 'system') return stored;
  } catch {
    // Storage can be unavailable in private mode or a sandboxed frame; the
    // system preference is a perfectly good answer when it is.
  }
  return 'system';
}

export function resolve(choice: ThemeChoice): Theme {
  if (choice !== 'system') return choice;
  return lightMedia()?.matches ? 'light' : 'dark';
}

export function apply(theme: Theme): void {
  document.documentElement.setAttribute('data-theme', theme);
  // The browser chrome around the page should not stay the colour of the theme
  // you just left.
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_COLOR[theme]);
}

export function store(choice: ThemeChoice): void {
  try {
    if (choice === 'system') localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, choice);
  } catch {
    // A choice that cannot be persisted still applies for this visit.
  }
}

/** Call `onChange` when the OS theme moves. Returns an unsubscribe. */
export function watchSystem(onChange: (theme: Theme) => void): () => void {
  const media = lightMedia();
  if (!media) return () => {};
  const handler = (event: MediaQueryListEvent) => onChange(event.matches ? 'light' : 'dark');
  media.addEventListener('change', handler);
  return () => media.removeEventListener('change', handler);
}

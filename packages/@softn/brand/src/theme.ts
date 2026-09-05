/**
 * Which theme the page is in, and who decided — shared by every SoftN app.
 *
 * Three choices, two outcomes: `system` follows the OS and keeps following it as
 * it changes, `light` and `dark` are the reader overruling it. The stored value
 * is the *choice*, never the resolved theme — storing "dark" when someone's
 * machine simply happened to be dark at the time would silently pin them to it.
 *
 * The key is the one the site has always used, so a preference set before the
 * four apps shared one carries over, and because the four are served from one
 * origin, switching in any of them switches all of them.
 *
 * The key and the resolution rule are duplicated by the inline script in each
 * app's index.html, which runs before first paint so the page never flashes
 * the wrong ground. If either changes, change them all — see PRE_PAINT_SCRIPT.
 */
export type ThemeChoice = 'system' | 'light' | 'dark';
export type Theme = 'light' | 'dark';

export const THEME_KEY = 'softn.site.theme';

const THEME_COLOR: Record<Theme, string> = { dark: '#101317', light: '#f4f6f9' };

/** The event the document fires when the theme changes, for anything that mirrors it. */
export const THEME_EVENT = 'softn:theme';

/**
 * What each index.html runs before first paint. Kept here as text so the copy
 * in every app can be checked against one source.
 */
export const PRE_PAINT_SCRIPT = `(function () {
  var theme = 'dark';
  try {
    var stored = localStorage.getItem('softn.site.theme');
    if (stored === 'light' || stored === 'dark') {
      theme = stored;
    } else if (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) {
      theme = 'light';
    }
  } catch (e) {
    /* Storage blocked; the dark default stands. */
  }
  document.documentElement.setAttribute('data-theme', theme);
  var meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', theme === 'light' ? '#f4f6f9' : '#101317');
})();`;

function lightMedia(): MediaQueryList | null {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-color-scheme: light)')
    : null;
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

/** The theme the page is painted in right now. */
export function currentTheme(): Theme {
  if (typeof document !== 'undefined') {
    const painted = document.documentElement.getAttribute('data-theme');
    if (painted === 'light' || painted === 'dark') return painted;
  }
  return resolve(readChoice());
}

export function apply(theme: Theme): void {
  const root = document.documentElement;
  if (root.getAttribute('data-theme') === theme) return;
  root.setAttribute('data-theme', theme);
  // The browser chrome around the page should not stay the colour of the theme
  // you just left.
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_COLOR[theme]);
  root.dispatchEvent(new CustomEvent<Theme>(THEME_EVENT, { detail: theme }));
}

export function store(choice: ThemeChoice): void {
  try {
    if (choice === 'system') localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, choice);
  } catch {
    // A choice that cannot be persisted still applies for this visit.
  }
}

/** The reader's decision: remember it and paint it. */
export function setTheme(theme: Theme): void {
  store(theme);
  apply(theme);
}

/** Call `onChange` when the OS theme moves. Returns an unsubscribe. */
export function watchSystem(onChange: (theme: Theme) => void): () => void {
  const media = lightMedia();
  if (!media) return () => {};
  const handler = (event: MediaQueryListEvent) => onChange(event.matches ? 'light' : 'dark');
  media.addEventListener('change', handler);
  return () => media.removeEventListener('change', handler);
}

/**
 * Follow the painted theme: the reader's toggle, the OS while the choice is
 * `system`, and another tab of the same origin changing the stored choice.
 * Returns an unsubscribe.
 */
export function subscribeTheme(onChange: (theme: Theme) => void): () => void {
  if (typeof document === 'undefined') return () => {};
  const onEvent = (event: Event) => onChange((event as CustomEvent<Theme>).detail);
  document.documentElement.addEventListener(THEME_EVENT, onEvent);
  const unwatch = watchSystem((next) => {
    if (readChoice() === 'system') apply(next);
  });
  const onStorage = (event: StorageEvent) => {
    if (event.key === THEME_KEY || event.key === null) apply(resolve(readChoice()));
  };
  window.addEventListener('storage', onStorage);
  return () => {
    document.documentElement.removeEventListener(THEME_EVENT, onEvent);
    unwatch();
    window.removeEventListener('storage', onStorage);
  };
}

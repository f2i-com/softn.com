import React, { useCallback, useEffect, useState } from 'react';
import { apply, readChoice, resolve, store, watchSystem, type Theme, type ThemeChoice } from '../lib/theme';

/**
 * One button, and it says what it will do rather than what is currently true —
 * a control labelled "dark mode" while the page is dark is a control nobody can
 * read. Pressing it always means "give me the other one".
 *
 * There is no third position for "follow the system". Once someone has an
 * opinion the page keeps it; before that, the choice is `system` and the page
 * follows the OS live, including while it is open.
 */
export function ThemeToggle(): React.ReactElement {
  const [choice, setChoice] = useState<ThemeChoice>('system');
  const [theme, setTheme] = useState<Theme>('dark');

  // The inline script in index.html already picked the theme before paint; this
  // reads back what it decided rather than deciding again, so the button never
  // disagrees with the page it is sitting on.
  useEffect(() => {
    const stored = readChoice();
    setChoice(stored);
    setTheme(resolve(stored));
  }, []);

  useEffect(() => {
    if (choice !== 'system') return;
    return watchSystem((next) => {
      setTheme(next);
      apply(next);
    });
  }, [choice]);

  const flip = useCallback(() => {
    const next: Theme = theme === 'dark' ? 'light' : 'dark';
    setChoice(next);
    setTheme(next);
    store(next);
    apply(next);
  }, [theme]);

  const goingTo = theme === 'dark' ? 'light' : 'dark';

  return (
    <button type="button" className="theme-toggle" onClick={flip} aria-label={`Switch to ${goingTo} mode`}>
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        {theme === 'dark' ? (
          <>
            <circle cx="8" cy="8" r="3.25" stroke="currentColor" strokeWidth="1.4" />
            <path
              d="M8 1.4v1.6M8 13v1.6M14.6 8H13M3 8H1.4M12.67 3.33l-1.13 1.13M4.46 11.54l-1.13 1.13M12.67 12.67l-1.13-1.13M4.46 4.46 3.33 3.33"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
            />
          </>
        ) : (
          <path
            d="M13.5 9.6A5.9 5.9 0 0 1 6.4 2.5a5.9 5.9 0 1 0 7.1 7.1Z"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinejoin="round"
          />
        )}
      </svg>
    </button>
  );
}

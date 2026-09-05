import React, { useCallback, useEffect, useState } from 'react';
import { currentTheme, setTheme, subscribeTheme, type Theme } from './theme';

/**
 * One button, and it says what it will do rather than what is currently true —
 * a control labelled "dark mode" while the page is dark is a control nobody can
 * read. Pressing it always means "give me the other one".
 *
 * There is no third position for "follow the system". Once someone has an
 * opinion the page keeps it; before that, the choice is `system` and the page
 * follows the OS live, including while it is open.
 */
export function ThemeToggle({ className = 'softn-theme-toggle' }: { className?: string }): React.ReactElement {
  // Seeded from what the pre-paint script decided, so the button agrees with
  // the page on its very first frame.
  const [theme, setThemeState] = useState<Theme>(currentTheme);

  useEffect(() => subscribeTheme(setThemeState), []);

  const flip = useCallback(() => {
    const next: Theme = theme === 'dark' ? 'light' : 'dark';
    setThemeState(next);
    setTheme(next);
  }, [theme]);

  const goingTo = theme === 'dark' ? 'light' : 'dark';

  return (
    <button type="button" className={className} onClick={flip} aria-label={`Switch to ${goingTo} mode`} title={`Switch to ${goingTo} mode`}>
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

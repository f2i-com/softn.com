/**
 * The theme a component drawn on the canvas is drawn in: the app's, not the
 * editor's.
 *
 * The two are different things. The editor is dark or light as the person
 * using it likes; the app is light, dark or the visitor's own choice as its
 * project says, and a page can pin its `<App theme>` to one of them over
 * that. A component on the canvas has to look as it will in Preview, so
 * what is worked out here is what Preview works out, in the same order:
 *
 *  - the tokens (the palette, type and spacing every component reads) are
 *    the light or the dark set by the project's theme mode, as the runtime's
 *    ThemeProvider chooses them; "system" is the stored preference the
 *    running app would read, then the device's;
 *  - the page's own colours are `<App theme="light|dark">` where the page
 *    says so, and the tokens' side otherwise, as the App component decides.
 *
 * The canvas does not ask for the project's theme yet: it draws everything
 * in the light one, for the reason given at CANVAS_THEME below. What is
 * above is kept, and tested, for when the artboard follows the project.
 */

import { useEffect, useState } from 'react';
import { useCanvasStore } from '../stores/canvasStore';
import { useProjectStore } from '../stores/projectStore';

export type ThemeSide = 'light' | 'dark';

export interface DrawnTheme {
  /** Which set of tokens: the project's theme mode. */
  tokens: ThemeSide;
  /** Which of the page's own colours: its `<App theme>`, or the tokens' side. */
  page: ThemeSide;
}

/** Where the running app keeps a visitor's explicit choice (ThemeProvider reads it first). */
const PREFERENCE_KEY = 'softn-theme-preference';

/** What "system" comes to here and now, as the running app would read it. */
export function systemSide(): ThemeSide {
  if (typeof window === 'undefined') return 'light';
  try {
    const stored = window.localStorage.getItem(PREFERENCE_KEY);
    if (stored === 'dark' || stored === 'light') return stored;
  } catch {
    // Storage that cannot be read has no preference in it.
  }
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/** The theme for a project of this mode and a page whose `<App theme>` is this. */
export function drawnThemeFor(themeMode: 'light' | 'dark' | 'system', pageTheme: unknown, system: ThemeSide): DrawnTheme {
  const tokens: ThemeSide = themeMode === 'system' ? system : themeMode;
  const page: ThemeSide = pageTheme === 'light' || pageTheme === 'dark' ? pageTheme : tokens;
  return { tokens, page };
}

/** The theme of what the canvas draws, followed as the project, the page or the device changes it. */
export function useDrawnTheme(): DrawnTheme {
  const themeMode = useProjectStore((state) => state.themeMode);
  // The page's own choice, when it is written as the word and not worked out.
  const pageTheme = useCanvasStore((state) => {
    const page = state.elements.get(state.rootId);
    return page && !(page.expressionProps ?? []).includes('theme') ? page.props.theme : undefined;
  });
  const [system, setSystem] = useState<ThemeSide>(systemSide);

  useEffect(() => {
    if (themeMode !== 'system' || typeof window === 'undefined') return;
    const update = () => setSystem(systemSide());
    const query = window.matchMedia?.('(prefers-color-scheme: dark)');
    query?.addEventListener('change', update);
    const stored = (event: StorageEvent) => {
      if (event.key === PREFERENCE_KEY || event.key === null) update();
    };
    window.addEventListener('storage', stored);
    update();
    return () => {
      query?.removeEventListener('change', update);
      window.removeEventListener('storage', stored);
    };
  }, [themeMode]);

  const { tokens, page } = drawnThemeFor(themeMode, pageTheme, system);
  // The same object while nothing has changed, so what reads it is not redrawn.
  return THEMES[tokens][page];
}

const THEMES: Record<ThemeSide, Record<ThemeSide, DrawnTheme>> = {
  light: { light: { tokens: 'light', page: 'light' }, dark: { tokens: 'light', page: 'dark' } },
  dark: { light: { tokens: 'dark', page: 'light' }, dark: { tokens: 'dark', page: 'dark' } },
};

/**
 * The theme the canvas draws in: the light one, whatever the project's.
 *
 * The artboard is paper, and the elements drawn on it by hand (a Button, a
 * Text, a Card, the name cards) are light. A dark project's components drawn
 * in its own theme stood there as black tiles among light ones: each right
 * in itself and the page a patchwork. So the canvas is one thing, the
 * structure of the page in one set of colours, and Preview is where the
 * project is seen in its own. `useDrawnTheme` above works out what Preview
 * works out and is what the canvas will ask once the artboard and the
 * hand-drawn elements follow the project too.
 */
export const CANVAS_THEME: DrawnTheme = THEMES.light.light;

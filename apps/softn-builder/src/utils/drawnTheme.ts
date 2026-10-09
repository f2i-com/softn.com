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
 * The artboard is the app's page in that theme (canvas/DrawnComponent.tsx,
 * AppPage), and everything Builder draws on it by hand reads its colours
 * from the page, so a dark project is a dark page on the canvas. For a
 * while the canvas drew everything light whatever the project: the
 * artboard was paper then, and a dark project's own components stood on it
 * as black tiles among light ones.
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

/**
 * Which theme a page is drawn in, said in a sentence, for a person who has
 * set the project's theme and the page's own and sees only one of them.
 * What decides is what the App component decides (it reads the page's
 * `theme` first, and the project's only where the page does not say light
 * or dark).
 */
export function themeSentence(
  themeMode: 'light' | 'dark' | 'system',
  pageTheme: { value: unknown; isExpression: boolean } | undefined,
  system: ThemeSide
): string {
  const project = themeMode === 'system' ? system : themeMode;
  if (pageTheme?.isExpression) {
    return `This page works its theme out when the app runs ({${String(pageTheme.value)}}). Until it does, it is drawn as the project is set: ${project}.`;
  }
  const own = pageTheme?.value;
  if (own === 'light' || own === 'dark') {
    if (themeMode === 'system') return `This page is ${own}: its own theme is set to ${own}, whatever a visitor's device prefers.`;
    return own === project
      ? `This page is ${own}: its own theme is set to ${own}, as the project's is.`
      : `This page is ${own}: its own theme is set to ${own}, which wins over the project's ${project}.`;
  }
  if (typeof own === 'string' && own !== '' && own !== 'system') {
    return `This page has a theme of its own, "${own}", drawn here over the project's ${project} colours.`;
  }
  return themeMode === 'system'
    ? `This page follows the project: system, which is ${system} on this device. A visitor sees their own.`
    : // The project's setting is the Builder's: Preview and the canvas read it,
      // and it is saved in the app's manifest, where no runtime looks for
      // it yet. What a running app follows is said, not left to be found.
      `This page follows the project: ${project}, on the canvas and in Preview. A running app follows its visitor's device unless the page's own theme is set.`;
}

/** What "system" comes to on this device, followed while it is asked for. */
export function useSystemSide(watch: boolean): ThemeSide {
  const [system, setSystem] = useState<ThemeSide>(systemSide);
  useEffect(() => {
    if (!watch || typeof window === 'undefined') return;
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
  }, [watch]);
  return system;
}

/** The theme of what the canvas draws, followed as the project, the page or the device changes it. */
export function useDrawnTheme(): DrawnTheme {
  const themeMode = useProjectStore((state) => state.themeMode);
  // The page's own choice, when it is written as the word and not worked out.
  const pageTheme = useCanvasStore((state) => {
    const page = state.elements.get(state.rootId);
    return page && !(page.expressionProps ?? []).includes('theme') ? page.props.theme : undefined;
  });
  const system = useSystemSide(themeMode === 'system');

  const { tokens, page } = drawnThemeFor(themeMode, pageTheme, system);
  // The same object while nothing has changed, so what reads it is not redrawn.
  return THEMES[tokens][page];
}

const THEMES: Record<ThemeSide, Record<ThemeSide, DrawnTheme>> = {
  light: { light: { tokens: 'light', page: 'light' }, dark: { tokens: 'light', page: 'dark' } },
  dark: { light: { tokens: 'dark', page: 'light' }, dark: { tokens: 'dark', page: 'dark' } },
};

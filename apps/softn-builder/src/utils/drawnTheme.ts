/**
 * The theme a component drawn on the canvas is drawn in: the app's, not the
 * editor's.
 *
 * The two are different things. The editor is dark or light as the person
 * using it likes; the app is light, dark or the visitor's own choice as its
 * project says, and a page can pin its `<App theme>` to one of them over
 * that. A component on the canvas has to look as it will when the app
 * runs, so what is worked out here is the one rule every host that draws an
 * app goes by (@softn/components, theme/app-theme.ts), asked of that rule
 * and not written out again here:
 *
 *  - the tokens (the palette, type and spacing every component reads) are
 *    the side the project declares, light or dark, unless the page pins the
 *    other, and then they go with the page. They stayed the project's, and
 *    a light page in a dark project had the dark set's chart colours on it;
 *  - a project that declares nothing ("system") has the tokens of what the
 *    host comes to: here the document's own theme, as on the site an app
 *    runs on, then the stored preference, then the device;
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
import { resolveAppTheme } from '@softn/components/theme';
import { useCanvasStore } from '../stores/canvasStore';
import { useProjectStore } from '../stores/projectStore';

export type ThemeSide = 'light' | 'dark';

export interface DrawnTheme {
  /** Which set of tokens: the project's declared side, the page's where it pins the other, or the host's. */
  tokens: ThemeSide;
  /** Which of the page's own colours: its `<App theme>`, or the tokens' side. */
  page: ThemeSide;
}

/** Where the running app keeps a visitor's explicit choice, one for the whole origin. */
const PREFERENCE_KEY = 'softn-theme-preference';

/**
 * What "system" comes to here and now, read in the order the web runtime
 * reads it: the theme of the document the app is drawn in (its
 * `data-theme`: in the Builder the site's theme, which is the editor's
 * own), then the stored preference, then the device. The document's theme
 * was not read, so a System project was drawn by the device under an editor
 * a person had switched the other way, where the same app on the site
 * would follow the switch.
 */
export function systemSide(): ThemeSide {
  if (typeof window === 'undefined') return 'light';
  let stored: string | null = null;
  try {
    stored = window.localStorage.getItem(PREFERENCE_KEY);
  } catch {
    // Storage that cannot be read has no preference in it.
  }
  return resolveAppTheme({
    host: typeof document === 'undefined' ? undefined : document.documentElement.getAttribute('data-theme'),
    stored,
    device: window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
  }).ambient;
}

/**
 * The theme for a project of this mode and a page whose `<App theme>` is
 * this, where "system" comes to `system` here: what the rule makes of them.
 */
export function drawnThemeFor(themeMode: 'light' | 'dark' | 'system', pageTheme: unknown, system: ThemeSide): DrawnTheme {
  const { tokens, page } = resolveAppTheme({ manifest: themeMode, page: pageTheme, host: system });
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
    // A project that declares no side leaves the tokens following the host
    // under a page that pins one: the page's own colours are its own, and
    // the chart series and code colours are still the visitor's side's.
    // That is what the canvas draws, and it looks like a mistake unsaid.
    if (themeMode === 'system') {
      return `This page is ${own}: its own theme is set to ${own}, whatever a visitor's device prefers. Its chart and code colours still follow the visitor: set the project to ${own} to keep them with the page.`;
    }
    return own === project
      ? `This page is ${own}: its own theme is set to ${own}, as the project's is.`
      : `This page is ${own}: its own theme is set to ${own}, which wins over the project's ${project}.`;
  }
  if (typeof own === 'string' && own !== '' && own !== 'system') {
    return `This page has a theme of its own, "${own}", drawn here over the project's ${project} colours.`;
  }
  return themeMode === 'system'
    ? // What "system" comes to here is the document's theme first, which in
      // the Builder is the editor's own (systemSide).
      `This page follows the project: system, which is ${system} here, as this editor is. A visitor sees their own.`
    : // The project's light or dark is saved in the app's manifest
      // (`config.theme.mode`), and the running app is that theme as the canvas
      // and Preview are. For a while no runtime read it, and this sentence
      // said a running app followed its visitor's device.
      `This page follows the project: ${project}, on the canvas, in Preview and in the running app.`;
}

/** What "system" comes to here, followed while it is asked for: the document's theme, the store, the device. */
export function useSystemSide(watch: boolean): ThemeSide {
  const [system, setSystem] = useState<ThemeSide>(systemSide);
  useEffect(() => {
    if (!watch || typeof window === 'undefined') return;
    const update = () => setSystem(systemSide());
    // The document's theme is switched without the page being loaded again.
    const observer = typeof MutationObserver === 'undefined' ? null : new MutationObserver(update);
    observer?.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    const query = window.matchMedia?.('(prefers-color-scheme: dark)');
    query?.addEventListener('change', update);
    const stored = (event: StorageEvent) => {
      if (event.key === PREFERENCE_KEY || event.key === null) update();
    };
    window.addEventListener('storage', stored);
    update();
    return () => {
      observer?.disconnect();
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
